import { spawn } from "node:child_process";
import { once } from "node:events";
import type * as fsPromises from "node:fs/promises";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { expect, it, onTestFinished, vi } from "vitest";

import { applyWorkspaceEdit, moveFile, recoverInterruptedEdits } from "../src/rename.js";
import { directory } from "./fixtures.js";

// Set to an error code, link fails with it, as on a file system without hard links.
const links = vi.hoisted(() => ({
  failure: undefined as string | undefined,
  editorSave: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (links.failure === undefined) return actual.link(from, to);
      if (links.editorSave) await actual.writeFile(links.editorSave, "editor save");
      throw Object.assign(new Error(`${links.failure}: link failed`), {
        code: links.failure,
      });
    },
  };
});

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

it("applies same-position insertions in server order", async () => {
  const root = await directory();
  const file = join(root, "a.ts");
  await writeFile(file, "tail");
  const edits = ["first ", "second "].map((newText) => ({
    range: { start, end: start },
    newText,
  }));
  const result = await applyWorkspaceEdit(
    { changes: { [uriOf(root, "a.ts")]: edits } },
    root,
    undefined,
  );
  expect(result.outcome).toBe("written");
  expect(await readFile(file, "utf8")).toBe("first second tail");
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

it.each(["EXDEV", "EPERM", "ENOTSUP"])(
  "explains a move refused for want of a hard link (%s)",
  async (code) => {
    const root = await directory();
    await writeFile(join(root, "old.ts"), "moved\n");
    links.failure = code;
    onTestFinished(() => {
      links.failure = undefined;
    });
    await expect(
      moveFile({ from: join(root, "old.ts"), to: join(root, "new.ts") }),
    ).rejects.toThrow(`The file system refuses the hard link that moving the file needs (${code})`);
  },
);

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

const originals = ["const value = 1;\n", "import { value } from './index';\n"];
const renamed = ["let value = 1;\n", "import { renamed } from './index';\n"];

// Writes index.ts and other.ts with the original text; the edit gives them the renamed text.
async function twoFiles(root: string) {
  await writeFile(join(root, "index.ts"), originals[0] ?? "");
  await writeFile(join(root, "other.ts"), originals[1] ?? "");
  return {
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
}

it("keeps an intervening editor save and the journal when a move fails", async () => {
  const agentDir = await directory();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const root = await directory();
  const response = await twoFiles(root);
  const move = { from: join(root, "other.ts"), to: join(root, "moved.ts") };
  Object.assign(links, {
    failure: "EXDEV",
    editorSave: join(root, "index.ts"),
  });
  onTestFinished(() => {
    Object.assign(links, { failure: undefined, editorSave: undefined });
    vi.unstubAllEnvs();
  });
  const outcome = await applyWorkspaceEdit(response, root, undefined, move);
  expect(await filesIn(root, ["index.ts", "other.ts"])).toEqual(["editor save", renamed[1]]);
  expect(outcome.outcome).toBe("failed");
  const journalDir = join(agentDir, "hl-lsp", "journal");
  const [name] = await readdir(journalDir);
  const entry = join(journalDir, name ?? "");
  expect(JSON.stringify(outcome)).toContain(entry);
  expect(JSON.stringify(outcome)).toContain("index.ts, other.ts");
  expect(JSON.parse(await readFile(entry, "utf8"))).toMatchObject({
    files: [{ original: originals[0] }, { original: originals[1] }],
    move,
  });
});

it("refuses an edit of a read-only file before writing any file", async () => {
  const root = await directory();
  const response = await twoFiles(root);
  await chmod(join(root, "other.ts"), 0o444);
  const outcome = await applyWorkspaceEdit(response, root, undefined);
  expect(outcome).toEqual({
    outcome: "refused",
    reason: "other.ts is read-only",
  });
  expect(await filesIn(root, ["index.ts", "other.ts"])).toEqual(originals);
});

it("keeps the permissions of an edited file", async () => {
  const root = await directory();
  const response = await twoFiles(root);
  await chmod(join(root, "index.ts"), 0o664);
  await applyWorkspaceEdit(response, root, undefined);
  expect((await stat(join(root, "index.ts"))).mode & 0o777).toBe(0o664);
});

// Starts an apply of the two-file edit with a move in a child process, paused before it removes its journal.
async function pausedApply(root: string) {
  vi.stubEnv("PI_CODING_AGENT_DIR", await directory());
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const response = await twoFiles(root);
  const fixture = fileURLToPath(new URL("paused-apply.ts", import.meta.url));
  const from = join(root, "other.ts");
  const to = join(root, "moved.ts");
  const child = spawn(process.execPath, [fixture, root, JSON.stringify(response), from, to], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  onTestFinished(async () => {
    child.kill("SIGKILL");
    await exited;
  });
  for await (const chunk of child.stdout)
    if (String(chunk).includes("paused")) return { child, exited };
  throw new Error("The child process exited before it paused");
}

it("leaves an edit alone while the process that applies it runs", async () => {
  const root = await directory();
  await pausedApply(root);
  expect(await recoverInterruptedEdits()).toEqual([]);
  expect(await filesIn(root, ["index.ts", "moved.ts"])).toEqual(renamed);
});

it("reports a killed edit without changing saved text or moving files", async () => {
  const root = await directory();
  const { child, exited } = await pausedApply(root);
  child.kill("SIGKILL");
  await exited;
  await writeFile(join(root, "moved.ts"), "editor save");
  const [note] = await recoverInterruptedEdits();
  expect(await readdir(root)).toEqual(["index.ts", "moved.ts"]);
  expect(await filesIn(root, ["index.ts", "moved.ts"])).toEqual([renamed[0], "editor save"]);
  expect(note).toContain(join(root, "index.ts"));
  expect(note).toContain(join(root, "moved.ts"));
  expect(await recoverInterruptedEdits()).toEqual([note]);
});
