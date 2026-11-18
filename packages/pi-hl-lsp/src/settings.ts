import { isAbsolute } from "node:path";

import {
  defineLayeredSettings,
  escapeControls,
  type LayeredSettingsSession,
} from "pi-hl-utils/layered-settings";
import type { SettingsCommandSpec } from "pi-hl-utils/settings-command";
import { Type, type Static } from "typebox";

import { presetFor } from "./presets.js";
import { bounded } from "./text.js";

const extensionSchema = Type.String({
  minLength: 2,
  maxLength: 32,
  pattern: "^\\.[a-z0-9_+-]{1,31}$",
});
const jsonObject = Type.Record(Type.String(), Type.Unknown());
const serverSchema = Type.Object(
  {
    command: Type.Refine(
      Type.String({ minLength: 1, maxLength: 4096 }),
      isAbsolute,
      () => "Server commands must use absolute paths",
    ),
    args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 32 }),
    fileTypes: Type.Optional(Type.Array(extensionSchema, { minItems: 1, maxItems: 32 })),
    rootMarkers: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: 255,
          pattern: "^[*]?[^*/\\\\\\u0000-\\u001f\\u007f]+$",
        }),
        { minItems: 1, maxItems: 32 },
      ),
    ),
    dependencyDirs: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          maxLength: 255,
          pattern: "^[^*/\\\\\\u0000-\\u001f\\u007f]+$",
        }),
        { minItems: 1, maxItems: 32 },
      ),
    ),
    languageId: Type.Optional(
      Type.Record(extensionSchema, Type.String({ minLength: 1, maxLength: 64 })),
    ),
    initializationOptions: Type.Optional(jsonObject),
    settings: Type.Optional(jsonObject),
  },
  { additionalProperties: false },
);

// A custom server has no preset, so it must declare the file types and markers that route to it.
function undeclaredCustom(servers: Record<string, ServerConfig>): string | undefined {
  for (const [name, config] of Object.entries(servers))
    if (!presetFor(name) && !(config.fileTypes && config.rootMarkers))
      return `Custom server "${name}" needs fileTypes and rootMarkers`;
  return undefined;
}

function fileTypesOf(name: string, config: ServerConfig): readonly string[] {
  return config.fileTypes ?? presetFor(name)?.fileTypes ?? [];
}

function sharedFileType(servers: Record<string, ServerConfig>): string | undefined {
  const owners = new Map<string, string>();
  for (const [name, config] of Object.entries(servers))
    for (const fileType of fileTypesOf(name, config)) {
      const owner = owners.get(fileType);
      if (owner !== undefined && owner !== name)
        return `Servers "${owner}" and "${name}" both claim "${fileType}"; remove one fileTypes entry`;
      owners.set(fileType, name);
    }
  return undefined;
}

function serverProblem(servers: Record<string, ServerConfig>): string | undefined {
  return undeclaredCustom(servers) ?? sharedFileType(servers);
}

const serverName = Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" });
const serversSchema = Type.Refine(
  Type.Record(serverName, serverSchema, {
    additionalProperties: false,
    maxProperties: 32,
  }),
  (servers) => serverProblem(servers) === undefined,
  (servers) => serverProblem(servers) ?? "Servers are invalid",
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
    // Detected languages the setup dialog no longer offers at startup.
    ignoredLanguages: Type.Optional(
      Type.Array(serverName, {
        maxItems: 64,
        uniqueItems: true,
      }),
    ),
  },
  { additionalProperties: false },
);

export type ServerConfig = Static<typeof serverSchema>;
export type LspSettings = Required<Static<typeof schema>>;
export type LspOptions = Static<typeof schema>;

const defaults: LspSettings = {
  enabled: false,
  name: "HL LSP",
  allowProjectExecution: false,
  timeoutMs: 5000,
  formatOnWrite: false,
  servers: {},
  ignoredLanguages: [],
};

export const lspSettings = defineLayeredSettings({
  namespace: "hl-lsp",
  label: "HL LSP",
  schema,
  defaults,
  sessionEntryType: "hl-lsp-settings",
  globalOnlyKeys: [
    "servers",
    "allowProjectExecution",
    "timeoutMs",
    "formatOnWrite",
    "ignoredLanguages",
  ],
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
