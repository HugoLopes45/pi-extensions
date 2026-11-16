import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject } from "typebox";
import { Value } from "typebox/value";

import { isRecord } from "./record.ts";

/** Native layer an authored option is written to or replayed from. */
export type LayeredSettingScope = "session" | "global" | "project";
/** Native layer supplying an effective option. */
export type LayeredSettingSource = "default" | LayeredSettingScope;
/** Authored scopes cached at startup/reload; a failed scope keeps its error until corrected. */
export interface LayeredSettingsLayers<Options> {
  global: Options | Error;
  project: Options | Error;
}
/** A validated authored mutation, independent of its persistence scope. */
export type LayeredSettingChange<Options> =
  | { action: "set"; key: keyof Options; patch: Options }
  | { action: "inherit"; key: keyof Options };

/**
 * Merges one layer's value for a key into the value accumulated from lower layers, instead of
 * replacing it. Called once per layer that authored the key, lowest precedence first.
 */
export type LayeredSettingMerge<Config, Key extends keyof Config> = (
  current: Config[Key],
  next: Config[Key],
  source: LayeredSettingScope,
) => Config[Key];
/** Per-key merge hooks; keys without one are replaced by the highest-precedence layer. */
export type LayeredSettingMerges<Config> = {
  [Key in keyof Config]?: LayeredSettingMerge<Config, Key>;
};
/** One layer's authored options, typed as the config values they set; `undefined` inherits. */
export type LayeredSettingLayer<Config> = {
  [Key in keyof Config]?: Config[Key] | undefined;
};

/** Input for {@link resolveLayeredOptions}. */
export interface ResolveLayeredOptionsInput<Config> {
  defaults: Config;
  /** Keys resolved, in order: each key is merged across every layer before the next key. */
  optionKeys: readonly (keyof Config)[];
  /** Layers lowest precedence first. */
  layers: readonly (readonly [LayeredSettingScope, LayeredSettingLayer<Config>])[];
  merge?: LayeredSettingMerges<Config> | undefined;
}
/** Effective settings and the source that supplied each key. */
export interface ResolvedLayeredSettings<Config> {
  settings: Config;
  sources: Record<string, LayeredSettingSource>;
}

/**
 * Resolve effective settings: defaults, then each layer in order. A key a layer authors replaces
 * the lower value, or is passed to that key's merge hook. A key authored as `undefined` inherits
 * like an absent one. Also reports which source supplied each key. Pure: validation and trust gating belong to whoever built the layers.
 */
export function resolveLayeredOptions<Config extends object>(
  input: ResolveLayeredOptionsInput<Config>,
): ResolvedLayeredSettings<Config> {
  const settings = structuredClone(input.defaults);
  const sources: Record<string, LayeredSettingSource> = {};
  const apply = <Key extends keyof Config>(
    key: Key,
    layer: LayeredSettingLayer<Config>,
    source: LayeredSettingScope,
  ): boolean => {
    if (!Object.hasOwn(layer, key)) return false;
    const next = layer[key];
    // An explicit `undefined` inherits, as an absent key does; merge hooks never receive it.
    if (next === undefined) return false;
    const hook = input.merge?.[key];
    settings[key] = hook ? hook(settings[key], next, source) : next;
    return true;
  };
  for (const key of input.optionKeys) {
    sources[String(key)] = "default";
    for (const [source, layer] of input.layers) {
      if (apply(key, layer, source)) sources[String(key)] = source;
    }
  }
  return { settings, sources };
}

/** Why {@link rewriteNamespaceDocument} refused a stored settings document. */
export type InvalidSettingsDocument = "malformed" | "root" | "namespace";

/** Input for {@link rewriteNamespaceDocument}. */
export interface RewriteNamespaceDocumentInput {
  /** Current file text, or `undefined` when the file is absent. */
  current: string | undefined;
  namespace: string;
  /** Keep an empty namespace instead of removing it. */
  keepEmpty?: boolean;
  /** Receives a copy of the stored namespace options and returns its replacement. */
  update: (options: Record<string, unknown>) => Record<string, unknown>;
  /** Builds the error thrown instead of overwriting a document that cannot be safely rewritten. */
  invalid: (reason: InvalidSettingsDocument, cause: Error | undefined) => Error;
}

