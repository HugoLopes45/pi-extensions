import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isFile, outside, readManifest } from "./project-files.js";
import type { ServerFamily } from "./settings.js";

export type Refusal = { outcome: "blocked" | "ambiguous"; reason: string };

type Preset = {
  rootMarkers: string[];
  // Consulted only when no rootMarkers entry is found.
  fallbackMarkers?: string[];
  workspaceRoot?: (root: string, base: string) => Promise<string | Refusal>;
  environment?: (root: string, base: string) => Promise<Refusal | undefined>;
};

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

export const presets: Record<ServerFamily, Preset> = {
  typescript: {
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  python: {
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg"],
    fallbackMarkers: ["requirements.txt"],
    environment: pythonEnvironment,
  },
  rust: {
    rootMarkers: ["Cargo.toml", "rust-project.json"],
    workspaceRoot: cargoWorkspace,
  },
};
