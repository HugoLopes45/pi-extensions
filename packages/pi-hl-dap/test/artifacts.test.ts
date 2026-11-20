import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "vitest";

import { createDapArtifacts, DAP_MAX_OUTPUT_BYTES, DapOutputBuffer } from "../src/artifacts.js";

test("retains the newest unread Debuggee output and reports discarded bytes", () => {
  const output = new DapOutputBuffer();

  output.append("a".repeat(DAP_MAX_OUTPUT_BYTES));
  output.append("tail");

  expect(output.drain()).toEqual({
    discardedBytes: 4,
    text: `${"a".repeat(DAP_MAX_OUTPUT_BYTES - 4)}tail`,
  });
  expect(output.drain()).toEqual({ discardedBytes: 0, text: "" });
});

test("discarding half of a UTF-8 character discards the whole character", () => {
  const output = new DapOutputBuffer();
  const tail = "a".repeat(DAP_MAX_OUTPUT_BYTES - 1);
  output.append("é" + tail);
  const result = output.drain();
  expect(result.discardedBytes).toBe(2);
  expect(result.text === tail).toBe(true);
});

test.each(["persisted", "in-memory"])(
  "writes private Result Spills and adapter stderr paths, then cleans up for %s Pi sessions",
  async (mode) => {
    const sessionDirectory =
      mode === "persisted" ? await mkdtemp(join(tmpdir(), "pi-hl-dap-session-")) : "";
    const files = await createDapArtifacts(sessionDirectory);
    try {
      const spillPath = await files.writeResultSpill("complete output");
      const traversalPath = await files.getAdapterStderrPath();
      const stderrPath = await files.getAdapterStderrPath();

      expect(dirname(files.directoryPath)).toBe(sessionDirectory || tmpdir());
      expect(await readFile(spillPath, "utf8")).toBe("complete output");
      expect(dirname(traversalPath)).toBe(files.directoryPath);
      expect(await readFile(stderrPath)).toEqual(Buffer.alloc(0));
      expect((await stat(files.directoryPath)).mode & 0o777).toBe(0o700);
      expect((await stat(spillPath)).mode & 0o777).toBe(0o600);

      await files.dispose();
      await expect(stat(files.directoryPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(files.writeResultSpill("late")).rejects.toThrow(
        "HL DAP: session files are closed",
      );
    } finally {
      await files.dispose();
      if (sessionDirectory !== "") {
        await rm(sessionDirectory, { force: true, recursive: true });
      }
    }
  },
);
