import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished, vi } from "vitest";

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

it("reports an unreadable summary snapshot once, then drops the stale summary", async () => {
  const { instance, file } = await controller("versioned");
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
  });
  expect(await instance.summary()).toMatchObject({ reportedCount: 1 });
  await writeFile(file, "x".repeat(1024 * 1024 + 1));
  await expect(instance.summary()).rejects.toThrow("1 MiB snapshot limit");
  expect(await instance.summary()).toBeUndefined();
});

it("does not issue requests for capabilities that the server did not advertise", async () => {
  const { instance, file } = await controller();
  expect(await instance.query("definition", file, { line: 0, character: 6 })).toMatchObject({
    outcome: "unsupported",
  });
});

async function packages(cwd: string, count: number) {
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const root = join(cwd, `package-${index}`);
      await mkdir(root);
      await writeFile(join(root, "tsconfig.json"), "{}");
      await writeFile(join(root, "index.ts"), "const value = 1;\n");
      return join(root, "index.ts");
    }),
  );
}

it("does not count failed instances toward the eight-instance limit", async () => {
  const { instance, file, spawnLog } = await controller("wrong-encoding");
  for (const path of await packages(join(file, ".."), 9))
    await expect(instance.query("hover", path, { line: 0, character: 6 })).rejects.toThrow(
      "Unsupported LSP position encoding",
    );
  expect((await readFile(spawnLog, "utf8")).trim().split("\n")).toHaveLength(9);
});

it("refuses a ninth active instance", async () => {
  const { instance, file } = await controller();
  for (const path of await packages(join(file, ".."), 8))
    expect(await instance.query("hover", path, { line: 0, character: 6 })).toMatchObject({
      outcome: "completed",
    });
  expect(await instance.query("hover", file, { line: 0, character: 6 })).toMatchObject({
    outcome: "unavailable",
    reason: "Eight-instance session limit reached",
  });
});

it.skipIf(process.platform === "win32")("rejects dispose when SIGKILL is refused", async () => {
  const { instance, file, spawnLog } = await controller("stubborn-server");
  await instance.query("hover", file, { line: 0, character: 6 });
  const pid = Number((await readFile(spawnLog, "utf8")).trim());
  const kill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (signal === "SIGKILL") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill(target, signal);
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
    process.kill(pid, "SIGKILL");
  });
  await expect(instance.dispose()).rejects.toThrow("LSP process group did not stop");
});

it.skipIf(process.platform === "win32")(
  "waits for an evicted failed instance before dispose resolves",
  async () => {
    const { instance, file, spawnLog } = await controller("stubborn-garbage");
    await instance.query("hover", file, { line: 0, character: 6 });
    await delay(300);
    const group = -Number((await readFile(spawnLog, "utf8")).trim());
    const kill = vi.spyOn(process, "kill");
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const next = instance.query("hover", file, { line: 0, character: 6 }).catch(() => undefined);
    await delay(300);
    await instance.dispose();
    expect(kill.mock.calls).toContainEqual([group, "SIGKILL"]);
    await next;
  },
);

it("prevents use after disposal", async () => {
  const { instance, file } = await controller();
  await instance.dispose();
  const result = await instance.query("hover", file, { line: 0, character: 6 });
  expect(result).toMatchObject({ outcome: "unavailable" });
  expect(result).toHaveProperty("reason", expect.stringContaining("closed"));
});
