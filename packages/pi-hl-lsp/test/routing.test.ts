import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { resolveRoute, serverDefinitions } from "../src/routing.js";
import { directory } from "./fixtures.js";

it("routes identical TSX filenames to independent nearest package roots", async () => {
  const boundary = await directory();
  await Promise.all(
    ["web", "shared"].map(async (name) => {
      const root = join(boundary, name);
      await mkdir(root);
      await writeFile(join(root, "tsconfig.json"), "{}");
      const file = join(root, "App.tsx");
      await writeFile(file, "export const value = 1");
      expect(await resolveRoute(file, boundary)).toEqual({
        outcome: "completed",
        file,
        root,
        language: "typescriptreact",
        server: "typescript",
        coverage: "local-marker",
      });
    }),
  );
});

it("routes a custom server by its declared file type and root marker", async () => {
  const root = await directory();
  await mkdir(join(root, "project.foo-project"));
  const file = join(root, "main.foo");
  await writeFile(file, "");
  const definitions = serverDefinitions({
    mylsp: {
      command: "/usr/bin/mylsp",
      args: [],
      fileTypes: [".foo"],
      rootMarkers: ["*.foo-project"],
    },
  });
  expect(await resolveRoute(file, root, definitions)).toEqual({
    outcome: "completed",
    file,
    root,
    language: "mylsp",
    server: "mylsp",
    coverage: "local-marker",
  });
});

it("routes a Swift file to the swift server by Package.swift or an Xcode project", async () => {
  const swiftPackage = await directory();
  await writeFile(join(swiftPackage, "Package.swift"), "");
  await mkdir(join(swiftPackage, "Sources"));
  const packageFile = join(swiftPackage, "Sources", "main.swift");
  await writeFile(packageFile, "");
  const app = await directory();
  await mkdir(join(app, "App.xcodeproj"));
  await mkdir(join(app, "App"));
  const appFile = join(app, "App", "ContentView.swift");
  await writeFile(appFile, "");
  const definitions = serverDefinitions({});
  expect(await resolveRoute(packageFile, swiftPackage, definitions)).toEqual({
    outcome: "completed",
    file: packageFile,
    root: swiftPackage,
    language: "swift",
    server: "swift",
    coverage: "local-marker",
  });
  expect(await resolveRoute(appFile, app, definitions)).toEqual({
    outcome: "completed",
    file: appFile,
    root: app,
    language: "swift",
    server: "swift",
    coverage: "local-marker",
  });
});

it("replaces the built-in file types of a configured built-in server", async () => {
  const root = await directory();
  await writeFile(join(root, "tsconfig.json"), "{}");
  const file = join(root, "index.ts");
  await writeFile(file, "");
  const definitions = serverDefinitions({
    typescript: {
      command: "/usr/bin/ts-ls",
      args: [],
      fileTypes: [".vue"],
      rootMarkers: ["tsconfig.json"],
    },
  });
  expect(await resolveRoute(file, root, definitions)).toMatchObject({
    outcome: "unsupported",
    reason: "No server declares this file type",
  });
});

it("rejects escaped file symlinks", async () => {
  const root = await directory();
  const outside = await directory();
  const file = join(outside, "other.ts");
  await writeFile(file, "");
  await symlink(file, join(root, "link.ts"));
  expect(await resolveRoute(join(root, "link.ts"), root)).toMatchObject({
    outcome: "blocked",
    file: join(root, "link.ts"),
  });
});

it("reports competing Python environments instead of selecting one", async () => {
  const root = await directory();
  await writeFile(join(root, "pyproject.toml"), "");
  await writeFile(join(root, "main.py"), "");
  await Promise.all(
    [".venv", "venv"].map(async (name) => {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "pyvenv.cfg"), "");
    }),
  );
  expect(await resolveRoute(join(root, "main.py"), root)).toMatchObject({
    outcome: "ambiguous",
  });
});

it("names both Python environments and the fix in the refusal", async () => {
  const root = await directory();
  await writeFile(join(root, "pyproject.toml"), "");
  await writeFile(join(root, "main.py"), "");
  await Promise.all(
    [".venv", "venv"].map(async (name) => {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "pyvenv.cfg"), "");
    }),
  );
  expect(await resolveRoute(join(root, "main.py"), root)).toMatchObject({
    outcome: "ambiguous",
    reason: "Two Python environments (.venv and venv); ask the user which to keep",
  });
});

