import { realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";

import { presets, type Refusal } from "./presets.js";
import { isFile, nearestRoot, outside, realpathIfExists } from "./project-files.js";
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

async function projectRoot(
  family: ServerFamily,
  path: string,
  base: string,
): Promise<string | Refusal | undefined> {
  const preset = presets[family];
  const directory = dirname(path);
  const nearest =
    (await nearestRoot(directory, base, preset.rootMarkers)) ??
    (preset.fallbackMarkers
      ? await nearestRoot(directory, base, preset.fallbackMarkers)
      : undefined);
  if (!nearest || !preset.workspaceRoot) return nearest;
  return preset.workspaceRoot(nearest, base);
}

async function environmentProblem(
  family: ServerFamily,
  root: string,
  base: string,
): Promise<Refusal | undefined> {
  return presets[family].environment?.(root, base);
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
