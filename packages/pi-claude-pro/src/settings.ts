import { defineLayeredSettings, type LayeredSettingChange } from "pi-hl-utils/layered-settings";
import { Type, type Static } from "typebox";

const windowSchema = Type.Union([Type.Literal("5h"), Type.Literal("7d"), Type.Literal("Fable")]);

/** Authored options; every key is optional so absent values inherit. */
export const claudeProOptionsSchema = Type.Object(
  {
    footer: Type.Optional(Type.Boolean()),
    warnAt: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    extraUsageWarning: Type.Optional(Type.Boolean()),
    // The version reaches the user agent and the billing header, so only version numbers pass.
    claudeCodeVersion: Type.Optional(Type.String({ pattern: "^\\d+(\\.\\d+)+$" })),
    usageCacheSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    footerWindows: Type.Optional(Type.Array(windowSchema, { minItems: 1 })),
  },
  { additionalProperties: false },
);

/** Authored options; absent values inherit rather than taking a default. */
export type ClaudeProOptions = Static<typeof claudeProOptionsSchema>;
/** Fully defaulted options; an unset pin keeps the bundled Claude Code version. */
export type ClaudeProConfig = Required<Omit<ClaudeProOptions, "claudeCodeVersion">> &
  Pick<ClaudeProOptions, "claudeCodeVersion">;
/** A validated authored mutation, independent of its persistence scope. */
export type ClaudeProChange = LayeredSettingChange<ClaudeProOptions>;

/** The settings when no layer authors a value. */
export const claudeProDefaults: ClaudeProConfig = {
  footer: true,
  warnAt: 80,
  extraUsageWarning: true,
  usageCacheSeconds: 30,
  footerWindows: ["5h", "7d", "Fable"],
};

/** The `claude-pro` settings: validation, option keys, reads of each layer and writes. */
export const claudeProSettings = defineLayeredSettings({
  namespace: "claude-pro",
  label: "Claude Pro",
  schema: claudeProOptionsSchema,
  defaults: claudeProDefaults,
  sessionEntryType: "pi-claude-pro-settings",
});
