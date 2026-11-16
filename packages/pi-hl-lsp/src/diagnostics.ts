import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

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
    const message = truncateHead(item.message, { maxBytes: 512, maxLines: 8 });
    return {
      message: message.content,
      truncated: message.truncated,
      code: typeof item.code === "number" ? item.code : undefined,
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

export type Observation = Exclude<ReturnType<typeof diagnosticResult>, { outcome: "superseded" }>;
