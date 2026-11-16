import type { SettingsCommandSpec } from "pi-hl-utils/settings-command";

import { type ContextKitOptionsPatch, contextKitSettings } from "./context-kit-settings.ts";

const usage =
  "Usage: /context-kit [on|off|status|inherit [key]|set <key> <JSON>] [--global|--project]; /context-kit alone opens settings";

/** The `/context-kit` grammar; validated patches cannot invent option keys. */
export const contextKitCommandSpec: SettingsCommandSpec<
  ContextKitOptionsPatch,
  keyof ContextKitOptionsPatch
> = {
  usage,
  optionKey: contextKitSettings.optionKey,
  parseOptions: contextKitSettings.parseOptions,
  toggle: (enabled) => ({ key: "enabled", patch: { enabled } }),
};