/**
 * Rewrite one namespace of a Pi settings document, preserving every other setting. Strips a
 * leading BOM, refuses documents whose root or namespace is not an object, and removes an empty
 * namespace unless `keepEmpty` is set. Transport-independent: callers run it inside whichever
 * lock and writer they use.
 * @returns The replacement file text.
 */
export function rewriteNamespaceDocument(input: RewriteNamespaceDocumentInput): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse((input.current ?? "{}").replace(/^\uFEFF/, ""));
  } catch (cause) {
    throw input.invalid("malformed", cause instanceof Error ? cause : undefined);
  }
  if (!isRecord(parsed)) throw input.invalid("root", undefined);
  const stored = parsed[input.namespace];
  if (stored !== undefined && !isRecord(stored)) throw input.invalid("namespace", undefined);
  const updated = input.update({ ...stored });
  if (Object.keys(updated).length === 0 && !input.keepEmpty) delete parsed[input.namespace];
  else parsed[input.namespace] = updated;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Definition of one extension's layered settings namespace. `Options` is `Static<S>`; `Merge`
 * holds the per-key merge hooks and `Entry` the session entry type, both inferred.
 */
export interface LayeredSettingsDefinition<
  S extends TObject,
  Config extends object,
  Merge extends LayeredSettingMerges<Config> = {},
  Entry extends string | undefined = undefined,
> {
  /** Key under which authored options live in Pi's settings documents, e.g. `my-extension`. */
  namespace: string;
  /** Name used in error messages, e.g. `My extension`. */
  label: string;
  /** Schema of the authored options; every property must be optional so absent values inherit. */
  schema: S;
  defaults: Config;
  /** Custom session entry type holding `{ version: 1, overrides }`; omit for no session layer. */
  sessionEntryType?: Entry;
  /** Per-key merge hooks for keys that merge across layers instead of replacing. */
  merge?: Merge;
  /** Keep the namespace in a settings document after its last option is removed. */
  keepEmptyNamespace?: boolean;
  globalOnlyKeys?: readonly (keyof Static<S> & keyof Config & string)[];
}

/**
 * Option keys the definition's `Config` cannot hold: a key `Config` lacks, or a key whose authored
 * value type is not assignable to its `Config` type.
 */
export type LayeredSettingsConfigMismatch<Options, Config> = {
  [Key in keyof Options]-?: Key extends keyof Config
    ? [Exclude<Options[Key], undefined>] extends [Config[Key]]
      ? never
      : Key
    : Key;
}[keyof Options];
/** Adds a type error naming the mismatched keys; `unknown` (no constraint) when there are none. */
type LayeredSettingsConfigCheck<Options, Config> = [
  LayeredSettingsConfigMismatch<Options, Config>,
] extends [never]
  ? unknown
  : { configMismatch: LayeredSettingsConfigMismatch<Options, Config> };

/** The settings and session a layered read or write runs against. */
export interface LayeredSettingsSession {
  settingsManager: SettingsManager;
  sessionManager: Pick<SessionManager, "getBranch">;
}
/** Effective settings that survive unreadable layers; `invalid` lists each layer left out. */
export interface LenientLayeredSettings<Options, Config> extends ResolvedLayeredSettings<Config> {
  /** Usable authored options per scope; an unreadable scope or session entry authors nothing. */
  authored: { global: Options; project: Options; session: Options };
  /** Errors of the layers left out, in the order global, project, session. */
  invalid: Error[];
}

