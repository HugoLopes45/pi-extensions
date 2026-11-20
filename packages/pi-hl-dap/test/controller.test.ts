import childProcess, { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { isRecord } from "pi-hl-utils/record";
import { objectContaining, stringContaining, stringMatching } from "pi-hl-utils/testing/matchers";
import { afterEach, describe, expect, test, vi, type MockInstance } from "vitest";

import { createDapArtifacts, type DapArtifacts } from "../src/artifacts.js";
import { DapController, DapError, type DapSnapshot } from "../src/controller.js";
import { DAP_ADAPTER_PRESETS } from "../src/presets.js";
import type {
  DapAdapterDefinition,
  DapLaunchProfile,
  ResolvedDapSettings,
} from "../src/settings.js";

const temporaryDirectories: string[] = [];
const openSessionFiles: DapArtifacts[] = [];
const ownedProcesses: childProcess.ChildProcess[] = [];
const ownedPidPaths: string[] = [];
const execFileText = promisify(execFile);

function trackOwnedProcesses() {
  const spawn = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  const restore = () => {
    for (const result of spawn.mock.results) {
      if (result.type === "return") ownedProcesses.push(result.value);
    }
    spawn.mockRestore();
    syncBuiltinESMExports();
  };
  return { spawn, restore };
}

function parseOwnedPid(text: string | undefined): number {
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid owned fixture PID");
  return pid;
}

function ownedSocket(sockets: readonly net.Socket[], index: number): net.Socket {
  const socket = sockets[index];
  if (socket === undefined) throw new Error("Missing owned fixture channel");
  return socket;
}

function ownedAdapterPid(tracking: ReturnType<typeof trackOwnedProcesses>): number {
  const root = tracking.spawn.mock.results[0];
  if (root?.type !== "return" || root.value.pid === undefined)
    throw new Error("Missing owned adapter process");
  return root.value.pid;
}

async function ownedPids(path: string) {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
  const [leader, descendant] = text.trim().split("\n");
  return {
    leader: parseOwnedPid(leader),
    descendant: parseOwnedPid(descendant),
  };
}

async function ownedProcessDetails(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileText(
      "ps",
      ["-ww", "-p", String(pid), "-o", "stat=,command="],
      { timeout: 5_000 },
    );
    return stdout.trim();
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === 1) return undefined;
    throw cause;
  }
}

async function ownedDescendantRunning(path: string): Promise<boolean> {
  const pids = await ownedPids(path);
  if (pids === undefined) return false;
  const details = await ownedProcessDetails(pids.descendant);
  return details !== undefined && !details.startsWith("Z");
}

const fakeAdapterPath = resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs");

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("DAP session test timed out waiting for state");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

/** Preset data exactly as `readSettings` resolves it into an Adapter Definition. */
function resolvedPreset(
  presetId: string,
): Partial<Pick<DapAdapterDefinition, "adapterID" | "channels" | "outputExitReport">> {
  return DAP_ADAPTER_PRESETS[presetId] ?? {};
}

interface SessionFixture {
  readonly cwd: string;
  readonly files: DapArtifacts;
  readonly session: DapController;
}

async function createSession(
  profileArguments: Readonly<DapLaunchProfile["arguments"]> = {
    stopOnEntry: true,
  },
  executionMs = 200,
  observation: {
    readonly onSnapshotChange?: (snapshot: DapSnapshot) => void;
    readonly onUnexpectedFailure?: (error: Error) => void;
  } = {},
  adapterCommand = process.execPath,
  wrapSessionFiles?: (files: DapArtifacts) => DapArtifacts,
  adapterFields: Partial<
    Pick<DapAdapterDefinition, "adapterID" | "channels" | "outputExitReport" | "environment">
  > = {},
): Promise<SessionFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-hl-dap-session-project-"));
  temporaryDirectories.push(cwd);
  const created = await createDapArtifacts(cwd);
  const files = wrapSessionFiles?.(created) ?? created;
  openSessionFiles.push(files);
  const settings: ResolvedDapSettings = {
    adapters: new Map([
      [
        "node",
        {
          id: "node",
          command: adapterCommand,
          args: [fakeAdapterPath],
          environment: {},
          transport: { type: "stdio" },
          ...adapterFields,
        },
      ],
    ]),
    profiles: new Map([
      [
        "node",
        {
          id: "node",
          adapterId: "node",
          arguments: profileArguments,
        },
      ],
    ]),
    timeouts: {
      executionMs,
      requestMs: 1_000,
      shutdownMs: 500,
      startupMs: 5_000,
    },
    warnings: [],
  };
  return {
    cwd,
    files,
    session: new DapController({
      cwd,
      settings,
      artifacts: files,
      ...observation,
    }),
  };
}

/** Session files whose first stderr-path request holds a launch inside startup until released. */
function gateAdapterStderrPath(): {
  readonly wrap: (files: DapArtifacts) => DapArtifacts;
  readonly entered: Promise<void>;
  readonly release: () => void;
} {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let requests = 0;
  return {
    entered: entered.promise,
    release: gate.resolve,
    wrap: (files): DapArtifacts => ({
      directoryPath: files.directoryPath,
      writeResultSpill: (output) => files.writeResultSpill(output),
      dispose: () => files.dispose(),
      getAdapterStderrPath: async () => {
        requests += 1;
        if (requests === 1) {
          entered.resolve();
          await gate.promise;
        }
        return files.getAdapterStderrPath();
      },
    }),
  };
}

async function createLeaderlessOwnedSession(
  tracking: ReturnType<typeof trackOwnedProcesses>,
  observation: { readonly onUnexpectedFailure?: (error: Error) => void } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-prune-owned-"));
  temporaryDirectories.push(directory);
  const pidPath = join(directory, "owned.pid");
  ownedPidPaths.push(pidPath);
  const { session } = await createSession(
    {
      stopOnEntry: true,
      runInTerminalArgs: [
        process.execPath,
        resolve(import.meta.dirname, "fixtures/run-in-terminal-parent.mjs"),
        pidPath,
        "exit",
      ],
    },
    200,
    observation,
  );
  await session.launch();
  await expect.poll(() => ownedPids(pidPath), { timeout: 5_000 }).toBeDefined();
  const pids = await ownedPids(pidPath);
  const group = tracking.spawn.mock.results[1];
  if (pids === undefined || group?.type !== "return")
    throw new Error("Missing owned Debuggee group");
  expect(group.value.pid).toBe(pids.leader);
  await expect
    .poll(
      () => group.value.stdin?.closed && group.value.stdout?.closed && group.value.stderr?.closed,
      { timeout: 5_000 },
    )
    .toBe(true);
  return { session, pids, pidPath };
}

afterEach(async () => {
  for (const path of ownedPidPaths.splice(0)) {
    const pids = await ownedPids(path);
    if (pids === undefined) continue;
    const details = await ownedProcessDetails(pids.descendant);
    if (details === undefined || details.startsWith("Z")) continue;
    if (!details.includes(path)) throw new Error("Fixture PID no longer belongs to this test");
    process.kill(pids.descendant, "SIGKILL");
  }
  await Promise.all(
    ownedProcesses.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
      child.kill("SIGKILL");
      await exit;
    }),
  );
  await Promise.all(openSessionFiles.splice(0).map((files) => files.dispose()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const fakeJsDebugPath = resolve(import.meta.dirname, "fixtures/fake-js-debug-adapter.mjs");

/** A DapController over TCP against the fake two-channel vscode-js-debug adapter. */
async function createJsDapSession(
  script: string,
  profileArguments: Readonly<Record<string, string>> = {},
  shutdownMs = 500,
  executionMs = 5_000,
  observation: {
    readonly onSnapshotChange?: (snapshot: DapSnapshot) => void;
    readonly onUnexpectedFailure?: (error: Error) => void;
  } = {},
  environment: Readonly<Record<string, string>> = {},
): Promise<DapController> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-hl-dap-session-js-debug-"));
  temporaryDirectories.push(cwd);
  const files = await createDapArtifacts(cwd);
  openSessionFiles.push(files);
  const settings: ResolvedDapSettings = {
    adapters: new Map([
      [
        "node",
        {
          id: "node",
          command: process.execPath,
          args: [fakeJsDebugPath, "$PORT"],
          environment: { FAKE_JS_DEBUG_SCRIPT: script, ...environment },
          ...resolvedPreset("vscode-js-debug"),
          transport: { type: "tcp", host: "127.0.0.1", port: 0 },
        },
      ],
    ]),
    profiles: new Map([
      [
        "node",
        {
          id: "node",
          adapterId: "node",
          arguments: { type: "pwa-node", ...profileArguments },
        },
      ],
    ]),
    timeouts: { executionMs, requestMs: 2_000, shutdownMs, startupMs: 5_000 },
    warnings: [],
  };
  return new DapController({
    cwd,
    settings,
    artifacts: files,
    ...observation,
  });
}

/** A DapController over the fake promoted adapter, with the Adapter Definition and profile a test sets. */
async function createPromotedSession(
  script: string,
  adapter: Partial<Pick<DapAdapterDefinition, "adapterID" | "channels" | "outputExitReport">>,
  options: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly executionMs?: number;
    readonly profileAdapterID?: string;
    readonly profileArguments?: Readonly<Record<string, string | number>>;
  } = {},
): Promise<DapController> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-hl-dap-session-promoted-"));
  temporaryDirectories.push(cwd);
  const files = await createDapArtifacts(cwd);
  openSessionFiles.push(files);
  const settings: ResolvedDapSettings = {
    adapters: new Map([
      [
        "node",
        {
          id: "node",
          command: process.execPath,
          args: [fakeJsDebugPath, "$PORT"],
          environment: { FAKE_JS_DEBUG_SCRIPT: script, ...options.environment },
          transport: { type: "tcp", host: "127.0.0.1", port: 0 },
          ...adapter,
        },
      ],
    ]),
    profiles: new Map([
      [
        "node",
        {
          ...(options.profileAdapterID === undefined
            ? {}
            : { adapterID: options.profileAdapterID }),
          id: "node",
          adapterId: "node",
          arguments: options.profileArguments ?? {},
        },
      ],
    ]),
    timeouts: {
      executionMs: options.executionMs ?? 5_000,
      requestMs: 2_000,
      shutdownMs: 500,
      startupMs: 5_000,
    },
    warnings: [],
  };
  return new DapController({ cwd, settings, artifacts: files });
}

