import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { Observation } from "./diagnostics.js";
import { bounded } from "./text.js";

type Formatted = { text: string; truncated: boolean };
export type LineReader = (file: string) => Promise<string[] | undefined>;

const hoverLimits = { maxBytes: 8192, maxLines: 100 };
const bodyLimits = { maxBytes: 16384, maxLines: 250 };
const diagnosticMessageLimits = { maxBytes: 512, maxLines: 1 };
const sourceLimits = { maxBytes: 200, maxLines: 1 };
const locationLimit = 50;
const newErrorLimit = 10;
const symbolLimit = 200;
const maxSymbolDepth = 8;

const symbolKindNames = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enummember",
  "struct",
  "event",
  "operator",
  "typeparameter",
];
const severityNames = ["error", "warning", "information", "hint"];

const position = Type.Object({
  line: Type.Integer({ minimum: 0 }),
  character: Type.Integer({ minimum: 0 }),
});
const range = Type.Object({ start: position, end: position });
const location = Type.Object({ uri: Type.String(), range });
const locationLink = Type.Object({
  targetUri: Type.String(),
  targetRange: range,
  targetSelectionRange: range,
});
const markupContent = Type.Object({
  kind: Type.String(),
  value: Type.String(),
});
const markedString = Type.Union([
  Type.String(),
  Type.Object({ language: Type.String(), value: Type.String() }),
]);
const hoverSchema = Type.Object({
  contents: Type.Union([markupContent, markedString, Type.Array(markedString)]),
});
const symbolKind = Type.Integer({
  minimum: 1,
  maximum: symbolKindNames.length,
});
const documentSymbol = Type.Object({
  name: Type.String(),
  kind: symbolKind,
  range,
  selectionRange: range,
  children: Type.Optional(Type.Array(Type.Unknown())),
});
const symbolInformation = Type.Object({
  name: Type.String(),
  kind: symbolKind,
  location,
});
// A WorkspaceSymbol may name only a file, without a range.
const workspaceSymbol = Type.Object({
  name: Type.String(),
  kind: symbolKind,
  location: Type.Union([location, Type.Object({ uri: Type.String() })]),
});

type Place = {
  uri: string;
  file: string | undefined;
  line: number;
  character: number;
};
type Rendered = { text: string; truncated: boolean };
type MarkedString = Static<typeof markedString>;

export function formatHover(response: unknown): Formatted {
  if (response === null) return emptyResult();
  const hover = checked(hoverSchema, response, "hover");
  const text = hoverText(hover.contents);
  if (text === "") return emptyResult();
  const body = bounded(text, hoverLimits);
  return { text: body.content, truncated: body.truncated };
}

export async function formatLocations(
  response: unknown,
  cwd: string,
  lines: LineReader,
  operation: "definition" | "type_definition" | "implementation" | "references",
): Promise<Formatted> {
  if (response === null) return emptyResult();
  const items = responseItems(response, operation);
  if (items.length === 0) return emptyResult();
  const places = distinctPlaces(items.map((item) => placeOf(item, operation)));
  const shown = places.slice(0, locationLimit);
  const sources = await readSources(shown, cwd, lines);
  const rendered = shown.map((place) => renderPlace(place, cwd, sources));
  return renderBody(
    rendered.map((line) => line.text),
    places.length - shown.length,
    rendered.some((line) => line.truncated),
  );
}

export function formatSymbols(response: unknown): Formatted {
  if (response === null) return emptyResult();
  if (!Value.Check(Type.Array(Type.Unknown()), response)) throw unexpected("symbols");
  if (response.length === 0) return emptyResult();
  const lines: string[] = [];
  if (Value.Check(symbolInformation, response[0])) flatSymbols(response, lines);
  else outline(response, 0, lines);
  return renderBody(lines.slice(0, symbolLimit), Math.max(lines.length - symbolLimit, 0), false);
}

