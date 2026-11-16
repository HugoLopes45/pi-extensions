import {
  defineLayeredSettings,
  type LayeredSettingChange,
  type ResolvedLayeredSettings,
} from "pi-hl-utils/layered-settings";
import { type Static, Type } from "typebox";

import {
  type ConfigResult,
  type Method,
  type Strategy,
  STRATEGIES,
  type Threshold,
  writesHandoff,
} from "./config.ts";

const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const PERCENT = "^(0*100(\\.0+)?|0*[1-9]\\d?(\\.\\d+)?|0+\\.\\d*[1-9]\\d*)%$";

const method = Type.Union([Type.Literal("handoff"), Type.Literal("shake"), Type.Literal("soft")]);
const strategy = Type.Union([
  Type.Literal("balanced"),
  Type.Literal("frugal"),
  Type.Literal("pi-summary"),
]);
const count = Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_COUNT }));

/** Authored options under `context-kit` in Pi's settings; every key is optional so absent values inherit. */
export const contextKitOptionsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    threshold: Type.Optional(
      Type.Union([
        Type.Integer({ minimum: 1, maximum: MAX_COUNT }),
        Type.String({ pattern: PERCENT }),
        Type.Literal("pi"),
      ]),
    ),
    strategy: Type.Optional(strategy),
    methodOrder: Type.Optional(Type.Array(method)),
    background: Type.Optional(Type.Boolean()),
    supersedeReads: Type.Optional(Type.Boolean()),
    progressRatio: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1 })),
    pruneEnabled: Type.Optional(Type.Boolean()),
    pruneProtectTokens: count,
    pruneMinSavings: count,
    pruneMinTokens: count,
    shakeProtectTokens: count,
    shakeMinSavings: count,
    shakeBlockMinTokens: count,
  },
  { additionalProperties: false },
);

/** Layered options. `threshold` is a token count, a percentage such as `"75%"`, or `"pi"`. */
export interface ContextKitOptions {
  enabled: boolean;
  threshold: number | string;
  strategy: Strategy;
  /** Absent: the strategy's method order. */
  methodOrder?: Method[];
  /** Absent: the strategy's background setting. */
  background?: boolean;
  supersedeReads: boolean;
  progressRatio: number;
  pruneEnabled: boolean;
  pruneProtectTokens: number;
  pruneMinSavings: number;
  pruneMinTokens: number;
  shakeProtectTokens: number;
  shakeMinSavings: number;
  shakeBlockMinTokens: number;
}

export const contextKitDefaults: ContextKitOptions = {
  enabled: true,
  threshold: "75%",
  strategy: "balanced",
  supersedeReads: true,
  progressRatio: 0.8,
  pruneEnabled: true,
  pruneProtectTokens: 40_000,
  pruneMinSavings: 20_000,
  pruneMinTokens: 50,
  shakeProtectTokens: 16_000,
  shakeMinSavings: 4_000,
  shakeBlockMinTokens: 400,
};

/** Authored options as Pi's settings store them: every key optional, so absent values inherit. */
export type ContextKitOptionsPatch = Static<typeof contextKitOptionsSchema>;
export type ContextKitChange = LayeredSettingChange<ContextKitOptionsPatch>;

export const contextKitSettings = defineLayeredSettings({
  namespace: "context-kit",
  label: "context-kit",
  schema: contextKitOptionsSchema,
  defaults: contextKitDefaults,
  sessionEntryType: "pi-context-kit-settings",
  // The namespace marks a scope as moved, so the 0.3 block is not imported again.
  keepEmptyNamespace: true,
});

/** The schema accepts only these three forms, so each one maps without a failure path. */
function thresholdOf(value: number | string): Threshold {
  if (typeof value === "number") return { tokens: value };
  return value === "pi" ? "pi" : { percent: Number.parseFloat(value) };
}

/** Maps resolved options to the runtime config, with a problem for each ineffective combination. */
export function contextKitConfig(
  resolved: ResolvedLayeredSettings<ContextKitOptions>,
): ConfigResult {
  const { settings, sources } = resolved;
  const { strategy } = settings;
  const customOrder = sources.methodOrder !== "default";
  const methodOrder = [...new Set(settings.methodOrder ?? STRATEGIES[strategy].methodOrder)];
  const background = settings.background ?? STRATEGIES[strategy].background;
  const problems: string[] = [];
  if (sources.strategy !== "default" && customOrder)
    problems.push(
      `strategy "${strategy}" does not set the method order, because methodOrder replaces it`,
    );
  if (customOrder && sources.background !== "default" && background && !writesHandoff(methodOrder))
    problems.push(
      'background has no effect, because "handoff" is not before "soft" in the method order',
    );
  return {
    config: {
      enabled: settings.enabled,
      threshold: thresholdOf(settings.threshold),
      strategy,
      methodOrder,
      customOrder,
      background,
      supersedeReads: settings.supersedeReads,
      prune: {
        enabled: settings.pruneEnabled,
        protectTokens: settings.pruneProtectTokens,
        minSavings: settings.pruneMinSavings,
        minTokens: settings.pruneMinTokens,
      },
      shake: {
        protectTokens: settings.shakeProtectTokens,
        minSavings: settings.shakeMinSavings,
        blockMinTokens: settings.shakeBlockMinTokens,
      },
      progressRatio: settings.progressRatio,
    },
    problems,
  };
}