it("routes a Python project with one environment", async () => {
  const root = await directory();
  await writeFile(join(root, "pyproject.toml"), "");
  await writeFile(join(root, "main.py"), "");
  await mkdir(join(root, ".venv"));
  await writeFile(join(root, ".venv", "pyvenv.cfg"), "");
  expect(await resolveRoute(join(root, "main.py"), root)).toEqual({
    outcome: "completed",
    file: join(root, "main.py"),
    root,
    language: "python",
    server: "python",
    coverage: "local-marker",
  });
});

it("blocks a Python environment symlinked outside the boundary", async () => {
  const root = await directory();
  const outside = await directory();
  await writeFile(join(root, "pyproject.toml"), "");
  await writeFile(join(root, "main.py"), "");
  await writeFile(join(outside, "pyvenv.cfg"), "");
  await symlink(outside, join(root, ".venv"));
  expect(await resolveRoute(join(root, "main.py"), root)).toMatchObject({
    outcome: "blocked",
  });
});

it("routes a Python project marked only by requirements.txt", async () => {
  const root = await directory();
  await writeFile(join(root, "requirements.txt"), "");
  await writeFile(join(root, "main.py"), "");
  expect(await resolveRoute(join(root, "main.py"), root)).toEqual({
    outcome: "completed",
    file: join(root, "main.py"),
    root,
    language: "python",
    server: "python",
    coverage: "local-marker",
  });
});

it("routes a Python file under a nested requirements.txt to the root pyproject.toml", async () => {
  const root = await directory();
  await writeFile(join(root, "pyproject.toml"), "");
  const tests = join(root, "tests");
  await mkdir(tests);
  await writeFile(join(tests, "requirements.txt"), "");
  await writeFile(join(tests, "test_x.py"), "");
  expect(await resolveRoute(join(tests, "test_x.py"), root)).toMatchObject({
    outcome: "completed",
    root,
  });
});

it("does not guess the root of nested Cargo manifests", async () => {
  const root = await directory();
  await writeFile(join(root, "Cargo.toml"), "");
  const nested = join(root, "crate");
  await mkdir(nested);
  await writeFile(join(nested, "Cargo.toml"), "");
  await writeFile(join(nested, "lib.rs"), "");
  expect(await resolveRoute(join(nested, "lib.rs"), root)).toMatchObject({
    outcome: "ambiguous",
  });
});

it("names the parent manifest and the fix when a nested crate has no readable workspace", async () => {
  const root = await directory();
  await writeFile(join(root, "Cargo.toml"), "");
  const nested = join(root, "crate");
  await mkdir(nested);
  await writeFile(join(nested, "Cargo.toml"), "");
  await writeFile(join(nested, "lib.rs"), "");
  expect(await resolveRoute(join(nested, "lib.rs"), root)).toMatchObject({
    outcome: "ambiguous",
    reason:
      "Parent Cargo.toml without a readable [workspace]; declare [workspace] in the parent or open the crate on its own",
  });
});

it("routes a Cargo workspace member to the workspace root", async () => {
  const root = await directory();
  await writeFile(join(root, "Cargo.toml"), '[workspace]\nmembers = ["crate"]\n');
  const crate = join(root, "crate");
  await mkdir(crate);
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "crate"\n');
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), root)).toEqual({
    outcome: "completed",
    file: join(crate, "lib.rs"),
    root,
    language: "rust",
    server: "rust",
    coverage: "local-marker",
  });
});

it("routes a Cargo member to the nearest of two nested workspace manifests", async () => {
  const root = await directory();
  await writeFile(join(root, "Cargo.toml"), "[workspace]\n");
  const middle = join(root, "middle");
  await mkdir(middle);
  await writeFile(join(middle, "Cargo.toml"), "[workspace]\n");
  const crate = join(middle, "crate");
  await mkdir(crate);
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "crate"\n');
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), root)).toMatchObject({
    outcome: "completed",
    root: middle,
  });
});

it("does not use a workspace manifest outside the boundary", async () => {
  const outer = await directory();
  await writeFile(join(outer, "Cargo.toml"), "[workspace]\n");
  const boundary = join(outer, "inner");
  await mkdir(boundary);
  const crate = join(boundary, "crate");
  await mkdir(crate);
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "crate"\n');
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), boundary)).toMatchObject({
    outcome: "completed",
    root: crate,
  });
});

it("does not count a commented workspace header as a workspace", async () => {
  const root = await directory();
  await writeFile(join(root, "Cargo.toml"), "# [workspace]\n");
  const crate = join(root, "crate");
  await mkdir(crate);
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "crate"\n');
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), root)).toMatchObject({
    outcome: "ambiguous",
  });
});

