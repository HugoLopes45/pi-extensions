import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { errorText } from "pi-hl-utils/errors";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { outside } from "./routing.js";

const MAX_EDITS = 1000;
const lineBreakPattern = /\r\n|\r|\n/gu;
const position = Type.Object({
  line: Type.Integer({ minimum: 0 }),
  character: Type.Integer({ minimum: 0 }),
});
const textEdit = Type.Object({
  range: Type.Object({ start: position, end: position }),
  newText: Type.String(),
});
const textDocumentEdit = Type.Object({
  textDocument: Type.Object({
    uri: Type.String(),
    version: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  }),
  edits: Type.Array(textEdit),
});
const workspaceEdit = Type.Object({
  changes: Type.Optional(Type.Record(Type.String(), Type.Array(textEdit))),
  documentChanges: Type.Optional(Type.Array(Type.Unknown())),
  changeAnnotations: Type.Optional(
    Type.Record(Type.String(), Type.Object({ needsConfirmation: Type.Optional(Type.Boolean()) })),
  ),
});

// The document the client last sent to the server; a rename computed against it names its version.
export type SyncedDocument = { file: string; version: number; text: string };
export type ChangedFile = { file: string; edits: number };
export type ApplyOutcome =
  | { outcome: "written"; changed: ChangedFile[] }
  | { outcome: "refused"; reason: string }
  | { outcome: "failed"; reason: string };

type Edit = Static<typeof textEdit>;
type Target = {
  file: string;
  version: number | null | undefined;
  edits: Edit[];
};
type Planned = Target & { original: string; text: string };
type Group = { uri: string; version: number | null | undefined; edits: Edit[] };

// Thrown before any write; it becomes a refusal of the whole edit.
class Refusal extends Error {}

// Validates the edit, then plans and writes each file under its queue; a refusal or write error leaves files as they were.
export async function applyWorkspaceEdit(
  response: unknown,
  root: string,
  synced: SyncedDocument | undefined,
): Promise<ApplyOutcome> {
  try {
    const targets = await targetsOf(response, root);
    return await queued(
      targets.map((target) => target.file),
      async () => {
        const planned = await planAll(targets, root, synced);
        return writeAll(planned, root);
      },
    );
  } catch (error) {
    if (error instanceof Refusal) return { outcome: "refused", reason: error.message };
    throw error;
  }
}

async function targetsOf(response: unknown, root: string): Promise<Target[]> {
  if (response === null) throw new Refusal("The server returned no workspace edit");
  if (!Value.Check(workspaceEdit, response))
    throw new Refusal("The server returned an invalid workspace edit");
  if (response.changes !== undefined && response.documentChanges !== undefined)
    throw new Refusal("The workspace edit has both changes and documentChanges");
  const confirmed = Object.values(response.changeAnnotations ?? {}).some(
    (annotation) => annotation.needsConfirmation === true,
  );
  if (confirmed) throw new Refusal("The workspace edit needs user confirmation");
  const groups = groupsOf(response);
  const total = groups.reduce((sum, group) => sum + group.edits.length, 0);
  if (total > MAX_EDITS)
    throw new Refusal(`The workspace edit has ${total} edits; the limit is ${MAX_EDITS}`);
  const targets: Target[] = [];
  for (const group of groups) {
    const file = await realFileOf(group.uri, root);
    if (targets.some((target) => target.file === file))
      throw new Refusal(`The workspace edit changes ${relative(root, file)} twice`);
    targets.push({ file, version: group.version, edits: group.edits });
  }
  return targets;
}

function groupsOf(edit: Static<typeof workspaceEdit>): Group[] {
  if (edit.documentChanges === undefined)
    return Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({
      uri,
      version: undefined,
      edits,
    }));
  return edit.documentChanges.map((change) => {
    if (!Value.Check(textDocumentEdit, change))
      throw new Refusal(
        "The workspace edit has a change that is not a text edit; resource operations are refused",
      );
    return {
      uri: change.textDocument.uri,
      version: change.textDocument.version,
      edits: change.edits,
    };
  });
}

async function realFileOf(uri: string, root: string): Promise<string> {
  const real = await realpath(fileOf(uri)).catch(() => {
    throw new Refusal("The workspace edit targets a missing file");
  });
  if (outside(root, real))
    throw new Refusal("The workspace edit targets a file outside the project");
  if (!(await stat(real)).isFile())
    throw new Refusal("The workspace edit targets a path that is not a regular file");
  return real;
}

