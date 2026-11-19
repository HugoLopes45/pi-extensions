import childProcess from "node:child_process";
import { once } from "node:events";
import filesystem from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionRunner,
  type ExtensionContext,
  type ExtensionError,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { hasSteering, clearSteering } from "pi-hl-utils/steering";
import { anyInstance, objectContaining, stringMatching } from "pi-hl-utils/testing/matchers";
import { afterEach, describe, expect, test, vi, type MockInstance } from "vitest";

import { createDapExtension } from "../extensions/index.js";
import { DAP_OPERATIONS } from "../src/schemas.js";
import type { DapSettingsDocumentInput } from "../src/settings.js";
import { expectDapToolOutput } from "./output.js";
import { toToolContext } from "./tool-context.js";

const temporaryDirectories: string[] = [];
const DAP_TOOL_NAMES = DAP_OPERATIONS.map((operation) => `hl_dap_${operation}`);
const agentSessions: AgentSession[] = [];

interface ExtensionHarness {
  readonly agentDirectory: string;
  readonly notifications: string[];
  readonly runner: ExtensionRunner;
  readonly session: AgentSession;
  readonly sessionDirectory: string;
  readonly shutdownHandlers: readonly ((
    event: SessionShutdownEvent,
    context: ExtensionContext,
  ) => Promise<unknown>)[];
  readonly startHandlers: readonly ((
    event: SessionStartEvent,
    context: ExtensionContext,
  ) => Promise<unknown>)[];
  readonly widgetCalls: readonly {
    readonly key: string;
    readonly content: unknown;
  }[];
}

function registeredDapLifecycle(harness: ExtensionHarness) {
  const launch = harness.runner.getToolDefinition("hl_dap_launch");
  const shutdown = harness.shutdownHandlers[0];
  const start = harness.startHandlers[0];
  if (launch === undefined || shutdown === undefined || start === undefined)
    throw new Error("Expected registered debugger lifecycle");
  return { launch, shutdown, start };
}

function ownedAdapter(spawn: MockInstance<typeof childProcess.spawn>) {
  const root = spawn.mock.results[0];
  if (root?.type !== "return" || root.value.pid === undefined)
    throw new Error("Expected owned adapter");
  return { child: root.value, pid: root.value.pid };
}

async function stopOwnedAdapter(child: childProcess.ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill("SIGKILL");
  await exit;
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createExtensionHarness(
  projectTrusted: boolean,
  globalSettings: DapSettingsDocumentInput,
  mode: "tui" | "rpc" = "rpc",
  noSession = false,
  projectSettings = JSON.stringify({ hlDap: { unknownProjectField: true } }),
): Promise<ExtensionHarness> {
  const cwd = await makeTemporaryDirectory("pi-hl-dap-extension-cwd-");
  const agentDirectory = await makeTemporaryDirectory("pi-hl-dap-extension-agent-");
  const sessionDirectory = await makeTemporaryDirectory("pi-hl-dap-extension-sessions-");
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
  await mkdir(resolve(cwd, ".pi"));
  await writeFile(resolve(cwd, ".pi/settings.json"), projectSettings);

  if (noSession) {
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, sessionDirectory);
  }
  const sessionManager = noSession
    ? SessionManager.inMemory(cwd)
    : SessionManager.create(cwd, sessionDirectory);
  const settingsManager = SettingsManager.create(cwd, agentDirectory, {
    projectTrusted,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    settingsManager,
    extensionFactories: [
      {
        name: "pi-hl-dap-lifecycle-test",
        factory: createDapExtension(() => agentDirectory),
      },
    ],
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  expect(extensions.errors).toEqual([]);
  expect(extensions.extensions).toHaveLength(1);

  const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
  const session = (
    await createAgentSession({
      cwd,
      agentDir: agentDirectory,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
    })
  ).session;
  agentSessions.push(session);
  const runner = session.extensionRunner;
  const notifications: string[] = [];
  const widgetCalls: { key: string; content: unknown }[] = [];
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify: (message) => notifications.push(message),
      setWidget: (key, content) => widgetCalls.push({ key, content }),
    },
    mode,
  );
  return {
    agentDirectory,
    notifications,
    shutdownHandlers: extensions.extensions.flatMap(
      (extension) => extension.handlers.get("session_shutdown") ?? [],
    ),
    startHandlers: extensions.extensions.flatMap(
      (extension) => extension.handlers.get("session_start") ?? [],
    ),
    get runner() {
      return session.extensionRunner;
    },
    session,
    sessionDirectory,
    widgetCalls,
  };
}

