import type { LayeredSettingScope, LayeredSettingSource } from "pi-hl-utils/layered-settings";
import {
  effectiveWithSource,
  type SettingRow,
  type SettingsMenuSpec,
} from "pi-hl-utils/settings-menu";

import {
  claudeProSettings,
  type ClaudeProChange,
  type ClaudeProConfig,
  type ClaudeProOptions,
} from "./settings.ts";

/** Everything the menu displays, read fresh after each change. */
export interface ClaudeProMenuView {
  /** Usage status lines shown above the settings. */
  headline: readonly string[];
  /** Writable scopes; project only when trusted. */
  scopes: readonly LayeredSettingScope[];
  /** Effective options after scope precedence. */
  settings: ClaudeProConfig;
  sources: Readonly<Record<string, LayeredSettingSource>>;
  /** Options authored at each scope; an absent scope authors nothing. */
  authored: Readonly<Partial<Record<LayeredSettingScope, ClaudeProOptions | undefined>>>;
}

/** The extension's settings authority behind the menu. */
export interface ClaudeProMenuHost {
  view(): ClaudeProMenuView;
  /** Validate and persist one change; rejects with a user-facing message. */
  apply(scope: LayeredSettingScope, change: ClaudeProChange): Promise<void>;
}

type CycleKey = "footer" | "extraUsageWarning";

const cycleValues: readonly string[] = ["inherit", "on", "off"];

const cycleDescriptions: Record<CycleKey, string> = {
  footer: "Shows your plan usage below the editor",
  extraUsageWarning: "Notifies once per session when a request is billed as extra usage",
};

const textDescriptions: Record<Exclude<keyof ClaudeProOptions, CycleKey>, string> = {
  warnAt: "Usage percentage from which the footer uses the warning color",
  claudeCodeVersion: "Claude Code version to send; inherit learns it from Anthropic",
  usageCacheSeconds: "Seconds a usage reply is reused; 0 looks it up on every request",
  footerWindows: 'Limits the footer shows, as a JSON array such as ["5h", "7d"]',
};

function isCycleKey(key: keyof ClaudeProOptions): key is CycleKey {
  return key === "footer" || key === "extraUsageWarning";
}

/** A cycled option's own value at one scope as cycle text; undefined when that scope inherits it. */
function ownText(options: ClaudeProOptions | undefined, key: CycleKey): string | undefined {
  const value = options?.[key];
  if (value === undefined) return undefined;
  return value ? "on" : "off";
}

/** The change that sets a cycled option to `value`, one of `cycleValues`. */
function cycleChange(key: CycleKey, value: string): ClaudeProChange {
  if (value === "inherit") return { action: "inherit", key };
  const enabled = value === "on";
  const patch: ClaudeProOptions =
    key === "footer" ? { footer: enabled } : { extraUsageWarning: enabled };
  return { action: "set", key, patch };
}

/** A typed value: JSON when the text parses as JSON, otherwise the text itself. */
function typedValue(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}

/** The change a typed value makes; schema validation rejects values the option cannot take. */
function typedChange(
  key: keyof ClaudeProOptions,
  text: string,
  scope: LayeredSettingScope,
): ClaudeProChange {
  const value = text.trim();
  if (value === "inherit") return { action: "inherit", key };
  if (value === "") throw new Error(`Enter a value for ${key}, or inherit`);
  return {
    action: "set",
    key,
    patch: claudeProSettings.parseOptions({ [key]: typedValue(value) }, scope),
  };
}

function formatValue(value: unknown): string {
  return value === undefined ? "unset" : JSON.stringify(value);
}

function optionRow(
  view: ClaudeProMenuView,
  scope: LayeredSettingScope,
  id: string,
): SettingRow<ClaudeProChange> {
  const key = claudeProSettings.optionKey(id);
  const source = view.sources[key] ?? "default";
  if (isCycleKey(key))
    return {
      kind: "cycle",
      id: key,
      label: key,
      description: cycleDescriptions[key],
      values: cycleValues,
      own: ownText(view.authored[scope], key),
      inEffect: effectiveWithSource(view.settings[key] ? "on" : "off", source),
      source,
      change: (value) => cycleChange(key, value),
    };
  return {
    kind: "input",
    id: key,
    label: key,
    description: textDescriptions[key],
    value: effectiveWithSource(formatValue(view.settings[key]), source),
    hint: "a value, or inherit",
    change: (text, scope) => typedChange(key, text, scope),
  };
}

/** The `/claude-pro` settings menu: a Scope row, then one row per option. */
export function claudeProMenuSpec(
  host: ClaudeProMenuHost,
): SettingsMenuSpec<ClaudeProMenuView, ClaudeProChange> {
  return {
    title: "Claude Pro settings",
    read: () => host.view(),
    rows: (view, scope) => [
      { kind: "scope" },
      ...claudeProSettings.optionKeys.map((id) => optionRow(view, scope, id)),
    ],
    apply: (scope, change) => host.apply(scope, change),
  };
}
