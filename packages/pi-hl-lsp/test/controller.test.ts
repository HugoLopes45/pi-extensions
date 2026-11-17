import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished, vi } from "vitest";

import { LspController } from "../src/controller.js";
import { LanguageServer } from "../src/server.js";
import type { LspSettings } from "../src/settings.js";
import { directory } from "./fixtures.js";

const fixture = fileURLToPath(new URL("./protocol-server.ts", import.meta.url));
// Protocol events the fixture logged after its launch line.
const events = async (spawnLog: string) =>
  (await readFile(spawnLog, "utf8")).trim().split("\n").slice(1);

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
        args: [fixture, mode, spawnLog],
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
  "keeps an evicted failed instance visible until its group is killed",
  async () => {
    const { instance, file, spawnLog } = await controller("stubborn-garbage");
    await packages(join(file, ".."), 1);
    const root = join(file, "..", "package-0");
    const failed = join(root, "index.ts");
    await instance.query("diagnostics", failed);
    const group = -(await lastPid(spawnLog));
    const failing = instance
      .query("hover", failed, { line: 0, character: 6 })
      .catch(() => undefined);
    await vi.waitFor(() => expect(instance.status().instances[0]?.active).toBe(false));
    const kill = vi.spyOn(process, "kill");
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const evicting = instance.query("diagnostics", file);
    // controller.dispose() only reaches instances still in the map, so the evicted one must
    // stay listed until its escalation ends.
    while (!kill.mock.calls.some(([target, signal]) => target === group && signal === "SIGKILL")) {
      expect(instance.status().instances.map((listed) => listed.root)).toContain(root);
      await delay(10);
    }
    await evicting;
    await failing;
  },
);

// The first server's group looks gone and refuses SIGKILL, so its cleanup rejects at once
// while the other servers still run their two-second escalation.
function refuseFirstGroup(spawnLog: string) {
  const first = () => Number(readFileSync(spawnLog, "utf8").split("\n")[0]);
  const kill = process.kill.bind(process);
  const spy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target !== -first()) return kill(target, signal);
    if (signal === 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    if (signal === "SIGKILL") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill(target, signal);
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
    process.kill(first(), "SIGKILL");
  });
  return spy;
}

const lastPid = async (spawnLog: string) =>
  Number((await readFile(spawnLog, "utf8")).trim().split("\n").at(-1));

it.skipIf(process.platform === "win32")(
  "rejects dispose only after every other instance finishes its cleanup",
  async () => {
    const { instance, file, spawnLog } = await controller("stubborn-server");
    for (const path of await packages(join(file, ".."), 2))
      await instance.query("hover", path, { line: 0, character: 6 });
    const group = -(await lastPid(spawnLog));
    const kill = refuseFirstGroup(spawnLog);
    await expect(instance.dispose()).rejects.toThrow("LSP process group did not stop");
    expect(kill.mock.calls).toContainEqual([group, "SIGKILL"]);
  },
);

it.skipIf(process.platform === "win32")(
  "evicts failed instances only after every cleanup finishes",
  async () => {
    const { instance, file, spawnLog } = await controller("stubborn-garbage");
    const kill = refuseFirstGroup(spawnLog);
    const paths = await packages(join(file, ".."), 2);
    for (const path of paths) await instance.query("diagnostics", path);
    const group = -(await lastPid(spawnLog));
    const failing = paths.map((path) =>
      instance.query("hover", path, { line: 0, character: 6 }).catch(() => undefined),
    );
    await vi.waitFor(() =>
      expect(instance.status().instances.map((listed) => listed.active)).toEqual([false, false]),
    );
    await expect(instance.query("diagnostics", file)).rejects.toThrow(
      "LSP process group did not stop",
    );
    expect(kill.mock.calls).toContainEqual([group, "SIGKILL"]);
    await Promise.all(failing);
  },
);

it("shuts a healthy initialized server down with shutdown, then exit", async () => {
  const { instance, file, spawnLog } = await controller("handshake");
  await instance.query("hover", file, { line: 0, character: 6 });
  await instance.dispose();
  expect(await events(spawnLog)).toEqual(["shutdown", "exit"]);
});

it("returns soon after a healthy server exits", async () => {
  const { instance, file } = await controller("handshake");
  await instance.query("hover", file, { line: 0, character: 6 });
  const started = performance.now();
  await instance.dispose();
  expect(performance.now() - started).toBeLessThan(40);
});

it.each([
  ["sync-log", ["didOpen 1", "didChange 2", "didClose", "didOpen 3"]],
  ["sync-open-close", ["didOpen 1", "didClose", "didOpen 2", "didClose", "didOpen 3"]],
])("synchronizes a changed file and a different file (%s)", async (mode, expected) => {
  const { instance, file, spawnLog } = await controller(mode);
  const other = join(file, "..", "other.ts");
  await writeFile(other, "const other = 1;\n");
  await instance.query("diagnostics", file);
  await writeFile(file, "const value = 2;\n");
  // The observation must come from the new version, not from the first snapshot.
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    documentVersion: 2,
  });
  await instance.query("diagnostics", other);
  expect(await events(spawnLog)).toEqual(expected);
});

it("falls back to signals within the budget when shutdown gets no answer", async () => {
  const { instance, file, spawnLog } = await controller("mute-shutdown");
  await instance.query("hover", file, { line: 0, character: 6 });
  const started = performance.now();
  await instance.dispose();
  expect(performance.now() - started).toBeLessThan(2500);
  expect(await events(spawnLog)).toEqual(["shutdown"]);
});

it.skipIf(process.platform === "win32")(
  "keeps one two-second budget for a server that ignores shutdown and SIGTERM",
  async () => {
    const { instance, file, spawnLog } = await controller("stubborn-mute");
    await instance.query("hover", file, { line: 0, character: 6 });
    const started = performance.now();
    await instance.dispose();
    expect(performance.now() - started).toBeLessThan(2500);
    expect(await events(spawnLog)).toEqual(["shutdown"]);
  },
);

it("does not send shutdown to a server that never finished initializing", async () => {
  const { instance, file, spawnLog } = await controller("wrong-encoding");
  await expect(instance.query("hover", file, { line: 0, character: 6 })).rejects.toThrow(
    "Unsupported LSP position encoding",
  );
  await instance.dispose();
  expect(await events(spawnLog)).toEqual([]);
});

it("sends nothing but exit after shutdown when a pending request is aborted", async () => {
  const cwd = await directory();
  const spawnLog = join(cwd, "spawns.log");
  const client = new LanguageServer(
    { command: process.execPath, args: [fixture, "slow-shutdown", spawnLog] },
    cwd,
    5000,
    () => {},
  );
  onTestFinished(() => client.dispose());
  await client.initialize();
  const abort = new AbortController();
  const outcome = client.request("textDocument/hover", {}, abort.signal).then(
    () => "resolved",
    (error: unknown) => error,
  );
  const disposing = client.dispose();
  // The fixture answers shutdown after 500 ms; the abort lands inside that window.
  await vi.waitFor(async () => expect(await events(spawnLog)).toContain("shutdown"));
  abort.abort(new Error("Caller cancelled"));
  await disposing;
  expect(await outcome).toHaveProperty("message", "Caller cancelled");
  expect(await events(spawnLog)).toEqual(["shutdown", "exit"]);
});

it("prevents use after disposal", async () => {
  const { instance, file } = await controller();
  await instance.dispose();
  const result = await instance.query("hover", file, { line: 0, character: 6 });
  expect(result).toMatchObject({ outcome: "unavailable" });
  expect(result).toHaveProperty("reason", expect.stringContaining("closed"));
});
