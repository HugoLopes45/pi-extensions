import { expect, it, vi } from "vitest";

import { diagnosticResult, type Observation } from "../src/diagnostics.js";
import {
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatSymbols,
  formatWorkspaceSymbols,
  type LineReader,
} from "../src/format.js";

const cwd = "/repo";
const aSourceLines = [
  ...Array.from({ length: 11 }, () => ""),
  "    export function start(port: number) {",
];

const readSource: LineReader = async (file) =>
  file === "/repo/src/a.ts" ? aSourceLines : undefined;

function range(line: number, character: number) {
  return {
    start: { line, character },
    end: { line, character: character + 1 },
  };
}

function location(uri: string, line: number, character: number) {
  return { uri, range: range(line, character) };
}

function link(uri: string, line: number, character: number) {
  return {
    targetUri: uri,
    targetRange: range(line, character),
    targetSelectionRange: range(line, character),
  };
}

function documentSymbol(
  name: string,
  kind: number,
  span: ReturnType<typeof range>,
  children: unknown[] = [],
) {
  return { name, kind, range: span, selectionRange: span, children };
}

// Returns the top-level symbols of a chain `levels` deep; the deepest node holds `deepestChildren`.
function symbolChain(levels: number, deepestChildren: unknown[] = []): unknown[] {
  let children = deepestChildren;
  for (let level = levels - 1; level >= 0; level -= 1) {
    children = [documentSymbol(`s${level}`, 6, range(level, 0), children)];
  }
  return children;
}

function observe(report: unknown): Observation {
  const result = diagnosticResult(report, 1);
  if (result.outcome === "superseded") throw new Error("unexpected superseded observation");
  return result;
}

it("formats markup hover contents as their value", () => {
  expect(formatHover({ contents: { kind: "markdown", value: "**x**" } })).toEqual({
    text: "**x**",
    truncated: false,
  });
});

it("formats marked-string array hover, fencing language-tagged entries", () => {
  expect(formatHover({ contents: ["a", { language: "ts", value: "b" }] })).toEqual({
    text: "a\n\n```ts\nb\n```",
    truncated: false,
  });
});

it("formats a LocationLink definition 1-based with its trimmed source line", async () => {
  const result = await formatLocations(
    [link("file:///repo/src/a.ts", 11, 4)],
    cwd,
    readSource,
    "definition",
  );
  expect(result).toEqual({
    text: "src/a.ts:12:5  export function start(port: number) {",
    truncated: false,
  });
});

it("formats a single Location definition reply", async () => {
  const result = await formatLocations(
    location("file:///repo/src/a.ts", 11, 4),
    cwd,
    readSource,
    "definition",
  );
  expect(result.text).toBe("src/a.ts:12:5  export function start(port: number) {");
});

it("reports a location as truncated when its source line is cut", async () => {
  const result = await formatLocations(
    [location("file:///repo/src/a.ts", 0, 0)],
    cwd,
    async () => ["y".repeat(300)],
    "definition",
  );
  expect(result.truncated).toBe(true);
});

it("prints a location without source text when its file cannot be read", async () => {
  const result = await formatLocations(
    [location("file:///repo/src/missing.ts", 4, 0)],
    cwd,
    async () => undefined,
    "definition",
  );
  expect(result.text).toBe("src/missing.ts:5:1");
});

it("prints an outside-cwd location as an absolute path without reading it", async () => {
  const reader = vi.fn<LineReader>(async () => ["x"]);
  const result = await formatLocations(
    [location("file:///elsewhere/b.ts", 2, 0)],
    cwd,
    reader,
    "definition",
  );
  expect(result.text).toBe("/elsewhere/b.ts:3:1");
  expect(reader).not.toHaveBeenCalled();
});

it("prints non-file URIs unchanged", async () => {
  const result = await formatLocations(
    [location("https://example.com/doc", 0, 0)],
    cwd,
    readSource,
    "definition",
  );
  expect(result.text).toBe("https://example.com/doc:1:1");
});

it("de-duplicates references and keeps the outside-cwd path absolute", async () => {
  const result = await formatLocations(
    [
      location("file:///repo/src/a.ts", 11, 4),
      location("file:///repo/src/a.ts", 11, 4),
      location("file:///elsewhere/b.ts", 2, 0),
    ],
    cwd,
    readSource,
    "references",
  );
  expect(result).toEqual({
    text: "src/a.ts:12:5  export function start(port: number) {\n/elsewhere/b.ts:3:1",
    truncated: false,
  });
});

