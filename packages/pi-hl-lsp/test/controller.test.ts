import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished } from "vitest";

import { LspController } from "../src/controller.js";
import type { LspSettings } from "../src/settings.js";
import { directory } from "./fixtures.js";

async function controller(mode = "normal", consent = true, trusted = true) {
  const cwd = await directory();
  await writeFile(join(cwd, "tsconfig.json"), "{}");
  const file = join(cwd, "index.ts");
  await writeFile(file, "const value = 1;\n");
  const spawnLog = join(cwd, "spawns.log");
  const settings: LspSettings = {
    enabled: true,
    name: "HL LSP",
    allowProjectExecution: consent,
    timeoutMs: 5000,
    servers: {
      typescript: {
        command: process.execPath,
        args: [fileURLToPath(new URL("./protocol-server.ts", import.meta.url)), mode, spawnLog],
      },
    },
  };
  const instance = new LspController(cwd, settings, trusted);
  onTestFinished(() => instance.dispose());
  return { instance, file, spawnLog };
}

it("requires separate global project-execution consent before launch", async () => {
  const { instance, file } = await controller("normal", false);
  expect(await instance.query("hover", file, { line: 0, character: 6 })).toMatchObject({
    outcome: "blocked",
  });
});

it("requires project trust before launch, even with global consent", async () => {
  const { instance, file, spawnLog } = await controller("normal", true, false);
  expect(await instance.query("hover", file, { line: 0, character: 6 })).toMatchObject({
    outcome: "blocked",
  });
  await expect(readFile(spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("routes, synchronizes, and returns bounded read-only hover output", async () => {
  const { instance, file } = await controller();
  const result = await instance.query("hover", file, { line: 0, character: 6 });
  expect(result).toHaveProperty("response", expect.stringContaining("const value"));
  expect(result).toMatchObject({
    outcome: "completed",
    server: "typescript",
    source: "untrusted_lsp",
  });
});

it("reports unversioned empty diagnostics as partial and omits automatic certification", async () => {
  const { instance, file } = await controller();
  expect(await instance.query("diagnostics", file)).toMatchObject({
    outcome: "partial",
    evidence: "unversioned_observation",
    projectComplete: false,
  });
  expect(await instance.summary()).toBeUndefined();
});

it("does not issue requests for capabilities that the server did not advertise", async () => {
  const { instance, file } = await controller();
  expect(await instance.query("definition", file, { line: 0, character: 6 })).toMatchObject({
    outcome: "unsupported",
  });
});

it("prevents use after disposal", async () => {
  const { instance, file } = await controller();
  await instance.dispose();
  const result = await instance.query("hover", file, { line: 0, character: 6 });
  expect(result).toMatchObject({ outcome: "unavailable" });
  expect(result).toHaveProperty("reason", expect.stringContaining("closed"));
});
