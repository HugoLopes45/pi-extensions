import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isFile, nearestRoot, outside, readManifest } from "./project-files.js";

// A root that cannot be chosen; the reason is shown to the user as is.
export type Refusal = { outcome: "blocked" | "ambiguous"; reason: string };
// Refines the root that the markers found in directory; undefined means no root there.
export type RootHook = (
  directory: string,
  boundary: string,
  markers: readonly string[],
) => Promise<string | Refusal | undefined>;

export type Preset = {
  fileTypes: readonly string[];
  rootMarkers: readonly string[];
  languageIds: Readonly<Partial<Record<string, string>>>;
  rootHook?: RootHook;
};

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

// A member crate is served from its Cargo workspace root, so its dependencies resolve.
async function cargoRoot(
  directory: string,
  boundary: string,
  markers: readonly string[],
): Promise<string | Refusal | undefined> {
  const nearest = await nearestRoot(directory, boundary, markers);
  return nearest === undefined ? undefined : cargoWorkspace(nearest, boundary);
}

async function pythonEnvironment(root: string, boundary: string): Promise<Refusal | undefined> {
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

// requirements.txt marks a Python root only when no projectMarkers entry is found.
async function pythonRoot(
  directory: string,
  boundary: string,
  markers: readonly string[],
): Promise<string | Refusal | undefined> {
  const root =
    (await nearestRoot(directory, boundary, markers)) ??
    (await nearestRoot(directory, boundary, ["requirements.txt"]));
  if (root === undefined) return undefined;
  return (await pythonEnvironment(root, boundary)) ?? root;
}

export const presets: Readonly<Record<string, Preset>> = {
  typescript: {
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    languageIds: {
      ".tsx": "typescriptreact",
      ".jsx": "javascriptreact",
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
  },
  python: {
    fileTypes: [".py"],
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg"],
    languageIds: {},
    rootHook: pythonRoot,
  },
  rust: {
    fileTypes: [".rs"],
    rootMarkers: ["Cargo.toml", "rust-project.json"],
    languageIds: {},
    rootHook: cargoRoot,
  },
};

export function presetFor(name: string): Preset | undefined {
  return Object.hasOwn(presets, name) ? presets[name] : undefined;
}