describe("DapController exit code from vscode-js-debug's two channels", () => {
  test.each([
    ["target channel ends first", "target-first", 3],
    ["root channel ends first", "root-first", 3],
    ["a clean run with no exit report", "clean", 0],
    ["Debuggee output on the target channel is not an exit report", "spoof", 0],
  ])("%s", async (_name, script, exitCode) => {
    const session = await createJsDapSession(script);

    const result = await session.launch();

    expect(result.snapshot).toMatchObject({ state: "terminated", exitCode });
    await session.dispose();
  });

  test("a root channel that never ends leaves the exit code unknown after shutdownMs", async () => {
    const session = await createJsDapSession("target-only", {}, 200);
    const startedAt = Date.now();

    const result = await session.launch();

    expect(result.snapshot.state).toBe("terminated");
    expect(Object.hasOwn(result.snapshot, "exitCode")).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    await session.dispose();
  });

  test.each([
    ["integratedTerminal", { console: "integratedTerminal" }],
    ["outputCapture std", { outputCapture: "std" }],
  ])("%s never guesses exit code 0 for a clean-looking end", async (_name, profile) => {
    const session = await createJsDapSession("clean", profile);

    const result = await session.launch();

    expect(result.snapshot.state).toBe("terminated");
    expect(Object.hasOwn(result.snapshot, "exitCode")).toBe(false);
    await session.dispose();
  });

  test("outputCapture std does not let Debuggee stderr set the exit code", async () => {
    const session = await createJsDapSession("root-first", {
      outputCapture: "std",
    });

    const result = await session.launch();

    expect(Object.hasOwn(result.snapshot, "exitCode")).toBe(false);
    await session.dispose();
  });

  test("a stop during the wait for the second channel wins and leaves the exit code unknown", async () => {
    const session = await createJsDapSession("target-only", {}, 5_000);
    const launched = session.launch();
    // stop() is a no-op until the adapter has started, which takes seconds on a loaded machine.
    await expect.poll(() => session.snapshot().state, { timeout: 5_000 }).toBe("running");
    await new Promise((resolveWait) => setTimeout(resolveWait, 600));

    await session.stop();
    const result = await launched;

    expect(result.snapshot).toMatchObject({
      state: "terminated",
      terminationReason: "stopped by request",
    });
    expect(Object.hasOwn(result.snapshot, "exitCode")).toBe(false);
  });
});

async function expectChildStopInspection(
  session: DapController,
  childName: string | undefined,
): Promise<void> {
  expect((await session.stack()).stackFrames?.at(0)?.name).toBe(childName);
  expect((await session.evaluate({ expression: "where" })).evaluation?.result).toBe(childName);
}

describe("DapController with vscode-js-debug Child sessions", () => {
  test("preserves the standard exited code when an owned terminal exits during child drain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-exit-precedence-"));
    temporaryDirectories.push(directory);
    const drainGate = join(directory, "drain.gate");
    const tracking = trackOwnedProcesses();
    const session = await createJsDapSession(
      "child-late-output",
      { console: "integratedTerminal" },
      2_000,
      5_000,
      {},
      {
        FAKE_CHILD_PARENT_EXITED: "root",
        FAKE_TERMINAL_EXIT_GATE: join(directory, "exit.gate"),
        FAKE_CHILD_DRAIN_GATE: drainGate,
      },
    );
    try {
      expect((await session.launch()).snapshot.state).toBe("stopped");
      const spawned = tracking.spawn.mock.results[1];
      if (spawned?.type !== "return") throw new Error("Missing owned terminal process");
      const terminalExit = once(spawned.value, "exit", {
        signal: AbortSignal.timeout(3_000),
      });
      const continued = session.continue();
      expect(await terminalExit).toEqual([0, null]);
      await writeFile(drainGate, "release child after terminal exit");
      expect((await continued).snapshot).toMatchObject({
        state: "terminated",
        exitCode: 7,
      });
    } finally {
      await session.dispose();
      tracking.restore();
    }
  });

  test("retains child output after both parent channels terminate before the child drains", async () => {
    const session = await createJsDapSession("child-late-output");
    try {
      expect((await session.launch()).snapshot.state).toBe("stopped");
      const finished = await session.continue();
      expect(finished.snapshot).toMatchObject({
        state: "terminated",
        exitCode: 0,
      });
      expect(finished.output).toContain("worker value 1");
      expect(finished.output).toContain("worker exited 0");
    } finally {
      await session.dispose();
    }
  });

  test.each(["root", "target"])(
    "retains child output after the %s channel reports exited before the child drains",
    async (channel) => {
      const session = await createJsDapSession(
        "child-late-output",
        {},
        500,
        5_000,
        {},
        {
          FAKE_CHILD_PARENT_EXITED: channel,
        },
      );
      try {
        expect((await session.launch()).snapshot.state).toBe("stopped");
        const finished = await session.continue();
        expect(finished.snapshot).toMatchObject({
          state: "terminated",
          exitCode: 7,
        });
        expect(finished.output).toContain("worker value 1");
        expect(finished.output).toContain("worker exited 0");
      } finally {
        await session.dispose();
      }
    },
  );

  test("sends configurationDone on the root channel only when the root advertised it", async () => {
    const session = await createJsDapSession(
      "child-running",
      {},
      2_000,
      500,
      {},
      {
        FAKE_ROOT_CONFIGURATION_DONE: "false",
      },
    );
    try {
      await session.setBreakpoints({
        filePath: "/src/shared.js",
        breakpoints: [{ line: 3 }],
      });
      expect((await session.launch()).snapshot.state).toBe("running");
    } finally {
      await session.dispose();
    }
  });

  test("completes when a child fails after both parent channels terminate", async () => {
    const failures: Error[] = [];
    const session = await createJsDapSession(
      "child-late-output",
      {},
      3_000,
      5_000,
      {
        onUnexpectedFailure: (error) => failures.push(error),
      },
      { FAKE_CHILD_END: "failure" },
    );
    try {
      expect((await session.launch()).snapshot.state).toBe("stopped");
      const startedAt = Date.now();
      const finished = await session.continue();
      expect(finished.snapshot).toMatchObject({
        state: "terminated",
        exitCode: 0,
      });
      expect(finished.output).toContain("worker value 1");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(failures).toEqual([]);
      // The child stopped being debugged mid-run, so the result names it once.
      expect(finished.rejectedChildSessions).toEqual([
        { name: "worker-a", message: stringContaining("worker-a") },
      ]);
    } finally {
      await session.dispose();
    }
  });

  test("bounds the wait for a child that never terminates by shutdownMs", async () => {
    const session = await createJsDapSession(
      "child-late-output",
      {},
      300,
      5_000,
      {},
      {
        FAKE_CHILD_END: "never",
      },
    );
    try {
      expect((await session.launch()).snapshot.state).toBe("stopped");
      const startedAt = Date.now();
      const finished = await session.continue();
      expect(finished.snapshot).toMatchObject({
        state: "terminated",
        exitCode: 0,
      });
      expect(finished.output).toContain("worker value 1");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    } finally {
      await session.dispose();
    }
  });

  test.each(["stop", "dispose"] as const)(
    "%s interrupts the child drain wait without waiting for shutdownMs",
    async (operation) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-child-drain-"));
      temporaryDirectories.push(directory);
      const evidencePath = join(directory, "events.jsonl");
      const termination = Promise.withResolvers<number>();
      const session = await createJsDapSession(
        "child-late-output",
        {},
        5_000,
        10_000,
        {
          onSnapshotChange: (snapshot) => {
            if (snapshot.state === "terminated") termination.resolve(Date.now());
          },
        },
        {
          FAKE_CHILD_END: "never",
          FAKE_JS_DEBUG_EVIDENCE_PATH: evidencePath,
        },
      );
      try {
        expect((await session.launch()).snapshot.state).toBe("stopped");
        const continued = session.continue();
        await waitForEvidence(evidencePath, (entry) => entry.event === "child-output");
        expect(session.snapshot().state).toBe("running");
        const startedAt = Date.now();
        await session[operation]();
        expect((await continued).snapshot).toMatchObject({
          state: "terminated",
          terminationReason: operation === "stop" ? "stopped by request" : "Pi session shutdown",
        });
        expect((await termination.promise) - startedAt).toBeLessThan(1_000);
        expect(Date.now() - startedAt).toBeLessThan(5_000);
      } finally {
        await session.dispose();
      }
    },
  );

  test("reports simultaneous child stops one at a time, each routed to its own target", async () => {
    const session = await createJsDapSession("children");
    await session.setBreakpoints({
      filePath: "/src/shared.js",
      breakpoints: [{ line: 3 }],
    });

    const first = await session.launch();
    const firstName = first.stop?.childSession;
    expect(first.snapshot).toMatchObject({
      state: "stopped",
      stopReason: "breakpoint",
    });
    expect(["worker-a", "worker-b"]).toContain(firstName);
    // The child's own Breakpoint id is reported as the primary target's id for that Breakpoint.
    expect(first.stop?.hitBreakpointIds).toEqual([1]);
    expect(first.stop?.topFrame?.name).toBe(firstName);
    await expectChildStopInspection(session, firstName);
    // Verified where any target verified it, under the id the primary target gave it.
    expect(
      (
        await session.setBreakpoints({
          filePath: "/src/shared.js",
          breakpoints: [{ line: 3 }],
        })
      ).breakpoints,
    ).toEqual([objectContaining({ id: 1, verified: true })]);

    // The other child stopped meanwhile: continuing reports its stop without waiting.
    const second = await session.continue();
    const secondName = second.stop?.childSession;
    expect(second.snapshot).toMatchObject({
      state: "stopped",
      stopReason: "breakpoint",
    });
    expect(secondName).toBe(firstName === "worker-a" ? "worker-b" : "worker-a");
    expect(second.stop?.hitBreakpointIds).toEqual([1]);
    expect((await session.evaluate({ expression: "where" })).evaluation?.result).toBe(secondName);
    // Both children call their thread 1; Pi's thread ids keep them apart.
    expect(second.snapshot).toHaveProperty("threadId");
    expect(first.snapshot).not.toMatchObject({
      threadId: "threadId" in second.snapshot ? second.snapshot.threadId : undefined,
    });

    const finished = await session.continue();
    expect(finished.snapshot).toMatchObject({
      state: "terminated",
      exitCode: 0,
    });
    expect(finished.rejectedChildSessions).toBeUndefined();
    await session.dispose();
  });

  test.each(["setBreakpoints", "pause"])(
    "surfaces a live Child session that refuses %s",
    async (command) => {
      const session = await createJsDapSession(
        "child-running",
        {},
        500,
        300,
        {},
        {
          FAKE_CHILD_REFUSE: command,
        },
      );
      try {
        expect((await session.launch()).snapshot.state).toBe("running");
        const operation =
          command === "pause"
            ? session.pause()
            : session.setBreakpoints({
                filePath: "/src/shared.js",
                breakpoints: [{ line: 3 }],
              });

        await expect(operation).rejects.toThrow(`child refused ${command}`);
        // The primary target applied the new list, so it stays the Desired Breakpoints.
        expect(session.status().desiredBreakpoints).toEqual(
          command === "setBreakpoints"
            ? [{ filePath: "/src/shared.js", breakpoints: [{ line: 3 }] }]
            : [],
        );
      } finally {
        await session.dispose();
      }
    },
  );

  test("a primary target that refuses setBreakpoints leaves live Child sessions unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-evidence-"));
    temporaryDirectories.push(directory);
    const evidencePath = join(directory, "events.jsonl");
    const session = await createJsDapSession(
      "child-running",
      {},
      500,
      300,
      {},
      {
        FAKE_TARGET_REFUSE: "setBreakpoints",
        FAKE_JS_DEBUG_EVIDENCE_PATH: evidencePath,
      },
    );
    try {
      expect((await session.launch()).snapshot.state).toBe("running");
      const childUpdates = async () =>
        (await readEvidence(evidencePath)).filter(
          (entry) => entry.event === "setBreakpoints" && entry.role === "child",
        ).length;
      const before = await childUpdates();
      await expect(
        session.setBreakpoints({
          filePath: "/src/shared.js",
          breakpoints: [{ line: 3 }],
        }),
      ).rejects.toThrow("target refused setBreakpoints");
      expect(session.status().desiredBreakpoints).toEqual([]);
      expect(await childUpdates()).toBe(before);
    } finally {
      await session.dispose();
    }
  });

  test.each([
    // Launch sends the first stackTrace for its top frame.
    ["stack", "stackTrace", 2, (session: DapController) => session.stack()],
    ["variables", "scopes", 1, (session: DapController) => session.variables({ frameId: 1 })],
    [
      "evaluate",
      "stackTrace",
      2,
      (session: DapController) => session.evaluate({ expression: "x" }),
    ],
  ] as const)(
    "%s rejects when its Child session ends during its %s request",
    async (operation, request, occurrence, call) => {
      const session = await createJsDapSession(
        "children",
        {},
        500,
        5_000,
        {},
        {
          FAKE_CHILD_END_ON: request,
          FAKE_CHILD_END_AT: String(occurrence),
        },
      );
      try {
        await session.setBreakpoints({
          filePath: "/src/shared.js",
          breakpoints: [{ line: 3 }],
        });
        expect((await session.launch()).snapshot.state).toBe("stopped");
        await expect(call(session)).rejects.toThrow(
          `${operation} requires the stopped target it started on`,
        );
      } finally {
        await session.dispose();
      }
    },
  );

  test("pause stops the primary target and every Child session, reporting one stop at a time", async () => {
    const session = await createJsDapSession("child-running", {}, 500, 300);
    expect((await session.launch()).snapshot.state).toBe("running");

    const stops = [await session.pause(), await session.continue()];

    expect(stops.map(({ snapshot }) => snapshot)).toEqual([
      objectContaining({ state: "stopped", stopReason: "pause" }),
      objectContaining({ state: "stopped", stopReason: "pause" }),
    ]);
    expect(stops.map(({ stop }) => stop?.childSession ?? "primary").toSorted()).toEqual([
      "primary",
      "worker-a",
    ]);
    expect((await session.continue()).snapshot.state).toBe("running");
    await session.dispose();
  });
});