function fileOf(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    throw new Refusal("The workspace edit targets a URI that is not a file");
  }
}

// Holds the queue of every target, in path order, so two renames cannot wait on each other.
function queued<T>(files: string[], run: () => Promise<T>): Promise<T> {
  const [first, ...rest] = files;
  if (first === undefined) return run();
  return withFileMutationQueue(first, () => queued(rest, run));
}

async function planAll(
  targets: Target[],
  root: string,
  synced: SyncedDocument | undefined,
): Promise<Planned[]> {
  const planned: Planned[] = [];
  for (const target of targets) {
    const name = relative(root, target.file);
    const original = await readOriginal(target.file, name);
    checkSynced(target, original, synced, name);
    planned.push({
      ...target,
      original,
      text: applyEdits(original, target.edits, name),
    });
  }
  return planned;
}

// Keeps the bytes exact: text that is not UTF-8 would be written back with replacement characters.
async function readOriginal(file: string, name: string): Promise<string> {
  const bytes = await readFile(file);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Refusal(`${name} is not valid UTF-8`);
  return text;
}

// The edit must name the text and version the server last received for this file.
function checkSynced(
  target: Target,
  original: string,
  synced: SyncedDocument | undefined,
  name: string,
): void {
  if (synced?.file === target.file && synced.text !== original)
    throw new Refusal(`${name} changed after the server read it`);
  const versioned = target.version !== undefined && target.version !== null;
  if (versioned && (synced?.file !== target.file || synced.version !== target.version))
    throw new Refusal(`The edit is stale for ${name}: the server computed it for another version`);
}

function lineBounds(text: string): { start: number; end: number }[] {
  const bounds: { start: number; end: number }[] = [];
  let start = 0;
  for (const match of text.matchAll(lineBreakPattern)) {
    bounds.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  bounds.push({ start, end: text.length });
  return bounds;
}

function offsetOf(
  bounds: { start: number; end: number }[],
  at: Static<typeof position>,
  name: string,
): number {
  const line = bounds[at.line];
  if (line === undefined || at.character > line.end - line.start)
    throw new Refusal(`The workspace edit has a position outside ${name}`);
  return line.start + at.character;
}

// Edits are applied from the end of the text, so earlier offsets stay valid.
function applyEdits(text: string, edits: Edit[], name: string): string {
  const bounds = lineBounds(text);
  const ranges = edits
    .map(({ range, newText }) => ({
      start: offsetOf(bounds, range.start, name),
      end: offsetOf(bounds, range.end, name),
      newText,
    }))
    .toSorted((a, b) => a.start - b.start || a.end - b.end);
  for (const [index, range] of ranges.entries()) {
    const previous = ranges[index - 1];
    if (range.end < range.start)
      throw new Refusal(`The workspace edit has a reversed range in ${name}`);
    if (previous && (range.start < previous.end || range.start === previous.start))
      throw new Refusal(`The workspace edits overlap in ${name}`);
  }
  let result = text;
  for (const range of ranges.toReversed())
    result = result.slice(0, range.start) + range.newText + result.slice(range.end);
  return result;
}

// Writes every planned file, or restores the written ones when a write fails.
async function writeAll(planned: Planned[], root: string): Promise<ApplyOutcome> {
  const attempted: Planned[] = [];
  for (const target of planned) {
    attempted.push(target);
    try {
      await writeFile(target.file, target.text);
    } catch (error) {
      const unrestored = await restore(attempted, root);
      const state =
        unrestored.length === 0
          ? "Restored every written file."
          : `Could not restore: ${unrestored.join(", ")}.`;
      return {
        outcome: "failed",
        reason: `Could not write ${relative(root, target.file)}: ${errorText(error)}. ${state}`,
      };
    }
  }
  return {
    outcome: "written",
    changed: planned.map(({ file, edits }) => ({ file, edits: edits.length })),
  };
}

// Rewrites the original text of each attempted file, newest first; returns the names still changed.
async function restore(attempted: Planned[], root: string): Promise<string[]> {
  const unrestored: string[] = [];
  for (const target of attempted.toReversed()) {
    try {
      await writeFile(target.file, target.original);
    } catch {
      unrestored.push(relative(root, target.file));
    }
  }
  return unrestored;
}
