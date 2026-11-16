import { isAbsolute } from "node:path";

import { defineLayeredSettings, type LayeredSettingsSession } from "pi-hl-utils/layered-settings";
import { Type, type Static } from "typebox";

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
    servers: Type.Optional(serversSchema),
  },
  { additionalProperties: false },
);

export type ServerConfig = Static<typeof serverSchema>;
export type ServerFamily = keyof Static<typeof serversSchema>;
export type LspSettings = Required<Static<typeof schema>>;
export type LspOptions = Static<typeof schema>;

const defaults: LspSettings = {
  enabled: false,
  name: "HL LSP",
  allowProjectExecution: false,
  timeoutMs: 5000,
  servers: {},
};

export const lspSettings = defineLayeredSettings({
  namespace: "hl-lsp",
  label: "HL LSP",
  schema,
  defaults,
  sessionEntryType: "hl-lsp-settings",
  globalOnlyKeys: ["servers", "allowProjectExecution", "timeoutMs"],
});

export function readSettings(session: LayeredSettingsSession) {
  if (session.settingsManager.drainErrors().length)
    throw new Error("Pi settings could not be read; correct them before enabling LSP");
  return lspSettings.readSettings(session);
}
