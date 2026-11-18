import type { Dirent } from "node:fs";
import { access, constants, opendir, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { isMissingFileError } from "pi-hl-utils/errors";

import { presetFor, presets } from "./presets.js";
import { matchesMarker, readManifest } from "./project-files.js";

const MAX_DEPTH = 2;
const MAX_SUBDIRECTORIES = 64;
const MAX_DIRECTORIES = 500;
const MAX_ENTRIES = 1024;

export type Candidate = { command: string; args: string[] };

// Plain names from the root .gitignore; patterns with wildcards, paths or negation are not used.
async function ignoredNames(root: string): Promise<Set<string>> {
  const text = (await readManifest(join(root, ".gitignore"))) ?? "";
  const names = text
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^\//u, "").replace(/\/$/u, ""))
    .filter((name) => name !== "" && !/[#!*?[\\/]/u.test(name));
  return new Set(names);
}

// Name order makes the caps cut the same entries everywhere, except in a directory larger than
// MAX_ENTRIES, where the file system decides which entries are read.
async function entriesOf(dir: string): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  try {
    for await (const entry of await opendir(dir)) {
      entries.push(entry);
      if (entries.length >= MAX_ENTRIES) break;
    }
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  return entries.toSorted((left, right) => (left.name < right.name ? -1 : 1));
}

function markLanguages(dir: string, names: readonly string[], found: Map<string, string>): void {
  for (const [language, preset] of Object.entries(presets)) {
    if (!preset.discovery || found.has(language)) continue;
    const markers = [...preset.rootMarkers, ...preset.discovery.detectMarkers];
    if (names.some((name) => markers.some((marker) => matchesMarker(name, marker))))
      found.set(language, dir);
  }
}

function subdirectories(dir: string, entries: readonly Dirent[], ignored: Set<string>): string[] {
  return entries
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith(".") && !ignored.has(entry.name),
    )
    .slice(0, MAX_SUBDIRECTORIES)
    .map((entry) => join(dir, entry.name));
}

// Breadth first in name order, so a language is reported at its shallowest marker directory.
export async function detectLanguages(root: string): Promise<Map<string, string>> {
  const ignored = await ignoredNames(root);
  const found = new Map<string, string>();
  let level = [root];
  let read = 0;
  for (let depth = 0; depth <= MAX_DEPTH; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (read++ >= MAX_DIRECTORIES) return found;
      const entries = await entriesOf(dir);
      markLanguages(
        dir,
        entries.map((entry) => entry.name),
        found,
      );
      next.push(...subdirectories(dir, entries, ignored));
    }
    level = next;
  }
  return found;
}

async function runnable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    if (error instanceof Error && "code" in error && error.code === "EACCES") return false;
    throw error;
  }
}

// The path is returned as found: rustup and Volta shims choose the tool by their own file name.
export async function findServer(
  language: string,
  markerDir: string,
  root: string,
  path: string | undefined,
): Promise<Candidate | undefined> {
  const discovery = presetFor(language)?.discovery;
  if (!discovery) return undefined;
  const searched = (path ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
  for (const candidate of discovery.candidates) {
    const local = discovery.localBins.flatMap((bin) => [join(markerDir, bin), join(root, bin)]);
    for (const dir of [...local, ...searched]) {
      const command = join(dir, candidate.command);
      if (await runnable(command)) return { command, args: [...candidate.args] };
    }
  }
  return undefined;
}
