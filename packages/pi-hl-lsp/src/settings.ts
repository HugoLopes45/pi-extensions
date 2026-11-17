import { isAbsolute } from "node:path";

import {
  defineLayeredSettings,
  escapeControls,
  type LayeredSettingsSession,
} from "pi-hl-utils/layered-settings";
import type { SettingsCommandSpec } from "pi-hl-utils/settings-command";
import { Type, type Static } from "typebox";

import { bounded } from "./text.js";

const serverSchema = Type.Object(
  {
    command: Type.Refine(
      Type.String({ minLength: 1, maxLength: 4096 }),
      isAbsolute,
      () => "Server commands must use absolute paths",
    ),
    args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 32 }),
  },
  { additionalProperties: false },
);
const serversSchema = Type.Object(
  {
    typescript: Type.Optional(serverSchema),
    python: Type.Optional(serverSchema),
    rust: Type.Optional(serverSchema),
  },
  { additionalProperties: false },
);
const schema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    name: Type.Optional(
      Type.Refine(
        Type.String({
          minLength: 1,
          maxLength: 80,
          pattern: "^[^\\u0000-\\u001f\\u007f]+$",
        }),
        (name) => name.trim() === name,
        () => "Display name must not start or end with whitespace",
      ),
    ),
    allowProjectExecution: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000 })),
    formatOnWrite: Type.Optional(Type.Boolean()),
    servers: Type.Optional(serversSchema),
  },
  { additionalProperties: false },
);

export type ServerConfig = Static<typeof serverSchema>;
export type ServerFamily = keyof Static<typeof serversSchema>;
// Every server key, in the order status lists them.
export const serverFamilies: readonly ServerFamily[] = ["typescript", "python", "rust"];
export type LspSettings = Required<Static<typeof schema>>;
export type LspOptions = Static<typeof schema>;

const defaults: LspSettings = {
  enabled: false,
  name: "HL LSP",
  allowProjectExecution: false,
  timeoutMs: 5000,
  formatOnWrite: false,
  servers: {},
};

export const lspSettings = defineLayeredSettings({
  namespace: "hl-lsp",
  label: "HL LSP",
  schema,
  defaults,
  sessionEntryType: "hl-lsp-settings",
  globalOnlyKeys: ["servers", "allowProjectExecution", "timeoutMs", "formatOnWrite"],
});

export function readSettings(session: LayeredSettingsSession) {
  const errors = session.settingsManager.drainErrors();
  const [first] = errors;
  if (first) {
    const prefix = "Pi settings could not be read: ";
    const suffix = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
    const detail = escapeControls(`${first.path ?? first.scope}: ${first.error.message}`);
    const budget = 512 - Buffer.byteLength(prefix + suffix);
    const shown = bounded(detail, { maxBytes: budget, maxLines: 1 });
    throw new Error(`${prefix}${shown.content}${suffix}`);
  }
  return lspSettings.readSettings(session);
}

export const commandSpec: SettingsCommandSpec<LspOptions, keyof LspOptions> = {
  usage:
    "Usage: /hl-lsp [on|off|status|inherit [key]|set <key> <JSON>] [--global|--project]; /hl-lsp alone opens settings",
  optionKey: lspSettings.optionKey,
  parseOptions: lspSettings.parseOptions,
  toggle: (enabled) => ({ key: "enabled", patch: { enabled } }),
};
