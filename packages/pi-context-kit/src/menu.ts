import type { LayeredSettingScope, LayeredSettingSource } from "pi-hl-utils/layered-settings";
import {
  effectiveWithSource,
  type SettingRow,
  type SettingsMenuSpec,
} from "pi-hl-utils/settings-menu";

import {
  type ContextKitChange,
  type ContextKitOptions,
  type ContextKitOptionsPatch,
  contextKitSettings,
} from "./context-kit-settings.ts";

type OptionKey = keyof ContextKitOptionsPatch;

/** What the menu displays, read again after each change. */
export interface ContextKitMenuView {
  headline: readonly string[];
  /** Writable scopes; `project` only when the project is trusted. */
  scopes: readonly LayeredSettingScope[];
  /** Effective options after scope precedence. */
  settings: ContextKitOptions;
  sources: Readonly<Partial<Record<OptionKey, LayeredSettingSource>>>;
  /** Options that each scope authors itself. */
  authored: Readonly<Partial<Record<LayeredSettingScope, ContextKitOptionsPatch>>>;
}

/** The extension side of the menu: reads the view and applies one change. */
export interface ContextKitMenuHost {
  view(): ContextKitMenuView;
  /** Validates, persists, and applies one change; a rejection shows inline in the menu. */
  apply(scope: LayeredSettingScope, change: ContextKitChange): Promise<void>;
}

const onOffKeys = new Set<OptionKey>(["enabled", "background", "supersedeReads", "pruneEnabled"]);
const strategyValues = ["balanced", "frugal", "pi-summary"] as const;

const descriptions = {
  enabled:
    "Makes room in a long conversation so the agent keeps working. Off leaves only Pi's own cleanup.",
  threshold:
    "Where cleanup starts: a token count, a percentage such as 75% of each window, or pi for Pi's own limit.",
  strategy:
    "Summary notes writes notes ahead of time. Trim first shortens old outputs without a model call. pi-summary uses Pi's own summary.",
  methodOrder:
    "What to try, in order, when the context stays above the threshold after pruning. Overrides strategy.",
  background: "Writes the handoff note in the background, before the threshold.",
  supersedeReads: "Replaces the old copy of a file that the model read again.",
  progressRatio:
    "Each method must bring the context to this fraction of the threshold, or the next method runs.",
  pruneEnabled: "Clears old tool outputs and file reads from the context.",
  pruneProtectTokens: "Recent tokens that pruning leaves as they are.",
  pruneMinSavings: "Pruning runs only when it saves at least this many tokens.",
  pruneMinTokens: "Outputs smaller than this many tokens are never pruned.",
  shakeProtectTokens: "Recent tokens that shaking leaves as they are.",
  shakeMinSavings: "Shaking runs only when it saves at least this many tokens.",
  shakeBlockMinTokens: "Blocks smaller than this many tokens are never elided.",
} satisfies Record<OptionKey, string>;

const hints: Partial<Record<OptionKey, string>> = {
  threshold: "a token count, a percentage such as 75%, pi, or inherit",
  strategy: "balanced, frugal, pi-summary, or inherit",
  methodOrder: "handoff, shake and soft, comma-separated, or inherit",
  progressRatio: "a number above 0, up to 1, or inherit",
};

/** Display text of an option value; an unset value reads as inherit. */
function valueText(value: unknown): string {
  if (value === undefined) return "inherit";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number" || typeof value === "string") return String(value);
  throw new Error(`Unexpected option value: ${JSON.stringify(value)}`);
}

/** The JSON value that menu text stands for; the option schema validates it before any write. */
function menuValue(key: OptionKey, text: string): unknown {
  if (onOffKeys.has(key)) return text === "on" ? true : text === "off" ? false : text;
  if (key === "threshold" && /^\d+$/.test(text)) return Number(text);
  if (key === "methodOrder") return text.split(",").map((method) => method.trim());
  if (key === "strategy" || key === "threshold") return text;
  return Number(text);
}

/** One change typed or chosen in the menu for one scope. */
export function menuChange(
  key: string,
  text: string,
  scope: LayeredSettingScope,
): ContextKitChange {
  const optionKey = contextKitSettings.optionKey(key);
  const value = text.trim();
  if (value === "inherit") return { action: "inherit", key: optionKey };
  if (value === "") throw new Error(`Enter a value for ${optionKey}, or inherit`);
  return {
    action: "set",
    key: optionKey,
    patch: contextKitSettings.parseOptions({ [optionKey]: menuValue(optionKey, value) }, scope),
  };
}

/** Values a cycled row steps through; `inherit` removes the scope's own value. */
function cycleValues(key: OptionKey): readonly string[] {
  if (key === "strategy") return ["inherit", ...strategyValues];
  return ["inherit", "on", "off"];
}

function isCycleKey(key: OptionKey): boolean {
  return key === "strategy" || onOffKeys.has(key);
}

function optionRow(
  view: ContextKitMenuView,
  scope: LayeredSettingScope,
  id: string,
): SettingRow<ContextKitChange> {
  const key = contextKitSettings.optionKey(id);
  const source = view.sources[key] ?? "default";
  const fields = {
    id: key,
    label: source === "default" ? key : `${key} [${source}]`,
    description: descriptions[key],
  };
  if (isCycleKey(key)) {
    const own = view.authored[scope]?.[key];
    return {
      kind: "cycle",
      ...fields,
      values: cycleValues(key),
      own: own === undefined ? undefined : valueText(own),
      inEffect: effectiveWithSource(valueText(view.settings[key]), source),
      source,
      change: (value, scope) => menuChange(key, value, scope),
    };
  }
  return {
    kind: "input",
    ...fields,
    value: valueText(view.settings[key]),
    hint: hints[key] ?? "a whole number, 0 or more, or inherit",
    change: (text, scope) => menuChange(key, text, scope),
  };
}

/** The `/context-kit` settings menu: a Scope row, then one row per option. */
export function contextKitMenuSpec(
  host: ContextKitMenuHost,
): SettingsMenuSpec<ContextKitMenuView, ContextKitChange> {
  return {
    title: "Context cleanup settings",
    read: () => host.view(),
    rows: (view, scope) => [
      { kind: "scope" },
      ...contextKitSettings.optionKeys.map((id) => optionRow(view, scope, id)),
    ],
    apply: (scope, change) => host.apply(scope, change),
  };
}