describe("DapController", () => {
  test("applies Desired Breakpoints before configuration and supports the stopped inspection workflow", async () => {
    const { cwd, session } = await createSession({
      requireBreakpoint: true,
      stopOnEntry: true,
    });
    const programPath = resolve(cwd, "program.ts");

    await expect(session.continue()).rejects.toThrow("continue requires a stopped Debuggee");
    const desired = await session.setBreakpoints({
      filePath: "program.ts",
      breakpoints: [{ line: 4, condition: "answer === 42" }],
    });
    expect(desired.desiredBreakpoints).toEqual([
      {
        filePath: programPath,
        breakpoints: [{ line: 4, condition: "answer === 42" }],
      },
    ]);

    const launched = await session.launch({ program: "program.ts" });
    expect(launched.snapshot).toMatchObject({
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "entry",
      threadId: 1,
    });
    expect(launched.output).toBe("launched\n");
    expect(launched.stop).toEqual({
      description: "Paused on entry",
      topFrame: objectContaining({
        id: 10,
        name: "main",
        line: 4,
        column: 1,
      }),
    });
    await expect(session.launch()).rejects.toThrow("launch requires no active Debug Session");

    const stack = await session.stack({ start: 0, count: 1 });
    expect(stack.stackFrames).toEqual([
      objectContaining({
        id: 10,
        name: "main",
        line: 4,
        source: { name: "program.ts", path: programPath },
      }),
    ]);
    expect(stack.totalFrames).toBe(2);

    const frameVariables = await session.variables({ frameId: 10 });
    expect(frameVariables.variableGroups).toEqual([
      {
        scope: objectContaining({
          name: "Local",
          variablesReference: 20,
        }),
        variables: [
          objectContaining({ name: "answer", value: "42" }),
          objectContaining({ name: "nested", variablesReference: 21 }),
        ],
      },
      // An expensive scope is listed with its reference but not expanded.
      {
        scope: objectContaining({
          name: "Global",
          variablesReference: 30,
          expensive: true,
        }),
      },
    ]);
    expect(frameVariables.variableGroups?.[1]).not.toHaveProperty("variables");
    const expanded = await session.variables({ variablesReference: 30 });
    expect(expanded.variables).toEqual([objectContaining({ name: "globalThis" })]);
    const childVariables = await session.variables({
      variablesReference: 21,
      start: 1,
      count: 1,
    });
    expect(childVariables.variables).toEqual([
      objectContaining({ name: "nested", variablesReference: 21 }),
    ]);

    const evaluation = await session.evaluate({ expression: "answer" });
    expect(evaluation.evaluation).toMatchObject({
      result: "answer",
      variablesReference: 0,
    });

    for (const step of [() => session.next(), () => session.stepIn(), () => session.stepOut()]) {
      await expect(step()).resolves.toMatchObject({
        snapshot: objectContaining({
          state: "stopped",
          stopReason: "step",
        }),
      });
    }

    await expect(
      session.setBreakpoints({
        filePath: "program.ts",
        breakpoints: [{ line: 8, condition: "fail" }],
      }),
    ).rejects.toThrow("breakpoint rejected");
    expect(session.status().desiredBreakpoints).toEqual([
      {
        filePath: programPath,
        breakpoints: [{ line: 4, condition: "answer === 42" }],
      },
    ]);

    const stopped = await session.stop();
    expect(stopped.snapshot.state).toBe("terminated");
    expect(Object.hasOwn(stopped.snapshot, "exitCode")).toBe(false);
    expect(Object.hasOwn(stopped.snapshot, "threadId")).toBe(false);
    await expect(session.stop()).resolves.toMatchObject({
      snapshot: objectContaining({ state: "terminated" }),
    });
  });

  test("launches, hits a breakpoint, and disconnects with an adapter that numbers frames from zero", async () => {
    const { session } = await createSession(
      { requireBreakpoint: true, stopOnEntry: true },
      200,
      {},
      process.execPath,
      undefined,
      { environment: { FAKE_ZERO_SEQUENCE: "1" } },
    );

    const desired = await session.setBreakpoints({
      filePath: "program.ts",
      breakpoints: [{ line: 4 }],
    });
    expect(desired.desiredBreakpoints).toHaveLength(1);

    const launched = await session.launch({ program: "program.ts" });
    expect(launched.snapshot).toMatchObject({
      state: "stopped",
      stopReason: "entry",
    });

    const hit = await session.continue();
    expect(hit.snapshot).toMatchObject({
      state: "stopped",
      stopReason: "breakpoint",
    });
    expect(hit.stop).toMatchObject({
      description: "Paused on breakpoint",
      hitBreakpointIds: [7],
      topFrame: { line: 4 },
    });

    await expect(session.dispose()).resolves.toBeUndefined();
  });

  test("setting a file's breakpoints to [] drops it from Desired Breakpoints, idle or active", async () => {
    const { cwd, session } = await createSession({ stopOnEntry: true });
    const first = resolve(cwd, "first.ts");
    const second = resolve(cwd, "second.ts");
    await session.setBreakpoints({
      filePath: "first.ts",
      breakpoints: [{ line: 1 }],
    });
    await session.setBreakpoints({
      filePath: "second.ts",
      breakpoints: [{ line: 2 }],
    });

    const idleCleared = await session.setBreakpoints({
      filePath: "first.ts",
      breakpoints: [],
    });
    expect(idleCleared.desiredBreakpoints).toEqual([
      { filePath: second, breakpoints: [{ line: 2 }] },
    ]);

    await session.launch();
    await session.setBreakpoints({
      filePath: "first.ts",
      breakpoints: [{ line: 3 }],
    });
    const activeCleared = await session.setBreakpoints({
      filePath: "second.ts",
      breakpoints: [],
    });
    expect(activeCleared.desiredBreakpoints).toEqual([
      { filePath: first, breakpoints: [{ line: 3 }] },
    ]);
    expect(session.status().desiredBreakpoints).toEqual(activeCleared.desiredBreakpoints);
    await session.dispose();
  });

  test("publishes observed launch transitions and clears stop-specific context on resume", async () => {
    const snapshots: DapSnapshot[] = [];
    const { session } = await createSession({ stopOnEntry: true }, 200, {
      onSnapshotChange: (snapshot) => snapshots.push(snapshot),
    });

    await session.launch();
    expect([
      ["launching", "stopped"],
      ["launching", "running", "stopped"],
    ]).toContainEqual(snapshots.map(({ state }) => state));
    expect(snapshots.at(0)).toEqual({
      state: "launching",
      adapterId: "node",
      profileId: "node",
    });
    expect(snapshots.at(-1)).toEqual({
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "entry",
      threadId: 1,
    });

    const priorRunningCount = snapshots.filter(({ state }) => state === "running").length;
    const continuing = session.continue();
    await waitFor(
      () => snapshots.filter(({ state }) => state === "running").length > priorRunningCount,
    );
    expect(snapshots).toContainEqual({
      state: "running",
      adapterId: "node",
      profileId: "node",
    });
    await continuing;
    expect(snapshots.at(-1)).toMatchObject({
      state: "stopped",
      stopReason: "breakpoint",
    });

    await session.stop();
    expect(snapshots.at(-1)).toMatchObject({
      state: "terminated",
      terminationReason: "stopped by request",
    });
  });

  test("publishes running before a launch wait and isolates observation failures", async () => {
    const snapshots: DapSnapshot[] = [];
    const { session } = await createSession({ neverStop: true, stopOnEntry: false }, 20, {
      onSnapshotChange: (snapshot) => {
        snapshots.push(snapshot);
        if (snapshot.state === "launching") throw new Error("observer failed");
      },
    });

    await expect(session.launch()).resolves.toMatchObject({
      snapshot: { state: "running" },
    });
    expect(snapshots.map(({ state }) => state)).toEqual(["launching", "running"]);
    await expect(session.stop()).resolves.toMatchObject({
      snapshot: { state: "terminated" },
    });
  });

  test("publishes idle after a failed pre-launch startup", async () => {
    const snapshots: DapSnapshot[] = [];
    const { session } = await createSession(
      { stopOnEntry: true },
      200,
      { onSnapshotChange: (snapshot) => snapshots.push(snapshot) },
      resolve(tmpdir(), "missing-pi-hl-dap-adapter"),
    );

    await expect(session.launch()).rejects.toThrow("launch failed");
    expect(snapshots).toEqual([{ state: "idle" }]);
  });

  test("reports an unexpected adapter failure without allowing its observer to break cleanup", async () => {
    const failures: Error[] = [];
    const snapshots: DapSnapshot[] = [];
    const { session } = await createSession({ crashOnContinue: true, stopOnEntry: true }, 200, {
      onSnapshotChange: (snapshot) => snapshots.push(snapshot),
      onUnexpectedFailure: (error) => {
        failures.push(error);
        throw new Error("failure observer failed");
      },
    });

    await session.launch();
    await expect(session.continue()).resolves.toMatchObject({
      snapshot: { state: "terminated" },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("adapter-stderr");
    expect(snapshots.at(-1)?.state).toBe("terminated");
  });

  test("execution timeout and cancellation return running and pause recovers the Debug Session", async () => {
    const { session } = await createSession({ neverStop: true, stopOnEntry: false }, 40);

    const launched = await session.launch();
    expect(launched.snapshot.state).toBe("running");
    await expect(session.stack()).rejects.toThrow("stack requires a stopped Debuggee");

    const paused = await session.pause();
    expect(paused.snapshot).toMatchObject({
      state: "stopped",
      stopReason: "pause",
    });

    const timedOut = await session.continue();
    expect(timedOut.snapshot.state).toBe("running");

    const recovered = await session.pause();
    expect(recovered.snapshot.state).toBe("stopped");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const cancelled = await session.continue(controller.signal);
    expect(cancelled.snapshot.state).toBe("running");

    await session.stop();
  });

  test("a continue cancelled before it is sent keeps the Debuggee stopped", async () => {
    const { session } = await createSession({ stopOnEntry: true }, 200);
    await session.launch();
    const controller = new AbortController();
    controller.abort();

    const cancelled = await session.continue(controller.signal);

    expect(cancelled.snapshot.state).toBe("stopped");
    await expect(session.stack()).resolves.toBeDefined();
    await session.stop();
  });

  test("a continue cancelled by a running snapshot observer keeps the Debuggee stopped", async () => {
    const controller = new AbortController();
    let armed = false;
    const { session } = await createSession({ stopOnEntry: true }, 200, {
      onSnapshotChange: (snapshot) => {
        if (armed && snapshot.state === "running") controller.abort();
      },
    });
    await session.launch();
    armed = true;

    const cancelled = await session.continue(controller.signal);

    expect(cancelled.snapshot.state).toBe("stopped");
    await session.stop();
  });

  test("a continue the adapter refuses keeps the Debuggee stopped", async () => {
    const { session } = await createSession({ refuseContinue: true, stopOnEntry: true }, 200);
    await session.launch();

    await expect(session.continue()).rejects.toThrow("fixture refused continue");

    await expect(session.stack()).resolves.toBeDefined();
    await session.stop();
  });

  test("a refused continue after a continued event leaves the Debuggee running", async () => {
    const { session } = await createSession(
      { refuseContinue: true, continueBeforeRefusal: true, stopOnEntry: true },
      200,
    );
    await session.launch();

    await expect(session.continue()).rejects.toThrow("fixture refused continue");

    await expect(session.stack()).rejects.toThrow("stack requires a stopped Debuggee");
    await session.stop();
  });

  test("a steer signal ends an execution wait early and leaves the Debuggee running", async () => {
    // The execution timeout is far longer than the test, so only the steer can end the wait.
    const { session } = await createSession({ neverStop: true, stopOnEntry: false }, 30_000);
    const steer = new AbortController();
    setTimeout(() => steer.abort(), 20);
    const started = Date.now();
    const launched = await session.launch({}, undefined, steer.signal);
    expect(launched.snapshot.state).toBe("running");
    expect(Date.now() - started).toBeLessThan(10_000);

    const stopped = await session.pause();
    expect(stopped.snapshot).toMatchObject({
      state: "stopped",
      stopReason: "pause",
    });

    // The wait began with the steer pending: it ends after the resuming request was sent.
    const resumed = await session.continue(undefined, AbortSignal.abort());
    expect(resumed.snapshot.state).toBe("running");
    expect(session.status().snapshot.state).toBe("running");
    const recovered = await session.pause();
    expect(recovered.snapshot.state).toBe("stopped");

    await session.stop();
  });

  test("reports the stop description, hit Breakpoint ids, and top frame of each stop", async () => {
    const { session } = await createSession({
      stopOnEntry: true,
      requireBreakpoint: false,
    });
    await session.launch();

    const stopped = await session.continue();

    expect(stopped.snapshot).toMatchObject({
      state: "stopped",
      stopReason: "breakpoint",
    });
    expect(stopped.stop).toEqual({
      description: "Paused on breakpoint",
      hitBreakpointIds: [7],
      topFrame: objectContaining({ name: "main", line: 4 }),
    });
    // hl_dap_status reuses the top frame the stop already read, and drops it on resume.
    expect(session.status().stop).toEqual(stopped.stop);
    await session.dispose();
  });

  test("drops telemetry-category output events and keeps every other category", async () => {
    const { session } = await createSession({
      outputCategories: true,
      stopOnEntry: true,
    });

    const launched = await session.launch();

    expect(launched.output).toBe("warned\nconsole\nimportant\nuncategorized\nlaunched\n");
    await session.dispose();
  });

  test("natural exit retains a terminal snapshot and drains remaining Debuggee output", async () => {
    const { session } = await createSession({
      exitOnContinue: true,
      stopOnEntry: true,
    });

    await session.launch();
    const exited = await session.continue();

    expect(exited.snapshot).toMatchObject({ state: "terminated", exitCode: 0 });
    expect(Object.hasOwn(exited.snapshot, "exitCode")).toBe(true);
    // A result that is not a stop carries no stop details.
    expect(exited.stop).toBeUndefined();
    expect(exited.output).toBe("finished\n");
    expect(session.status()).toMatchObject({
      snapshot: objectContaining({ state: "terminated", exitCode: 0 }),
      output: "",
    });
    await session.dispose();
  });

  test.skipIf(process.platform === "win32").each(["exit", "term"])(
    "cleans an owned runInTerminal descendant after its leader exits (%s)",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-owned-debuggee-"));
      temporaryDirectories.push(directory);
      const pidPath = join(directory, "owned.pid");
      ownedPidPaths.push(pidPath);
      const { restore } = trackOwnedProcesses();
      try {
        const { session } = await createSession({
          stopOnEntry: true,
          runInTerminalArgs: [
            process.execPath,
            resolve(import.meta.dirname, "fixtures/run-in-terminal-parent.mjs"),
            pidPath,
            mode,
          ],
        });
        await session.launch();
        await expect.poll(() => ownedPids(pidPath), { timeout: 5_000 }).toBeDefined();
        const pids = await ownedPids(pidPath);
        if (pids === undefined) throw new Error("Missing owned fixture PIDs");
        await expect
          .poll(() => isProcessAlive(pids.leader), { timeout: 5_000 })
          .toBe(mode === "term");
        expect(await ownedDescendantRunning(pidPath)).toBe(true);
        await session.stop();
        await expect.poll(() => ownedDescendantRunning(pidPath), { timeout: 5_000 }).toBe(false);
        await session.dispose();
      } finally {
        restore();
      }
    },
  );

  test.skipIf(process.platform === "win32").each([false, true])(
    "prunes only confirmed-absent owned groups at public operations (EPERM: %s)",
    async (denyProbe) => {
      const tracking = trackOwnedProcesses();
      let session: DapController | undefined;
      let kill: MockInstance<typeof process.kill> | undefined;
      try {
        const fixture = await createLeaderlessOwnedSession(tracking);
        session = fixture.session;
        const { pids, pidPath } = fixture;
        const details = await ownedProcessDetails(pids.descendant);
        if (!details?.includes(pidPath))
          throw new Error("Descendant no longer belongs to this fixture");
        let denied = denyProbe;
        const realKill = process.kill;
        kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (denied && pid === -pids.leader && signal === 0)
            throw Object.assign(new Error("owned group probe denied"), {
              code: "EPERM",
            });
          return realKill(pid, signal);
        });
        expect(session.status().snapshot.state).toBe("stopped");
        expect(kill.mock.calls).toContainEqual([-pids.leader, 0]);
        denied = false;
        kill.mockClear();
        session.status();
        expect(kill.mock.calls).toContainEqual([-pids.leader, 0]);
        realKill(pids.descendant, "SIGKILL");
        await expect
          .poll(
            () => {
              try {
                realKill(-pids.leader, 0);
                return "present";
              } catch (cause) {
                return cause instanceof Error && "code" in cause ? cause.code : cause;
              }
            },
            { timeout: 5_000 },
          )
          .toBe("ESRCH");
        kill.mockClear();
        session.status();
        expect(kill.mock.calls).toContainEqual([-pids.leader, 0]);
        kill.mockClear();
        session.status();
        await session.stack();
        await session.setBreakpoints({
          filePath: "program.js",
          breakpoints: [{ line: 7 }],
        });
        await session.stop();
        expect(kill.mock.calls.filter(([pid]) => pid === -pids.leader)).toEqual([]);
      } finally {
        kill?.mockRestore();
        tracking.restore();
        await session?.dispose();
      }
    },
  );

  test.skipIf(process.platform === "win32").each([
    { operation: "status", cleanupFails: false },
    { operation: "stop", cleanupFails: false },
    { operation: "dispose", cleanupFails: true },
  ] as const)(
    "$operation preserves a fresh operation-probe failure and completes cleanup (cleanup fails: $cleanupFails)",
    async ({ operation, cleanupFails }) => {
      const tracking = trackOwnedProcesses();
      const failures: Error[] = [];
      let session: DapController | undefined;
      let kill: MockInstance<typeof process.kill> | undefined;
      let expectedShutdown: PromiseSettledResult<void> = {
        status: "fulfilled",
        value: undefined,
      };
      try {
        const fixture = await createLeaderlessOwnedSession(tracking, {
          onUnexpectedFailure: (error) => failures.push(error),
        });
        session = fixture.session;
        const { pids } = fixture;
        const rootPid = ownedAdapterPid(tracking);
        const probeError = Object.assign(new Error("owned operation probe failed"), {
          code: "EIO",
        });
        const cleanupError = Object.assign(new Error("owned root cleanup denied"), {
          code: "EPERM",
        });
        let probeFails = true;
        const realKill = process.kill;
        kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === -pids.leader && signal === 0 && probeFails) {
            probeFails = false;
            throw probeError;
          }
          if (pid === -rootPid && cleanupFails) throw cleanupError;
          return realKill(pid, signal);
        });
        const [result] = await Promise.allSettled([
          Promise.resolve().then(async () => {
            await fixture.session[operation]();
          }),
        ]);
        if (result?.status !== "rejected")
          throw new Error("Expected fresh operation probe failure");
        const expectedProbe = objectContaining({
          kind: "adapter",
          cause: probeError,
        });
        expect(result.reason).toEqual(
          cleanupFails
            ? objectContaining({
                kind: "adapter",
                cause: objectContaining({
                  errors: [expectedProbe, objectContaining({ cause: cleanupError })],
                }),
              })
            : expectedProbe,
        );
        const reason: unknown = result.reason;
        if (cleanupFails) expectedShutdown = { status: "rejected", reason };
        expect(await Promise.allSettled([session.dispose()])).toEqual([expectedShutdown]);
        // A repeated shutdown reports the same result as the first one.
        expect(await Promise.allSettled([session.dispose()])).toEqual([expectedShutdown]);
        expect(kill.mock.calls).toContainEqual([-pids.leader, "SIGTERM"]);
        expect(kill.mock.calls).toContainEqual([-pids.leader, "SIGKILL"]);
        await expect
          .poll(() => ownedDescendantRunning(fixture.pidPath), {
            timeout: 5_000,
          })
          .toBe(false);
        expect(session.snapshot().state).toBe("terminated");
        expect(failures).toEqual([result.reason]);
      } finally {
        kill?.mockRestore();
        tracking.restore();
        // Cleanup only: an assertion here would mask a failure from the test body.
        await session?.dispose().catch(() => undefined);
      }
    },
  );

  test.skipIf(process.platform === "win32").each(["launch", "stop"] as const)(
    "acknowledges failed cleanup once through %s before a later launch",
    async (recoveryOperation) => {
      const tracking = trackOwnedProcesses();
      const failures: Error[] = [];
      let kill: MockInstance<typeof process.kill> | undefined;
      try {
        const { session } = await createSession({ stopOnEntry: true }, 200, {
          onUnexpectedFailure: (error) => failures.push(error),
        });
        await session.launch();
        const pid = ownedAdapterPid(tracking);
        const denied = Object.assign(new Error("owned group denied"), {
          code: "EPERM",
        });
        const realKill = process.kill;
        kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
          if (target === -pid) throw denied;
          return realKill(target, signal);
        });
        const [initial] = await Promise.allSettled([session.stop()]);
        if (initial?.status !== "rejected") throw new Error("Expected original cleanup failure");
        expect(initial.reason).toMatchObject({ kind: "adapter" });
        kill.mockRestore();
        const [recovery] = await Promise.allSettled([session[recoveryOperation]()]);
        if (recovery?.status !== "rejected") throw new Error("Expected explicit recovery warning");
        const error: unknown = recovery.reason;
        expect(error).toBeInstanceOf(DapError);
        expect(error).toMatchObject({
          kind: "state",
          message: stringContaining("processes may have survived"),
        });
        if (!(error instanceof Error)) throw new Error("Expected typed recovery error");
        expect(error.cause).toBe(initial.reason);
        expect(session.snapshot().state).toBe("idle");
        expect(tracking.spawn).toHaveBeenCalledOnce();
        await expect(session.launch()).resolves.toMatchObject({
          snapshot: { state: "stopped" },
        });
        expect(tracking.spawn).toHaveBeenCalledTimes(2);
        expect(failures).toEqual([initial.reason]);
        await session.stop();
        await session.dispose();
      } finally {
        kill?.mockRestore();
        tracking.restore();
      }
    },
  );

  test.skipIf(process.platform === "win32").each(["stop", "dispose"] as const)(
    "%s reports cleanup failures, allows recovery, and retains shutdown closure failure",
    async (operation) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-cleanup-failure-"));
      temporaryDirectories.push(directory);
      const pidPath = join(directory, "owned.pid");
      ownedPidPaths.push(pidPath);
      const tracking = trackOwnedProcesses();
      const failures: Error[] = [];
      let kill: MockInstance<typeof process.kill> | undefined;
      try {
        const { session } = await createSession(
          {
            stopOnEntry: true,
            runInTerminalArgs: [
              process.execPath,
              resolve(import.meta.dirname, "fixtures/run-in-terminal-parent.mjs"),
              pidPath,
              "term",
            ],
          },
          200,
          { onUnexpectedFailure: (error) => failures.push(error) },
        );
        await session.launch();
        await expect.poll(() => ownedPids(pidPath), { timeout: 5_000 }).toBeDefined();
        const pids = await ownedPids(pidPath);
        const root = tracking.spawn.mock.results[0];
        if (pids === undefined || root?.type !== "return" || root.value.pid === undefined)
          throw new Error("Missing owned fixture processes");
        const rootPid = root.value.pid;
        const rootError = Object.assign(new Error("root group denied"), {
          code: "EPERM",
        });
        const debuggeeError = Object.assign(new Error("debuggee group denied"), { code: "EPERM" });
        const realKill = process.kill;
        kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === -rootPid) throw rootError;
          if (pid === -pids.leader) throw debuggeeError;
          return realKill(pid, signal);
        });
        const [result] = await Promise.allSettled([session[operation]()]);
        expect(result).toEqual({
          status: "rejected",
          reason: objectContaining({
            kind: "adapter",
            cause: objectContaining({
              errors: [objectContaining({ kind: "shutdown", cause: rootError }), debuggeeError],
            }),
          }),
        });
        if (result?.status !== "rejected") throw new Error("Expected rejected cleanup");
        expect(session.snapshot().state).toBe("terminated");
        await expect(session.dispose()).rejects.toBe(result.reason);
        await expect(session.stop()).rejects.toMatchObject({
          kind: "state",
          message: stringContaining("processes may have survived"),
        });
        expect(session.snapshot().state).toBe("idle");
        await expect(session.dispose()).rejects.toBe(result.reason);
        expect(failures).toEqual([result.reason]);
        expect(kill.mock.calls).toContainEqual([-rootPid, "SIGTERM"]);
        expect(kill.mock.calls).toContainEqual([-pids.leader, "SIGTERM"]);
      } finally {
        kill?.mockRestore();
        tracking.restore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "reports fatal transport and live-group cleanup failures once without unhandled rejections",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-fatal-cleanup-"));
      temporaryDirectories.push(directory);
      const pidPath = join(directory, "owned.pid");
      ownedPidPaths.push(pidPath);
      const tracking = trackOwnedProcesses();
      const failures: Error[] = [];
      let kill: MockInstance<typeof process.kill> | undefined;
      try {
        const { session } = await createSession(
          {
            stopOnEntry: true,
            crashOnContinue: true,
            runInTerminalArgs: [
              process.execPath,
              resolve(import.meta.dirname, "fixtures/run-in-terminal-parent.mjs"),
              pidPath,
              "term",
            ],
          },
          200,
          {
            onUnexpectedFailure: (error) => {
              failures.push(error);
              throw new Error("observer failed");
            },
          },
        );
        await session.launch();
        await expect.poll(() => ownedPids(pidPath), { timeout: 5_000 }).toBeDefined();
        const pids = await ownedPids(pidPath);
        const root = tracking.spawn.mock.results[0];
        if (pids === undefined || root?.type !== "return" || root.value.pid === undefined)
          throw new Error("Missing owned fixture processes");
        const groupPids = new Set([-root.value.pid, -pids.leader]);
        const realKill = process.kill;
        kill = vi
          .spyOn(process, "kill")
          .mockImplementation((pid, signal) => (groupPids.has(pid) ? true : realKill(pid, signal)));
        const [result] = await Promise.allSettled([session.continue()]);
        expect(result).toEqual({
          status: "rejected",
          reason: objectContaining({
            kind: "adapter",
            cause: objectContaining({
              errors: [
                objectContaining({ kind: stringMatching(/exit|transport/) }),
                objectContaining({ kind: "shutdown" }),
                objectContaining({ message: stringContaining("group") }),
              ],
            }),
          }),
        });
        if (result?.status !== "rejected") throw new Error("Expected rejected fatal cleanup");
        await expect(session.dispose()).rejects.toBe(result.reason);
        expect(failures).toEqual([result.reason]);
        expect(session.snapshot().state).toBe("terminated");
        for (const pid of groupPids) expect(kill.mock.calls).toContainEqual([pid, "SIGKILL"]);
      } finally {
        kill?.mockRestore();
        tracking.restore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "preserves launch rejection when cleanup also fails",
    async () => {
      const tracking = trackOwnedProcesses();
      const realKill = process.kill;
      const denied = Object.assign(new Error("launch cleanup denied"), {
        code: "EPERM",
      });
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        const root = tracking.spawn.mock.results[0];
        if (root?.type === "return" && root.value.pid !== undefined && pid === -root.value.pid)
          throw denied;
        return realKill(pid, signal);
      });
      try {
        const { session } = await createSession({
          requestStartDebugging: true,
        });
        await expect(session.launch()).rejects.toMatchObject({
          kind: "adapter",
          cause: objectContaining({
            errors: [
              objectContaining({
                kind: "request",
                message: stringContaining("startDebugging rejected"),
              }),
              objectContaining({ kind: "shutdown", cause: denied }),
            ],
          }),
        });
        expect(session.snapshot().state).toBe("terminated");
      } finally {
        kill.mockRestore();
        tracking.restore();
      }
    },
  );

  test("ignores stopped events from a detaching child while retaining channel ownership", async () => {
    const connections = vi.spyOn(net, "createConnection");
    syncBuiltinESMExports();
    let session: DapController | undefined;
    const restorers: (() => void)[] = [];
    try {
      session = await createJsDapSession("child-detaching", {}, 3_000, 5_000);
      const launched = await session.launch();
      expect(launched.stop?.childSession).toBe("worker-a");
      const sockets = connections.mock.results.flatMap((result) =>
        result.type === "return" && !result.value.destroyed ? [result.value] : [],
      );
      expect(sockets).toHaveLength(3);
      const root = ownedSocket(sockets, 0);
      const child = ownedSocket(sockets, 2);
      let childEvents = "";
      const collectChildEvents = (chunk: Buffer) => {
        childEvents += chunk.toString("utf8");
      };
      child.on("data", collectChildEvents);
      restorers.push(() => child.off("data", collectChildEvents));
      const childDestroy = vi.spyOn(child, "destroy");
      const rootDestroy = vi.spyOn(root, "destroy");
      restorers.push(
        () => childDestroy.mockRestore(),
        () => rootDestroy.mockRestore(),
      );
      const resumed = await session.continue(undefined, AbortSignal.abort());
      // The detaching child answers inside its 1s detach request budget, not a test-wide wait.
      await expect
        .poll(() => childEvents.includes('"event":"stopped"'), {
          timeout: 1_000,
        })
        .toBe(true);
      expect(session.snapshot().state).toBe("running");
      expect(resumed.snapshot.state).toBe("running");
      expect(resumed.stop).toBeUndefined();
      expect(child.destroyed).toBe(false);
      const paused = await session.pause();
      expect(paused.stop?.childSession).toBeUndefined();
      expect((await session.stack()).stackFrames?.at(0)?.name).toBe("primary");
      await session.stop();
      const [childOrder] = childDestroy.mock.invocationCallOrder;
      const [rootOrder] = rootDestroy.mock.invocationCallOrder;
      if (childOrder === undefined || rootOrder === undefined)
        throw new Error("Expected both owned channels to close");
      expect(childOrder).toBeLessThan(rootOrder);
    } finally {
      for (const restore of restorers) restore();
      connections.mockRestore();
      syncBuiltinESMExports();
      await session?.dispose();
    }
  });

  test.skipIf(process.platform === "win32")(
    "retains a failed removed child channel and cleans every other channel",
    async () => {
      const tracking = trackOwnedProcesses();
      const connections = vi.spyOn(net, "createConnection");
      syncBuiltinESMExports();
      const connected = () =>
        connections.mock.results.flatMap((result) =>
          result.type === "return" && !result.value.destroyed ? [result.value] : [],
        );
      const failures: Error[] = [];
      const restorers: (() => void)[] = [];
      let session: DapController | undefined;
      try {
        session = await createJsDapSession("children", {}, 500, 5_000, {
          onUnexpectedFailure: (error) => failures.push(error),
        });
        const launched = await session.launch();
        await expect.poll(() => connected().length, { timeout: 5_000 }).toBe(4);
        expect(["worker-a", "worker-b"]).toContain(launched.stop?.childSession);
        const sockets = connected();
        const rootSocket = ownedSocket(sockets, 0);
        const targetSocket = ownedSocket(sockets, 1);
        const firstName = launched.stop?.childSession;
        const failedChild = ownedSocket(sockets, firstName === "worker-a" ? 2 : 3);
        const remainingChild = ownedSocket(sockets, firstName === "worker-a" ? 3 : 2);
        const rootPid = ownedAdapterPid(tracking);
        const childError = new Error("child socket teardown failed");
        const targetError = new Error("target socket teardown failed");
        const childDestroy = vi.spyOn(failedChild, "destroy").mockImplementationOnce(() => {
          throw childError;
        });
        restorers.push(() => childDestroy.mockRestore());
        const targetDestroy = vi.spyOn(targetSocket, "destroy").mockImplementationOnce(() => {
          throw targetError;
        });
        restorers.push(() => targetDestroy.mockRestore());
        const remainingDestroy = vi.spyOn(remainingChild, "destroy");
        restorers.push(() => remainingDestroy.mockRestore());
        const rootDestroy = vi.spyOn(rootSocket, "destroy");
        restorers.push(() => rootDestroy.mockRestore());
        const realKill = process.kill;
        const kill = vi
          .spyOn(process, "kill")
          .mockImplementation((pid, signal) => (pid === -rootPid ? true : realKill(pid, signal)));
        restorers.push(() => kill.mockRestore());
        await Promise.allSettled([session.continue()]);
        await expect.poll(() => failures.length, { timeout: 5_000 }).toBe(1);
        const [result] = await Promise.allSettled([session.dispose()]);
        expect(result).toEqual({
          status: "rejected",
          reason: objectContaining({
            kind: "adapter",
            cause: objectContaining({
              errors: [childError, targetError, objectContaining({ kind: "shutdown" })],
            }),
          }),
        });
        if (result?.status !== "rejected") throw new Error("Expected rejected child cleanup");
        expect(failures).toEqual([result.reason]);
        expect(remainingDestroy).toHaveBeenCalled();
        expect(rootDestroy).toHaveBeenCalled();
        expect(kill.mock.calls).toContainEqual([-rootPid, "SIGKILL"]);
        await expect(session.dispose()).rejects.toBe(result.reason);
        await expect(session.stop()).rejects.toMatchObject({
          kind: "state",
          message: stringContaining("processes may have survived"),
        });
        expect(session.snapshot().state).toBe("idle");
        await expect(session.dispose()).rejects.toBe(result.reason);
      } finally {
        for (const restore of restorers) restore();
        connections.mockRestore();
        tracking.restore();
        await session?.dispose().catch(() => undefined);
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "retains a transport failure arriving during explicit stop cleanup",
    async () => {
      const tracking = trackOwnedProcesses();
      const failures: Error[] = [];
      let kill: MockInstance<typeof process.kill> | undefined;
      try {
        const { session } = await createSession(
          { stopOnEntry: true, crashOnTerminate: true },
          200,
          { onUnexpectedFailure: (error) => failures.push(error) },
        );
        await session.launch();
        const rootPid = ownedAdapterPid(tracking);
        const denied = Object.assign(new Error("shutdown group denied"), {
          code: "EPERM",
        });
        const realKill = process.kill;
        kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === -rootPid) throw denied;
          return realKill(pid, signal);
        });
        const [result] = await Promise.allSettled([session.stop()]);
        expect(result).toEqual({
          status: "rejected",
          reason: objectContaining({
            kind: "adapter",
            cause: objectContaining({
              errors: [
                objectContaining({ kind: stringMatching(/exit|transport/) }),
                objectContaining({ kind: "shutdown", cause: denied }),
              ],
            }),
          }),
        });
        if (result?.status !== "rejected") throw new Error("Expected rejected shutdown");
        expect(failures).toEqual([result.reason]);
        await expect(session.dispose()).rejects.toBe(result.reason);
      } finally {
        kill?.mockRestore();
        tracking.restore();
      }
    },
  );

  test.each(["absent", "false"] as const)(
    "stop sends no terminate to an adapter that did not advertise it (%s)",
    async (capability) => {
      const tracking = trackOwnedProcesses();
      const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-terminate-capability-"));
      temporaryDirectories.push(directory);
      const requestLogPath = join(directory, "requests.jsonl");
      try {
        const { session } = await createSession(
          { stopOnEntry: true },
          200,
          {},
          process.execPath,
          undefined,
          {
            environment: {
              FAKE_TERMINATE_CAPABILITY: capability,
              FAKE_REQUEST_LOG: requestLogPath,
            },
          },
        );
        await session.launch();
        const adapterPid = ownedAdapterPid(tracking);

        await expect(session.stop()).resolves.toMatchObject({
          snapshot: { state: "terminated" },
        });

        const requests = await readFile(requestLogPath, "utf8");
        expect(requests).not.toContain('"command":"terminate"');
        expect(requests).toContain('"command":"disconnect","arguments":{"terminateDebuggee":true}');
        expect(isProcessAlive(adapterPid)).toBe(false);
      } finally {
        tracking.restore();
      }
    },
  );

  test("stop sends terminate before disconnect when the adapter advertises terminate support", async () => {
    const tracking = trackOwnedProcesses();
    const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-terminate-capability-"));
    temporaryDirectories.push(directory);
    const requestLogPath = join(directory, "requests.jsonl");
    try {
      const { session } = await createSession(
        { stopOnEntry: true },
        200,
        {},
        process.execPath,
        undefined,
        { environment: { FAKE_REQUEST_LOG: requestLogPath } },
      );
      await session.launch();
      const adapterPid = ownedAdapterPid(tracking);

      await expect(session.stop()).resolves.toMatchObject({
        snapshot: { state: "terminated" },
      });

      const requests = await readFile(requestLogPath, "utf8");
      const terminateAt = requests.indexOf('"command":"terminate"');
      const disconnectAt = requests.indexOf('"command":"disconnect"');
      expect(terminateAt).toBeGreaterThanOrEqual(0);
      expect(disconnectAt).toBeGreaterThan(terminateAt);
      expect(isProcessAlive(adapterPid)).toBe(false);
    } finally {
      tracking.restore();
    }
  });

  test.each([false, true])(
    "notifies only actual shutdown-time adapter failure after successful cleanup (crash: %s)",
    async (crash) => {
      const tracking = trackOwnedProcesses();
      const failures: Error[] = [];
      try {
        const { session } = await createSession(
          { stopOnEntry: true, crashOnTerminate: crash },
          200,
          { onUnexpectedFailure: (error) => failures.push(error) },
        );
        await session.launch();
        await expect(session.stop()).resolves.toMatchObject({
          snapshot: { state: "terminated" },
        });
        expect(failures).toEqual(
          crash ? [objectContaining({ kind: stringMatching(/exit|transport/) })] : [],
        );
        await expect(session.dispose()).resolves.toBeUndefined();
        expect(failures).toHaveLength(crash ? 1 : 0);
      } finally {
        tracking.restore();
      }
    },
  );

  test.skipIf(process.platform === "win32").each([false, true])(
    "forgets a runInTerminal group only after confirmed absence (probe fails: %s)",
    async (probeFails) => {
      const tracking = trackOwnedProcesses();
      const failures: Error[] = [];
      let kill: MockInstance<typeof process.kill> | undefined;
      try {
        const { session } = await createSession(
          {
            stopOnEntry: true,
            runInTerminalArgs: [
              process.execPath,
              "-e",
              "process.on('SIGUSR2', () => process.exit(0)); process.stdout.write('solo-ready\\n'); setInterval(() => {}, 1000)",
            ],
          },
          200,
          { onUnexpectedFailure: (error) => failures.push(error) },
        );
        const launched = await session.launch();
        let output = launched.output;
        await waitFor(() => {
          output += session.status().output;
          return output.includes("solo-ready");
        });
        const spawned = tracking.spawn.mock.results[1];
        if (spawned?.type !== "return" || spawned.value.pid === undefined)
          throw new Error("Expected owned terminal process");
        const child = spawned.value;
        const pid = spawned.value.pid;
        const close = once(child, "close", {
          signal: AbortSignal.timeout(5_000),
        });
        const realKill = process.kill;
        const absent = Object.assign(new Error("former group absent"), {
          code: "ESRCH",
        });
        const probeError = Object.assign(new Error("group probe failed"), {
          code: "EIO",
        });
        let groupProbes = 0;
        kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
          if (target === -pid) {
            groupProbes++;
            if (probeFails && groupProbes === 1) throw probeError;
            throw absent;
          }
          return realKill(target, signal);
        });
        process.kill(pid, "SIGUSR2");
        await close;
        kill.mockClear();
        await expect(session.stop()).resolves.toMatchObject({
          snapshot: { state: "terminated" },
        });
        expect(kill.mock.calls.filter(([target]) => target === -pid)).toHaveLength(
          probeFails ? 1 : 0,
        );
        expect(failures).toEqual(probeFails ? [probeError] : []);
      } finally {
        kill?.mockRestore();
        tracking.restore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "refuses a runInTerminal that arrives during teardown without spawning or reporting success",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-teardown-terminal-"));
      temporaryDirectories.push(directory);
      const replyPath = join(directory, "teardown-reply.json");
      const tracking = trackOwnedProcesses();
      try {
        const { session } = await createSession({
          stopOnEntry: true,
          runInTerminalOnTeardown: {
            args: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
            replyPath,
          },
        });

        await expect(session.launch()).resolves.toMatchObject({
          snapshot: objectContaining({ state: "stopped" }),
        });
        await expect(session.stop()).resolves.toMatchObject({
          snapshot: objectContaining({ state: "terminated" }),
        });

        // The adapter process is the only spawn: teardown never started a terminal it could leak.
        expect(tracking.spawn.mock.calls).toHaveLength(1);
        expect(JSON.parse(await readFile(replyPath, "utf8"))).toMatchObject({
          success: false,
          message: stringContaining("refused because the Debug Session is stopping"),
        });
        // The stop finished every resource it owned: shutdown adds nothing and reports no failure.
        await expect(session.dispose()).resolves.toBeUndefined();
        expect(session.status().rejectedChildSessions).toBeUndefined();
      } finally {
        tracking.restore();
      }
    },
  );

  test("decodes a UTF-8 character that runInTerminal output splits across chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-utf8-"));
    temporaryDirectories.push(directory);
    const donePath = join(directory, "done");
    const terminal = await createSession({
      stopOnEntry: true,
      runInTerminalArgs: [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a]), () => require('node:fs').writeFileSync(process.argv[1], 'done')), 50); setInterval(() => {}, 1000)",
        donePath,
      ],
    });
    try {
      let output = (await terminal.session.launch()).output;
      await waitFor(async () => {
        output += terminal.session.status().output;
        return (await readFile(donePath, "utf8").catch(() => "")) === "done";
      });
      await waitFor(() => {
        output += terminal.session.status().output;
        return output.includes("\n");
      });
      expect(output).toContain("é\n");
    } finally {
      await terminal.session.stop();
    }
  });

  test("handles runInTerminal headlessly and rejects child Debug Sessions", async () => {
    const debuggeePidPath = join(
      tmpdir(),
      `pi-hl-dap-debuggee-${String(process.pid)}-${String(Date.now())}`,
    );
    const terminal = await createSession({
      stopOnEntry: true,
      runInTerminalArgs: [
        process.execPath,
        "-e",
        "process.stdout.write('terminal-output\\n'); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
        debuggeePidPath,
      ],
    });

    const launched = await terminal.session.launch();
    let collectedOutput = launched.output;
    await waitFor(async () => {
      try {
        const pidText = await readFile(debuggeePidPath, "utf8");
        collectedOutput += terminal.session.status().output;
        return pidText.length > 0;
      } catch {
        return false;
      }
    });
    const debuggeePid = Number(await readFile(debuggeePidPath, "utf8"));
    expect(collectedOutput).toContain("terminal-output\n");
    expect(isProcessAlive(debuggeePid)).toBe(true);
    await terminal.session.stop();
    await waitFor(() => !isProcessAlive(debuggeePid));
    await rm(debuggeePidPath, { force: true });

    const childSession = await createSession(
      { requestStartDebugging: true },
      200,
      {},
      process.execPath,
      undefined,
      resolvedPreset("vscode-js-debug"),
    );
    await expect(childSession.session.launch()).rejects.toThrow("startDebugging rejected");
    // The refusal outlives the failed launch and is reported once, like unread Debuggee output.
    const terminated = childSession.session.status();
    expect(terminated.snapshot.state).toBe("terminated");
    expect(terminated.rejectedChildSessions).toEqual([
      {
        type: "pwa-node",
        name: "child [1]",
        targetId: "child-1",
        message: stringContaining('child session pwa-node "child [1]" (target child-1)'),
      },
    ]);
    expect(childSession.session.status().rejectedChildSessions).toBeUndefined();
  });

  test("names a child session it cannot debug in the launch result and keeps the Debug Session usable", async () => {
    const { session } = await createSession(
      {
        startDebuggingChild: true,
        stopOnEntry: true,
      },
      200,
      {},
      process.execPath,
      undefined,
      resolvedPreset("vscode-js-debug"),
    );

    const launched = await session.launch();
    expect(launched.snapshot).toMatchObject({
      state: "stopped",
      stopReason: "entry",
    });
    expect(launched.rejectedChildSessions).toEqual([
      {
        type: "pwa-node",
        name: "[worker 1]",
        targetId: "w-1",
        message: stringMatching(
          /child session pwa-node "\[worker 1\]" \(target w-1\): .*transport cannot host another session channel.*Breakpoints in it will not bind/u,
        ),
      },
    ]);
    expect(session.status().rejectedChildSessions).toBeUndefined();
    expect((await session.continue()).rejectedChildSessions).toBeUndefined();
  });

  test("merges launch arguments over the Launch Profile's, with program, args, and cwd winning", async () => {
    const { cwd, session } = await createSession({ stopOnEntry: true }, 100);

    const launched = await session.launch({
      program: "program.ts",
      launchArguments: {
        stopOnEntry: false,
        neverStop: true,
        program: "ignored.ts",
      },
    });
    // stopOnEntry: false from launch_arguments replaced the profile's true, so nothing stops.
    expect(launched.snapshot.state).toBe("running");
    await session.stop();

    const second = await session.launch({
      launchArguments: { program: "other.ts" },
    });
    expect(second.stop?.topFrame?.source?.path).toBe("other.ts");
    await session.stop();
    const third = await session.launch({
      program: "program.ts",
      launchArguments: { program: "other.ts" },
    });
    expect(third.stop?.topFrame?.source?.path).toBe(resolve(cwd, "program.ts"));
  });

  test("a shutdown during startup publishes no Debug Session and starts no adapter", async () => {
    const stderrPath = gateAdapterStderrPath();
    const snapshots: DapSnapshot[] = [];
    const tracking = trackOwnedProcesses();
    try {
      const { session } = await createSession(
        { stopOnEntry: true },
        200,
        { onSnapshotChange: (snapshot) => snapshots.push(snapshot) },
        process.execPath,
        stderrPath.wrap,
      );

      const launching = session.launch();
      await stderrPath.entered;
      let shutdownSettled = false;
      const shutdown = session.dispose().then(() => {
        shutdownSettled = true;
      });
      await new Promise((resolveTick) => setImmediate(resolveTick));
      // Shutdown waits for the blocked startup instead of finishing while it is pending.
      expect(shutdownSettled).toBe(false);
      stderrPath.release();

      await expect(launching).rejects.toThrow("closed");
      await shutdown;
      // The rollback reports the idle state; the launch publishes no Debug Session of its own.
      expect(snapshots.filter((snapshot) => snapshot.state !== "idle")).toEqual([]);
      expect(tracking.spawn).not.toHaveBeenCalled();
      expect(session.snapshot()).toEqual({ state: "idle" });
      await expect(session.launch()).rejects.toThrow("closed");
      await expect(session.dispose()).resolves.toBeUndefined();
    } finally {
      tracking.restore();
    }
  });

  test("a second launch while the first is starting rejects and shutdown awaits the first", async () => {
    const stderrPath = gateAdapterStderrPath();
    const snapshots: DapSnapshot[] = [];
    const tracking = trackOwnedProcesses();
    try {
      const { session } = await createSession(
        { stopOnEntry: true },
        200,
        { onSnapshotChange: (snapshot) => snapshots.push(snapshot) },
        process.execPath,
        stderrPath.wrap,
      );

      const launching = session.launch();
      await stderrPath.entered;
      // Observed, not awaited: with the startup slot held, the second launch must reject at once.
      let secondFailure = "still starting";
      const second = session.launch().catch((cause: unknown) => {
        secondFailure = cause instanceof Error ? cause.message : String(cause);
      });
      await new Promise((resolveTick) => setImmediate(resolveTick));
      expect(secondFailure).toContain("already starting");
      await second;

      let shutdownSettled = false;
      const shutdown = session.dispose().then(() => {
        shutdownSettled = true;
      });
      await new Promise((resolveTick) => setImmediate(resolveTick));
      expect(shutdownSettled).toBe(false);
      stderrPath.release();

      await expect(launching).rejects.toThrow("closed");
      await shutdown;
      expect(snapshots.filter((snapshot) => snapshot.state !== "idle")).toEqual([]);
      // Neither launch started an adapter, and the rejected one left no barrier behind.
      expect(tracking.spawn).not.toHaveBeenCalled();
      expect(session.snapshot()).toEqual({ state: "idle" });
      await expect(session.launch()).rejects.toThrow("closed");
    } finally {
      tracking.restore();
    }
  });

  test("a shutdown while the adapter transport starts kills the adapter it spawned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-listen-gate-"));
    temporaryDirectories.push(directory);
    const pidPath = join(directory, "adapter.pid");
    const gatePath = join(directory, "listen.gate");
    const snapshots: DapSnapshot[] = [];
    const tracking = trackOwnedProcesses();
    try {
      const session = await createJsDapSession(
        "listen-gate",
        {},
        500,
        5_000,
        { onSnapshotChange: (snapshot) => snapshots.push(snapshot) },
        {
          FAKE_JS_DEBUG_PID_PATH: pidPath,
          FAKE_JS_DEBUG_LISTEN_GATE: gatePath,
        },
      );

      const launching = session.launch();
      // The adapter is running but cannot accept the transport yet, so startup is in flight.
      await expect.poll(() => readFile(pidPath, "utf8"), { timeout: 5_000 }).toMatch(/^\d+$/u);
      const adapterPid = Number(await readFile(pidPath, "utf8"));

      await session.dispose();

      await expect(launching).rejects.toThrow("closed");
      expect(isProcessAlive(adapterPid)).toBe(false);
      // The rollback reports the idle state; startup publishes no Debug Session of its own.
      expect(snapshots.filter((snapshot) => snapshot.state !== "idle")).toEqual([]);
      expect(session.snapshot()).toEqual({ state: "idle" });
      await expect(session.launch()).rejects.toThrow("closed");
    } finally {
      tracking.restore();
    }
  });

  test("cleans up launch cancellation", async () => {
    const controller = new AbortController();
    const cancelled = await createSession({ delayInitializedMs: 200, stopOnEntry: true }, 200, {
      onSnapshotChange: (snapshot) => {
        if (snapshot.state === "launching") controller.abort();
      },
    });

    await expect(cancelled.session.launch({}, controller.signal)).rejects.toThrow(
      "launch was cancelled and cleaned up",
    );
    expect(cancelled.session.status().snapshot.state).toBe("terminated");
  });
});

