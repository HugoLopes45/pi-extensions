import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  onlookerOptionKey,
  onlookerOptionKeys,
  parseOnlookerOptions,
  type OnlookerOptions,
} from "./onlooker-settings.js";
import {
  completeSettingsCommandArguments,
  parseSettingsCommand,
  type SettingsCommand,
} from "./utils/settings-command.js";

/** Native command completion values replace the entire argument prefix. */
export function completeOnlookerCommandArguments(prefix: string): AutocompleteItem[] {
  return completeSettingsCommandArguments(prefix, {
    words: ["on", "off", "status", "inherit", "set"],
    optionKeys: onlookerOptionKeys,
    parse: parseOnlookerCommand,
  });
}

const usage =
  "Usage: /onlooker [on|off|status|inherit [key]|set <key> <JSON>] [--global|--project]; /onlooker alone opens settings";

/** One parsed `/onlooker` command. */
export type OnlookerCommand = SettingsCommand<OnlookerOptions, keyof OnlookerOptions>;

/** Parse one configuration change; validated patches cannot invent option keys. */
export function parseOnlookerCommand(input: string): OnlookerCommand {
  return parseSettingsCommand(input, {
    usage,
    optionKey: onlookerOptionKey,
    parseOptions: parseOnlookerOptions,
    toggle: (enabled) => ({ key: "enabled", patch: { enabled } }),
  });
}