export async function formatWorkspaceSymbols(
  response: unknown,
  cwd: string,
  lines: LineReader,
): Promise<Formatted> {
  if (response === null) return emptyResult();
  if (!Value.Check(Type.Array(Type.Unknown()), response)) throw unexpected("workspace_symbols");
  if (response.length === 0) return emptyResult();
  const items = response.map((item) => checked(workspaceSymbol, item, "workspace_symbols"));
  const shown = items.slice(0, locationLimit);
  const places = shown.flatMap(({ location }) =>
    "range" in location ? [toPlace(location.uri, location.range.start, "workspace_symbols")] : [],
  );
  const sources = await readSources(places, cwd, lines);
  const rendered = shown.map((item) => renderWorkspaceSymbol(item, cwd, sources));
  return renderBody(
    rendered.map((line) => line.text),
    items.length - shown.length,
    rendered.some((line) => line.truncated),
  );
}

export function formatDiagnostics(observation: Observation): Formatted {
  if (observation.diagnostics.length === 0) return emptyResult();
  const rendered = observation.diagnostics.map(diagnosticLine);
  return renderBody(
    rendered.map((line) => line.text),
    observation.omitted,
    rendered.some((line) => line.truncated),
  );
}

export function formatNewErrors(errors: Observation["diagnostics"]): Formatted {
  const shown = errors.slice(0, newErrorLimit);
  const rendered = shown.map(diagnosticLine);
  return renderBody(
    rendered.map((line) => line.text),
    errors.length - shown.length,
    rendered.some((line) => line.truncated),
  );
}

function emptyResult(): Formatted {
  return { text: "no result", truncated: false };
}

function unexpected(operation: string): Error {
  return new Error(`Unexpected LSP ${operation} response shape`);
}

function checked<T extends TSchema>(schema: T, value: unknown, operation: string): Static<T> {
  if (!Value.Check(schema, value)) throw unexpected(operation);
  return value;
}

// Keeps a server string on one output line so it cannot forge a line of its own.
function oneLine(text: string): string {
  return text.replace(/[\r\n]/gu, " ");
}

function renderBody(lines: string[], omitted: number, linesTruncated: boolean): Formatted {
  const all = omitted > 0 ? [...lines, `... ${omitted} more`] : lines;
  const body = bounded(all.join("\n"), bodyLimits);
  return {
    text: body.content,
    truncated: body.truncated || omitted > 0 || linesTruncated,
  };
}

function markedText(part: MarkedString): string {
  return typeof part === "string" ? part : `\`\`\`${part.language}\n${part.value}\n\`\`\``;
}

function hoverText(contents: Static<typeof hoverSchema>["contents"]): string {
  if (Array.isArray(contents)) return contents.map(markedText).join("\n\n");
  if (typeof contents === "string") return contents;
  return "language" in contents ? markedText(contents) : contents.value;
}

function symbolKindName(kind: number): string {
  return symbolKindNames[kind - 1] ?? "unknown";
}

function lineSpan(span: Static<typeof range>): string {
  const start = span.start.line + 1;
  const end = span.end.line + 1;
  return start === end ? `${start}` : `${start}-${end}`;
}

// Nodes at maxSymbolDepth and deeper are neither validated nor walked; their parent prints one marker.
function outline(nodes: unknown[], depth: number, lines: string[]): void {
  for (const node of nodes) {
    const symbol = checked(documentSymbol, node, "symbols");
    const name = oneLine(symbol.name);
    lines.push(
      `${"  ".repeat(depth)}${symbolKindName(symbol.kind)} ${name} ${lineSpan(symbol.range)}`,
    );
    const children = symbol.children ?? [];
    if (depth + 1 < maxSymbolDepth) outline(children, depth + 1, lines);
    else if (children.length > 0) lines.push(`${"  ".repeat(depth + 1)}... deeper symbols omitted`);
  }
}

function flatSymbols(nodes: unknown[], lines: string[]): void {
  for (const node of nodes) {
    const info = checked(symbolInformation, node, "symbols");
    const name = oneLine(info.name);
    lines.push(`${symbolKindName(info.kind)} ${name} ${lineSpan(info.location.range)}`);
  }
}