/** A Debug Session whose profile map is all that matters: every launch fails before an adapter starts. */
async function createProfileSession(profiles: readonly DapLaunchProfile[]): Promise<DapController> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-hl-dap-session-profiles-"));
  temporaryDirectories.push(cwd);
  const files = await createDapArtifacts(cwd);
  openSessionFiles.push(files);
  return new DapController({
    cwd,
    settings: {
      adapters: new Map([
        [
          "node",
          {
            id: "node",
            command: process.execPath,
            args: [fakeAdapterPath],
            environment: {},
            transport: { type: "stdio" },
          },
        ],
      ]),
      profiles: new Map(profiles.map((profile) => [profile.id, profile])),
      timeouts: {
        executionMs: 200,
        requestMs: 1_000,
        shutdownMs: 500,
        startupMs: 5_000,
      },
      warnings: [],
    },
    artifacts: files,
  });
}

function nodeProfile(id: string): DapLaunchProfile {
  return { id, adapterId: "node", arguments: { stopOnEntry: true } };
}

describe("DapController Launch Profile resolution", () => {
  test("lists the valid profiles when the requested profile is unknown", async () => {
    const session = await createProfileSession([nodeProfile("beta"), nodeProfile("alpha")]);

    await expect(session.launch({ profile: "default" })).rejects.toThrow(
      'unknown Launch Profile default; valid profiles: "alpha", "beta"',
    );
  });

  test("names the only valid profile and says the profile can be omitted", async () => {
    const session = await createProfileSession([nodeProfile("python-fixture")]);

    await expect(session.launch({ profile: "default" })).rejects.toThrow(
      'unknown Launch Profile default; valid profiles: "python-fixture" (profile may be omitted)',
    );
  });

  test("says no valid Launch Profile is configured", async () => {
    const session = await createProfileSession([]);

    await expect(session.launch({ profile: "default" })).rejects.toThrow(
      "unknown Launch Profile default; no valid Launch Profile is configured",
    );
    await expect(session.launch()).rejects.toThrow(
      "launch requires a valid Launch Profile; no valid Launch Profile is configured",
    );
  });

  test("lists the valid profiles when launch omits the profile", async () => {
    const session = await createProfileSession([nodeProfile("beta"), nodeProfile("alpha")]);

    await expect(session.launch()).rejects.toThrow(
      'launch requires profile when there is not exactly one valid Launch Profile; valid profiles: "alpha", "beta"',
    );
  });

  test("lists ten valid profiles at most and summarizes the rest deterministically", async () => {
    const ids = Array.from(
      { length: 12 },
      (_value, index) => `profile-${String(index + 1).padStart(2, "0")}`,
    );
    const session = await createProfileSession(ids.map(nodeProfile));
    const reversed = await createProfileSession(ids.toReversed().map(nodeProfile));
    const expected =
      'valid profiles: "profile-01", "profile-02", "profile-03", "profile-04", "profile-05", "profile-06", "profile-07", "profile-08", "profile-09", "profile-10" and 2 more';

    await expect(session.launch({ profile: "unknown" })).rejects.toThrow(expected);
    await expect(reversed.launch({ profile: "unknown" })).rejects.toThrow(expected);
  });
});