/** Settings operations for one namespace; `Options` is `Static<S>`. */
export interface LayeredSettings<S extends TObject, Config extends object> {
  /** Reject inherited or unknown property names before applying an authored change. */
  optionKey(input: string): keyof Static<S> & string;
  /** Schema property names, in schema order. */
  optionKeys: readonly (keyof Static<S> & string)[];
  /** Validate authored options read from, or about to be written to, a scope. */
  // Native settings contain arbitrary authored JSON; the schema validates it before use.
  parseOptions(value: unknown, source: LayeredSettingScope): Static<S>;
  /** Read Pi's stored layers, preserving configuration failures until corrected. */
  readLayers(manager: SettingsManager): LayeredSettingsLayers<Static<S>>;
  /** Resolve stored scopes without changing Pi's effective runtime overrides. */
  readSettings(
    session: LayeredSettingsSession,
    authored?: LayeredSettingsLayers<Static<S>>,
  ): ResolvedLayeredSettings<Config>;
  /** Use Pi's actual backend: its generic storage API is not exported. */
  writeSettings(
    manager: SettingsManager,
    scope: "global" | "project",
    change: LayeredSettingChange<Static<S>>,
    isCurrent: () => boolean,
  ): Promise<Static<S> | undefined>;
}
/** Layered settings with a session layer, so overrides can be replayed from a session branch. */
export interface SessionLayeredSettings<
  S extends TObject,
  Config extends object,
> extends LayeredSettings<S, Config> {
  /** Replay only the selected branch's last complete override snapshot. */
  readOverrides(manager: Pick<SessionManager, "getBranch">): Static<S>;
  /** Like `readSettings`, but an unreadable layer is left out and listed in `invalid`. */
  readSettingsLeniently(session: LayeredSettingsSession): LenientLayeredSettings<Static<S>, Config>;
  /** Write one change; a session change is appended to the session as an entry through `pi`. */
  writeChange(
    pi: Pick<ExtensionAPI, "appendEntry">,
    session: LayeredSettingsSession,
    scope: LayeredSettingScope,
    change: LayeredSettingChange<Static<S>>,
    isCurrent: () => boolean,
  ): Promise<Static<S> | undefined>;
}

const optionalText = Type.Union([Type.String(), Type.Undefined()]);
const storageSchema = Type.Object({
  withLock: Type.Function(
    [
      Type.Union([Type.Literal("global"), Type.Literal("project")]),
      Type.Function([optionalText], optionalText),
    ],
    Type.Void(),
  ),
});

/**
 * Define layered settings: authored options from Pi's global settings, trusted-project settings
 * and (optionally) session overrides, resolved over defaults with precedence
 * default < global < trusted project < session. The authored options are `Static<S>`; `Config`
 * must hold every option key, with a type the authored value is assignable to unless the key
 * has a merge hook. `readOverrides` exists only when `sessionEntryType` is given.
 */
export function defineLayeredSettings<
  S extends TObject,
  Config extends object,
  Merge extends LayeredSettingMerges<Config> = {},
>(
  definition: LayeredSettingsDefinition<S, Config, Merge> &
    LayeredSettingsConfigCheck<Static<S>, Config>,
): LayeredSettings<S, Config>;
export function defineLayeredSettings<
  S extends TObject,
  Config extends object,
  Merge extends LayeredSettingMerges<Config> = {},
>(
  definition: LayeredSettingsDefinition<S, Config, Merge, string> &
    LayeredSettingsConfigCheck<Static<S>, Config> & {
      sessionEntryType: string;
    },
): SessionLayeredSettings<S, Config>;
export function defineLayeredSettings<
  S extends TObject,
  Config extends object,
  Merge extends LayeredSettingMerges<Config>,
