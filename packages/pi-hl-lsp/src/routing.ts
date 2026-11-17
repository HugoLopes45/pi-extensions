import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { isMissingFileError } from "pi-hl-utils/errors";

import type { ServerFamily } from "./settings.js";

export type Route =
  | {
      outcome: "completed";
      file: string;
      root: string;
      language: string;
      server: ServerFamily;
      coverage: "local-marker";
    }
  | {
      outcome: "blocked" | "unsupported" | "ambiguous" | "unavailable";
      file: string;
      reason: string;
    };

function outside(base: string, path: string): boolean {
  const rel = relative(base, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

const maxManifestBytes = 64 * 1024;

async function readManifest(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > maxManifestBytes) return undefined;
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

async function realpathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

const projectMarkers: Record<ServerFamily, string[]> = {
  typescript: ["tsconfig.json", "jsconfig.json", "package.json"],
  python: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg"],
  rust: ["Cargo.toml", "rust-project.json"],
};

// Used only when no projectMarkers entry is found up to the boundary.
const fallbackMarkers: Partial<Record<ServerFamily, string[]>> = {
  python: ["requirements.txt"],
};

function insideDependencies(boundary: string, dir: string): boolean {
  return relative(boundary, dir).split(sep).includes("node_modules");
}

async function nearestRoot(
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

async function pythonEnvironment(
  root: string,
  boundary: string,
): Promise<{ outcome: "blocked" | "ambiguous"; reason: string } | undefined> {
  const environments = await Promise.all(
    [".venv", "venv"].map(async (name) => {
      return (await isFile(join(root, name, "pyvenv.cfg")))
        ? realpath(join(root, name))
        : undefined;
    }),
  );
  const candidates = environments.filter((path) => path !== undefined);
  if (candidates.some((path) => outside(boundary, path)))
    return {
      outcome: "blocked",
      reason: "Environment is outside the workspace boundary",
    };
  if (candidates.length > 1)
    return {
      outcome: "ambiguous",
      reason: "Two Python environments (.venv and venv); ask the user which to keep",
    };
  return undefined;
}

function documentLanguage(path: string, language: string): string {
  const extension = extname(path).toLowerCase();
  return extension === ".tsx"
    ? "typescriptreact"
    : extension === ".jsx"
      ? "javascriptreact"
      : language;
}

function serverLanguage(path: string): { family: ServerFamily; language: string } | undefined {
  const detected = getLanguageFromPath(path);
  const family = detected === "javascript" ? "typescript" : detected;
  if (family !== "typescript" && family !== "python" && family !== "rust") return undefined;
  return {
    family,
    language: documentLanguage(path, detected === "javascript" ? detected : family),
  };
}

type Refusal = { outcome: "blocked" | "ambiguous"; reason: string };

const workspaceHeader = /^\s*\[workspace\]\s*$/mu;

async function cargoWorkspace(root: string, base: string): Promise<string | Refusal> {
  let parentManifest = false;
  for (let dir = root; ; dir = dirname(dir)) {
    const text = await readManifest(join(dir, "Cargo.toml"));
    if (text !== undefined && workspaceHeader.test(text)) return dir;
    if (dir !== root && (await isFile(join(dir, "Cargo.toml")))) parentManifest = true;
    if (dir === base) break;
  }
  return parentManifest
    ? {
        outcome: "ambiguous",
        reason:
          "Parent Cargo.toml without a readable [workspace]; declare [workspace] in the parent or open the crate on its own",
      }
    : root;
}

async function projectRoot(
  family: ServerFamily,
  path: string,
  base: string,
): Promise<string | Refusal | undefined> {
  const directory = dirname(path);
  const nearest =
    (await nearestRoot(directory, base, projectMarkers[family])) ??
    (await nearestRoot(directory, base, fallbackMarkers[family] ?? []));
  if (!nearest || family !== "rust") return nearest;
  return cargoWorkspace(nearest, base);
}

async function environmentProblem(
  family: ServerFamily,
  root: string,
  base: string,
): Promise<Refusal | undefined> {
  if (family === "python") return pythonEnvironment(root, base);
  return undefined;
}

export async function resolveRoute(file: string, boundary: string): Promise<Route> {
  if (!isAbsolute(file) && /^[a-z][a-z0-9+.-]*:/iu.test(file))
    return {
      outcome: "unsupported",
      file,
      reason: "Only filesystem paths are supported",
    };
  const base = await realpath(boundary);
  const path = await realpathIfExists(resolve(base, file));
  if (path === undefined) return { outcome: "unavailable", file, reason: "File does not exist" };
  if (outside(base, path))
    return {
      outcome: "blocked",
      file,
      reason: "File is outside the workspace boundary",
    };
  if (!(await isFile(path)))
    return {
      outcome: "unsupported",
      file: path,
      reason: "Expected a regular file",
    };
  const language = serverLanguage(path);
  if (!language)
    return {
      outcome: "unsupported",
      file: path,
      reason: "No supported language server family",
    };
  const root = await projectRoot(language.family, path, base);
  if (root === undefined)
    return {
      outcome: "unsupported",
      file: path,
      reason: "No recognized project marker",
    };
  if (typeof root !== "string") return { ...root, file: path };
  const problem = await environmentProblem(language.family, root, base);
  if (problem) return { ...problem, file: path };
  return {
    outcome: "completed",
    file: path,
    root,
    server: language.family,
    language: language.language,
    coverage: "local-marker",
  };
}
