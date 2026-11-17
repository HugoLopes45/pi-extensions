import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { applyWorkspaceEdit } from "../src/rename.js";
import { directory } from "./fixtures.js";

const start = { line: 0, character: 0 };

function uriOf(root: string, name: string): string {
  return pathToFileURL(join(root, name)).href;
}

async function filesIn(root: string, names: string[]): Promise<string[]> {
  return Promise.all(names.map((name) => readFile(join(root, name), "utf8")));
}

it("applies every changed file and reports the edit counts", async () => {
  const root = await directory();
  await writeFile(join(root, "index.ts"), "const value = 1;\n");
  await writeFile(join(root, "other.ts"), "import { value } from './index';\n");
  const response = {
    changes: {
      [uriOf(root, "index.ts")]: [
        { range: { start, end: { line: 0, character: 5 } }, newText: "let" },
      ],
      [uriOf(root, "other.ts")]: [
        {
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 14 },
          },
          newText: "renamed",
        },
      ],
    },
  };
  const outcome = await applyWorkspaceEdit(response, root, undefined);
  expect(outcome).toMatchObject({
    outcome: "written",
    changed: [
      { file: join(root, "index.ts"), edits: 1 },
      { file: join(root, "other.ts"), edits: 1 },
    ],
  });
  expect(await filesIn(root, ["index.ts", "other.ts"])).toEqual([
    "let value = 1;\n",
    "import { renamed } from './index';\n",
  ]);
});

it("refuses an edit that targets a file outside the root and writes nothing", async () => {
  const root = await directory();
  const outside = await directory();
  await writeFile(join(root, "index.ts"), "const value = 1;\n");
  await writeFile(join(outside, "elsewhere.ts"), "keep\n");
  const response = {
    changes: {
      [uriOf(root, "index.ts")]: [
        { range: { start, end: { line: 0, character: 5 } }, newText: "let" },
      ],
      [uriOf(outside, "elsewhere.ts")]: [
        { range: { start, end: { line: 0, character: 4 } }, newText: "gone" },
      ],
    },
  };
  const outcome = await applyWorkspaceEdit(response, root, undefined);
  expect(outcome).toMatchObject({ outcome: "refused" });
  expect(JSON.stringify(outcome)).toContain("outside the project");
  expect(await filesIn(root, ["index.ts"])).toEqual(["const value = 1;\n"]);
  expect(await readFile(join(outside, "elsewhere.ts"), "utf8")).toBe("keep\n");
});

it("refuses a versioned edit whose version is not the synchronized one", async () => {
  const root = await directory();
  await writeFile(join(root, "index.ts"), "const value = 1;\n");
  const response = {
    documentChanges: [
      {
        textDocument: { uri: uriOf(root, "index.ts"), version: 7 },
        edits: [{ range: { start, end: { line: 0, character: 5 } }, newText: "let" }],
      },
    ],
  };
  const synced = {
    file: join(root, "index.ts"),
    version: 1,
    text: "const value = 1;\n",
  };
  const outcome = await applyWorkspaceEdit(response, root, synced);
  expect(outcome).toMatchObject({ outcome: "refused" });
  expect(JSON.stringify(outcome)).toContain("is stale");
  expect(await filesIn(root, ["index.ts"])).toEqual(["const value = 1;\n"]);
});

it("refuses overlapping edits in one file", async () => {
  const root = await directory();
  await writeFile(join(root, "index.ts"), "const value = 1;\n");
  const response = {
    changes: {
      [uriOf(root, "index.ts")]: [
        { range: { start, end: { line: 0, character: 5 } }, newText: "let" },
        {
          range: {
            start: { line: 0, character: 3 },
            end: { line: 0, character: 8 },
          },
          newText: "x",
        },
      ],
    },
  };
  const outcome = await applyWorkspaceEdit(response, root, undefined);
  expect(outcome).toMatchObject({ outcome: "refused" });
  expect(JSON.stringify(outcome)).toContain("overlap");
  expect(await filesIn(root, ["index.ts"])).toEqual(["const value = 1;\n"]);
});

it("refuses a resource operation in documentChanges", async () => {
  const root = await directory();
  await writeFile(join(root, "index.ts"), "const value = 1;\n");
  const response = {
    documentChanges: [
      { kind: "create", uri: uriOf(root, "new.ts") },
      {
        textDocument: { uri: uriOf(root, "index.ts"), version: null },
        edits: [{ range: { start, end: { line: 0, character: 5 } }, newText: "let" }],
      },
    ],
  };
  const outcome = await applyWorkspaceEdit(response, root, undefined);
  expect(outcome).toMatchObject({ outcome: "refused" });
  expect(JSON.stringify(outcome)).toContain("resource operations");
  expect(await filesIn(root, ["index.ts"])).toEqual(["const value = 1;\n"]);
});

it("restores the written files when a later file cannot be written", async () => {
  const root = await directory();
  await writeFile(join(root, "index.ts"), "const value = 1;\n");
  await writeFile(join(root, "other.ts"), "import { value } from './index';\n");
  await chmod(join(root, "other.ts"), 0o444);
  const response = {
    changes: {
      [uriOf(root, "index.ts")]: [
        { range: { start, end: { line: 0, character: 5 } }, newText: "let" },
      ],
      [uriOf(root, "other.ts")]: [
        {
          range: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 14 },
          },
          newText: "renamed",
        },
      ],
    },
  };
  const outcome = await applyWorkspaceEdit(response, root, undefined);
  expect(outcome).toMatchObject({ outcome: "failed" });
  expect(JSON.stringify(outcome)).toContain("other.ts");
  expect(await filesIn(root, ["index.ts", "other.ts"])).toEqual([
    "const value = 1;\n",
    "import { value } from './index';\n",
  ]);
});
