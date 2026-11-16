import { Type, type Static } from "typebox";

export const onlookerNameSchema = Type.String({
  minLength: 1,
  pattern: "^(?!\\s)(?!.*[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]).*\\S$",
});

/** Intervention severities, in ascending urgency. */
export const onlookerSeveritySchema = Type.Union(
  [Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")],
  {
    description:
      "blocker: unsound work to reconsider now, such as an unsupported completion claim. concern: a material risk or a likely wrong direction. nit: low-risk cleanup, simplification, or style.",
  },
);
export type OnlookerSeverity = Static<typeof onlookerSeveritySchema>;

/** What a finding cites from the Review Evidence it was judged against. */
export const onlookerEvidenceSchema = Type.Object(
  {
    refs: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
        maxItems: 8,
        description:
          "`ref` values of the tool calls or results in the evidence that support the finding",
      }),
    ),
    quote: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1000,
        description: "A short verbatim quote from the evidence that supports the finding",
      }),
    ),
  },
  { additionalProperties: false },
);
export type OnlookerEvidence = Static<typeof onlookerEvidenceSchema>;

const findingFields = {
  severity: onlookerSeveritySchema,
  message: Type.String({
    minLength: 1,
    maxLength: 4000,
    description: "The problem and why it matters, in one or two sentences",
  }),
};

/**
 * One finding; also the journaled details of an Intervention message. `evidence` is absent from
 * Interventions recorded before findings cited evidence, and from legacy single-finding reports.
 */
export const onlookerFindingSchema = Type.Object(
  {
    ...findingFields,
    evidence: Type.Optional(onlookerEvidenceSchema),
    name: Type.Optional(onlookerNameSchema),
  },
  { additionalProperties: false },
);
export type OnlookerFinding = Static<typeof onlookerFindingSchema>;

const knownCost = Type.Union([Type.Number(), Type.Null()]);
/**
 * Native usage of one kind of Onlooker work: operations, model calls, tokens, cost and wall time.
 * `cost` stays null once any operation's cost was unknown.
 */
const onlookerWorkSpendSchema = Type.Object({
  count: Type.Number(),
  calls: Type.Number(),
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cost: knownCost,
  ms: Type.Number(),
});
export type OnlookerWorkSpend = Static<typeof onlookerWorkSpendSchema>;

/**
 * What the Onlooker spent since it was loaded, across Onlooker Session rebuilds, and the evidence
 * it did not see in full: Context Seeds sent, observed messages they omitted or shortened, and
 * tool results capped by `maxToolResultChars`.
 */
export const onlookerSpendSchema = Type.Object({
  reviews: onlookerWorkSpendSchema,
  consultations: onlookerWorkSpendSchema,
  compactions: onlookerWorkSpendSchema,
  evidence: Type.Object({
    seeds: Type.Number(),
    omittedMessages: Type.Number(),
    shortenedMessages: Type.Number(),
    cappedResults: Type.Number(),
  }),
});
export type OnlookerSpend = Static<typeof onlookerSpendSchema>;

/** A finding as `onlooker_report` accepts it: every finding cites its evidence. */
export const onlookerReportFindingSchema = Type.Object(
  {
    ...findingFields,
    evidence: Type.Object(onlookerEvidenceSchema.properties, {
      additionalProperties: false,
      description: "At least one `ref` or a quote; a finding without valid evidence is dropped",
    }),
  },
  { additionalProperties: false },
);

/**
 * Findings an Onlooker dropped since it started, by reason: findings citing no or unknown
 * evidence, and Reviews ended without findings by invalid reports.
 */
export const onlookerDroppedFindingsSchema = Type.Object({
  unsupported: Type.Number(),
  invalidReviews: Type.Number(),
});
export type OnlookerDroppedFindings = Static<typeof onlookerDroppedFindingsSchema>;

/** Observer lifecycle state reported by its `status`. */
export const onlookerObserverStateSchema = Type.Union([
  Type.Literal("disabled"),
  Type.Literal("armed"),
  Type.Literal("reviewing"),
  Type.Literal("consulting"),
  Type.Literal("paused"),
]);
export type OnlookerObserverState = Static<typeof onlookerObserverStateSchema>;

/** State recorded in status entries; private Onlooker Sessions cannot host an Onlooker. */
export const onlookerStateSchema = Type.Union([
  onlookerObserverStateSchema,
  Type.Literal("private"),
]);
export type OnlookerState = Static<typeof onlookerStateSchema>;