describe("DapController adapter-declared Debug targets", () => {
  test("starts the first promoted channel as the primary target without adapter-specific markers", async () => {
    const session = await createPromotedSession(
      "generic-primary",
      resolvedPreset("vscode-js-debug"),
    );

    const launched = await session.launch();

    expect(launched.snapshot).toMatchObject({
      state: "terminated",
      exitCode: 0,
    });
    expect(launched.rejectedChildSessions).toBeUndefined();
    await session.dispose();
  });

  test("keeps each channel's terminate capability when a promoted target replaces the root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-promoted-capability-"));
    temporaryDirectories.push(directory);
    const evidencePath = join(directory, "evidence.jsonl");
    const session = await createPromotedSession(
      "generic-primary",
      resolvedPreset("vscode-js-debug"),
      {
        environment: {
          FAKE_JS_DEBUG_EVIDENCE_PATH: evidencePath,
          FAKE_TERMINATE_ROOT: "true",
          FAKE_TERMINATE_TARGET: "false",
        },
      },
    );

    const launched = await session.launch();
    expect(launched.snapshot).toMatchObject({
      state: "terminated",
      exitCode: 0,
    });
    await session.dispose();

    const entries = (await readFile(evidencePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error("invalid promoted adapter evidence entry");
        return parsed;
      });
    expect(entries).toContainEqual({ event: "terminate", role: "root" });
    expect(entries).not.toContainEqual({ event: "terminate", role: "primary" });
  });

  test("keeps the root channel primary when the policy does not mark the first promoted channel", async () => {
    // The Adapter Definition's own policy overrides the preset's firstSessionIsPrimary.
    const session = await createPromotedSession("generic-child", {
      ...resolvedPreset("vscode-js-debug"),
      channels: { sessions: "promoted", firstSessionIsPrimary: false },
    });

    const launched = await session.launch();

    expect(launched.snapshot).toMatchObject({
      state: "stopped",
      stopReason: "breakpoint",
    });
    expect(launched.stop?.childSession).toBe("generic child");
    expect(launched.rejectedChildSessions).toBeUndefined();
    await session.dispose();
  });

  test("does not invent an exit code for a promoted adapter that declares no exit report", async () => {
    const session = await createPromotedSession("clean", {
      channels: { sessions: "promoted", firstSessionIsPrimary: true },
    });

    const launched = await session.launch();

    expect(launched.snapshot.state).toBe("terminated");
    expect(Object.hasOwn(launched.snapshot, "exitCode")).toBe(false);
    await session.dispose();
  });

  test("keeps the standard exited code over a later adapter exit report", async () => {
    const session = await createPromotedSession(
      "report-then-exited",
      resolvedPreset("vscode-js-debug"),
    );

    const launched = await session.launch();

    expect(launched.snapshot).toMatchObject({
      state: "terminated",
      exitCode: 4,
    });
    await session.dispose();
  });

  test("advertises startDebugging only when the adapter promotes targets over a hosting transport", async () => {
    const promoted = await createPromotedSession("advertise", resolvedPreset("vscode-js-debug"));

    const launched = await promoted.launch();

    expect(launched.stop?.description).toBe(
      "initialize adapterID=pwa-node supportsStartDebuggingRequest=true",
    );
    await promoted.dispose();
  });

  test("does not advertise startDebugging for an adapter that declares no Debug targets", async () => {
    const session = await createPromotedSession("advertise", {});

    const launched = await session.launch();

    expect(launched.stop?.description).toBe(
      "initialize adapterID=node supportsStartDebuggingRequest=false",
    );
    await session.dispose();
  });

  test("does not advertise startDebugging for a promoted adapter on stdio", async () => {
    const { session } = await createSession(
      { reportInitializeArguments: true, stopOnEntry: true },
      200,
      {},
      process.execPath,
      undefined,
      resolvedPreset("vscode-js-debug"),
    );

    const launched = await session.launch();

    expect(launched.stop?.description).toBe(
      "initialize adapterID=pwa-node supportsStartDebuggingRequest=false",
    );
    await session.dispose();
  });

  test("uses a Launch Profile adapterID before the adapter's", async () => {
    const session = await createPromotedSession("advertise", resolvedPreset("vscode-js-debug"), {
      profileAdapterID: "custom-adapter",
    });

    const launched = await session.launch();

    expect(launched.stop?.description).toBe(
      "initialize adapterID=custom-adapter supportsStartDebuggingRequest=true",
    );
    await session.dispose();
  });

  test("surfaces an adapter launch failure instead of waiting for initialized", async () => {
    const { session } = await createSession({
      launchError: "Invalid program path",
    });
    const startedAt = Date.now();

    await expect(session.launch()).rejects.toThrow("Invalid program path");

    // Well inside the 1000 ms startup timeout that used to mask the adapter's error.
    expect(Date.now() - startedAt).toBeLessThan(900);
    expect(session.status().snapshot.state).toBe("terminated");
  });
});

