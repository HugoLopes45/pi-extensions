import { lstat, readFile, realpath, stat } from "node:fs/promises";
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

const maxManifestBytes = 64 * 1024;

export async function readManifest(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > maxManifestBytes) return undefined;
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
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

function insideDependencies(boundary: string, dir: string): boolean {
  return relative(boundary, dir).split(sep).includes("node_modules");
}

export async function nearestRoot(
  root: string,
  boundary: string,
  markers: string[],
): Promise<string | undefined> {
  if (!insideDependencies(boundary, root)) {
    const matches = await Promise.all(markers.map((marker) => isFile(join(root, marker))));
    if (matches.some(Boolean)) return root;
  }
  return root === boundary ? undefined : nearestRoot(dirname(root), boundary, markers);
}
