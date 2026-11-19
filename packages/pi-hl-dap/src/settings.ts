import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveLayeredOptions } from "pi-hl-utils/layered-settings";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { DAP_ADAPTER_PRESETS, type DapChannelPolicy, type DapOutputExitReport } from "./presets.js";

const DEFAULT_DAP_TIMEOUTS = {
  executionMs: 30_000,
  requestMs: 10_000,
  shutdownMs: 5_000,
  startupMs: 10_000,
} as const;

const NonEmptyStringSchema = Type.String({ minLength: 1 });
// Node timers clamp a longer delay to 1 ms.
const PositiveMillisecondsSchema = Type.Integer({
  minimum: 1,
  maximum: 2_147_483_647,
});
export const JsonValueSchema = Type.Unknown();
/** A JSON object of opaque adapter arguments, as a Launch Profile holds them. */
export const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);
const EnvironmentSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));
const DapChannelPolicySchema = Type.Object(
  {
    sessions: Type.Union([Type.Literal("root"), Type.Literal("promoted")]),
    firstSessionIsPrimary: Type.Optional(Type.Boolean()),
    targetIdKey: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);
const DapAdapterDefinitionSchema = Type.Object(
  {
    args: Type.Optional(Type.Array(Type.String())),
    channels: Type.Optional(DapChannelPolicySchema),
    command: NonEmptyStringSchema,
    environment: Type.Optional(EnvironmentSchema),
    preset: Type.Optional(NonEmptyStringSchema),
    transport: Type.Unknown(),
  },
  { additionalProperties: false },
);
const DapTcpTransportSchema = Type.Object(
  {
    host: Type.Optional(NonEmptyStringSchema),
    port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65_535 })),
    type: Type.Literal("tcp"),
  },
  { additionalProperties: false },
);
const DapLaunchProfileSchema = Type.Object(
  {
    adapter: NonEmptyStringSchema,
    adapterID: Type.Optional(NonEmptyStringSchema),
    arguments: JsonObjectSchema,
  },
  { additionalProperties: false },
);
const SettingsDocumentSchema = Type.Object({
  hlDap: Type.Optional(JsonValueSchema),
});

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type DapAdapterDefinitionWire = Static<typeof DapAdapterDefinitionSchema>;
type DapLaunchProfileWire = Static<typeof DapLaunchProfileSchema>;
type DapTimeoutName = keyof typeof DEFAULT_DAP_TIMEOUTS;
type DapTimeoutOverrides = Partial<Record<DapTimeoutName, number>>;
type SettingsScope = "global" | "project";

const DAP_TIMEOUT_NAMES: readonly DapTimeoutName[] = [
  "executionMs",
  "requestMs",
  "shutdownMs",
  "startupMs",
];

/** Describes the configured stdio or TCP connection used by one Debug Adapter. */
export type DapAdapterTransport =
  | { readonly type: "stdio" }
  | { readonly host: string; readonly port: number; readonly type: "tcp" };

/** Preset data resolved into an Adapter Definition; the core reads only these fields. */
export interface ResolvedDapAdapterPreset {
  /** Adapter ID the preset declares for `initialize`; a Launch Profile `adapterID` wins. */
  readonly adapterID?: string;
  /** Channel policy: preset defaults overridden field by field by the Adapter Definition. */
  readonly channels?: DapChannelPolicy;
  /** Debuggee exit report for an adapter that never sends `exited`. */
  readonly outputExitReport?: DapOutputExitReport;
}

/** Contains the parsed process and transport values for one configured Debug Adapter. */
export interface DapAdapterDefinition extends ResolvedDapAdapterPreset {
  readonly args: readonly string[];
  readonly command: string;
  /** Environment overrides applied when the Debug Adapter starts; null removes an inherited key. */
  readonly environment: Readonly<Record<string, string | null>>;
  readonly id: string;
  readonly transport: DapAdapterTransport;
}

/** Contains opaque launch arguments associated with one configured Debug Adapter. */
export interface DapLaunchProfile {
  /** Explicit `initialize.adapterID`; wins over the preset and the launch argument `type`. */
  readonly adapterID?: string;
  readonly adapterId: string;
  readonly arguments: Static<typeof JsonObjectSchema>;
  readonly id: string;
}

/** Contains timeout budgets in milliseconds for Debug Adapter lifecycle operations. */
export interface DapTimeouts {
  readonly executionMs: number;
  readonly requestMs: number;
  readonly shutdownMs: number;
  readonly startupMs: number;
}

