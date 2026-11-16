import {
  DynamicBorder,
  getSelectListTheme,
  getSettingsListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  SettingsList,
  wrapTextWithAnsi,
  type Component,
  type SelectItem,
  type SettingItem,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { errorText } from "./errors.js";
import type { LayeredSettingScope } from "./layered-settings.js";
import { SEPARATOR, statusMark } from "./ui.js";

/** The theme methods the settings widgets draw with; Pi's `Theme` satisfies it. */
export type SettingsMenuTheme = Pick<Theme, "fg" | "bold">;

/**
 * The value after `current` in `values`, wrapping around; `undefined` when `values` is empty.
 * A `current` that is not in `values` yields the first value.
 */
export function nextCycleValue<Value extends string>(
  values: readonly Value[],
  current: string,
): Value | undefined {
  return values[(values.findIndex((value) => value === current) + 1) % values.length];
}

/**
 * Single-line value entry with inline validation. `submit` may throw a user-facing message,
 * which is shown in place of the hint until the next keystroke.
 */
export class ValueInput implements Component {
  private readonly input: Input;
  private error: string | undefined;

  constructor(
    private readonly title: string,
    private readonly hint: string,
    private readonly theme: SettingsMenuTheme,
    submit: (text: string) => void,
    cancel: () => void,
  ) {
    this.input = new Input({ placeholder: hint });
    this.input.focused = true;
    this.input.onSubmit = (text) => {
      try {
        submit(text);
      } catch (cause) {
        this.error = errorText(cause);
      }
    };
    this.input.onEscape = cancel;
  }
  handleInput(data: string): void {
    this.error = undefined;
    this.input.handleInput(data);
  }
  render(width: number): string[] {
    return [
      this.theme.bold(this.title),
      ...this.input.render(width),
      this.error
        ? `${statusMark(this.theme, "failed")} ${this.theme.fg("error", this.error)}`
        : this.theme.fg("dim", this.hint),
    ];
  }
  invalidate(): void {
    this.input.invalidate();
  }
}

const listActions = [
  "tui.select.up",
  "tui.select.down",
  "tui.select.confirm",
  "tui.select.cancel",
] as const;

/** Fuzzy-searchable model list whose first choice is `inherit`. */
export class ModelPicker implements Component {
  private readonly input = new Input({ placeholder: "type to search" });
  private list: SelectList;

  constructor(
    private readonly models: readonly string[],
    private readonly choose: (value: string) => void,
    private readonly cancel: () => void,
  ) {
    this.input.focused = true;
    this.list = this.createList("");
  }
  private createList(query: string): SelectList {
    const items: SelectItem[] = ["inherit", ...this.models].map((value) => ({
      value,
      label: value,
    }));
    const list = new SelectList(
      query ? fuzzyFilter(items, query, (item) => item.value) : items,
      10,
      getSelectListTheme(),
    );
    list.onSelect = (item) => this.choose(item.value);
    list.onCancel = this.cancel;
    return list;
  }
  handleInput(data: string): void {
    const bindings = getKeybindings();
    if (listActions.some((action) => bindings.matches(data, action))) {
      this.list.handleInput(data);
      return;
    }
    this.input.handleInput(data);
    this.list = this.createList(this.input.getValue());
  }
  render(width: number): string[] {
    return [...this.input.render(width), ...this.list.render(width)];
  }
  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }
}

/** Native UI collaborators a settings menu needs, as supplied by `ctx.ui.custom`. */
export interface SettingsMenuUi {
  tui: TUI;
  theme: SettingsMenuTheme;
}

/** `effective · source`, the usual `inEffect` text for `cycleDisplay`. */
export function effectiveWithSource(effective: string, source: string): string {
  return `${effective}${SEPARATOR}${source}`;
}

/**
 * A cycled option's display: the selected scope's own value, or what it inherits, noting when a
 * higher-precedence scope overrides it. `inEffect` describes the effective value and its source.
 */
export function cycleDisplay(input: {
  own: string | undefined;
  inEffect: string;
  source: string;
  scope: string;
}): string {
  if (input.own === undefined) return `inherit (${input.inEffect})`;
  return input.source === input.scope ? input.own : `${input.own} (overridden: ${input.inEffect})`;
}

/** What the frame shows from an extension's view: its live status lines and writable scopes. */
export interface SettingsMenuView {
  headline: readonly string[];
  /** Writable scopes, in the order the Scope row cycles them. */
  scopes: readonly LayeredSettingScope[];
}