/** A promoted-session fixture that also records the adapter's protocol events in an evidence file. */
async function createEvidenceSession(
  script: string,
  adapter: Partial<Pick<DapAdapterDefinition, "adapterID" | "channels" | "outputExitReport">>,
  options: {
    readonly executionMs?: number;
    readonly profileAdapterID?: string;
    readonly profileArguments?: Readonly<Record<string, string | number>>;
  } = {},
): Promise<{ readonly evidencePath: string; readonly session: DapController }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-hl-dap-evidence-"));
  temporaryDirectories.push(directory);
  const evidencePath = join(directory, "events.jsonl");
  const session = await createPromotedSession(script, adapter, {
    ...options,
    environment: { FAKE_JS_DEBUG_EVIDENCE_PATH: evidencePath },
  });
  return { evidencePath, session };
}

/** The evidence lines the fake adapter wrote so far. */
async function readEvidence(evidencePath: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(evidencePath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseEvidenceLine);
}

/** One evidence line, which the fake adapter always writes as a JSON object. */
function parseEvidenceLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error("DAP session test found a malformed evidence line");
  return parsed;
}

/** Wait until the adapter recorded an event matching the predicate. */
async function waitForEvidence(
  evidencePath: string,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await waitFor(async () => {
    found = (await readEvidence(evidencePath)).find(predicate);
    return found !== undefined;
  });
  if (found === undefined) throw new Error("DAP session test found no matching evidence");
  return found;
}

