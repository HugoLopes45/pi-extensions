import type { SettingsList } from "@earendil-works/pi-tui";
import { type Component, type SettingItem } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";

import { formatOnlookerOption, type OnlookerRenderTheme } from "./onlooker-rendering.js";
import {
  onlookerOptionKey,
  onlookerOptionKeys,
  onlookerSettingScopeSchema,
  parseOnlookerOptions,
  type OnlookerChange,
  type OnlookerOptions,
  type OnlookerSettingScope,
  type OnlookerSettingSource,
} from "./onlooker-settings.js";
import {
  cycleDisplay,
  effectiveWithSource,
  errorText,
  ModelPicker,
  nextCycleValue,
  scopeRow,
  SettingsMenu,
  ValueInput,
  type SettingsMenuUi,
} from "./utils/settings-menu.js";

/** Authored options at each writable scope. */
export type OnlookerScopedOptions = { [Scope in OnlookerSettingScope]: OnlookerOptions };

/** Everything the menu displays, read fresh after each change. */
export interface OnlookerMenuView {
  /** Themed live status lines shown above the settings. */
  headline: readonly string[];
  paused: boolean;
  /** Writable scopes; project only when trusted. */
  scopes: readonly OnlookerSettingScope[];
  /** Effective options after scope precedence. */
  settings: OnlookerOptions;
  sources: Readonly<Partial<Record<keyof OnlookerOptions, OnlookerSettingSource>>>;
  authored: Readonly<Partial<OnlookerScopedOptions>>;
  /** `provider/id` names of selectable models. */
  models: readonly string[];
}

/** The extension's settings authority behind the menu. */
export interface OnlookerMenuHost {
  view(): OnlookerMenuView;
  /** Validate, persist, and apply one change; rejects with a user-facing message. */
  apply(scope: OnlookerSettingScope, change: OnlookerChange): Promise<void>;
  /** Retry a Paused Onlooker with its current settings. */
  resume(): Promise<void>;
}

/** Native UI collaborators supplied by `ctx.ui.custom`. */
export interface OnlookerMenuUi extends SettingsMenuUi {
  theme: OnlookerRenderTheme;
}

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Options edited by cycling the selected scope's own value; `inherit` removes it. */
const cycleValues = {
  enabled: ["inherit", "on", "off"],
  correct: ["inherit", "on", "off"],
  thinkingLevel: ["inherit", ...thinkingLevels],
} as const satisfies Record<string, readonly string[]>;
type CycleKey = keyof typeof cycleValues;

function isCycleKey(key: keyof OnlookerOptions): key is CycleKey {
  return key === "enabled" || key === "correct" || key === "thinkingLevel";
}

/** A cycled option's value as shown and cycled; undefined when absent. */
function cycleValue(key: CycleKey, options: OnlookerOptions): string | undefined {
  if (key === "thinkingLevel") return options.thinkingLevel;
  const value = options[key];
  return value === undefined ? undefined : value ? "on" : "off";
}
const descriptions = {
  enabled: "Review this session's work",
  name: "Display name; inherit uses the name from the next scope",
  model: "Onlooker model; inherit follows the observed agent",
  thinkingLevel: "Onlooker thinking level; inherit uses the default (high)",
  reviewEvery:
    "When Reviews run: every turn, every N turns, or once per request; a tool error reviews at once",
  correct:
    "After a Concern or Blocker, start one hidden turn that asks the agent to decide and continue",
} satisfies Record<keyof OnlookerOptions, string>;
const onOff = new Map([
  ["on", true],
  ["off", false],
]);

/** Convert one typed or selected menu value into a validated change. */
function parseOnlookerMenuValue(
  key: keyof OnlookerOptions,
  text: string,
  scope: OnlookerSettingScope,
): OnlookerChange {
  const value = key === "name" ? text : text.trim();
  if (value === "inherit") return { action: "inherit", key };
  if (value === "") throw new Error(`Enter a value for ${key}, or inherit`);
  const patch =
    key === "enabled" || key === "correct"
      ? { [key]: onOff.get(value) ?? value }
      : key === "reviewEvery"
        ? { reviewEvery: value === "turn" || value === "request" ? value : Number(value) }
        : { [key]: value };
  return { action: "set", key, patch: parseOnlookerOptions(patch, scope) };
}

/** Menu row ids that are not Onlooker options. */
const actionRows = { resume: "resume", scope: "scope" } as const;

/** `/onlooker` settings menu built from Pi's native settings list. */
export class OnlookerSettingsMenu extends SettingsMenu {
  private scope: OnlookerSettingScope = "session";
  private view: OnlookerMenuView;
  private rows: SettingItem[] = [];
  private lastRow: string = actionRows.scope;
  private submenuOpen = false;
  private rebuildPending = false;

  constructor(
    private readonly host: OnlookerMenuHost,
    protected override readonly ui: OnlookerMenuUi,
    done: () => void,
  ) {
    super("Onlooker settings", ui, done);
    this.view = host.view();
    this.createList();
  }

  protected headline(): readonly string[] {
    return this.view.headline;
  }