it("does not read a Cargo.toml over 64 KiB as a workspace", async () => {
  const root = await directory();
  await writeFile(join(root, "Cargo.toml"), "[workspace]\n".padEnd(64 * 1024 + 1));
  const crate = join(root, "crate");
  await mkdir(crate);
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "crate"\n');
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), root)).toMatchObject({
    outcome: "ambiguous",
  });
});

it("does not read a directory named Cargo.toml as a manifest", async () => {
  const root = await directory();
  await mkdir(join(root, "Cargo.toml"));
  const crate = join(root, "crate");
  await mkdir(crate);
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "crate"\n');
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), root)).toMatchObject({
    outcome: "completed",
    root: crate,
  });
});

it("refuses a symlinked parent Cargo.toml that targets a workspace outside the boundary", async () => {
  const outer = await directory();
  await writeFile(join(outer, "Cargo.toml"), "[workspace]\n");
  const boundary = join(outer, "inner");
  await mkdir(boundary);
  await symlink(join(outer, "Cargo.toml"), join(boundary, "Cargo.toml"));
  const crate = join(boundary, "crate");
  await mkdir(crate);
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "crate"\n');
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), boundary)).toMatchObject({
    outcome: "ambiguous",
  });
});

it("routes a crate whose own Cargo.toml declares a workspace to itself", async () => {
  const root = await directory();
  const crate = join(root, "crate");
  await mkdir(crate);
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "crate"\n[workspace]\n');
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), root)).toMatchObject({
    outcome: "completed",
    root: crate,
  });
});

it("routes a Cargo member past an intermediate package manifest to the workspace root", async () => {
  const root = await directory();
  await writeFile(join(root, "Cargo.toml"), "[workspace]\n");
  const middle = join(root, "middle");
  await mkdir(middle);
  await writeFile(join(middle, "Cargo.toml"), '[package]\nname = "middle"\n');
  const crate = join(middle, "crate");
  await mkdir(crate);
  await writeFile(join(crate, "Cargo.toml"), '[package]\nname = "crate"\n');
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), root)).toMatchObject({
    outcome: "completed",
    root,
  });
});

it("distinguishes virtual, missing and unmarked files", async () => {
  const root = await directory();
  expect(await resolveRoute("untitled:draft.ts", root)).toMatchObject({
    outcome: "unsupported",
  });
  expect(await resolveRoute(join(root, "missing.ts"), root)).toMatchObject({
    outcome: "unavailable",
  });
  await writeFile(join(root, "main.ts"), "");
  expect(await resolveRoute(join(root, "main.ts"), root)).toMatchObject({
    outcome: "unsupported",
  });
});

it("refuses a directory named like a source file", async () => {
  const root = await directory();
  await writeFile(join(root, "package.json"), "{}");
  await mkdir(join(root, "dir.ts"));
  expect(await resolveRoute(join(root, "dir.ts"), root)).toEqual({
    outcome: "unsupported",
    file: join(root, "dir.ts"),
    reason: "Expected a regular file",
  });
});

it("routes a dependency file under node_modules to the project root", async () => {
  const root = await directory();
  await writeFile(join(root, "package.json"), "{}");
  const pkg = join(root, "node_modules", "pkg");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), "{}");
  await writeFile(join(pkg, "index.d.ts"), "");
  expect(await resolveRoute(join(pkg, "index.d.ts"), root)).toMatchObject({
    outcome: "completed",
    root,
  });
});

it("skips dependency directories only for the language that declares them", async () => {
  const root = await directory();
  await writeFile(join(root, "Cargo.toml"), "[package]\n");
  const crate = join(root, "node_modules", "crate");
  await mkdir(crate, { recursive: true });
  await writeFile(join(crate, "Cargo.toml"), "[package]\n");
  await writeFile(join(crate, "lib.rs"), "");
  expect(await resolveRoute(join(crate, "lib.rs"), root)).toMatchObject({
    outcome: "ambiguous",
  });
});

it("ignores node_modules segments above the boundary", async () => {
  const outer = await directory();
  const boundary = join(outer, "node_modules", "app");
  await mkdir(join(boundary, "src"), { recursive: true });
  await writeFile(join(boundary, "package.json"), "{}");
  await writeFile(join(boundary, "src", "index.ts"), "");
  expect(await resolveRoute(join(boundary, "src", "index.ts"), boundary)).toMatchObject({
    outcome: "completed",
    root: boundary,
  });
});
