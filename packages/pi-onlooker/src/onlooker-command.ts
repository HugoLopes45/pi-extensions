import type { SettingsCommandSpec } from "pi-hl-utils/settings-command";

import { onlookerSettings, type OnlookerOptions } from "./onlooker-settings.js";

const usage =
  "Usage: /onlooker [on|off|status|inherit [key]|set <key> <JSON>] [--global|--project]; /onlooker alone opens settings";

/** The `/onlooker` grammar; validated patches cannot invent option keys. */
export const onlookerCommandSpec: SettingsCommandSpec<OnlookerOptions, keyof OnlookerOptions> = {
  usage,
  optionKey: onlookerSettings.optionKey,
  parseOptions: onlookerSettings.parseOptions,
  toggle: (enabled) => ({ key: "enabled", patch: { enabled } }),
};
