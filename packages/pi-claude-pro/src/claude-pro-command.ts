import type { SettingsCommandSpec } from "pi-hl-utils/settings-command";

import { claudeProSettings, type ClaudeProOptions } from "./settings.ts";

const usage =
  "Usage: /claude-pro [status|on|off|inherit [key]|set <key> <JSON>] [--global|--project]; /claude-pro alone opens settings";

/** The `/claude-pro` grammar: `on` and `off` set the footer, and validated patches cannot invent keys. */
export const claudeProCommandSpec: SettingsCommandSpec<ClaudeProOptions, keyof ClaudeProOptions> = {
  usage,
  optionKey: claudeProSettings.optionKey,
  parseOptions: claudeProSettings.parseOptions,
  toggle: (footer) => ({ key: "footer", patch: { footer } }),
};