>(
  definition: LayeredSettingsDefinition<S, Config, Merge, string | undefined> &
    LayeredSettingsConfigCheck<Static<S>, Config>,
): LayeredSettings<S, Config> | SessionLayeredSettings<S, Config> {
  type Options = Static<S>;
  type OptionKey = keyof Options & keyof Config & string;
  type Layers = LayeredSettingsLayers<Options>;
  type Change = LayeredSettingChange<Options>;
  const {
    namespace,
    label,
    schema,
    defaults,
    sessionEntryType,
    merge,
    keepEmptyNamespace,
    globalOnlyKeys = [],
  } = definition;
  if (!Value.Check(schema, {}))
    throw new Error(`${label} settings schema must make every option optional`);
  const keySchema = Type.KeyOf(schema);
  const sessionSchema = Type.Object(
    { version: Type.Literal(1), overrides: schema },
    { additionalProperties: false },
  );

  function isOptionKey(input: string): input is OptionKey {
    return Value.Check(keySchema, input);
  }
  // Native settings contain arbitrary authored JSON; this guard validates it with the option schema before use.
  function isOptions(value: unknown): value is Options & LayeredSettingLayer<Config> {
    return Value.Check(schema, value);
  }
  // Session entry data is arbitrary JSON; this guard validates the versioned envelope before replay.
  function isSessionData(value: unknown): value is { version: 1; overrides: Options } {
    return Value.Check(sessionSchema, value);
  }

  function optionKey(input: string): OptionKey {
    if (!isOptionKey(input)) throw new Error(`Unknown ${label} option: ${input}`);
    return input;
  }
  const optionKeys = Object.keys(schema.properties).map(optionKey);

  // Every option is optional, so the empty layer must pass the schema.
  function checkedEmptyOptions(): Options {
    const empty: unknown = {};
    if (!isOptions(empty))
      throw new Error(`${label} settings schema must make every option optional`);
    return empty;
  }

  const empty = checkedEmptyOptions();
  /** The options of a layer that authored nothing. */
  function noOptions(): Options {
    return structuredClone(empty);
  }

  function checkScope(options: Options, source: LayeredSettingScope): void {
    if (source === "global") return;
    for (const key of globalOnlyKeys) {
      if (Object.hasOwn(options, key))
        throw new Error(
          `Invalid ${source} ${label} settings: ${key} is global-only; set it in global settings`,
        );
    }
  }

  // Native settings contain arbitrary authored JSON; the option schema validates it before use. SDK command tests exercise the boundary.
  function parseOptions(value: unknown, source: LayeredSettingScope): Options {
    if (value === undefined) return noOptions();
    if (!isOptions(value)) {
      const issue = Value.Errors(schema, value)[0];
      if (issue?.schemaPath === "#/additionalProperties")
        throw new Error(
          `Invalid ${source} ${label} settings: unknown option ${issue.instancePath.slice(1)}`,
        );
      throw new Error(
        `Invalid ${source} ${label} settings${issue?.instancePath ?? ""}: ${issue?.message ?? "invalid options"}`,
      );
    }
    checkScope(value, source);
    return structuredClone(value);
  }

  /** Replay only the selected branch's last complete override snapshot. */
  function readOverrides(manager: Pick<SessionManager, "getBranch">): Options {
    const entry = manager
      .getBranch()
      .findLast((item) => item.type === "custom" && item.customType === sessionEntryType);
    if (!entry || entry.type !== "custom") return noOptions();
    if (!isSessionData(entry.data)) throw new Error(`Invalid ${label} session settings`);
    checkScope(entry.data.overrides, "session");
    return structuredClone(entry.data.overrides);
  }

  /** Read Pi's stored layers, preserving configuration failures until corrected. */
  function readLayers(manager: SettingsManager): Layers {
    const layers: Layers = { global: noOptions(), project: noOptions() };
    for (const scope of ["global", "project"] as const) {
      try {
        if (scope === "project" && !manager.isProjectTrusted()) continue;
        const document =
          scope === "global" ? manager.getGlobalSettings() : manager.getProjectSettings();
        layers[scope] = parseOptions(
          Object.getOwnPropertyDescriptor(document, namespace)?.value,
          scope,
        );
      } catch (cause) {
        layers[scope] = cause instanceof Error ? cause : new Error(String(cause));
      }
    }
    return layers;
  }

  /** Resolve stored scopes without changing Pi's effective runtime overrides. */
  function readSettings(
    session: LayeredSettingsSession,
    authored = readLayers(session.settingsManager),
  ) {
    if (authored.global instanceof Error) throw authored.global;
    const project = session.settingsManager.isProjectTrusted() ? authored.project : noOptions();
    if (project instanceof Error) throw project;
    checkScope(project, "project");
    const layers: (readonly [LayeredSettingScope, LayeredSettingLayer<Config>])[] = [
      ["global", authored.global],
      ["project", project],
    ];
    if (sessionEntryType !== undefined)
      layers.push(["session", readOverrides(session.sessionManager)]);
    return resolveLayeredOptions<Config>({
      defaults,
      optionKeys,
      layers,
      merge,
    });
  }

  /** Use Pi's actual backend: its generic storage API is not exported. */
  async function writeSettings(
    manager: SettingsManager,
    scope: "global" | "project",
    change: Change,
    isCurrent: () => boolean,
  ): Promise<Options | undefined> {
    const untrusted = () => new Error(`${label} project settings require a trusted project`);
    if (scope === "project" && !manager.isProjectTrusted()) throw untrusted();
    const candidate: unknown = Object.getOwnPropertyDescriptor(manager, "storage")?.value;
    if (!Value.Check(storageSchema, candidate)) {
      throw new Error(
        `Unsupported Pi settings backend: ${label} cannot safely write scoped settings`,
      );
    }
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = candidate;
    await manager.flush();
    if (!isCurrent()) return undefined;
    if (scope === "project" && !manager.isProjectTrusted()) throw untrusted();
    let updated: Options | undefined;
    storage.withLock(scope, (current) =>
      rewriteNamespaceDocument({
        current,
        namespace,
        keepEmpty: keepEmptyNamespace === true,
        invalid: (reason, cause) =>
          reason === "malformed" && cause
            ? cause
            : new Error(`Invalid ${scope} settings document; refusing to overwrite it`),
        update: (stored) => {
          const next = { ...stored };
          if (change.action === "inherit") Reflect.deleteProperty(next, change.key);
          else Object.assign(next, change.patch);
          updated = parseOptions(next, scope);
          return next;
        },
      }),
    );
    return updated;
  }

  const settings: LayeredSettings<S, Config> = {
    optionKey,
    optionKeys,
    parseOptions,
    readLayers,
    readSettings,
    writeSettings,
  };
  if (sessionEntryType === undefined) return settings;
  const sessionEntry = sessionEntryType;

  /** Like `readSettings`; an unreadable layer or session entry is left out, and its error kept. */
  function readSettingsLeniently(
    session: LayeredSettingsSession,
  ): LenientLayeredSettings<Options, Config> {
    // Pi reads an unloadable file as empty, so only its recorded error shows the problem.
    const invalid: Error[] = session.settingsManager.drainErrors().map((entry) => entry.error);
    const layers = readLayers(session.settingsManager);
    const usable = (layer: Options | Error): Options => {
      if (!(layer instanceof Error)) return layer;
      invalid.push(layer);
      return noOptions();
    };
    const authored = {
      global: usable(layers.global),
      project: usable(layers.project),
    };
    let sessionManager = session.sessionManager;
    let overrides = noOptions();
    try {
      overrides = readOverrides(sessionManager);
    } catch (cause) {
      invalid.push(cause instanceof Error ? cause : new Error(String(cause)));
      // An unreadable session entry counts as no session overrides.
      sessionManager = { getBranch: () => [] };
    }
    const resolved = readSettings(
      { settingsManager: session.settingsManager, sessionManager },
      authored,
    );
    return {
      ...resolved,
      authored: { ...authored, session: overrides },
      invalid,
    };
  }

  /** Write one change unless the session changed first; a session change becomes the entry that replays it. */
  async function writeChange(
    pi: Pick<ExtensionAPI, "appendEntry">,
    session: LayeredSettingsSession,
    scope: LayeredSettingScope,
    change: LayeredSettingChange<Options>,
    isCurrent: () => boolean,
  ): Promise<Options | undefined> {
    if (!isCurrent()) return undefined;
    if (scope !== "session")
      return writeSettings(session.settingsManager, scope, change, isCurrent);
    const overrides = readOverrides(session.sessionManager);
    if (change.action === "inherit") Reflect.deleteProperty(overrides, change.key);
    else Object.assign(overrides, change.patch);
    const validated = parseOptions(overrides, "session");
    pi.appendEntry(sessionEntry, { version: 1, overrides: validated });
    return validated;
  }

  return { ...settings, readOverrides, readSettingsLeniently, writeChange };
}

/** The settings and session of a command or menu on `ctx`; the project file is read only when trusted. */
export function layeredSettingsSession(
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "sessionManager">,
): LayeredSettingsSession {
  return {
    settingsManager: SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    }),
    sessionManager: ctx.sessionManager,
  };
}

/** Scopes a settings menu offers: the project scope only while the project is trusted. */
export function layeredMenuScopes(
  manager: Pick<SettingsManager, "isProjectTrusted">,
): LayeredSettingScope[] {
  return manager.isProjectTrusted() ? ["session", "project", "global"] : ["session", "global"];
}