  /** Re-read the host after external state changes, such as a Review starting. */
  override refresh(): void {
    const paused = this.view.paused;
    try {
      this.view = this.host.view();
    } catch (cause) {
      // Keep the last good view; an unreadable settings file is reported inline.
      this.error = errorText(cause);
      return;
    }
    if (!this.view.scopes.includes(this.scope)) this.scope = "session";
    for (const row of this.rows) Object.assign(row, this.createRow(row.id));
    // Adding or removing Resume rebuilds the list; never discard an open submenu to do it.
    if (paused !== this.view.paused) {
      if (this.submenuOpen) this.rebuildPending = true;
      else this.rebuild();
    }
  }

  private rebuild(): void {
    this.rebuildPending = false;
    this.createList().selectItem(this.view.paused ? actionRows.resume : this.lastRow);
  }

  private createList(): SettingsList {
    const ids = [
      ...(this.view.paused ? [actionRows.resume] : []),
      actionRows.scope,
      ...onlookerOptionKeys,
    ];
    this.rows = ids.map((id) => this.createRow(id));
    return this.setList(this.rows, (id, value) => this.change(id, value));
  }

  private createRow(id: string): SettingItem {
    if (id === actionRows.resume)
      return {
        id,
        label: "Resume",
        currentValue: "retry",
        values: ["retry"],
        description: "Retry the Paused Onlooker with its current settings",
      };
    if (id === actionRows.scope) return scopeRow(this.scope, this.view.scopes);
    return this.optionRow(onlookerOptionKey(id));
  }

  /** Track an open submenu so a rebuild waits for it to close. */
  private submenu(
    id: string,
    open: (close: () => void) => Component,
  ): NonNullable<SettingItem["submenu"]> {
    return (_value, done) => {
      this.submenuOpen = true;
      this.lastRow = id;
      return open(() => {
        this.submenuOpen = false;
        done();
        if (this.rebuildPending) this.rebuild();
      });
    };
  }

  private optionRow(key: keyof OnlookerOptions): SettingItem {
    const source = this.view.sources[key] ?? "default";
    const settings = this.view.settings;
    const row = {
      id: key,
      label: source === "default" ? key : `${key} [${source}]`,
      description: descriptions[key],
    };
    switch (key) {
      case "enabled":
      case "correct":
      case "thinkingLevel":
        // The row shows and cycles this scope's own value, so every state is reachable.
        return {
          ...row,
          label: key,
          currentValue: this.cycleDisplay(key),
          values: [...cycleValues[key]],
        };
      case "model":
        return {
          ...row,
          currentValue: settings.model ?? "inherit",
          submenu: this.submenu(
            key,
            (close) =>
              new ModelPicker(
                this.view.models,
                (value) => {
                  this.apply(parseOnlookerMenuValue(key, value, this.scope));
                  close();
                },
                close,
              ),
          ),
        };
      default:
        return {
          ...row,
          currentValue: formatOnlookerOption(settings, key),
          submenu: this.submenu(
            key,
            (close) =>
              new ValueInput(
                key,
                key === "name"
                  ? "A display name, or inherit"
                  : "turn, request, a number of turns, or inherit",
                this.ui.theme,
                (text) => {
                  // Throws for invalid input, keeping the field open with the message.
                  this.apply(parseOnlookerMenuValue(key, text, this.scope));
                  close();
                },
                close,
              ),
          ),
        };
    }
  }

  /** This scope's own value, or what it inherits; notes when another scope overrides it. */
  private cycleDisplay(key: CycleKey): string {
    const effective = cycleValue(key, this.view.settings);
    const source = this.view.sources[key] ?? "default";
    return cycleDisplay({
      own: cycleValue(key, this.view.authored[this.scope] ?? {}),
      inEffect: effective === undefined ? "observed agent" : effectiveWithSource(effective, source),
      source,
      scope: this.scope,
    });
  }

  private change(id: string, value: string): void {
    if (id === actionRows.resume) {
      this.run(() => this.host.resume());
      return;
    }
    if (id === actionRows.scope) {
      if (Value.Check(onlookerSettingScopeSchema, value)) this.scope = value;
      this.lastRow = id;
      this.refresh();
      return;
    }
    this.lastRow = id;
    const key = onlookerOptionKey(id);
    if (!isCycleKey(key)) return;
    // Cycle from this scope's own value. The list proposes values[0] because its display
    // text is not one of the values, so ignore its suggestion.
    const values = cycleValues[key];
    const own = cycleValue(key, this.view.authored[this.scope] ?? {}) ?? "inherit";
    const next = nextCycleValue(values, own) ?? "inherit";
    let change: OnlookerChange;
    try {
      change = parseOnlookerMenuValue(key, next, this.scope);
    } catch (cause) {
      this.error = errorText(cause);
      this.refresh();
      return;
    }
    this.apply(change);
    // The list already overwrote the row with its proposal; show the current value until
    // the write settles and refresh() shows the new one.
    const row = this.rows.find((item) => item.id === id);
    if (row) row.currentValue = this.cycleDisplay(key);
  }

  /** Apply at the current scope (Pi settings semantics); the list refreshes once it settles. */
  private apply(change: OnlookerChange): void {
    const scope = this.scope;
    this.run(() => this.host.apply(scope, change));
  }
}