/** The fields every editable row shows. */
interface SettingRowFields {
  id: string;
  label: string;
  description: string;
}

/**
 * One row of a settings menu, in display order. `scope` is the frame's Scope row. Every change
 * function receives the scope being written. A `cycle` row steps through `values`, starting after
 * the scope's own value `own` (`undefined` when that scope inherits). An `input` row takes typed
 * text and a `pick` row chooses from `choices`; both throw a user-facing message for invalid text.
 * An `action` row runs `run` when chosen.
 */
export type SettingRow<Change> =
  | { kind: "scope" }
  | (SettingRowFields & {
      kind: "cycle";
      values: readonly string[];
      own: string | undefined;
      /** The effective value and its source, as `effectiveWithSource` shows them. */
      inEffect: string;
      source: string;
      change: (value: string, scope: LayeredSettingScope) => Change;
    })
  | (SettingRowFields & {
      kind: "input";
      value: string;
      hint: string;
      change: (text: string, scope: LayeredSettingScope) => Change;
    })
  | (SettingRowFields & {
      kind: "pick";
      value: string;
      choices: readonly string[];
      change: (value: string, scope: LayeredSettingScope) => Change;
    })
  | (SettingRowFields & {
      kind: "action";
      value: string;
      run: () => Promise<void>;
    });

/** An extension's settings authority behind a menu: it reads the view and writes one change. */
export interface SettingsMenuSpec<View extends SettingsMenuView, Change> {
  title: string;
  /** Read the host fresh; a read that throws is shown inline and the last good view is kept. */
  read(): View;
  /** The rows for `view` with `scope` selected, in display order. */
  rows(view: View, scope: LayeredSettingScope): readonly SettingRow<Change>[];
  /** Persist one change at `scope`; a rejection is shown inline. */
  apply(scope: LayeredSettingScope, change: Change): Promise<void>;
}

/**
 * Pi's settings-screen look (a border, an accent title, live status lines, then a native settings
 * list) plus a serialized edit queue. An extension supplies its rows and host as a
 * {@link SettingsMenuSpec}.
 */
export class SettingsMenu<View extends SettingsMenuView, Change> implements Component {
  /** The last failed edit, shown under the list until the next edit starts. */
  private error: string | undefined;
  /** Edits run one at a time so each reads the result of the previous one. */
  private pending: Promise<void> = Promise.resolve();
  private view: View;
  private scope: LayeredSettingScope = "session";
  private rows: readonly SettingRow<Change>[];
  private items = new Map<string, SettingItem>();
  private list: SettingsList | undefined;
  /** The row last changed or opened; a rebuilt list selects it unless a new row appears. */
  private lastRow = "scope";
  private submenuOpen = false;
  private rebuildPending = false;
  private readonly border: DynamicBorder;

  constructor(
    private readonly spec: SettingsMenuSpec<View, Change>,
    private readonly ui: SettingsMenuUi,
    private readonly done: () => void,
  ) {
    this.border = new DynamicBorder((text) => ui.theme.fg("border", text));
    this.view = spec.read();
    this.rows = spec.rows(this.view, this.scope);
    this.rebuild();
  }

  /** Resolves once every edit started so far has been applied or rejected. */
  settled(): Promise<void> {
    return this.pending;
  }

  /** Re-read the host after external state changes, such as a Review starting. */
  refresh(): void {
    try {
      this.view = this.spec.read();
    } catch (cause) {
      this.error = errorText(cause);
      return;
    }
    if (!this.view.scopes.includes(this.scope)) this.scope = "session";
    this.rows = this.spec.rows(this.view, this.scope);
    this.sync();
  }

  /** Update rows in place; rebuild the list only when the set of rows changes. */
  private sync(): void {
    const ids = this.rows.map(rowId);
    if (ids.length === this.items.size && ids.every((id) => this.items.has(id))) {
      for (const row of this.rows) {
        const item = this.items.get(rowId(row));
        if (item) Object.assign(item, this.toItem(row));
      }
      return;
    }
    if (this.submenuOpen) this.rebuildPending = true;
    else this.rebuild();
  }

  /** Create a fresh native list; a newly listed row is selected, otherwise the last row. */
  private rebuild(): void {
    const previous = new Set(this.items.keys());
    const added = this.rows.map(rowId).find((id) => !previous.has(id));
    this.rebuildPending = false;
    this.items = new Map(this.rows.map((row) => [rowId(row), this.toItem(row)]));
    this.list = new SettingsList(
      [...this.items.values()],
      this.items.size,
      getSettingsListTheme(),
      (id, value) => this.change(id, value),
      this.done,
    );
    this.list.selectItem(added ?? this.lastRow);
  }