/** Collect unhandled rejections for the duration of one test body. */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  // Let queued rejection notices run before the caller asserts on them.
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  return unhandled;
}

describe("DapController teardown and handshake regressions", () => {
  test("refuses a startDebugging request that arrives after the Debuggee exited", async () => {
    const { evidencePath, session } = await createEvidenceSession(
      "stop-then-promote",
      resolvedPreset("vscode-js-debug"),
    );

    await session.launch();

    const reply = await waitForEvidence(evidencePath, (event) => event.event === "reply");
    const connects = (await readEvidence(evidencePath)).filter(
      (event) => event.event === "connect",
    );
    expect(connects.map((event) => event.role)).toEqual(["root"]);
    expect(reply.success).toBe(false);
    await session.dispose();
  });

  test("refuses a Child session request that arrives after the Debuggee exited", async () => {
    const { evidencePath, session } = await createEvidenceSession("stop-then-promote", {
      ...resolvedPreset("vscode-js-debug"),
      channels: {
        sessions: "promoted",
        firstSessionIsPrimary: false,
        targetIdKey: "__pendingTargetId",
      },
    });

    await session.launch();

    await waitForEvidence(evidencePath, (event) => event.event === "reply");
    const connects = (await readEvidence(evidencePath)).filter(
      (event) => event.event === "connect",
    );
    expect(connects.map((event) => event.role)).toEqual(["root"]);
    await session.dispose();
  });

  test("surfaces a promoted target launch failure before initialized", async () => {
    const { evidencePath, session } = await createEvidenceSession(
      "fail-primary-launch",
      resolvedPreset("vscode-js-debug"),
      { executionMs: 500 },
    );

    const unhandled = await withoutUnhandledRejections(async () => {
      const startedAt = Date.now();
      await expect(session.launch()).rejects.toThrow(/target launch exploded/u);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      const reply = await waitForEvidence(evidencePath, (event) => event.event === "reply");
      expect(reply.success).toBe(false);
      expect(reply.message).toContain("target launch exploded");
      await session.dispose();
    });

    expect(unhandled).toEqual([]);
  });

  test("fails the launch when the promoted target launch fails", async () => {
    const { evidencePath, session } = await createEvidenceSession(
      "fail-primary-launch",
      resolvedPreset("vscode-js-debug"),
      { executionMs: 500 },
    );

    const unhandled = await withoutUnhandledRejections(async () => {
      try {
        const startedAt = Date.now();
        await expect(session.launch()).rejects.toThrow(/target launch exploded/u);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(session.snapshot().state).toBe("terminated");
        await waitForEvidence(evidencePath, (event) => event.event === "disconnect");
      } finally {
        await session.dispose();
      }
    });

    expect(unhandled).toEqual([]);
  });

  test("surfaces a Child session launch failure before initialized", async () => {
    const { evidencePath, session } = await createEvidenceSession(
      "fail-child-launch",
      {
        ...resolvedPreset("vscode-js-debug"),
        channels: {
          sessions: "promoted",
          firstSessionIsPrimary: false,
          targetIdKey: "__pendingTargetId",
        },
      },
      { executionMs: 500 },
    );

    const unhandled = await withoutUnhandledRejections(async () => {
      const startedAt = Date.now();
      const launched = await session.launch();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(launched.rejectedChildSessions?.[0]?.message).toContain("child launch exploded");
      const reply = await waitForEvidence(evidencePath, (event) => event.event === "reply");
      expect(reply.success).toBe(false);
      await session.dispose();
    });

    expect(unhandled).toEqual([]);
  });

  test("reports distinct thread ids when the root and a Child session share adapter thread 1", async () => {
    const session = await createPromotedSession("thread-collision", {
      ...resolvedPreset("vscode-js-debug"),
      channels: {
        sessions: "promoted",
        firstSessionIsPrimary: false,
        targetIdKey: "__pendingTargetId",
      },
    });

    const launched = await session.launch();
    if (launched.snapshot.state !== "stopped") throw new Error("root Debug Session did not stop");
    expect(launched.snapshot.stopReason).toBe("entry");
    const rootThread = launched.snapshot.threadId;
    if (rootThread === undefined) throw new Error("root stop reported no thread id");
    const continued = await session.continue();
    if (continued.snapshot.state !== "stopped") throw new Error("Child session did not stop");
    expect(continued.snapshot.stopReason).toBe("breakpoint");
    const childThread = continued.snapshot.threadId;

    expect(childThread).not.toBe(rootThread);
    await expect(session.stack({ threadId: rootThread })).rejects.toThrow(/is not one/u);
    await session.dispose();
  });
});

