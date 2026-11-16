import type {
  AgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { onlookerNameSchema } from "./onlooker-contract.js";
import {
  defineLayeredSettings,
  type LayeredSettingChange,
  type LayeredSettingsLayers,
} from "./utils/layered-settings.js";

/** Authored Onlooker options; every key is optional so absent values inherit. */
export const onlookerOptionsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    name: Type.Optional(onlookerNameSchema),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinkingLevel: Type.Optional(
      Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
    reviewEvery: Type.Optional(
      Type.Union([
        Type.Literal("turn"),
        Type.Literal("request"),
        Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      ]),
    ),
    correct: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Authored options; absent values inherit rather than disabling their setting. */
export type OnlookerOptions = Static<typeof onlookerOptionsSchema>;
/** Fully defaulted options; an absent model follows the Observed Agent. */
export type OnlookerConfig = Required<Omit<OnlookerOptions, "model">> &
  Pick<OnlookerOptions, "model">;
/** Native settings/session layer an authored change is written to. */
export const onlookerSettingScopeSchema = Type.Union([
  Type.Literal("session"),
  Type.Literal("global"),
  Type.Literal("project"),
]);
export type OnlookerSettingScope = Static<typeof onlookerSettingScopeSchema>;
/** Native settings/session layer supplying an effective option. */
export const onlookerSettingSourceSchema = Type.Union([
  Type.Literal("default"),
  onlookerSettingScopeSchema,
]);
export type OnlookerSettingSource = Static<typeof onlookerSettingSourceSchema>;

export const onlookerPrompt = [
  "You review another coding agent's work from its transcript.",
  "",
  "Report only these findings about work the agent already did:",
  "- a violation of the user's instructions, or scope drift; the agent's choice of tool for a step is not a violation",
  "- a repeated failure the agent does not address",
  "- a completion claim the evidence does not support",
  "- low-risk cleanup or simplification worth making",
  "",
  "Report a missing step only after the agent stops or claims it is done.",
  "",
  "Before you report a finding, check that:",
  "- no newer turn fixed or explained it",
  "- a claim about tool output matches the arguments the agent passed",
  "",
  "Advice about what to do next is not a finding; give it only when the agent asks you a question.",
].join("\n");

const defaults: OnlookerConfig = {
  enabled: false,
  name: "Onlooker",
  // Fixed and independent of the observed agent: review quality is worth `high`, while
  // inheriting `xhigh`/`max` mostly adds output-priced reasoning tokens.
  thinkingLevel: "high" as const,
  reviewEvery: "turn" as const,
  correct: true,
};

/**
 * Absolute ceilings for the seed and session sizes, in the Onlooker model's reported tokens. Every
 * Review re-reads the whole Onlooker Session, and those cache reads were the largest Onlooker cost,
 * so the session's size, not the model's window, sets the per-Review floor. Native compaction is a
 * separate uncached call that summarizes each Onlooker token about once, so its amortized cost per
 * Review barely depends on the cap while the read cost grows with it: modeled per-Review cost is
 * about 11K input-token equivalents at a 200K cap and 6–7K at 80–100K. The seed ceiling is half
 * the session ceiling so a seed always fits within half the session. The price is more frequent
 * compaction and less verbatim recall of older evidence. Seed and session sizes are measured in
 * reported tokens (Token calibration), so these ceilings are real tokens.
 */
const seedCeiling = 50_000;
const sessionCeiling = 100_000;
/** Pi's branch summarization uses the same fallback for models without a declared window. */
const fallbackWindow = 128_000;

/**
 * Context Seed token budget: a quarter of the Onlooker model's context window, at most 50K. The
 * seed is resent with every inference of the first Review and stays in the Onlooker Session, so the
 * rest is left for the Onlooker Prompt, investigation, and later incremental Reviews, and it stays
 * at most half the Onlooker Session cap.
 */
export function seedBudget(contextWindow: number | undefined): number {
  return Math.min(Math.floor((contextWindow || fallbackWindow) / 4), seedCeiling);
}

/**
 * Onlooker Session size above which a completed Review compacts it: half the Onlooker model's
 * context window, at most 100K. That is room for a full Context Seed plus as much again for
 * incremental Reviews, so a seed alone never forces compaction, while staying far below Pi's own
 * threshold (the window less its reserve), where every Review re-reads almost a full window.
 * Compaction re-sends the history it summarizes, so a much lower cap compacts often (Pi keeps
 * `compaction.keepRecentTokens` of recent history, so a cap near it compacts almost every Review).
 */
export function sessionTokenLimit(contextWindow: number | undefined): number {
  return Math.min(Math.floor((contextWindow || fallbackWindow) / 2), sessionCeiling);
}

const layered = defineLayeredSettings({
  namespace: "onlooker",
  label: "Onlooker",
  schema: onlookerOptionsSchema,
  defaults,
  sessionEntryType: "pi-onlooker-settings",
});

export const onlookerOptionKeys = layered.optionKeys;

// Native settings contain arbitrary authored JSON; the shared layered-settings schema check validates it before use. SDK command tests exercise the boundary.
export function parseOnlookerOptions(
  value: unknown,
  source: OnlookerSettingScope,
): OnlookerOptions {
  return layered.parseOptions(value, source);
}

/** Reject inherited or unknown property names before applying an authored change. */
export function onlookerOptionKey(input: string): keyof OnlookerOptions {
  return layered.optionKey(input);
}

/** Replay only the selected branch's last complete override snapshot. */
export function readOnlookerOverrides(manager: Pick<SessionManager, "getBranch">): OnlookerOptions {
  return layered.readOverrides(manager);
}

/** Authored scopes cached at startup/reload and updated after this extension's own writes. */
export type OnlookerLayers = LayeredSettingsLayers<OnlookerOptions>;
/** A validated authored mutation, independent of its persistence scope. */
export type OnlookerChange = LayeredSettingChange<OnlookerOptions>;
/** An applied change as recorded for confirmation; `options` is empty when the key inherits. */
export const onlookerAppliedChangeSchema = Type.Object({
  scope: onlookerSettingScopeSchema,
  key: Type.KeyOf(onlookerOptionsSchema),
  options: onlookerOptionsSchema,
});
export type OnlookerAppliedChange = Static<typeof onlookerAppliedChangeSchema>;

/** Read Pi's stored layers, preserving configuration failures until corrected. */
export function readOnlookerLayers(manager: SettingsManager): OnlookerLayers {
  return layered.readLayers(manager);
}

/** Resolve stored scopes without changing Pi's effective runtime overrides. */
export function readOnlookerSettings(
  session: Pick<AgentSession, "settingsManager" | "sessionManager">,
  authored = readOnlookerLayers(session.settingsManager),
) {
  return layered.readSettings(session, authored);
}

/** Use Pi's actual backend: its generic storage API is not exported. */
export function writeOnlookerSettings(
  manager: SettingsManager,
  scope: "global" | "project",
  change: OnlookerChange,
  isCurrent: () => boolean,
): Promise<OnlookerOptions | undefined> {
  return layered.writeSettings(manager, scope, change, isCurrent);
}
