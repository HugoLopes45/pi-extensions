import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  constants,
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { errorText } from "pi-hl-utils/errors";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { outside } from "./project-files.js";

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
const textEdits = Type.Array(textEdit);
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

export type FileMove = { from: string; to: string };
export type MovePlan =
  | { outcome: "planned"; move: FileMove }
  | { outcome: "refused"; reason: string };

type Edit = Static<typeof textEdit>;
type Target = {
  file: string;
  version: number | null | undefined;
  edits: Edit[];
};
type Planned = Target & { original: string; text: string; mode: number };

// Written before the first file changes and removed after the last step, so a killed apply can be undone.
const journal = Type.Object({
  pid: Type.Integer(),
  files: Type.Array(
    Type.Object({
      file: Type.String(),
      original: Type.String(),
      text: Type.String(),
    }),
  ),
  move: Type.Optional(Type.Object({ from: Type.String(), to: Type.String() })),
});
type Journal = Static<typeof journal>;
type Group = { uri: string; version: number | null | undefined; edits: Edit[] };

// Thrown before any write; it becomes a refusal of the whole edit.
class Refusal extends Error {}

// Validates the edit, then plans and writes each file under its queue; the move runs once all files are written.
// A refusal, write error or move error leaves files as they were; a killed process leaves a journal for
// recoverInterruptedEdits.
export async function applyWorkspaceEdit(
  response: unknown,
  root: string,
  synced: SyncedDocument | undefined,
  move?: FileMove,
): Promise<ApplyOutcome> {
  try {
    const targets = await targetsOf(response, root);
    return await queued(targets.map((target) => target.file).toSorted(), async () => {
      const planned = await planAll(targets, root, synced);
      return writeAll(planned, root, move);
    });
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

// Formatting answers with TextEdit[] for the synced document; the same checks apply to them as to a rename.
export async function applyTextEdits(
  response: unknown,
  root: string,
  synced: SyncedDocument,
): Promise<ApplyOutcome> {
  if (!Value.Check(textEdits, response))
    return {
      outcome: "refused",
      reason: "The server returned invalid text edits",
    };
  return applyWorkspaceEdit(
    { changes: { [pathToFileURL(synced.file).href]: response } },
    root,
    synced,
  );
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
    // The new text replaces the file by rename, which a read-only file would not stop.
    await access(target.file, constants.W_OK).catch(() => {
      throw new Refusal(`${name} is read-only`);
    });
    planned.push({
      ...target,
      original,
      text: applyEdits(original, target.edits, name),
      mode: (await stat(target.file)).mode,
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

// Checks the new path before any server is asked: it must be free and, after realpath, inside the project.
export async function planMove(from: string, newPath: string, root: string): Promise<MovePlan> {
  try {
    const target = resolve(root, newPath);
    if ((await realpathOrMissing(target)) !== undefined)
      throw new Refusal(`${newPath} already exists`);
    const to = await nearestRealpath(target);
    if (outside(root, to)) throw new Refusal("The new path is outside the project");
    return { outcome: "planned", move: { from, to } };
  } catch (error) {
    if (error instanceof Refusal) return { outcome: "refused", reason: error.message };
    throw error;
  }
}

export async function moveFile({ from, to }: FileMove): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  // link fails on an existing destination, so a file created since planning is never replaced.
  await link(from, to).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP")
      throw new Error(
        `The file system refuses the hard link that moving the file needs (${code})`,
        {
          cause: error,
        },
      );
    throw error;
  });
  try {
    await unlink(from);
  } catch (error) {
    await unlink(to);
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function realpathOrMissing(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

// The real path a new file would have: its nearest existing ancestor, resolved, plus the missing names.
async function nearestRealpath(path: string): Promise<string> {
  return (
    (await realpathOrMissing(path)) ?? join(await nearestRealpath(dirname(path)), basename(path))
  );
}

function journalDir(): string {
  return join(getAgentDir(), "hl-lsp", "journal");
}

// Replaces the file in one step, so a killed process leaves either the old or the new text, never a part.
async function replaceFile(file: string, text: string, mode?: number): Promise<void> {
  const temporary = `${file}.hl-lsp-${randomUUID()}`;
  try {
    await writeFile(temporary, text);
    // Set after the write: a mode given to writeFile is reduced by the umask.
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Writes every planned file and then moves the file, or restores the written files when either fails.
async function writeAll(
  planned: Planned[],
  root: string,
  move: FileMove | undefined,
): Promise<ApplyOutcome> {
  const record: Journal = {
    pid: process.pid,
    files: planned.map(({ file, original, text }) => ({
      file,
      original,
      text,
    })),
    ...(move && { move }),
  };
  await mkdir(journalDir(), { recursive: true });
  const entry = join(journalDir(), `${randomUUID()}.json`);
  await replaceFile(entry, JSON.stringify(record));
  const outcome = await writeJournaled(planned, root, move, entry);
  if (outcome.outcome === "written") await unlink(entry);
  return outcome;
}

async function writeJournaled(
  planned: Planned[],
  root: string,
  move: FileMove | undefined,
  entry: string,
): Promise<ApplyOutcome> {
  const attempted: Planned[] = [];
  for (const target of planned) {
    attempted.push(target);
    try {
      await replaceFile(target.file, target.text, target.mode);
    } catch (error) {
      return failed(
        `Could not write ${relative(root, target.file)}: ${errorText(error)}.`,
        attempted,
        root,
        entry,
      );
    }
  }
  try {
    if (move) await moveFile(move);
  } catch (error) {
    return failed(`${errorText(error)}.`, attempted, root, entry);
  }
  return {
    outcome: "written",
    changed: planned.map(({ file, edits }) => ({ file, edits: edits.length })),
  };
}

async function failed(
  reason: string,
  attempted: Planned[],
  root: string,
  entry: string,
): Promise<ApplyOutcome> {
  const unrestored = await restore(attempted, root);
  if (unrestored.length === 0) {
    await unlink(entry);
    return {
      outcome: "failed",
      reason: `${reason} Restored every written file.`,
    };
  }
  // The journal stays, so the next Pi start can still undo the files left changed.
  return {
    outcome: "failed",
    reason: `${reason} Could not restore: ${unrestored.join(", ")}. The next Pi start retries.`,
  };
}

// Rewrites the original text of each attempted file, newest first; returns the names still changed.
async function restore(attempted: Planned[], root: string): Promise<string[]> {
  const unrestored: string[] = [];
  for (const target of attempted.toReversed()) {
    try {
      await replaceFile(target.file, target.original, target.mode);
    } catch {
      unrestored.push(relative(root, target.file));
    }
  }
  return unrestored;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

// Undoes the edits that a killed process left in the journal. A file changed since then is kept and named,
// and its journal stays so the original text is not lost. Returns one note per journal it acted on.
export async function recoverInterruptedEdits(): Promise<string[]> {
  const names = await readdir(journalDir()).catch((error: unknown) => {
    if (isMissingPath(error)) return [];
    throw error;
  });
  const notes: string[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const note = await recoverJournal(join(journalDir(), name));
    if (note !== undefined) notes.push(note);
  }
  return notes;
}

async function recoverJournal(entry: string): Promise<string | undefined> {
  const record: unknown = JSON.parse(await readFile(entry, "utf8"));
  if (!Value.Check(journal, record))
    return `The LSP edit journal ${entry} is invalid; it was kept.`;
  if (running(record.pid)) return undefined;
  if (record.move) await undoMove(record.move);
  const kept: string[] = [];
  for (const { file, original, text } of record.files) {
    const current = await readFile(file, "utf8").catch((error: unknown) => {
      if (isMissingPath(error)) return undefined;
      throw error;
    });
    if (current === text) await replaceFile(file, original, (await stat(file)).mode);
    else if (current !== original) kept.push(file);
  }
  if (kept.length > 0)
    return `Could not undo an interrupted LSP edit of ${kept.join(", ")}: the files changed since. ${entry} keeps their original text.`;
  await unlink(entry);
  return `Undid an interrupted LSP edit of ${record.files.length} files.`;
}

async function undoMove({ from, to }: FileMove): Promise<void> {
  if ((await realpathOrMissing(from)) === undefined && (await realpathOrMissing(to)) !== undefined)
    await moveFile({ from: to, to: from });
}