/** Reports resolved trusted DAP configuration while quarantining invalid map entries. */
export interface ResolvedDapSettings {
  readonly adapters: ReadonlyMap<string, DapAdapterDefinition>;
  readonly profiles: ReadonlyMap<string, DapLaunchProfile>;
  readonly timeouts: DapTimeouts;
  readonly warnings: readonly string[];
}

/** Reads Pi's already trust-filtered global and project settings documents. */
export interface DapSettingsReader {
  getGlobalSettings(): DapSettingsDocumentInput;
  getProjectSettings(): DapSettingsDocumentInput;
}

/** Minimal Pi settings document input carrying the extension-owned optional `hlDap` value. */
type PiSettingsDocument = ReturnType<SettingsManager["getGlobalSettings"]>;

/** Pi's core settings type or a test boundary document carrying the extension-owned `hlDap` value. */
export type DapSettingsDocumentInput = PiSettingsDocument | { readonly hlDap?: JsonValue };

type ParsedDapAdapter =
  | { readonly kind: "excluded" }
  | {
      readonly kind: "valid";
      readonly value: DapAdapterDefinitionWire;
      readonly transport: DapAdapterTransport;
    };
type ParsedDapProfile =
  | { readonly kind: "excluded" }
  | {
      readonly kind: "valid";
      readonly scope: SettingsScope;
      readonly value: DapLaunchProfileWire;
    };

interface ParsedDapLayer {
  readonly adapters: ReadonlyMap<string, ParsedDapAdapter>;
  readonly profiles: ReadonlyMap<string, ParsedDapProfile>;
  readonly timeouts: DapTimeoutOverrides;
  readonly warnings: readonly string[];
}

interface ParsedDapAdapterTransport {
  readonly transport?: DapAdapterTransport;
  readonly warning?: string;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return Value.Check(JsonObjectSchema, value);
}

function schemaValidationWarning(
  schema:
    | typeof DapAdapterDefinitionSchema
    | typeof DapTcpTransportSchema
    | typeof DapLaunchProfileSchema
    | typeof PositiveMillisecondsSchema,
  value: unknown,
  prefix: string,
): string {
  const error = Value.Errors(schema, value)[0];
  const path = error?.instancePath.replaceAll("/", ".") ?? "";
  const field =
    error?.keyword === "additionalProperties"
      ? error.params.additionalProperties[0]
      : error?.keyword === "required"
        ? error.params.requiredProperties[0]
        : undefined;
  const fieldSuffix = field === undefined ? "" : `.${field}`;
  return `${prefix}${path}${fieldSuffix}: ${error?.message ?? "invalid settings"}`;
}

function parseDapAdapterTransport(transport: unknown, path: string): ParsedDapAdapterTransport {
  if (transport === "stdio") return { transport: { type: "stdio" } };
  if (!Value.Check(DapTcpTransportSchema, transport)) {
    return {
      warning: schemaValidationWarning(DapTcpTransportSchema, transport, `${path}.transport`),
    };
  }
  return {
    transport: {
      host: transport.host ?? "127.0.0.1",
      port: transport.port ?? 0,
      type: "tcp",
    },
  };
}

function parseDapAdapter(adapter: JsonValue, path: string, warnings: string[]): ParsedDapAdapter {
  if (adapter === null) {
    return { kind: "excluded" };
  }
  if (!Value.Check(DapAdapterDefinitionSchema, adapter)) {
    warnings.push(schemaValidationWarning(DapAdapterDefinitionSchema, adapter, path));
    return { kind: "excluded" };
  }
  const parsedTransport = parseDapAdapterTransport(adapter.transport, path);
  if (parsedTransport.transport === undefined) {
    warnings.push(parsedTransport.warning ?? `${path}.transport: invalid transport`);
    return { kind: "excluded" };
  }
  if (
    parsedTransport.transport.type === "stdio" &&
    (adapter.args ?? []).some((argument) => argument.includes("$PORT"))
  ) {
    warnings.push(`${path}.args: $PORT requires TCP transport`);
    return { kind: "excluded" };
  }
  if (adapter.preset !== undefined && !Object.hasOwn(DAP_ADAPTER_PRESETS, adapter.preset)) {
    warnings.push(`${path}.preset: unknown adapter preset "${adapter.preset}"`);
    return { kind: "excluded" };
  }
  return {
    kind: "valid",
    transport: parsedTransport.transport,
    value: adapter,
  };
}

