import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { detectLanguages, findServer } from "../src/detect.js";
import { directory } from "./fixtures.js";

async function files(root: string, paths: readonly string[]) {
  for (const path of paths) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "");
  }
}

async function executable(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n", { mode: 0o755 });
}

it("detects each language from a marker within two levels", async () => {
  const root = await directory();
  await files(root, ["Cargo.toml", "packages/web/package.json", "tools/requirements.txt"]);
  await mkdir(join(root, "ios", "App.xcodeproj"), { recursive: true });
  const started = performance.now();
  const found = await detectLanguages(root);
  expect(performance.now() - started).toBeLessThan(200);
  expect(Object.fromEntries(found)).toEqual({
    rust: root,
    typescript: join(root, "packages", "web"),
    python: join(root, "tools"),
    swift: join(root, "ios"),
  });
});

it("skips git-ignored, hidden and linked directories, and markers deeper than two levels", async () => {
  const root = await directory();
  await writeFile(join(root, ".gitignore"), "# deps\nnode_modules/\n/target\n*.log\n!keep\n");
  await files(root, [
    "node_modules/left-pad/package.json",
    "target/debug/Cargo.toml",
    ".git/pyproject.toml",
    "a/b/c/Package.swift",
  ]);
  const elsewhere = await directory();
  await files(elsewhere, ["Cargo.toml"]);
  await symlink(elsewhere, join(root, "linked"));
  expect(Object.fromEntries(await detectLanguages(root))).toEqual({});
});

// Entries are read in name order, so the caps cut the same directories on every file system.
it("reads at most 64 subdirectories of one directory", async () => {
  const root = await directory();
  for (let index = 0; index < 100; index++)
    await mkdir(join(root, `d${String(index).padStart(3, "0")}`));
  await files(root, ["d070/Cargo.toml", "d000/pyproject.toml"]);
  expect([...(await detectLanguages(root)).keys()]).toEqual(["python"]);
});

it("stops reading after 500 directories", async () => {
  const root = await directory();
  for (const parent of "abcdefghij")
    for (let index = 0; index < 60; index++)
      await mkdir(join(root, parent, `x${String(index).padStart(2, "0")}`), {
        recursive: true,
      });
  await files(root, ["j/x00/Cargo.toml", "a/x00/pyproject.toml"]);
  expect([...(await detectLanguages(root)).keys()]).toEqual(["python"]);
});

it("prefers a project-local server, then the first candidate on PATH", async () => {
  const root = await directory();
  const bin = join(root, "outside-bin");
  await executable(join(bin, "typescript-language-server"));
  await executable(join(bin, "pyright-langserver"));
  const path = ["relative/bin", bin].join(":");
  expect(await findServer("typescript", root, root, path)).toEqual({
    command: join(bin, "typescript-language-server"),
    args: ["--stdio"],
  });
  await executable(join(root, "node_modules", ".bin", "typescript-language-server"));
  expect(await findServer("typescript", root, root, path)).toEqual({
    command: join(root, "node_modules", ".bin", "typescript-language-server"),
    args: ["--stdio"],
  });
  expect(await findServer("python", root, root, path)).toEqual({
    command: join(bin, "pyright-langserver"),
    args: ["--stdio"],
  });
});

it("keeps a shim path as found and skips files that cannot run", async () => {
  const root = await directory();
  const bin = join(root, "bin");
  await executable(join(root, "rustup"));
  await mkdir(bin);
  await symlink(join(root, "rustup"), join(bin, "rust-analyzer"));
  expect(await findServer("rust", root, root, bin)).toEqual({
    command: join(bin, "rust-analyzer"),
    args: [],
  });
  const plain = join(root, "plain");
  await files(root, ["plain/sourcekit-lsp"]);
  expect(await findServer("swift", root, root, plain)).toBeUndefined();
  expect(await findServer("swift", root, root, undefined)).toBeUndefined();
});
