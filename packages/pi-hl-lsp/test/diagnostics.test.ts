import { expect, it } from "vitest";

import { diagnosticResult, pullResult, unionObservation } from "../src/diagnostics.js";

const finding = {
  message: "Wrong type",
  code: 2322,
  severity: 1,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
};

it("returns useful unversioned findings without certification", () => {
  expect(diagnosticResult({ diagnostics: [finding] }, 1)).toMatchObject({
    outcome: "partial",
    evidence: "unversioned_observation",
    projectComplete: false,
    diagnostics: [{ code: 2322 }],
  });
});

it("keeps a short string code and drops one with spaces or over 64 characters", () => {
  expect(diagnosticResult({ diagnostics: [{ ...finding, code: "E0308" }] }, 1)).toMatchObject({
    diagnostics: [{ code: "E0308" }],
  });
  expect(diagnosticResult({ diagnostics: [{ ...finding, code: "bad code" }] }, 1)).toMatchObject({
    diagnostics: [{ code: undefined }],
  });
  expect(
    diagnosticResult({ diagnostics: [{ ...finding, code: "x".repeat(65) }] }, 1),
  ).toMatchObject({ diagnostics: [{ code: undefined }] });
});

it("reads a full pull report as an observation correlated to the requested version", () => {
  expect(pullResult({ kind: "full", items: [finding] })).toMatchObject({
    outcome: "completed",
    evidence: "revision_correlated",
    reportedCount: 1,
    diagnostics: [{ code: 2322 }],
  });
});

it("rejects an unchanged pull report, which needs a previousResultId this client never sends", () => {
  expect(() => pullResult({ kind: "unchanged", resultId: "1" })).toThrow(
    "Invalid diagnostic pull report",
  );
});

it("keeps an unversioned empty report partial and uncertified", () => {
  expect(diagnosticResult({ diagnostics: [] }, 1)).toMatchObject({
    outcome: "partial",
    projectComplete: false,
    diagnostics: [],
  });
});

it("distinguishes correlated empty observations from stale publications", () => {
  expect(diagnosticResult({ version: 2, diagnostics: [] }, 2)).toMatchObject({
    outcome: "completed",
    diagnostics: [],
    projectComplete: false,
  });
  expect(diagnosticResult({ version: 1, diagnostics: [] }, 2)).toMatchObject({
    outcome: "superseded",
  });
});

it("bounds output and discloses omissions", () => {
  const result = diagnosticResult(
    {
      diagnostics: Array.from({ length: 30 }, () => ({
        ...finding,
        message: "x".repeat(2000),
      })),
    },
    1,
  );
  expect(result).toMatchObject({ reportedCount: 30, omitted: 10 });
  expect(JSON.stringify(result).length).toBeLessThan(16000);
});

it("counts each error once when pull and push report it", () => {
  const other = { ...finding, message: "Other error" };
  const warnings = Array.from({ length: 20 }, () => ({
    ...finding,
    severity: 2,
  }));
  const pulled = pullResult({ kind: "full", items: [...warnings, finding] });
  const pushed = pullResult({ kind: "full", items: [finding, other] });
  expect(unionObservation(pulled, pushed)).toMatchObject({ reportedErrors: 2 });
});

it("keeps a bounded leading part of an oversized single-line message", () => {
  const result = diagnosticResult({ diagnostics: [{ ...finding, message: "y".repeat(2000) }] }, 1);
  expect(result).toMatchObject({
    diagnostics: [{ message: `${"y".repeat(497)}... [truncated]`, truncated: true }],
  });
});

it("bounds oversized single-line multibyte messages by bytes", () => {
  const result = diagnosticResult({ diagnostics: [{ ...finding, message: "é".repeat(2000) }] }, 1);
  expect(result).toMatchObject({
    diagnostics: [{ message: `${"é".repeat(248)}... [truncated]`, truncated: true }],
  });
});

it("keeps a single-line message that fits maxBytes whole", () => {
  const result = diagnosticResult({ diagnostics: [{ ...finding, message: "a".repeat(512) }] }, 1);
  expect(result).toMatchObject({
    diagnostics: [{ message: "a".repeat(512), truncated: false }],
  });
});

it("cuts a single-line message one byte over maxBytes to the marker budget", () => {
  const result = diagnosticResult({ diagnostics: [{ ...finding, message: "a".repeat(513) }] }, 1);
  expect(result).toMatchObject({
    diagnostics: [{ message: `${"a".repeat(497)}... [truncated]`, truncated: true }],
  });
});

it("rejects invalid ranges and invalid publication versions", () => {
  expect(() => diagnosticResult({ version: -1, diagnostics: [] }, 1)).toThrow(
    "Invalid diagnostic publication",
  );
  expect(() =>
    diagnosticResult(
      {
        diagnostics: [
          {
            ...finding,
            range: {
              start: { line: -1, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        ],
      },
      1,
    ),
  ).toThrow("Invalid diagnostic publication");
});
