import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { expect, it, onTestFinished } from "vitest";

import { applyWorkspaceEdit, moveFile } from "../src/rename.js";
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

it("applies two concurrent edits that list the same files in opposite orders", async () => {
  const root = await directory();
  await writeFile(join(root, "a.ts"), "a\n");
  await writeFile(join(root, "b.ts"), "b\n");
  const edit = (name: string) => [
    { range: { start, end: { line: 0, character: 1 } }, newText: name },
  ];
  const forward = {
    changes: {
      [uriOf(root, "a.ts")]: edit("x"),
      [uriOf(root, "b.ts")]: edit("y"),
    },
  };
  const backward = {
    changes: {
      [uriOf(root, "b.ts")]: edit("z"),
      [uriOf(root, "a.ts")]: edit("w"),
    },
  };
  // Both queues stay held until each edit waits on its first file, so the order the edits
  // take their second queue does not depend on timing.
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = Promise.all(
    ["a.ts", "b.ts"].map((name) => withFileMutationQueue(join(root, name), () => gate)),
  );
  const both = Promise.all([
    applyWorkspaceEdit(forward, root, undefined),
    applyWorkspaceEdit(backward, root, undefined),
  ]).then((outcomes) => outcomes.map(({ outcome }) => outcome));
  await delay(100);
  release();
  await held;
  const stalled = new Promise((resolve) => setTimeout(resolve, 1000, "stalled"));
  expect(await Promise.race([both, stalled])).toEqual(["written", "written"]);
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

it("does not overwrite a file that appeared at the destination after planning", async () => {
  const root = await directory();
  await writeFile(join(root, "old.ts"), "moved\n");
  await writeFile(join(root, "new.ts"), "kept\n");
  await expect(moveFile({ from: join(root, "old.ts"), to: join(root, "new.ts") })).rejects.toThrow(
    "EEXIST",
  );
  expect(await filesIn(root, ["old.ts", "new.ts"])).toEqual(["moved\n", "kept\n"]);
});

it("leaves no destination behind when the old name cannot be removed", async () => {
  const root = await directory();
  const source = join(root, "locked");
  await mkdir(source);
  await writeFile(join(source, "old.ts"), "moved\n");
  await chmod(source, 0o555);
  onTestFinished(() => chmod(source, 0o755));
  await expect(
    moveFile({ from: join(source, "old.ts"), to: join(root, "new.ts") }),
  ).rejects.toThrow("EACCES");
  expect(await readdir(root)).toEqual(["locked"]);
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
