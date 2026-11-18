import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { isMissingFileError } from "pi-hl-utils/errors";

export function outside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

const maxManifestBytes = 64 * 1024;

// One handle is checked and read, so the path cannot turn into a symlink, a FIFO or a larger file in between.
export async function readManifest(path: string): Promise<string | undefined> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (isMissingFileError(error) || code === "ELOOP") return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(maxManifestBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > maxManifestBytes ? undefined : buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function realpathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function insideDependencies(
  boundary: string,
  dir: string,
  dependencyDirs: readonly string[],
): boolean {
  return relative(boundary, dir)
    .split(sep)
    .some((name) => dependencyDirs.includes(name));
}

// A plain marker names a file or a directory; a marker with a leading * matches an entry whose name ends with the rest.
export function matchesMarker(name: string, marker: string): boolean {
  return marker.startsWith("*") ? name.endsWith(marker.slice(1)) : name === marker;
}

async function hasMarker(dir: string, marker: string): Promise<boolean> {
  if (!marker.startsWith("*")) return exists(join(dir, marker));
  return (await readdir(dir)).some((name) => matchesMarker(name, marker));
}

export async function nearestRoot(
  root: string,
  boundary: string,
  markers: readonly string[],
  dependencyDirs: readonly string[],
): Promise<string | undefined> {
  if (!insideDependencies(boundary, root, dependencyDirs)) {
    const matches = await Promise.all(markers.map((marker) => hasMarker(root, marker)));
    if (matches.some(Boolean)) return root;
  }
  return root === boundary
    ? undefined
    : nearestRoot(dirname(root), boundary, markers, dependencyDirs);
}
