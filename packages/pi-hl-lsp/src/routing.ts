import { realpath, stat } from "node:fs/promises";
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
  python: ["pyproject.toml", "pyrightconfig.json"],
  rust: ["Cargo.toml", "rust-project.json"],
};

async function nearestRoot(
  root: string,
  boundary: string,
  markers: string[],
): Promise<string | undefined> {
  const matches = await Promise.all(markers.map((marker) => isFile(join(root, marker))));
  if (matches.some(Boolean)) return root;
  return root === boundary ? undefined : nearestRoot(dirname(root), boundary, markers);
}

async function pythonEnvironment(
  root: string,
  boundary: string,
): Promise<{ outcome: "blocked" | "ambiguous" | "unsupported"; reason: string } | undefined> {
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
  if (candidates.length)
    return {
      outcome: candidates.length > 1 ? "ambiguous" : "unsupported",
      reason: "Project environment binding requires an explicit policy",
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

async function environmentProblem(
  family: ServerFamily,
  root: string,
  base: string,
): Promise<{ outcome: "blocked" | "ambiguous" | "unsupported"; reason: string } | undefined> {
  if (family === "python") return pythonEnvironment(root, base);
  if (
    family === "rust" &&
    root !== base &&
    (await nearestRoot(dirname(root), base, ["Cargo.toml"]))
  )
    return {
      outcome: "ambiguous",
      reason: "Nested Cargo manifests require workspace resolution",
    };
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
      file: path,
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
  const root = await nearestRoot(dirname(path), base, projectMarkers[language.family]);
  if (!root)
    return {
      outcome: "unsupported",
      file: path,
      reason: "No recognized project marker",
    };
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
