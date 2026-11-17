import { Type } from "typebox";
import { Value } from "typebox/value";

import { bounded } from "./text.js";

const coordinate = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const position = Type.Object({ line: coordinate, character: coordinate });
const reportSchema = Type.Object({
  version: Type.Optional(coordinate),
  diagnostics: Type.Array(
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
  ),
});

// Codes such as E0308 and reportMissingImports are short; other strings are dropped.
const stringCode = /^[\w.-]{1,64}$/u;

export function diagnosticResult(report: unknown, version: number) {
  if (!Value.Check(reportSchema, report)) throw new Error("Invalid diagnostic publication");
  if (report.version !== undefined && report.version !== version) {
    return { outcome: "superseded" as const, coverage: "none" as const };
  }
  const diagnostics = report.diagnostics.slice(0, 20).map((item) => {
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
    outcome: report.version === undefined ? ("partial" as const) : ("completed" as const),
    evidence:
      report.version === undefined
        ? ("unversioned_observation" as const)
        : ("revision_correlated" as const),
    source: "untrusted_lsp" as const,
    coverage: "observed" as const,
    projectComplete: false,
    receivedAt: Date.now(),
    reportedCount: report.diagnostics.length,
    omitted: report.diagnostics.length - diagnostics.length,
    diagnostics,
  };
}

type Report = Exclude<ReturnType<typeof diagnosticResult>, { outcome: "superseded" }>;
// An unversioned report is settled by the controller; raw reports keep their evidence value.
export type Observation = Omit<Report, "evidence"> & {
  evidence: Report["evidence"] | "settled_unversioned" | "unchanged_empty";
};

export function settledObservation(report: Report): Observation {
  return report.evidence === "revision_correlated"
    ? { ...report, evidence: "revision_correlated" }
    : { ...report, evidence: "settled_unversioned" };
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
    omitted: 0,
    diagnostics: [],
  };
}
