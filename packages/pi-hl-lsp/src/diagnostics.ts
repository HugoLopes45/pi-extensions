import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { bounded } from "./text.js";

const coordinate = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const position = Type.Object({ line: coordinate, character: coordinate });
const diagnosticList = Type.Array(
  Type.Object({
    message: Type.String(),
    range: Type.Object({ start: position, end: position }),
    severity: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    code: Type.Optional(
      Type.Union([
        Type.String(),
        Type.Integer({
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        }),
      ]),
    ),
  }),
  { maxItems: 10000 },
);
const reportSchema = Type.Object({
  version: Type.Optional(coordinate),
  diagnostics: diagnosticList,
});
// Only full reports: this client sends no previousResultId, so an unchanged report is a protocol error.
const pullSchema = Type.Object({
  kind: Type.Literal("full"),
  items: diagnosticList,
});
const shownLimit = 20;
const errorCount = (list: readonly { severity?: number | undefined }[]) =>
  list.filter((item) => item.severity === 1).length;

// Codes such as E0308 and reportMissingImports are short; other strings are dropped.
const stringCode = /^[\w.-]{1,64}$/u;

export function diagnosticResult(report: unknown, version: number) {
  if (!Value.Check(reportSchema, report)) throw new Error("Invalid diagnostic publication");
  if (report.version !== undefined && report.version !== version) {
    return { outcome: "superseded" as const, coverage: "none" as const };
  }
  return observationOf(report.diagnostics, report.version === undefined);
}

// A pull answers for the version the controller sent, so its observation is correlated by construction.
export function pullResult(report: unknown) {
  if (!Value.Check(pullSchema, report)) throw new Error("Invalid diagnostic pull report");
  return observationOf(report.items, false);
}

function observationOf(list: Static<typeof diagnosticList>, unversioned: boolean) {
  // Errors go first, so the shown part, which the post-edit check compares, keeps as many as it can.
  const ordered = list.toSorted((a, b) => Number(b.severity === 1) - Number(a.severity === 1));
  const diagnostics = ordered.slice(0, shownLimit).map((item) => {
    const { start, end } = item.range;
    if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
      throw new Error("Invalid diagnostic range");
    }
    const message = bounded(item.message, { maxBytes: 512, maxLines: 8 });
    return {
      message: message.content,
      truncated: message.truncated,
      code: typeof item.code === "string" && !stringCode.test(item.code) ? undefined : item.code,
      severity: item.severity,
      range: {
        start: { line: start.line, character: start.character },
        end: { line: end.line, character: end.character },
      },
    };
  });
  return {
    outcome: unversioned ? ("partial" as const) : ("completed" as const),
    evidence: unversioned ? ("unversioned_observation" as const) : ("revision_correlated" as const),
    source: "untrusted_lsp" as const,
    coverage: "observed" as const,
    projectComplete: false,
    receivedAt: Date.now(),
    reportedCount: list.length,
    reportedErrors: errorCount(list),
    omitted: list.length - diagnostics.length,
    diagnostics,
  };
}

type Report = Exclude<ReturnType<typeof diagnosticResult>, { outcome: "superseded" }>;
// An unversioned report is settled by the controller; raw reports keep their evidence value.
export type Observation = Omit<Report, "evidence"> & {
  evidence: Report["evidence"] | "settled_unversioned" | "unchanged_empty" | "server_busy";
};

export function settledObservation(report: Report): Observation {
  return report.evidence === "revision_correlated"
    ? { ...report, evidence: "revision_correlated" }
    : { ...report, evidence: "settled_unversioned" };
}

// Pull and push can report the same problem, so each (range, severity, code, message) is kept once.
export function unionObservation(pulled: Observation, pushed: Observation): Observation {
  const seen = new Set<string>();
  const unique = [...pulled.diagnostics, ...pushed.diagnostics].filter((item) => {
    const key = JSON.stringify([item.range, item.severity, item.code, item.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // A duplicate beyond the shown part of both lists is not seen, so reportedCount can be high.
  const shared = pulled.diagnostics.length + pushed.diagnostics.length - unique.length;
  const reportedCount = pulled.reportedCount + pushed.reportedCount - shared;
  const sharedErrors =
    errorCount(pulled.diagnostics) + errorCount(pushed.diagnostics) - errorCount(unique);
  const diagnostics = unique.slice(0, shownLimit);
  return {
    ...pulled,
    reportedCount,
    reportedErrors: pulled.reportedErrors + pushed.reportedErrors - sharedErrors,
    omitted: reportedCount - diagnostics.length,
    diagnostics,
  };
}

// Reported when a work-done progress token is still open at the deadline, so no answer settled.
export function busyObservation(): Observation {
  return {
    outcome: "partial",
    evidence: "server_busy",
    source: "untrusted_lsp",
    coverage: "observed",
    projectComplete: false,
    receivedAt: Date.now(),
    reportedCount: 0,
    reportedErrors: 0,
    omitted: 0,
    diagnostics: [],
  };
}

// Reported when the server stays silent after a clean edit, so the diagnostics did not change.
export function unchangedObservation(): Observation {
  return {
    outcome: "partial",
    evidence: "unchanged_empty",
    source: "untrusted_lsp",
    coverage: "observed",
    projectComplete: false,
    receivedAt: Date.now(),
    reportedCount: 0,
    reportedErrors: 0,
    omitted: 0,
    diagnostics: [],
  };
}
