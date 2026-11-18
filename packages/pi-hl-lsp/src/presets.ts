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

// How setup finds a language in a project and a server for it.
export type Discovery = {
  // Tried in order; the first one found wins.
  candidates: readonly { command: string; args: readonly string[] }[];
  // Project directories searched before PATH, only in a trusted project.
  localBins: readonly string[];
  // Files that mark the language without being root markers.
  detectMarkers: readonly string[];
  install: string;
};

export type Preset = {
  fileTypes: readonly string[];
  rootMarkers: readonly string[];
  languageIds: Readonly<Partial<Record<string, string>>>;
  rootHook?: RootHook;
  discovery?: Discovery;
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
    discovery: {
      candidates: [{ command: "typescript-language-server", args: ["--stdio"] }],
      localBins: ["node_modules/.bin"],
      detectMarkers: [],
      install: "npm install --global typescript-language-server typescript",
    },
  },
  python: {
    fileTypes: [".py"],
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg"],
    languageIds: {},
    rootHook: pythonRoot,
    discovery: {
      candidates: [
        { command: "basedpyright-langserver", args: ["--stdio"] },
        { command: "pyright-langserver", args: ["--stdio"] },
        { command: "pylsp", args: [] },
      ],
      localBins: [".venv/bin", "venv/bin"],
      detectMarkers: ["requirements.txt"],
      install: "pipx install basedpyright",
    },
  },
  rust: {
    fileTypes: [".rs"],
    rootMarkers: ["Cargo.toml", "rust-project.json"],
    languageIds: {},
    rootHook: cargoRoot,
    discovery: {
      candidates: [{ command: "rust-analyzer", args: [] }],
      localBins: [],
      detectMarkers: [],
      install: "rustup component add rust-analyzer",
    },
  },
  swift: {
    fileTypes: [".swift"],
    rootMarkers: [
      "Package.swift",
      "buildServer.json",
      "*.xcodeproj",
      "*.xcworkspace",
      "compile_commands.json",
    ],
    languageIds: {},
    discovery: {
      candidates: [{ command: "sourcekit-lsp", args: [] }],
      localBins: [],
      detectMarkers: [],
      install:
        "install Xcode (then run xcodebuild -runFirstLaunch) or a Swift toolchain from swift.org",
    },
  },
};

export function presetFor(name: string): Preset | undefined {
  return Object.hasOwn(presets, name) ? presets[name] : undefined;
}