function parseDapAdapters(
  value: JsonValue | undefined,
  scope: SettingsScope,
): Pick<ParsedDapLayer, "adapters" | "warnings"> {
  const adapters = new Map<string, ParsedDapAdapter>();
  const warnings: string[] = [];
  if (value === undefined) return { adapters, warnings };
  if (!isJsonObject(value)) {
    return {
      adapters,
      warnings: [`${scope} hlDap.adapters: expected a JSON object`],
    };
  }

  for (const [id, adapter] of Object.entries(value)) {
    const path = `${scope} hlDap.adapters.${id}`;
    if (!Value.Check(NonEmptyStringSchema, id)) {
      warnings.push(`${scope} hlDap.adapters: Adapter Definition ID must be a non-empty string`);
      continue;
    }
    adapters.set(id, parseDapAdapter(adapter, path, warnings));
  }
  return { adapters, warnings };
}

function parseDapProfiles(
  value: JsonValue | undefined,
  scope: SettingsScope,
): Pick<ParsedDapLayer, "profiles" | "warnings"> {
  const profiles = new Map<string, ParsedDapProfile>();
  const warnings: string[] = [];
  if (value === undefined) return { profiles, warnings };
  if (!isJsonObject(value)) {
    return {
      profiles,
      warnings: [`${scope} hlDap.profiles: expected a JSON object`],
    };
  }

  for (const [id, profile] of Object.entries(value)) {
    const path = `${scope} hlDap.profiles.${id}`;
    if (!Value.Check(NonEmptyStringSchema, id)) {
      warnings.push(`${scope} hlDap.profiles: Launch Profile ID must be a non-empty string`);
      continue;
    }
    if (profile === null) {
      profiles.set(id, { kind: "excluded" });
      continue;
    }
    if (!Value.Check(DapLaunchProfileSchema, profile)) {
      warnings.push(schemaValidationWarning(DapLaunchProfileSchema, profile, path));
      profiles.set(id, { kind: "excluded" });
      continue;
    }
    profiles.set(id, { kind: "valid", scope, value: profile });
  }
  return { profiles, warnings };
}

function isDapTimeoutName(name: string): name is DapTimeoutName {
  return DAP_TIMEOUT_NAMES.some((timeoutName) => timeoutName === name);
}

function parseDapTimeouts(
  value: JsonValue | undefined,
  scope: SettingsScope,
): Pick<ParsedDapLayer, "timeouts" | "warnings"> {
  const timeouts: DapTimeoutOverrides = {};
  const warnings: string[] = [];
  if (value === undefined) return { timeouts, warnings };
  if (!isJsonObject(value)) {
    return {
      timeouts,
      warnings: [`${scope} hlDap.timeouts: expected a JSON object`],
    };
  }
  for (const [name, timeout] of Object.entries(value)) {
    if (!isDapTimeoutName(name)) {
      warnings.push(`${scope} hlDap.timeouts.${name}: unknown field`);
      continue;
    }
    if (!Value.Check(PositiveMillisecondsSchema, timeout)) {
      warnings.push(
        schemaValidationWarning(
          PositiveMillisecondsSchema,
          timeout,
          `${scope} hlDap.timeouts.${name}`,
        ),
      );
      continue;
    }
    timeouts[name] = timeout;
  }
  return { timeouts, warnings };
}

function readDapLayer(settings: DapSettingsDocumentInput, scope: SettingsScope): ParsedDapLayer {
  if (!Value.Check(SettingsDocumentSchema, settings)) {
    return {
      adapters: new Map(),
      profiles: new Map(),
      timeouts: {},
      warnings: [`${scope} settings: expected a JSON object`],
    };
  }
  if (settings.hlDap === undefined) {
    return {
      adapters: new Map(),
      profiles: new Map(),
      timeouts: {},
      warnings: [],
    };
  }
  if (!isJsonObject(settings.hlDap)) {
    return {
      adapters: new Map(),
      profiles: new Map(),
      timeouts: {},
      warnings: [`${scope} hlDap: expected a JSON object`],
    };
  }

  const unknownWarnings = Object.keys(settings.hlDap)
    .filter((field) => field !== "adapters" && field !== "profiles" && field !== "timeouts")
    .map((field) => `${scope} hlDap.${field}: unknown field`);
  const parsedAdapters = parseDapAdapters(settings.hlDap.adapters, scope);
  const parsedProfiles = parseDapProfiles(settings.hlDap.profiles, scope);
  const parsedTimeouts = parseDapTimeouts(settings.hlDap.timeouts, scope);
  return {
    adapters: parsedAdapters.adapters,
    profiles: parsedProfiles.profiles,
    timeouts: parsedTimeouts.timeouts,
    warnings: [
      ...unknownWarnings,
      ...parsedAdapters.warnings,
      ...parsedProfiles.warnings,
      ...parsedTimeouts.warnings,
    ],
  };
}