function responseItems(response: unknown, operation: string): unknown[] {
  if (Value.Check(Type.Array(Type.Unknown()), response)) return response;
  return [checked(location, response, operation)];
}

function placeOf(item: unknown, operation: string): Place {
  if (Value.Check(location, item)) return toPlace(item.uri, item.range.start, operation);
  const link = checked(locationLink, item, operation);
  return toPlace(link.targetUri, link.targetSelectionRange.start, operation);
}

function toPlace(uri: string, start: Static<typeof position>, operation: string): Place {
  return {
    uri,
    file: filePath(uri, operation),
    line: start.line,
    character: start.character,
  };
}

function distinctPlaces(places: Place[]): Place[] {
  const seen = new Map<string, Place>();
  for (const place of places) {
    seen.set(JSON.stringify([place.uri, place.line, place.character]), place);
  }
  return [...seen.values()];
}

// Returns the absolute path of a file: URI, or undefined for other URIs.
function filePath(uri: string, operation: string): string | undefined {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    throw unexpected(operation);
  }
}

// Returns the path relative to cwd, or undefined when file lies outside cwd.
function insidePath(cwd: string, file: string): string | undefined {
  const path = relative(cwd, file);
  const outside = path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  return outside ? undefined : path;
}

function displayPath(place: Place, cwd: string): string {
  if (place.file === undefined) return place.uri;
  return insidePath(cwd, place.file) ?? place.file;
}

function readableFile(place: Place, cwd: string): string | undefined {
  return place.file !== undefined && insidePath(cwd, place.file) !== undefined
    ? place.file
    : undefined;
}

async function readSources(
  places: Place[],
  cwd: string,
  lines: LineReader,
): Promise<Map<string, string[] | undefined>> {
  const files = new Set(
    places.flatMap((place) => {
      const file = readableFile(place, cwd);
      return file === undefined ? [] : [file];
    }),
  );
  const entries = await Promise.all(
    [...files].map(async (file): Promise<[string, string[] | undefined]> => [
      file,
      await lines(file),
    ]),
  );
  return new Map(entries);
}

function sourceText(
  place: Place,
  cwd: string,
  sources: Map<string, string[] | undefined>,
): Rendered {
  const file = readableFile(place, cwd);
  const text = file === undefined ? undefined : sources.get(file)?.[place.line];
  if (text === undefined) return { text: "", truncated: false };
  const source = bounded(oneLine(text.trim()), sourceLimits);
  return { text: source.content, truncated: source.truncated };
}

function renderPlace(
  place: Place,
  cwd: string,
  sources: Map<string, string[] | undefined>,
): Rendered {
  const head = oneLine(`${displayPath(place, cwd)}:${place.line + 1}:${place.character + 1}`);
  const source = sourceText(place, cwd, sources);
  return {
    text: source.text === "" ? head : `${head}  ${source.text}`,
    truncated: source.truncated,
  };
}

function renderWorkspaceSymbol(
  item: Static<typeof workspaceSymbol>,
  cwd: string,
  sources: Map<string, string[] | undefined>,
): Rendered {
  const head = `${symbolKindName(item.kind)} ${oneLine(item.name)}`;
  const { location } = item;
  if (!("range" in location))
    return { text: `${head}  ${uriPath(location.uri, cwd)}`, truncated: false };
  const place = renderPlace(
    toPlace(location.uri, location.range.start, "workspace_symbols"),
    cwd,
    sources,
  );
  return { text: `${head}  ${place.text}`, truncated: place.truncated };
}

function uriPath(uri: string, cwd: string): string {
  const file = filePath(uri, "workspace_symbols");
  if (file === undefined) return uri;
  return insidePath(cwd, file) ?? file;
}

function diagnosticLine(item: Observation["diagnostics"][number]): Rendered {
  const severity = item.severity === undefined ? "-" : severityNames[item.severity - 1];
  const { start } = item.range;
  const message = bounded(oneLine(item.message), diagnosticMessageLimits);
  return {
    text: `${start.line + 1}:${start.character + 1} ${severity} ${item.code ?? "-"} ${message.content}`,
    truncated: item.truncated || message.truncated,
  };
}
