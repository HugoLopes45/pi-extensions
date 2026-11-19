import {
  layeredMenuScopes,
  type LayeredSettingChange,
  type LayeredSettingScope,
  type LayeredSettingsSession,
} from "pi-hl-utils/layered-settings";
import {
  effectiveWithSource,
  type SettingRow,
  type SettingsMenuSpec,
  type SettingsMenuView,
} from "pi-hl-utils/settings-menu";

import { lspSettings, type LspOptions } from "./settings.js";

export type LspChange = LayeredSettingChange<LspOptions>;
type MenuKey = "enabled" | "name" | "timeoutMs" | "allowProjectExecution" | "formatOnWrite";
type View = ReturnType<typeof lspSettings.readSettingsLeniently> & SettingsMenuView;

function change(key: MenuKey, text: string, scope: LayeredSettingScope): LspChange {
  if (text === "inherit") return { action: "inherit", key };
  const value =
    key === "name"
      ? text
      : key === "timeoutMs"
        ? Number(text)
        : text === "on"
          ? true
          : text === "off"
            ? false
            : text;
  return {
    action: "set",
    key,
    patch: lspSettings.parseOptions({ [key]: value }, scope),
  };
}

const descriptions = {
  enabled: "Enable the language tools. Project trust and global execution consent remain required.",
  name: "Display name, at most 80 characters without control characters or surrounding whitespace.",
  timeoutMs: "Request timeout in milliseconds, from 100 to 60000.",
  allowProjectExecution:
    "Allow approved servers to execute project-controlled code in trusted projects.",
  formatOnWrite:
    "Format files that an edit or write changed, when the server offers formatting; this rewrites other lines too.",
};

function row(view: View, scope: LayeredSettingScope, key: MenuKey): SettingRow<LspChange> {
  const source = view.sources[key] ?? "default";
  const fields = {
    id: key,
    label: key,
    description: descriptions[key],
    change: (text: string, target: LayeredSettingScope) => change(key, text, target),
  };
  if (key === "name" || key === "timeoutMs")
    return {
      kind: "input",
      ...fields,
      value: String(view.settings[key]),
      hint: "Enter a value, or inherit",
    };
  const own = view.authored[scope][key];
  return {
    kind: "cycle",
    ...fields,
    values: ["inherit", "on", "off"],
    own: own === undefined ? undefined : own ? "on" : "off",
    inEffect: effectiveWithSource(view.settings[key] ? "on" : "off", source),
    source,
  };
}

export function menuSpec(host: {
  session(): LayeredSettingsSession;
  apply(scope: LayeredSettingScope, change: LspChange): Promise<void>;
}): SettingsMenuSpec<View, LspChange> {
  return {
    title: "HL LSP settings",
    read() {
      const session = host.session();
      // Only the menu uses partial settings; controller construction requires strict validation.
      const view = lspSettings.readSettingsLeniently(session);
      return {
        ...view,
        scopes: layeredMenuScopes(session.settingsManager),
        headline: view.invalid.map((error) => error.message),
      };
    },
    rows(view, scope) {
      const keys: MenuKey[] = ["enabled", "name"];
      if (scope === "global") keys.push("timeoutMs", "allowProjectExecution", "formatOnWrite");
      return [{ kind: "scope" }, ...keys.map((key) => row(view, scope, key))];
    },
    apply: host.apply,
  };
}