/** Filter only after overlay so excluded project entries still mask global entries. */
function validDapEntries<Entry extends { readonly kind: "excluded" } | { readonly kind: "valid" }>(
  entries: ReadonlyMap<string, Entry>,
): ReadonlyMap<string, Extract<Entry, { readonly kind: "valid" }>> {
  type Valid = Extract<Entry, { readonly kind: "valid" }>;
  return new Map(
    [...entries]
      .filter((entry): entry is [string, Valid] => entry[1].kind === "valid")
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

/** Merge the named preset's data with the Adapter Definition's own channel policy. */
function resolveDapAdapterPreset(
  presetId: string | undefined,
  channels: DapChannelPolicy | undefined,
): ResolvedDapAdapterPreset {
  const preset = presetId === undefined ? undefined : DAP_ADAPTER_PRESETS[presetId];
  const presetChannels = preset?.channels;
  const resolvedChannels =
    presetChannels === undefined
      ? channels
      : channels === undefined
        ? presetChannels
        : { ...presetChannels, ...channels };
  return {
    ...(preset?.adapterID === undefined ? {} : { adapterID: preset.adapterID }),
    ...(resolvedChannels === undefined ? {} : { channels: resolvedChannels }),
    ...(preset?.outputExitReport === undefined
      ? {}
      : { outputExitReport: preset.outputExitReport }),
  };
}

function resolveDapAdapter(
  id: string,
  adapter: Extract<ParsedDapAdapter, { readonly kind: "valid" }>,
): DapAdapterDefinition {
  return {
    args: [...(adapter.value.args ?? [])],
    command: adapter.value.command,
    environment: { ...adapter.value.environment },
    id,
    transport: adapter.transport,
    ...resolveDapAdapterPreset(adapter.value.preset, adapter.value.channels),
  };
}

/** Resolve global and trusted-project DAP settings, preserving valid entries around warnings. */
export function readSettings(reader: DapSettingsReader): ResolvedDapSettings {
  const globalLayer = readDapLayer(reader.getGlobalSettings(), "global");
  const projectLayer = readDapLayer(reader.getProjectSettings(), "project");
  const { settings } = resolveLayeredOptions<ParsedDapLayer>({
    defaults: globalLayer,
    optionKeys: ["adapters", "profiles", "timeouts", "warnings"],
    layers: [["project", projectLayer]],
    merge: {
      adapters: (current, next) => new Map([...current, ...next]),
      profiles: (current, next) => new Map([...current, ...next]),
      timeouts: (current, next) => ({ ...current, ...next }),
      warnings: (current, next) => [...current, ...next],
    },
  });
  const mergedAdapters = validDapEntries(settings.adapters);
  const mergedProfiles = validDapEntries(settings.profiles);
  const adapters = new Map(
    [...mergedAdapters].map(([id, adapter]) => [id, resolveDapAdapter(id, adapter)]),
  );
  const profiles = new Map<string, DapLaunchProfile>();
  const referenceWarnings: string[] = [];
  for (const [id, profile] of mergedProfiles) {
    if (!adapters.has(profile.value.adapter)) {
      referenceWarnings.push(
        `${profile.scope} hlDap.profiles.${id}.adapter: adapter "${profile.value.adapter}" is not configured`,
      );
      continue;
    }
    profiles.set(id, {
      ...(profile.value.adapterID === undefined ? {} : { adapterID: profile.value.adapterID }),
      adapterId: profile.value.adapter,
      arguments: structuredClone(profile.value.arguments),
      id,
    });
  }

  return {
    adapters,
    profiles,
    timeouts: { ...DEFAULT_DAP_TIMEOUTS, ...settings.timeouts },
    warnings: [...settings.warnings, ...referenceWarnings],
  };
}
