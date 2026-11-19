import {
  effectiveWithSource,
  type SettingRow,
  type SettingsMenuSpec,
} from "pi-hl-utils/settings-menu";

import { formatOnlookerOption } from "./onlooker-rendering.js";
import {
  onlookerSettings,
  type OnlookerChange,
  type OnlookerOptions,
  type OnlookerSettingScope,
  type OnlookerSettingSource,
} from "./onlooker-settings.js";

/** Authored options at each writable scope. */
export type OnlookerScopedOptions = {
  [Scope in OnlookerSettingScope]: OnlookerOptions;
};

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

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Options edited by cycling the selected scope's own value; `inherit` removes it. */
const cycleValues = {
  enabled: ["inherit", "on", "off"],
  correct: ["inherit", "on", "off"],
  thinkingLevel: ["inherit", ...thinkingLevels],
} as const satisfies Record<string, readonly string[]>;
type CycleKey = keyof typeof cycleValues;

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
        ? {
            reviewEvery: value === "turn" || value === "request" ? value : Number(value),
          }
        : { [key]: value };
  return { action: "set", key, patch: onlookerSettings.parseOptions(patch, scope) };
}

function cycleRow(
  view: OnlookerMenuView,
  scope: OnlookerSettingScope,
  key: CycleKey,
  source: string,
  change: (value: string, scope: OnlookerSettingScope) => OnlookerChange,
): SettingRow<OnlookerChange> {
  const effective = cycleValue(key, view.settings);
  return {
    kind: "cycle",
    id: key,
    label: key,
    description: descriptions[key],
    values: cycleValues[key],
    own: cycleValue(key, view.authored[scope] ?? {}),
    inEffect: effective === undefined ? "observed agent" : effectiveWithSource(effective, source),
    source,
    change,
  };
}

function optionRow(
  view: OnlookerMenuView,
  scope: OnlookerSettingScope,
  key: keyof OnlookerOptions,
): SettingRow<OnlookerChange> {
  const source = view.sources[key] ?? "default";
  const label = source === "default" ? key : `${key} [${source}]`;
  const change = (value: string, changeScope: OnlookerSettingScope) =>
    parseOnlookerMenuValue(key, value, changeScope);
  switch (key) {
    case "enabled":
    case "correct":
    case "thinkingLevel":
      return cycleRow(view, scope, key, source, change);
    case "model":
      return {
        kind: "pick",
        id: key,
        label,
        description: descriptions[key],
        value: view.settings.model ?? "inherit",
        choices: view.models,
        change,
      };
    default:
      return {
        kind: "input",
        id: key,
        label,
        description: descriptions[key],
        value: formatOnlookerOption(view.settings, key),
        hint:
          key === "name"
            ? "A display name, or inherit"
            : "turn, request, a number of turns, or inherit",
        change,
      };
  }
}

/** The `/onlooker` settings menu: the Resume action while paused, a Scope row, then the options. */
export function onlookerMenuSpec(
  host: OnlookerMenuHost,
): SettingsMenuSpec<OnlookerMenuView, OnlookerChange> {
  return {
    title: "Onlooker settings",
    read: () => host.view(),
    rows: (view, scope) => [
      ...(view.paused
        ? [
            {
              kind: "action" as const,
              id: "resume",
              label: "Resume",
              description: "Retry the Paused Onlooker with its current settings",
              value: "retry",
              run: () => host.resume(),
            },
          ]
        : []),
      { kind: "scope" },
      ...onlookerSettings.optionKeys.map((id) =>
        optionRow(view, scope, onlookerSettings.optionKey(id)),
      ),
    ],
    apply: (scope, change) => host.apply(scope, change),
  };
}