it("caps locations at 50 and reports the rest", async () => {
  const response = Array.from({ length: 60 }, (_, line) =>
    location("file:///repo/src/a.ts", line, 0),
  );
  const result = await formatLocations(response, cwd, async () => undefined, "references");
  const printed = Array.from({ length: 50 }, (_, line) => `src/a.ts:${line + 1}:1`);
  expect(result).toEqual({
    text: [...printed, "... 10 more"].join("\n"),
    truncated: true,
  });
});

it("reads each distinct file once", async () => {
  const reader = vi.fn<LineReader>(async () => ["x", "y"]);
  await formatLocations(
    [
      location("file:///repo/src/a.ts", 0, 0),
      location("file:///repo/src/a.ts", 1, 0),
      location("file:///repo/src/b.ts", 0, 0),
    ],
    cwd,
    reader,
    "references",
  );
  expect(reader).toHaveBeenCalledTimes(2);
  expect(reader).toHaveBeenCalledWith("/repo/src/a.ts");
  expect(reader).toHaveBeenCalledWith("/repo/src/b.ts");
});

it("indents hierarchical symbols two spaces per level with line spans", () => {
  const response = [
    documentSymbol(
      "Server",
      5,
      {
        start: { line: 9, character: 0 },
        end: { line: 20, character: 1 },
      },
      [documentSymbol("start", 6, range(13, 2))],
    ),
  ];
  expect(formatSymbols(response)).toEqual({
    text: "class Server 10-21\n  method start 14",
    truncated: false,
  });
});

it("replaces line breaks in a symbol name so it cannot forge a line", () => {
  expect(formatSymbols([documentSymbol("run\nFORGED", 12, range(0, 0))])).toEqual({
    text: "function run FORGED 1",
    truncated: false,
  });
});

it("prints eight symbol levels then marks the omitted deeper symbols", () => {
  const printed = Array.from(
    { length: 8 },
    (_, level) => `${"  ".repeat(level)}method s${level} ${level + 1}`,
  );
  expect(formatSymbols(symbolChain(10))).toEqual({
    text: [...printed, `${"  ".repeat(8)}... deeper symbols omitted`].join("\n"),
    truncated: false,
  });
});

it("does not validate symbols past depth 8", () => {
  const result = formatSymbols(symbolChain(8, [{ bogus: 1 }]));
  expect(result.text).toMatch(/\.\.\. deeper symbols omitted$/u);
});

it("formats flat SymbolInformation lowercased kind and 1-based line", () => {
  const response = [
    {
      name: "run",
      kind: 12,
      location: location("file:///repo/src/a.ts", 3, 0),
    },
  ];
  expect(formatSymbols(response)).toEqual({
    text: "function run 4",
    truncated: false,
  });
});

it("lowercases the enum member and type parameter kinds", () => {
  const response = [
    {
      name: "Red",
      kind: 22,
      location: location("file:///repo/src/a.ts", 0, 0),
    },
    { name: "T", kind: 26, location: location("file:///repo/src/a.ts", 1, 0) },
  ];
  expect(formatSymbols(response)).toEqual({
    text: "enummember Red 1\ntypeparameter T 2",
    truncated: false,
  });
});

it("formats a numeric diagnostic code raw with 1-based position and severity name", () => {
  const observation = observe({
    diagnostics: [
      {
        message: "Type 'string' is not assignable",
        code: 2322,
        severity: 1,
        range: range(11, 4),
      },
    ],
  });
  expect(formatDiagnostics(observation)).toEqual({
    text: "12:5 error 2322 Type 'string' is not assignable",
    truncated: false,
  });
});

it("reports a diagnostic as truncated when its message is cut", () => {
  const observation = observe({
    diagnostics: [
      {
        message: "x".repeat(2000),
        code: 2322,
        severity: 1,
        range: range(0, 0),
      },
    ],
  });
  expect(formatDiagnostics(observation).truncated).toBe(true);
});

it("keeps a multi-line diagnostic message on one line", () => {
  const observation = observe({
    diagnostics: [{ message: "first\nsecond", code: 2322, severity: 1, range: range(0, 0) }],
  });
  expect(formatDiagnostics(observation)).toEqual({
    text: "1:1 error 2322 first second",
    truncated: false,
  });
});