describe("DapController adapter-declared exit reporting", () => {
  test("does not treat a present non-string console argument as the default", async () => {
    const session = await createPromotedSession("clean", resolvedPreset("vscode-js-debug"), {
      profileArguments: { console: 123 },
    });

    const launched = await session.launch();

    expect(launched.snapshot.state).toBe("terminated");
    expect(Object.hasOwn(launched.snapshot, "exitCode")).toBe(false);
    await session.dispose();
  });

  test("does not default the exit code for a terminal console", async () => {
    const session = await createPromotedSession("clean", resolvedPreset("vscode-js-debug"), {
      profileArguments: { console: "externalTerminal" },
    });

    const launched = await session.launch();

    expect(launched.snapshot.state).toBe("terminated");
    expect(Object.hasOwn(launched.snapshot, "exitCode")).toBe(false);
    await session.dispose();
  });

  test("leaves a report-shaped stderr line unknown without a preset rule", async () => {
    const session = await createPromotedSession("report-only", {
      channels: { sessions: "promoted", firstSessionIsPrimary: true },
    });

    const launched = await session.launch();

    expect(launched.snapshot.state).toBe("terminated");
    expect(Object.hasOwn(launched.snapshot, "exitCode")).toBe(false);
    await session.dispose();
  });
});

describe("DapController adapterID and startDebugging argument validation", () => {
  test("sends the explicit adapterID on the primary target and Child session channels", async () => {
    const { evidencePath, session } = await createEvidenceSession(
      "children",
      resolvedPreset("vscode-js-debug"),
      { profileAdapterID: "custom-adapter" },
    );

    const launched = await session.launch();
    expect(launched.snapshot).toMatchObject({ state: "stopped" });
    const initialized = (await readEvidence(evidencePath)).filter(
      (event) => event.event === "initialize" && event.role !== "root",
    );
    expect(initialized.length).toBeGreaterThan(1);
    expect(initialized.every((event) => event.adapterID === "custom-adapter")).toBe(true);
    await session.dispose();
  });

  test("refuses invalid startDebugging arguments before opening a channel", async () => {
    const { evidencePath, session } = await createEvidenceSession(
      "invalid-start-debugging",
      resolvedPreset("vscode-js-debug"),
      { executionMs: 200 },
    );

    await session.launch();

    const reply = await waitForEvidence(evidencePath, (event) => event.event === "reply");
    expect(reply).toMatchObject({
      success: false,
      message: "HL DAP: startDebugging arguments are invalid",
    });
    const connects = (await readEvidence(evidencePath)).filter(
      (event) => event.event === "connect",
    );
    expect(connects.map((event) => event.role)).toEqual(["root"]);
    await session.dispose();
  });
});
