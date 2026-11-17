import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { resolveRoute } from "../src/routing.js";
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