it("rejects a malformed definition response without raw fallback", async () => {
  await expect(formatLocations({ bogus: 1 }, cwd, readSource, "definition")).rejects.toThrow(
    "Unexpected LSP definition response shape",
  );
});

it("formats null and empty results as no result", async () => {
  const empty = { text: "no result", truncated: false };
  expect(formatHover(null)).toEqual(empty);
  expect(formatSymbols(null)).toEqual(empty);
  expect(formatSymbols([])).toEqual(empty);
  expect(await formatLocations(null, cwd, readSource, "definition")).toEqual(empty);
  expect(await formatLocations([], cwd, readSource, "references")).toEqual(empty);
});

it("reports hover with empty contents as no result", () => {
  const empty = { text: "no result", truncated: false };
  expect(formatHover({ contents: "" })).toEqual(empty);
  expect(formatHover({ contents: [] })).toEqual(empty);
});

it("caps flat symbols at 200 lines and reports the rest", () => {
  const response = Array.from({ length: 250 }, (_, line) => ({
    name: `s${line}`,
    kind: 12,
    location: location("file:///repo/src/a.ts", line, 0),
  }));
  const printed = Array.from({ length: 200 }, (_, line) => `function s${line} ${line + 1}`);
  expect(formatSymbols(response)).toEqual({
    text: [...printed, "... 50 more"].join("\n"),
    truncated: true,
  });
});

it("formats a workspace symbol with its 1-based location and source line", async () => {
  const result = await formatWorkspaceSymbols(
    [
      {
        name: "start",
        kind: 12,
        location: location("file:///repo/src/a.ts", 11, 4),
      },
    ],
    cwd,
    readSource,
  );
  expect(result).toEqual({
    text: "function start  src/a.ts:12:5  export function start(port: number) {",
    truncated: false,
  });
});

it("prints a workspace symbol without a range as its path", async () => {
  const result = await formatWorkspaceSymbols(
    [{ name: "Server", kind: 5, location: { uri: "file:///repo/src/a.ts" } }],
    cwd,
    readSource,
  );
  expect(result).toEqual({ text: "class Server  src/a.ts", truncated: false });
});

it("caps workspace symbols at 50 and reports the other 10", async () => {
  const response = Array.from({ length: 60 }, (_, line) => ({
    name: `s${line}`,
    kind: 12,
    location: location("file:///repo/src/a.ts", line, 0),
  }));
  const printed = Array.from(
    { length: 50 },
    (_, line) => `function s${line}  src/a.ts:${line + 1}:1`,
  );
  expect(await formatWorkspaceSymbols(response, cwd, async () => undefined)).toEqual({
    text: [...printed, "... 10 more"].join("\n"),
    truncated: true,
  });
});

it("formats null and empty workspace results as no result", async () => {
  const empty = { text: "no result", truncated: false };
  expect(await formatWorkspaceSymbols(null, cwd, readSource)).toEqual(empty);
  expect(await formatWorkspaceSymbols([], cwd, readSource)).toEqual(empty);
});

it("rejects a workspace symbol response that matches neither symbol form", async () => {
  await expect(formatWorkspaceSymbols([{ bogus: 1 }], cwd, readSource)).rejects.toThrow(
    "Unexpected LSP workspace_symbols response shape",
  );
});

it("replaces line breaks in a location URI and in a source line with spaces", async () => {
  const result = await formatLocations(
    [location("https://example.com/a\rb\nc", 0, 0)],
    cwd,
    async () => ["x\ry"],
    "references",
  );
  expect(result.text).toBe("https://example.com/a b c:1:1");
  const source = await formatLocations(
    [location("file:///repo/src/a.ts", 0, 0)],
    cwd,
    async () => ["x\ry"],
    "references",
  );
  expect(source.text).toBe("src/a.ts:1:1  x y");
});

it("rejects a file URI that is not a local path with the shape error", async () => {
  await expect(
    formatLocations([location("file://remote/repo/src/a.ts", 0, 0)], cwd, readSource, "definition"),
  ).rejects.toThrow("Unexpected LSP definition response shape");
});

it("bounds an oversized hover to 8 KiB and reports truncation", () => {
  const result = formatHover({ contents: "x".repeat(9000) });
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192);
});

it("bounds the whole location body when a URI is 20 KiB", async () => {
  const result = await formatLocations(
    [location(`https://example.com/${"a".repeat(20 * 1024)}`, 0, 0)],
    cwd,
    readSource,
    "references",
  );
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16 * 1024);
});
