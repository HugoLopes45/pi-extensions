import { realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

import { presetFor, presets, type Preset, type Refusal, type RootHook } from "./presets.js";
import { isFile, nearestRoot, outside, realpathIfExists } from "./project-files.js";
import type { ServerConfig } from "./settings.js";

export type ServerDefinition = {
  name: string;
  fileTypes: readonly string[];
  rootMarkers: readonly string[];
  languageIds: Readonly<Partial<Record<string, string>>>;
  dependencyDirs: readonly string[];
  rootHook?: RootHook | undefined;
};

export type Route =
  | {
      outcome: "completed";
      file: string;
      root: string;
      language: string;
      server: string;
      coverage: "local-marker";
    }
  | {
      outcome: "blocked" | "unsupported" | "ambiguous" | "unavailable";
      file: string;
      reason: string;
    };

// Configured servers come first in settings order, so they win over unconfigured built-ins.
export function serverDefinitions(
  servers: Readonly<Record<string, ServerConfig>>,
): ServerDefinition[] {
  const configured = Object.entries(servers).map(([name, config]) => definitionOf(name, config));
  const unconfigured = Object.keys(presets)
    .filter((name) => !Object.hasOwn(servers, name))
    .map((name) => definitionOf(name));
  return [...configured, ...unconfigured];
}

// A custom server has no preset; settings already require its own file types and markers.
const noPreset: Preset = { fileTypes: [], rootMarkers: [], languageIds: {} };

function definitionOf(name: string, config?: ServerConfig): ServerDefinition {
  const preset = presetFor(name) ?? noPreset;
  return {
    name,
    fileTypes: config?.fileTypes ?? preset.fileTypes,
    rootMarkers: config?.rootMarkers ?? preset.rootMarkers,
    languageIds: { ...preset.languageIds, ...config?.languageId },
    dependencyDirs: preset.dependencyDirs ?? [],
    rootHook: preset.rootHook,
  };
}

function matchDefinition(
  path: string,
  definitions: readonly ServerDefinition[],
): { definition: ServerDefinition; language: string } | undefined {
  const extension = extname(path).toLowerCase();
  const definition = definitions.find((candidate) => candidate.fileTypes.includes(extension));
  if (!definition) return undefined;
  return {
    definition,
    language: definition.languageIds[extension] ?? definition.name,
  };
}

function projectRoot(
  definition: ServerDefinition,
  path: string,
  base: string,
): Promise<string | Refusal | undefined> {
  const directory = dirname(path);
  return definition.rootHook
    ? definition.rootHook(directory, base, definition.rootMarkers, definition.dependencyDirs)
    : nearestRoot(directory, base, definition.rootMarkers, definition.dependencyDirs);
}

export async function resolveRoute(
  file: string,
  boundary: string,
  definitions: readonly ServerDefinition[] = serverDefinitions({}),
): Promise<Route> {
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
  const match = matchDefinition(path, definitions);
  if (!match)
    return {
      outcome: "unsupported",
      file: path,
      reason: "No server declares this file type",
    };
  const root = await projectRoot(match.definition, path, base);
  if (root === undefined)
    return {
      outcome: "unsupported",
      file: path,
      reason: "No recognized project marker",
    };
  if (typeof root !== "string") return { ...root, file: path };
  return {
    outcome: "completed",
    file: path,
    root,
    server: match.definition.name,
    language: match.language,
    coverage: "local-marker",
  };
}