  private toItem(row: SettingRow<Change>): SettingItem {
    switch (row.kind) {
      case "scope":
        return {
          id: "scope",
          label: "Scope",
          currentValue: this.scope,
          values: [...this.view.scopes],
          description: "Where edits are written",
        };
      case "cycle":
        return {
          id: row.id,
          label: row.label,
          description: row.description,
          currentValue: this.cycleText(row),
          values: [...row.values],
        };
      case "input":
        return {
          id: row.id,
          label: row.label,
          description: row.description,
          currentValue: row.value,
          submenu: this.submenu(row.id, (close) => {
            return new ValueInput(
              row.id,
              row.hint,
              this.ui.theme,
              (text) => {
                this.apply(row.change(text, this.scope));
                close();
              },
              close,
            );
          }),
        };
      case "pick":
        return {
          id: row.id,
          label: row.label,
          description: row.description,
          currentValue: row.value,
          submenu: this.submenu(row.id, (close) => {
            return new ModelPicker(
              row.choices,
              (value) => {
                this.apply(row.change(value, this.scope));
                close();
              },
              close,
            );
          }),
        };
      case "action":
        return {
          id: row.id,
          label: row.label,
          description: row.description,
          currentValue: row.value,
          values: [row.value],
        };
    }
  }

  /** This scope's own value, or what it inherits; notes when another scope overrides it. */
  private cycleText(row: CycleRow<Change>): string {
    return cycleDisplay({
      own: row.own,
      inEffect: row.inEffect,
      source: row.source,
      scope: this.scope,
    });
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

  private change(id: string, value: string): void {
    if (id === "scope") {
      const scope = this.view.scopes.find((name) => name === value);
      if (scope) this.scope = scope;
      this.lastRow = id;
      this.refresh();
      return;
    }
    const row = this.rows.find((item) => rowId(item) === id);
    if (row?.kind === "action") this.run(row.run);
    if (row?.kind !== "cycle") return;
    this.lastRow = id;
    const scope = this.scope;
    this.run(() => this.cycle(id, scope));
    // The list already overwrote the row with its proposal; show the current value until the
    // write settles and refresh() shows the new one.
    const item = this.items.get(id);
    if (item) item.currentValue = this.cycleText(row);
  }

  /**
   * Write the value after the scope's own value, read when the queued edit runs so an earlier
   * edit is counted. The list's proposal is not used: the row's display text is not a value.
   */
  private async cycle(id: string, scope: LayeredSettingScope): Promise<void> {
    const row = this.spec.rows(this.spec.read(), scope).find((item) => rowId(item) === id);
    if (row?.kind !== "cycle") return;
    const next = nextCycleValue(row.values, row.own ?? "inherit") ?? "inherit";
    await this.spec.apply(scope, row.change(next, scope));
  }

  /** Apply a change already built for the current scope. */
  private apply(change: Change): void {
    const scope = this.scope;
    this.run(() => this.spec.apply(scope, change));
  }

  /** Queue an edit; a failure shows inline, and the menu refreshes once it settles. */
  private run(task: () => Promise<void>): void {
    this.error = undefined;
    this.pending = this.pending
      .then(task)
      .catch((cause: unknown) => {
        this.error = errorText(cause);
      })
      .finally(() => {
        this.refresh();
        this.ui.tui.requestRender();
      });
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list?.handleMouse(event);
  }

  render(width: number): string[] {
    const { theme } = this.ui;
    const indented = (text: string) => wrapTextWithAnsi(` ${text}`, width);
    return [
      ...this.border.render(width),
      ...indented(theme.fg("accent", theme.bold(this.spec.title))),
      ...this.view.headline.flatMap(indented),
      "",
      ...(this.list?.render(width) ?? []),
      ...(this.error
        ? indented(`${statusMark(theme, "failed")} ${theme.fg("error", this.error)}`)
        : []),
      ...this.border.render(width),
    ];
  }

  invalidate(): void {
    this.list?.invalidate();
  }
}

type CycleRow<Change> = Extract<SettingRow<Change>, { kind: "cycle" }>;

function rowId<Change>(row: SettingRow<Change>): string {
  return row.kind === "scope" ? "scope" : row.id;
}