async function startExtension(
  harness: ExtensionHarness,
  reason: "startup" | "reload",
): Promise<void> {
  await harness.runner.emit({
    type: "session_start",
    reason,
  } satisfies SessionStartEvent);
}

async function shutdownExtension(harness: ExtensionHarness): Promise<void> {
  await harness.runner.emit({
    type: "session_shutdown",
    reason: "quit",
  } satisfies SessionShutdownEvent);
}

async function piDapSessionDirectories(sessionDirectory: string): Promise<string[]> {
  return (await readdir(sessionDirectory)).filter((entry) => entry.startsWith("pi-hl-dap-"));
}

function holdNextArtifactAllocation(sessionDirectory: string) {
  const entered = Promise.withResolvers<string>();
  const gate = Promise.withResolvers<void>();
  const chmod = filesystem.chmod;
  let held = false;
  const permission = vi.spyOn(filesystem, "chmod").mockImplementation(async (path, mode) => {
    await chmod(path, mode);
    if (
      held ||
      typeof path !== "string" ||
      !path.startsWith(resolve(sessionDirectory, "pi-hl-dap-"))
    )
      return;
    held = true;
    entered.resolve(path);
    await gate.promise;
  });
  syncBuiltinESMExports();
  return {
    entered: entered.promise,
    release: gate.resolve,
    restore: () => {
      permission.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const session of agentSessions) {
    clearSteering(session.extensionRunner.createContext().sessionManager.getSessionId());
  }
  for (const session of agentSessions.splice(0)) {
    try {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      session.dispose();
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("HL DAP extension lifecycle", () => {
  test("names only registered debugger tools in the troubleshooting skill", async () => {
    const harness = await createExtensionHarness(false, {});
    await harness.session.bindExtensions({ mode: "rpc" });
    const registeredNames = harness.runner
      .getAllRegisteredTools()
      .map(({ definition }) => definition.name);
    const skill = await readFile(
      resolve(import.meta.dirname, "../skills/pi-hl-dap/SKILL.md"),
      "utf8",
    );
    const references = Array.from(skill.matchAll(/`(?:hl_)?dap_[a-z_]+`/gu), ([reference]) =>
      reference.slice(1, -1),
    );

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(registeredNames).toContain(reference);
  });

  test("loads the package manifest entry through Pi and executes a registered tool", async () => {
    const cwd = await makeTemporaryDirectory("pi-hl-dap-package-");
    const agentDir = await makeTemporaryDirectory("pi-hl-dap-package-agent-");
    const packagePath = resolve(import.meta.dirname, "..");
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      additionalExtensionPaths: [packagePath],
    });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.map(({ resolvedPath }) => resolvedPath)).toEqual([
      resolve(packagePath, "extensions/index.ts"),
    ]);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    });
    agentSessions.push(session);
    await session.bindExtensions({ mode: "rpc" });
    expect(
      session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition.name),
    ).toEqual(DAP_TOOL_NAMES);
    const tool = session.getToolDefinition("hl_dap_status");
    if (tool === undefined) throw new Error("Expected package DAP status tool");
    const result = await tool.execute(
      "package-status",
      {},
      undefined,
      undefined,
      toToolContext(session.extensionRunner.createContext()),
    );
    expectDapToolOutput("status", result);
    expect(result.structuredContent).toMatchObject({
      state: "idle",
      desired_breakpoints: [],
    });
  });

  test.each([false, true])(
    "keeps DAP usable across startup, reload, and shutdown (noSession: %s)",
    async (noSession) => {
      const harness = await createExtensionHarness(false, {}, "rpc", noSession);
      const errors: unknown[] = [];
      await harness.session.bindExtensions({
        mode: "rpc",
        uiContext: harness.runner.getUIContext(),
        onError: (error) => errors.push(error),
      });
      expect(errors).toEqual([]);
      expect(harness.runner.createContext().sessionManager.getSessionDir()).toBe(
        noSession ? "" : harness.sessionDirectory,
      );
      const status = async () => {
        const tool = harness.session.getToolDefinition("hl_dap_status");
        if (tool === undefined) throw new Error("Expected DAP status tool");
        const result = await tool.execute(
          "status",
          {},
          undefined,
          undefined,
          toToolContext(harness.runner.createContext()),
        );
        expectDapToolOutput("status", result);
        return result;
      };
      expect(await status()).toMatchObject({
        details: { operation: "status", state: "idle" },
      });
      const firstDirectories = await piDapSessionDirectories(harness.sessionDirectory);
      expect(firstDirectories).toHaveLength(1);

      let definitionsDuringTranscriptRebuild: unknown[] = [];
      await harness.session.reload({
        beforeSessionStart: () => {
          definitionsDuringTranscriptRebuild = DAP_TOOL_NAMES.map((name) =>
            harness.session.getToolDefinition(name),
          );
        },
      });

      expect(definitionsDuringTranscriptRebuild).toEqual(
        DAP_TOOL_NAMES.map((name) =>
          objectContaining({
            name,
            renderCall: anyInstance(Function),
            renderResult: anyInstance(Function),
          }),
        ),
      );
      expect(errors).toEqual([]);
      expect(await status()).toMatchObject({
        details: { operation: "status", state: "idle" },
      });
      const reloadedDirectories = await piDapSessionDirectories(harness.sessionDirectory);
      expect(reloadedDirectories).toHaveLength(1);
      expect(reloadedDirectories).not.toEqual(firstDirectories);
      await shutdownExtension(harness);
      expect(await piDapSessionDirectories(harness.sessionDirectory)).toEqual([]);
    },
  );

  test("tracks Queued Steers so execution waits can yield, ignoring follow-ups", async () => {
    const harness = await createExtensionHarness(false, {});
    const sessionId = harness.runner.createContext().sessionManager.getSessionId();

    await harness.runner.emitInput("later", undefined, "interactive", "followUp");
    expect(hasSteering(sessionId)).toBe(false);
    await harness.runner.emitInput("now", undefined, "interactive", "steer");
    expect(hasSteering(sessionId)).toBe(true);
    await harness.runner.emit({ type: "agent_end", messages: [] });
    expect(hasSteering(sessionId)).toBe(false);
  });

  test("reports a settings warning without terminal control sequences", async () => {
    const harness = await createExtensionHarness(false, {
      hlDap: { "field\x1b]0;pwned\x07\x1b[2J": true },
    });

    await startExtension(harness, "startup");
    expect(harness.notifications).toEqual([stringMatching(/hlDap\.field\b/u)]);
    for (const control of ["\u001b", "\u0007"]) {
      expect(harness.notifications[0]).not.toContain(control);
    }
  });

  test("reports settings warnings once per load, and shuts down idempotently", async () => {
    const harness = await createExtensionHarness(false, {
      hlDap: { unknownGlobalField: true },
    });

    expect(harness.runner.getAllRegisteredTools().map(({ definition }) => definition.name)).toEqual(
      DAP_TOOL_NAMES,
    );
    expect(await piDapSessionDirectories(harness.sessionDirectory)).toEqual([]);

    await startExtension(harness, "startup");
    expect(harness.notifications).toEqual([
      stringMatching(/^DAP: settings:\n- .*global hlDap\.unknownGlobalField/su),
    ]);
    expect(harness.notifications[0]).not.toContain("unknownProjectField");
    const firstDirectories = await piDapSessionDirectories(harness.sessionDirectory);
    expect(firstDirectories).toHaveLength(1);

    harness.notifications.length = 0;
    await writeFile(resolve(harness.agentDirectory, "settings.json"), "{}");
    await startExtension(harness, "reload");
    expect(harness.notifications).toEqual([]);
    const reloadedDirectories = await piDapSessionDirectories(harness.sessionDirectory);
    expect(reloadedDirectories).toHaveLength(1);
    expect(reloadedDirectories).not.toEqual(firstDirectories);

    await Promise.all([shutdownExtension(harness), shutdownExtension(harness)]);
    expect(await piDapSessionDirectories(harness.sessionDirectory)).toEqual([]);
  });

  test("cleans the debugger and artifacts when widget disposal throws, retaining the error", async () => {
    const harness = await createExtensionHarness(
      false,
      {
        hlDap: {
          adapters: {
            node: {
              command: process.execPath,
              args: [resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs")],
              transport: "stdio",
            },
          },
          profiles: {
            node: { adapter: "node", arguments: { stopOnEntry: true } },
          },
        },
      },
      "tui",
    );
    const errors: ExtensionError[] = [];
    const widgetError = new Error("widget removal failed");
    const ui = harness.runner.getUIContext();
    const setWidget = vi.spyOn(ui, "setWidget");
    await harness.session.bindExtensions({
      mode: "tui",
      uiContext: ui,
      onError: (error) => errors.push(error),
    });
    const launch = harness.session.getToolDefinition("hl_dap_launch");
    if (launch === undefined) throw new Error("Expected registered launch tool");
    const spawn = vi.spyOn(childProcess, "spawn");
    syncBuiltinESMExports();
    let child: childProcess.ChildProcess | undefined;
    try {
      const result = await launch.execute(
        "launch",
        {},
        undefined,
        undefined,
        toToolContext(harness.runner.createContext()),
      );
      expectDapToolOutput("launch", result);
      expect(result).toMatchObject({ details: { state: "stopped" } });
      child = ownedAdapter(spawn).child;
      expect(harness.widgetCalls).toContainEqual({
        key: "pi-hl-dap",
        content: anyInstance(Function),
      });
      setWidget.mockImplementation(() => {
        throw widgetError;
      });
      await shutdownExtension(harness);
      expect.soft(await piDapSessionDirectories(harness.sessionDirectory)).toEqual([]);
      expect.soft(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(errors).toEqual([
        objectContaining({
          event: "session_shutdown",
          error: widgetError.message,
        }),
      ]);
      await shutdownExtension(harness);
      expect(errors).toEqual([
        objectContaining({
          event: "session_shutdown",
          error: widgetError.message,
        }),
        objectContaining({
          event: "session_shutdown",
          error: widgetError.message,
        }),
      ]);
    } finally {
      setWidget.mockRestore();
      spawn.mockRestore();
      syncBuiltinESMExports();
      await stopOwnedAdapter(child);
    }
  });

  test("overlapping session starts cannot replace the newer runtime with an obsolete allocation", async () => {
    const harness = await createExtensionHarness(false, {});
    const errors: ExtensionError[] = [];
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: harness.runner.getUIContext(),
      onError: (error) => errors.push(error),
    });
    const allocation = holdNextArtifactAllocation(harness.sessionDirectory);
    const firstStart = startExtension(harness, "reload");
    try {
      await allocation.entered;
      await startExtension(harness, "reload");
      const breakpoints = harness.session.getToolDefinition("hl_dap_set_breakpoints");
      const status = harness.session.getToolDefinition("hl_dap_status");
      if (breakpoints === undefined || status === undefined)
        throw new Error("Expected registered breakpoint and status tools");
      const filePath = resolve(harness.runner.createContext().cwd, "current.ts");
      await breakpoints.execute(
        "newer-breakpoints",
        { file_path: filePath, breakpoints: [{ line: 7 }] },
        undefined,
        undefined,
        toToolContext(harness.runner.createContext()),
      );
      allocation.release();
      await firstStart;
      const result = await status.execute(
        "newer-status",
        {},
        undefined,
        undefined,
        toToolContext(harness.runner.createContext()),
      );
      expectDapToolOutput("status", result);
      expect.soft(result.structuredContent).toMatchObject({
        desired_breakpoints: [{ file_path: filePath, breakpoints: [{ line: 7 }] }],
      });
      expect.soft(await piDapSessionDirectories(harness.sessionDirectory)).toHaveLength(1);
      await shutdownExtension(harness);
      expect.soft(await piDapSessionDirectories(harness.sessionDirectory)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      allocation.release();
      await firstStart;
      allocation.restore();
    }
  });

  test("shutdown during pending artifact allocation cannot publish or leak a runtime", async () => {
    const harness = await createExtensionHarness(false, {});
    const errors: ExtensionError[] = [];
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: harness.runner.getUIContext(),
      onError: (error) => errors.push(error),
    });
    const status = harness.session.getToolDefinition("hl_dap_status");
    if (status === undefined) throw new Error("Expected registered status tool");
    const readStatus = () =>
      status.execute(
        "shutdown-status",
        {},
        undefined,
        undefined,
        toToolContext(harness.runner.createContext()),
      );
    await shutdownExtension(harness);
    await expect(readStatus()).rejects.toThrow("Pi conversation session is not active");
    const allocation = holdNextArtifactAllocation(harness.sessionDirectory);
    const starting = startExtension(harness, "reload");
    try {
      await allocation.entered;
      await shutdownExtension(harness);
      allocation.release();
      await starting;
      expect.soft(await piDapSessionDirectories(harness.sessionDirectory)).toEqual([]);
      await expect(readStatus()).rejects.toThrow("Pi conversation session is not active");
      expect(errors).toEqual([]);
    } finally {
      allocation.release();
      await starting;
      allocation.restore();
    }
  });

  test("retains obsolete artifact cleanup failure without disposing the newer runtime", async () => {
    const harness = await createExtensionHarness(false, {});
    const errors: ExtensionError[] = [];
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: harness.runner.getUIContext(),
      onError: (error) => errors.push(error),
    });
    const allocation = holdNextArtifactAllocation(harness.sessionDirectory);
    const firstStart = startExtension(harness, "reload");
    const rm = filesystem.rm;
    const cleanupError = new Error("obsolete artifact cleanup failed");
    let remove: MockInstance<typeof filesystem.rm> | undefined;
    try {
      const obsoletePath = await allocation.entered;
      await startExtension(harness, "reload");
      remove = vi
        .spyOn(filesystem, "rm")
        .mockImplementation((...args) =>
          args[0] === obsoletePath ? Promise.reject(cleanupError) : rm(...args),
        );
      syncBuiltinESMExports();
      allocation.release();
      await firstStart;
      expect.soft(errors).toEqual([
        objectContaining({
          event: "session_start",
          error: cleanupError.message,
        }),
      ]);
      const status = harness.session.getToolDefinition("hl_dap_status");
      if (status === undefined) throw new Error("Expected registered status tool");
      const result = await status.execute(
        "newer-status",
        {},
        undefined,
        undefined,
        toToolContext(harness.runner.createContext()),
      );
      expectDapToolOutput("status", result);
      expect(result.structuredContent).toMatchObject({ state: "idle" });
      await shutdownExtension(harness);
      await shutdownExtension(harness);
      expect.soft(errors).toEqual([
        objectContaining({
          event: "session_start",
          error: cleanupError.message,
        }),
        objectContaining({
          event: "session_shutdown",
          error: cleanupError.message,
        }),
        objectContaining({
          event: "session_shutdown",
          error: cleanupError.message,
        }),
      ]);
      expect
        .soft(await piDapSessionDirectories(harness.sessionDirectory))
        .toEqual([obsoletePath.slice(harness.sessionDirectory.length + 1)]);
      await startExtension(harness, "reload");
      await shutdownExtension(harness);
      expect(errors).toHaveLength(3);
    } finally {
      allocation.release();
      await firstStart;
      remove?.mockRestore();
      allocation.restore();
      syncBuiltinESMExports();
    }
  });

  test("pending stale allocation failure cannot replace in-flight owned cleanup", async () => {
    const harness = await createExtensionHarness(false, {});
    const errors: ExtensionError[] = [];
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: harness.runner.getUIContext(),
      onError: (error) => errors.push(error),
    });
    const allocation = holdNextArtifactAllocation(harness.sessionDirectory);
    const firstStart = startExtension(harness, "reload");
    const rm = filesystem.rm;
    const disposalEntered = Promise.withResolvers<void>();
    const disposalGate = Promise.withResolvers<void>();
    const staleError = new Error("stale allocation cleanup failed");
    const ownedError = new Error("current runtime artifact cleanup failed");
    let remove: MockInstance<typeof filesystem.rm> | undefined;
    let shutdownOne: Promise<void> | undefined;
    let shutdownTwo: Promise<void> | undefined;
    try {
      const obsoletePath = await allocation.entered;
      await startExtension(harness, "reload");
      const directories = await piDapSessionDirectories(harness.sessionDirectory);
      const current = directories.find(
        (name) => resolve(harness.sessionDirectory, name) !== obsoletePath,
      );
      if (current === undefined) throw new Error("Expected newer runtime directory");
      const currentPath = resolve(harness.sessionDirectory, current);
      remove = vi.spyOn(filesystem, "rm").mockImplementation(async (...args) => {
        if (args[0] === obsoletePath) throw staleError;
        if (args[0] === currentPath) {
          disposalEntered.resolve();
          await disposalGate.promise;
          throw ownedError;
        }
        return rm(...args);
      });
      syncBuiltinESMExports();
      shutdownOne = shutdownExtension(harness);
      await disposalEntered.promise;
      allocation.release();
      await firstStart;
      expect(errors).toEqual([
        objectContaining({ event: "session_start", error: staleError.message }),
      ]);
      let settledBeforeRelease = false;
      shutdownTwo = shutdownExtension(harness).then(() => {
        settledBeforeRelease = true;
      });
      for (let turn = 0; turn < 32; turn++) await Promise.resolve();
      expect.soft(settledBeforeRelease).toBe(false);
      disposalGate.resolve();
      await shutdownOne;
      await shutdownTwo;
      const { shutdown } = registeredDapLifecycle(harness);
      const event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
      const context = harness.runner.createContext();
      const [result] = await Promise.allSettled([shutdown(event, context)]);
      expect.soft(result).toEqual({
        status: "rejected",
        reason: objectContaining({ errors: [staleError, ownedError] }),
      });
      if (result?.status !== "rejected") throw new Error("Expected retained cleanup failures");
      await expect(shutdown(event, context)).rejects.toBe(result.reason);
      await startExtension(harness, "reload");
      const errorsBeforeRestartedShutdown = [...errors];
      await shutdownExtension(harness);
      expect(errors).toEqual(errorsBeforeRestartedShutdown);
    } finally {
      allocation.release();
      disposalGate.resolve();
      await firstStart;
      await shutdownOne;
      await shutdownTwo;
      remove?.mockRestore();
      allocation.restore();
      syncBuiltinESMExports();
    }
  });

  test("warns about malformed project settings while retaining the valid global layer", async () => {
    const harness = await createExtensionHarness(
      true,
      {
        hlDap: {
          adapters: {
            node: {
              command: process.execPath,
              args: [resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs")],
              transport: "stdio",
            },
          },
          profiles: {
            node: { adapter: "node", arguments: { stopOnEntry: true } },
          },
        },
      },
      "rpc",
      false,
      "{ broken",
    );
    expect(harness.runner.createContext().isProjectTrusted()).toBe(true);
    const errors: ExtensionError[] = [];
    await harness.session.bindExtensions({
      mode: "rpc",
      uiContext: harness.runner.getUIContext(),
      onError: (error) => errors.push(error),
    });
    const launch = harness.session.getToolDefinition("hl_dap_launch");
    if (launch === undefined) throw new Error("Expected registered launch tool");
    const result = await launch.execute(
      "global-profile",
      {},
      undefined,
      undefined,
      toToolContext(harness.runner.createContext()),
    );
    expectDapToolOutput("launch", result);
    expect(result).toMatchObject({ details: { state: "stopped" } });
    expect(errors).toEqual([]);
    expect(harness.notifications).toEqual([
      stringMatching(/^DAP: settings:\n- .*project.*(?:JSON|parse|property)/isu),
    ]);
  });

  test.skipIf(process.platform === "win32").each([
    { operation: "shutdown", closeFails: false },
    { operation: "shutdown", closeFails: true },
    { operation: "start", closeFails: false },
    { operation: "start", closeFails: true },
  ])(
    "delivers fresh $operation teardown failures and restarts after delivery (close fails: $closeFails)",
    async ({ operation, closeFails }) => {
      const harness = await createExtensionHarness(false, {
        hlDap: {
          timeouts: {
            startupMs: 5_000,
            requestMs: 1_000,
            executionMs: 2_000,
            shutdownMs: 250,
          },
          adapters: {
            node: {
              command: process.execPath,
              args: [resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs")],
              transport: "stdio",
            },
          },
          profiles: {
            node: { adapter: "node", arguments: { stopOnEntry: true } },
          },
        },
      });
      await startExtension(harness, "startup");
      const { launch, shutdown, start } = registeredDapLifecycle(harness);
      const spawn = vi.spyOn(childProcess, "spawn");
      syncBuiltinESMExports();
      let child: childProcess.ChildProcess | undefined;
      const restorers: (() => void)[] = [];
      try {
        await launch.execute(
          "launch",
          {},
          undefined,
          undefined,
          toToolContext(harness.runner.createContext()),
        );
        const owned = ownedAdapter(spawn);
        child = owned.child;
        const pid = owned.pid;
        const [directory] = await piDapSessionDirectories(harness.sessionDirectory);
        if (directory === undefined) throw new Error("Expected artifact directory");
        const path = resolve(harness.sessionDirectory, directory);
        const denied = Object.assign(new Error("controller group denied"), {
          code: "EPERM",
        });
        const closeError = Object.assign(new Error("artifact removal failed"), {
          code: "EIO",
        });
        const realKill = process.kill;
        const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
          if (target === -pid) throw denied;
          return realKill(target, signal);
        });
        restorers.push(() => kill.mockRestore());
        const realRm = filesystem.rm;
        const remove = vi
          .spyOn(filesystem, "rm")
          .mockImplementation((...args) =>
            closeFails && args[0] === path ? Promise.reject(closeError) : realRm(...args),
          );
        restorers.push(() => remove.mockRestore());
        syncBuiltinESMExports();
        const event: SessionShutdownEvent = {
          type: "session_shutdown",
          reason: "quit",
        };
        const context = harness.runner.createContext();
        const [result] = await Promise.allSettled([
          operation === "start"
            ? start({ type: "session_start", reason: "reload" }, context)
            : shutdown(event, context),
        ]);
        expect(remove).toHaveBeenCalledWith(path, {
          force: true,
          recursive: true,
        });
        expect(await piDapSessionDirectories(harness.sessionDirectory)).toEqual(
          closeFails ? [directory] : [],
        );
        expect(result).toEqual({
          status: "rejected",
          reason: closeFails
            ? objectContaining({
                errors: [
                  objectContaining({
                    kind: "adapter",
                    cause: objectContaining({
                      errors: [objectContaining({ kind: "shutdown", cause: denied })],
                    }),
                  }),
                  closeError,
                ],
              })
            : objectContaining({ kind: "adapter" }),
        });
        if (result?.status !== "rejected") throw new Error("Expected rejected teardown");
        await expect(shutdown(event, context)).rejects.toBe(result.reason);
        await startExtension(harness, "reload");
        const status = harness.runner.getToolDefinition("hl_dap_status");
        if (status === undefined) throw new Error("Expected registered status tool");
        const restarted = await status.execute(
          "restarted-status",
          {},
          undefined,
          undefined,
          toToolContext(harness.runner.createContext()),
        );
        expect(restarted).toMatchObject({
          details: { operation: "status", state: "idle" },
        });
        expect(restarted.isError).not.toBe(true);
        const relaunched = await launch.execute(
          "restarted-launch",
          {},
          undefined,
          undefined,
          toToolContext(harness.runner.createContext()),
        );
        expect(relaunched).toMatchObject({
          details: { operation: "launch", state: "stopped" },
        });
        await shutdown(event, context);
      } finally {
        for (const restore of restorers) restore();
        spawn.mockRestore();
        syncBuiltinESMExports();
        await stopOwnedAdapter(child);
      }
    },
  );

  test("mounts only in TUI mode and disposes the old Observer widget on reload", async () => {
    const fakeAdapterPath = resolve(import.meta.dirname, "fixtures/fake-dap-session-adapter.mjs");
    const harness = await createExtensionHarness(
      false,
      {
        hlDap: {
          timeouts: { executionMs: 20 },
          adapters: {
            node: {
              command: process.execPath,
              args: [fakeAdapterPath],
              transport: "stdio",
            },
          },
          profiles: {
            node: {
              adapter: "node",
              arguments: { neverStop: true, stopOnEntry: false },
            },
          },
        },
      },
      "tui",
    );
    await startExtension(harness, "startup");
    const tool = harness.runner.getToolDefinition("hl_dap_launch");
    if (tool === undefined) throw new Error("Expected registered DAP launch tool");
    expectDapToolOutput(
      "launch",
      await tool.execute(
        "launch",
        {},
        undefined,
        undefined,
        toToolContext(harness.runner.createContext()),
      ),
    );
    expect(harness.widgetCalls).toContainEqual({
      key: "pi-hl-dap",
      content: anyInstance(Function),
    });

    await startExtension(harness, "reload");
    expect(harness.widgetCalls.at(-1)).toEqual({
      key: "pi-hl-dap",
      content: undefined,
    });
    await shutdownExtension(harness);

    const rpc = await createExtensionHarness(false, {});
    await startExtension(rpc, "startup");
    const rpcTool = rpc.runner.getToolDefinition("hl_dap_launch");
    if (rpcTool === undefined) throw new Error("Expected registered DAP launch tool");
    await expect(
      rpcTool.execute(
        "launch",
        {},
        undefined,
        undefined,
        toToolContext(rpc.runner.createContext()),
      ),
    ).rejects.toThrow(
      "launch requires a valid Launch Profile; no valid Launch Profile is configured",
    );
    expect(rpc.widgetCalls).toEqual([]);
    await shutdownExtension(rpc);
  });
});
