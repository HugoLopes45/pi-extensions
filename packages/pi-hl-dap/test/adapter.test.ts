import childProcess, { execFile } from "node:child_process";
import { once } from "node:events";
import filesystem, { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net, { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import * as fc from "fast-check";
import { isRecord } from "pi-hl-utils/record";
import {
  arrayContaining,
  objectContaining,
  stringContaining,
  stringMatching,
} from "pi-hl-utils/testing/matchers";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DapConnection,
  DapConnectionError,
  type DapConnectionOptions,
  type DapTransport,
} from "../src/adapter.js";

const fixturePath = resolve(import.meta.dirname, "fixtures/fake-dap-adapter.mjs");
const temporaryDirectories: string[] = [];
const clients: DapConnection[] = [];
const descendantPidPaths: string[] = [];
const execFileText = promisify(execFile);

// Successful starts return once the adapter listens; a generous budget keeps them reliable under
// parallel `vp run` load. Startup-timeout tests pass their own short budgets.
async function createClient(overrides: Partial<DapConnectionOptions> = {}): Promise<DapConnection> {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-protocol-"));
  temporaryDirectories.push(directory);
  const client = await DapConnection.start({
    adapterId: "fixture",
    cwd: directory,
    command: process.execPath,
    args: [fixturePath],
    environment: {},
    transport: "stdio",
    timeouts: { startupMs: 5_000, requestMs: 5_000, shutdownMs: 500 },
    stderrPath: resolve(directory, "adapter.stderr.log"),
    ...overrides,
  });
  clients.push(client);
  return client;
}

async function createUncooperativeClient(overrides: Partial<DapConnectionOptions> = {}) {
  const spawn = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  try {
    const client = await createClient({
      environment: {
        FAKE_IGNORE_SHUTDOWN: "1",
        FAKE_IGNORE_SIGTERM: "1",
        FAKE_REVERSE_ON_SIGUSR2: "1",
      },
      timeouts: { startupMs: 5_000, requestMs: 25, shutdownMs: 250 },
      ...overrides,
    });
    const spawned = spawn.mock.results.find(
      (result) => result.type === "return" && result.value.pid === client.adapterPid,
    );
    if (
      spawned?.type !== "return" ||
      spawned.value.stdin === null ||
      spawned.value.stdout === null
    ) {
      throw new Error("Expected an owned fixture process with piped transport");
    }
    return {
      client,
      child: spawned.value,
      reader: spawned.value.stdout,
      writer: spawned.value.stdin,
    };
  } finally {
    spawn.mockRestore();
    syncBuiltinESMExports();
  }
}

async function stopFixtureChild(child: childProcess.ChildProcess): Promise<void> {
  const exit =
    child.exitCode === null && child.signalCode === null
      ? once(child, "exit", { signal: AbortSignal.timeout(5_000) })
      : Promise.resolve();
  child.kill("SIGKILL");
  await exit;
}

/** Run a startup that may fail, then stop every child it spawned, even when cleanup regressed. */
async function withSpawnedChildrenStopped<T>(run: () => Promise<T>): Promise<T> {
  const spawn = vi.spyOn(childProcess, "spawn");
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    const children = spawn.mock.results.flatMap((result) =>
      result.type === "return" ? [result.value] : [],
    );
    spawn.mockRestore();
    syncBuiltinESMExports();
    await Promise.all(children.map(stopFixtureChild));
  }
}

async function createClientWithDescendant(overrides: Partial<DapConnectionOptions> = {}) {
  const client = await createClient(overrides);
  const pidPath = resolve(client.stderrPath, "..", "descendant.pid");
  descendantPidPaths.push(pidPath);
  await client.request("spawn-descendant", { descendant_pid_path: pidPath });
  expect(await descendantState(pidPath)).toBe("running");
  return { client, pidPath };
}

async function expectOwnedDescendantStopped(client: DapConnection, pidPath: string): Promise<void> {
  await expect.poll(() => processExists(client.adapterPid), { timeout: 5_000 }).toBe(false);
  // A zombie has stopped executing but may remain visible until its new parent reaps it.
  await expect.poll(() => descendantState(pidPath), { timeout: 5_000 }).not.toBe("running");
}

async function unusedTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return port;
}

function tcpTransport(port = 0): DapTransport {
  return { type: "tcp", host: "127.0.0.1", port };
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function descendantPid(pidPath: string): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(pidPath, "utf8");
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return undefined;
    throw cause;
  }
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid fixture descendant PID");
  return pid;
}

async function descendantDetails(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileText(
      "ps",
      ["-ww", "-p", String(pid), "-o", "stat=,command="],
      {
        timeout: 5_000,
      },
    );
    return stdout.trim();
  } catch (cause) {
    if (isRecord(cause) && cause.code === 1) return undefined;
    throw cause;
  }
}

async function descendantState(pidPath: string): Promise<"absent" | "zombie" | "running"> {
  const pid = await descendantPid(pidPath);
  if (pid === undefined) return "absent";
  const details = await descendantDetails(pid);
  if (details === undefined) return "absent";
  return details.startsWith("Z") ? "zombie" : "running";
}

async function cleanUpFixtureDescendant(pidPath: string): Promise<void> {
  const pid = await descendantPid(pidPath);
  if (pid === undefined) return;
  const details = await descendantDetails(pid);
  if (details === undefined || details.startsWith("Z")) return;
  if (!details.includes(pidPath)) throw new Error("Refusing to signal a non-fixture process");
  try {
    process.kill(pid, "SIGKILL");
  } catch (cause) {
    if (!(isRecord(cause) && cause.code === "ESRCH")) throw cause;
  }
  await expect.poll(() => descendantState(pidPath), { timeout: 5_000 }).not.toBe("running");
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.dispose()));
  await Promise.all(descendantPidPaths.splice(0).map(cleanUpFixtureDescendant));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DapConnection", () => {
  test("correlates successful and failed responses over stdio", async () => {
    const client = await createClient();

    await expect(client.request("echo", { value: 42 })).resolves.toEqual({
      value: 42,
    });
    await expect(client.request("fail")).rejects.toMatchObject({
      kind: "request",
      message: stringContaining("fixture failure"),
    });
    await expect(client.request("echo", { afterFailure: true })).resolves.toEqual({
      afterFailure: true,
    });
  });

  test("builds failed request text from the adapter error format", async () => {
    const client = await createClient();

    await expect(client.request("fail-error-format")).rejects.toMatchObject({
      kind: "request",
      message:
        "DAP Protocol Client: fail-error-format request failed: ReferenceError: nope is not defined (nope, {missing}) (adapter fixture)",
    });
  });

  test("names the adapter stderr path on failed requests only once stderr has content", async () => {
    const client = await createClient();

    const withoutStderr: unknown = expect.not.stringContaining("stderr");
    await expect(client.request("fail")).rejects.toMatchObject({
      message: withoutStderr,
    });
    await expect(client.request("fail-with-stderr")).rejects.toMatchObject({
      kind: "request",
      message: stringContaining(`stderr ${client.stderrPath}`),
    });
  });

  test("tracks the shared adapter stderr on failures from a target channel", async () => {
    const port = await unusedTcpPort();
    const root = await createClient({
      args: [fixturePath, "--tcp", "$PORT"],
      environment: { FAKE_MULTI_CONNECT: "1" },
      transport: tcpTransport(port),
    });
    const target = await root.connectTargetChannel();

    const withoutStderr: unknown = expect.not.stringContaining("stderr");
    await expect(target.request("fail")).rejects.toMatchObject({
      message: withoutStderr,
    });
    await expect(target.request("fail-with-stderr")).rejects.toMatchObject({
      message: stringContaining(`stderr ${root.stderrPath}`),
    });
    await target.dispose();
  });

  test.each(["refuse", "ignore"])(
    "does not confirm a live child detach when adapters %s disconnect",
    async (behavior) => {
      const root = await createClient({
        args: [fixturePath, "--tcp", "$PORT"],
        environment: {
          FAKE_CHILD_DISCONNECT: behavior,
          FAKE_MULTI_CONNECT: "1",
        },
        transport: tcpTransport(),
      });
      const target = await root.connectTargetChannel();
      await expect(target.detach()).rejects.toMatchObject({
        kind: behavior === "refuse" ? "request" : "timeout",
      });
      await expect(target.request("echo")).rejects.toMatchObject({
        kind: "shutdown",
      });
    },
  );

  test("keeps writing the shared adapter stderr after a target channel detaches", async () => {
    const port = await unusedTcpPort();
    const root = await createClient({
      args: [fixturePath, "--tcp", "$PORT"],
      environment: { FAKE_CHILD_DISCONNECT: "ack", FAKE_MULTI_CONNECT: "1" },
      transport: tcpTransport(port),
      timeouts: { startupMs: 5_000, requestMs: 1_000, shutdownMs: 500 },
    });
    const target = await root.connectTargetChannel();

    await expect(target.detach()).resolves.toBeUndefined();
    // The fixture writes this snapshot to stderr whether or not the detached channel can read the
    // reply, so any later capture proves the shared stderr still writes snapshots.
    void root.request("stderr-fill", { bytes: 32 }).catch(() => undefined);
    await expect
      .poll(() => readFile(root.stderrPath, "utf8"), { timeout: 5_000 })
      .toContain("xxxx");
    await expect(root.dispose()).resolves.toBeUndefined();
  });

  test("parses coalesced event and response frames", async () => {
    const client = await createClient();
    const event = client.waitForEvent("fixture");

    await expect(client.request("coalesced")).resolves.toEqual({
      coalesced: true,
    });
    await expect(event).resolves.toMatchObject({
      event: "fixture",
      body: { coalesced: true },
    });
  });

  test("accepts zero inbound sequence numbers from a non-conforming adapter", async () => {
    const client = await createClient({
      environment: { FAKE_ZERO_SEQUENCE: "1" },
    });
    const event = client.waitForEvent("fixture");

    await expect(client.request("coalesced")).resolves.toEqual({
      coalesced: true,
    });
    await expect(event).resolves.toMatchObject({
      seq: 0,
      event: "fixture",
      body: { coalesced: true },
    });
  });

  test("parses response frames across arbitrary chunk boundaries", async () => {
    const client = await createClient();

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 32 }), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.integer(),
        async (chunks, value) => {
          await expect(client.request("fragment", { chunks, value })).resolves.toEqual({ value });
        },
      ),
      { numRuns: 30 },
    );
  });

  test.each([
    ["malformed-header", "malformed"],
    ["missing-header", "Content-Length"],
    ["malformed-json", "malformed JSON"],
    ["invalid-envelope", "invalid protocol envelope"],
    ["seq-negative", "invalid protocol envelope"],
    ["seq-fraction", "invalid protocol envelope"],
    ["seq-string", "invalid protocol envelope"],
    ["reverse-seq-zero", "invalid protocol envelope"],
    ["request-seq-zero", "invalid protocol envelope"],
    ["oversize", "8 MiB"],
  ])("rejects %s input before it enters session logic", async (mode, message) => {
    const client = await createClient({ environment: { FAKE_MODE: mode } });

    await expect(client.request("echo", {})).rejects.toMatchObject({
      kind: "protocol",
      message: stringContaining(message),
    });
  });

  test("rejects a response for an unknown request sequence", async () => {
    const client = await createClient({
      environment: { FAKE_MODE: "stray-response" },
    });

    await expect(client.request("echo", {})).rejects.toMatchObject({
      kind: "protocol",
      message: stringContaining("unexpected response for request 999"),
    });
  });

  test("times out one request without losing the live client", async () => {
    const client = await createClient({
      timeouts: { startupMs: 5_000, requestMs: 30, shutdownMs: 500 },
    });
    // Stdio startup returns before the fixture loads; exercise request deadlines only once it answers.
    await client.request("echo", { value: "ready" }, { timeoutMs: 5_000 });

    await expect(client.request("hang")).rejects.toMatchObject({
      kind: "timeout",
    });
    await expect(client.request("echo", { recovered: true }, { timeoutMs: 500 })).resolves.toEqual({
      recovered: true,
    });
  });

  test("times out a request whose write the adapter never reads", async () => {
    const client = await createClient();
    await client.request("stop-reading");

    await expect(
      client.request("echo", { value: "x".repeat(4 * 1024 * 1024) }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  test("cancels a request whose write the adapter never reads", async () => {
    const client = await createClient();
    await client.request("stop-reading");
    const controller = new AbortController();
    const request = client.request(
      "echo",
      { value: "x".repeat(4 * 1024 * 1024) },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);

    await expect(request).rejects.toMatchObject({ kind: "cancelled" });
  });

  test("disposes within the shutdown budget when the adapter never reads", async () => {
    const client = await createClient();
    await client.request("stop-reading");
    void client
      .request("echo", { value: "x".repeat(4 * 1024 * 1024) })
      .catch((cause: unknown) => cause);
    const started = Date.now();

    await client.dispose();

    // requestMs is 5000: a dispose that waits on the stalled write exceeds 2 s.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("rejects a request written after the adapter closed its input", async () => {
    const client = await createClient();
    await client.request("close-input");

    await expect(
      client.request("echo", { value: "x".repeat(1024 * 1024) }, { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ kind: "transport" });
  });

  test("cancels one request wait without losing the live client", async () => {
    const client = await createClient();
    const controller = new AbortController();
    const request = client.request("hang", {}, { signal: controller.signal });

    controller.abort();

    await expect(request).rejects.toMatchObject({ kind: "cancelled" });
    await expect(client.request("echo", { recovered: true })).resolves.toEqual({
      recovered: true,
    });
  });

  test("cancels an event wait without losing the live client", async () => {
    const client = await createClient();
    const controller = new AbortController();
    const event = client.waitForEvent("never", { signal: controller.signal });

    controller.abort();

    await expect(event).rejects.toMatchObject({ kind: "cancelled" });
    await expect(client.request("echo", { recovered: true })).resolves.toEqual({
      recovered: true,
    });
  });

  test("handles and rejects reverse requests through the configured callback", async () => {
    const client = await createClient({
      onReverseRequest: (request) =>
        request.command === "runInTerminal"
          ? { success: true, body: { processId: 1234 } }
          : { success: false, message: "child Debug Sessions are unsupported" },
    });

    await expect(client.request("reverse", { command: "runInTerminal" })).resolves.toEqual({
      reverseSuccess: true,
      reverseBody: { processId: 1234 },
    });
    await expect(client.request("reverse", { command: "startDebugging" })).resolves.toEqual({
      reverseSuccess: false,
      reverseMessage: "child Debug Sessions are unsupported",
    });
  });

  test("substitutes every dynamic TCP port token and injects PORT", async () => {
    process.env.DEBUG_FIXTURE_INHERITED = "inherited";
    process.env.DEBUG_FIXTURE_REMOVED = "remove-me";
    try {
      const client = await createClient({
        args: [fixturePath, "--tcp", "$PORT", "port=$PORT/$PORT"],
        environment: { DEBUG_FIXTURE_REMOVED: null },
        transport: tcpTransport(),
      });

      const result = await client.request("inspect");

      expect(client.selectedPort).toBeGreaterThan(0);
      expect(result).toMatchObject({
        argv: arrayContaining([
          `port=${String(client.selectedPort)}/${String(client.selectedPort)}`,
        ]),
        port: String(client.selectedPort),
        inherited: "inherited",
      });
      expect(result).not.toHaveProperty("removed");
    } finally {
      delete process.env.DEBUG_FIXTURE_INHERITED;
      delete process.env.DEBUG_FIXTURE_REMOVED;
    }
  });

  test("rejects an occupied fixed TCP port before connecting", async () => {
    const owner = createServer((socket) => socket.destroy());
    owner.listen(0, "127.0.0.1");
    await once(owner, "listening");
    try {
      const address = owner.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      await expect(
        createClient({
          args: [fixturePath, "--tcp", "$PORT"],
          transport: tcpTransport(address.port),
        }),
      ).rejects.toThrow("allocate a TCP port");
    } finally {
      owner.close();
    }
  });

  test("requires the spawned process itself to own the connected socket", async () => {
    // This launcher delegates serving to a subprocess. It does not own the accepted stream.
    await expect(
      createClient({
        args: [
          "-e",
          "require('node:child_process').fork(process.argv[1], process.argv.slice(2))",
          fixturePath,
          "--tcp",
          "$PORT",
        ],
        transport: tcpTransport(),
      }),
    ).rejects.toThrow("TCP peer ownership");
  });

  test("uses a configured fixed TCP port", async () => {
    const port = await unusedTcpPort();
    const client = await createClient({
      args: [fixturePath, "--tcp", "$PORT"],
      transport: tcpTransport(port),
    });

    const result = await client.request("inspect");

    expect(client.selectedPort).toBe(port);
    expect(result).toMatchObject({ port: String(port) });
  });

  test("retries a TCP connection until the Debug Adapter listens", async () => {
    const client = await createClient({
      args: [fixturePath, "--tcp", "$PORT"],
      environment: { FAKE_LISTEN_DELAY_MS: "80" },
      transport: tcpTransport(),
      timeouts: { startupMs: 5_000, requestMs: 200, shutdownMs: 500 },
    });

    await expect(client.request("echo", { connected: true })).resolves.toEqual({
      connected: true,
    });
  });

  test("rejects TCP startup timeout and terminates the spawned process", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-protocol-timeout-"));
    temporaryDirectories.push(directory);

    await expect(
      DapConnection.start({
        adapterId: "fixture",
        cwd: directory,
        command: process.execPath,
        args: [fixturePath, "--tcp", "$PORT"],
        environment: { FAKE_MODE: "no-listen" },
        transport: tcpTransport(),
        timeouts: { startupMs: 60, requestMs: 30, shutdownMs: 100 },
        stderrPath: resolve(directory, "adapter.stderr.log"),
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  test.skipIf(process.platform === "win32")(
    "reports a TCP startup cleanup whose process group stays present",
    async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-protocol-persist-"));
      temporaryDirectories.push(directory);
      const realKill = process.kill;
      // The probe always finds the group, as with a descendant that survives SIGKILL.
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((target, signal) => (signal === 0 ? true : realKill(target, signal)));
      try {
        const error = await withSpawnedChildrenStopped(() =>
          DapConnection.start({
            adapterId: "fixture",
            cwd: directory,
            command: process.execPath,
            args: [fixturePath, "--tcp", "$PORT"],
            environment: { FAKE_MODE: "no-listen" },
            transport: tcpTransport(),
            timeouts: { startupMs: 60, requestMs: 30, shutdownMs: 100 },
            stderrPath: resolve(directory, "adapter.stderr.log"),
          }),
        ).catch((cause: unknown) => cause);

        expect(error).toMatchObject({ kind: "timeout" });
        const cleanup = error instanceof DapConnectionError ? error.cause : undefined;
        expect(cleanup).toBeInstanceOf(AggregateError);
        if (!(cleanup instanceof AggregateError)) throw new Error("Expected cleanup failures");
        // The startup cause leads, so cleanup failures never hide why the startup failed.
        expect(cleanup.errors).toEqual([
          objectContaining({ code: "ECONNREFUSED" }),
          objectContaining({ message: "Owned process group remains present" }),
        ]);
      } finally {
        kill.mockRestore();
      }
    },
  );

  test("times out a TCP connect attempt that never completes", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-protocol-stall-"));
    temporaryDirectories.push(directory);
    // A socket that never connects nor errors, as with a dropped SYN.
    const connect = vi.spyOn(net, "createConnection").mockImplementation(() => new net.Socket());
    syncBuiltinESMExports();
    try {
      await expect(
        withSpawnedChildrenStopped(() =>
          DapConnection.start({
            adapterId: "fixture",
            cwd: directory,
            command: process.execPath,
            args: [fixturePath, "--tcp", "$PORT"],
            environment: { FAKE_MODE: "no-listen" },
            transport: tcpTransport(),
            timeouts: { startupMs: 60, requestMs: 30, shutdownMs: 100 },
            stderrPath: resolve(directory, "adapter.stderr.log"),
          }),
        ),
      ).rejects.toMatchObject({ kind: "timeout" });
    } finally {
      connect.mockRestore();
      syncBuiltinESMExports();
    }
  });

  test("cancels TCP startup and terminates the spawned process", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-protocol-cancel-"));
    temporaryDirectories.push(directory);
    const controller = new AbortController();
    const startup = DapConnection.start({
      adapterId: "fixture",
      cwd: directory,
      command: process.execPath,
      args: [fixturePath, "--tcp", "$PORT"],
      environment: { FAKE_MODE: "no-listen" },
      transport: tcpTransport(),
      timeouts: { startupMs: 1000, requestMs: 30, shutdownMs: 100 },
      stderrPath: resolve(directory, "adapter.stderr.log"),
      startupSignal: controller.signal,
    });

    setTimeout(() => controller.abort(), 30);

    await expect(startup).rejects.toMatchObject({ kind: "cancelled" });
  });

  test.skipIf(process.platform === "win32")(
    "keeps the TCP startup failure when cleanup signals and the stderr snapshot fail",
    async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-protocol-cleanup-"));
      temporaryDirectories.push(directory);
      const stderrPath = resolve(directory, "adapter.stderr.log");
      const realKill = process.kill;
      const permissionError = Object.assign(new Error("fixture signal denied"), {
        code: "EPERM",
      });
      const writeError = Object.assign(new Error("fixture stderr write failed"), { code: "EIO" });
      let denied = false;
      let group: number | undefined;
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        group = target;
        if (!denied && signal !== 0) {
          denied = true;
          throw permissionError;
        }
        return realKill(target, signal);
      });
      const realWriteFile = filesystem.writeFile;
      // Startup fails only once the stderr snapshot write has failed, however slow the host is.
      const startupController = new AbortController();
      const write = vi.spyOn(filesystem, "writeFile").mockImplementation((...args) => {
        if (typeof args[1] === "string") return realWriteFile(...args);
        startupController.abort();
        return Promise.reject(writeError);
      });
      syncBuiltinESMExports();
      try {
        let alive: boolean | undefined;
        const error = await withSpawnedChildrenStopped(async () => {
          const startup = await DapConnection.start({
            adapterId: "fixture",
            cwd: directory,
            command: process.execPath,
            args: ["-e", "process.stderr.write('startup detail\\n'); setInterval(() => {}, 1000)"],
            environment: {},
            transport: tcpTransport(),
            timeouts: { startupMs: 10_000, requestMs: 30, shutdownMs: 100 },
            stderrPath,
            startupSignal: startupController.signal,
          }).catch((cause: unknown) => cause);
          // Probe before the helper stops leftovers: the denied SIGTERM must not stop cleanup.
          if (group === undefined) throw new Error("Expected a signalled process group");
          try {
            realKill(group, 0);
            alive = true;
          } catch (cause) {
            alive = !(isRecord(cause) && cause.code === "ESRCH");
          }
          return startup;
        });

        expect(error).toBeInstanceOf(DapConnectionError);
        expect(error).toMatchObject({
          kind: "cancelled",
          message: stringContaining("Debug Adapter startup was cancelled"),
        });
        const cleanup = error instanceof DapConnectionError ? error.cause : undefined;
        expect(cleanup).toBeInstanceOf(AggregateError);
        if (!(cleanup instanceof AggregateError))
          throw new Error("Expected aggregated startup cleanup failures");
        expect(cleanup.errors).toEqual([
          expect.objectContaining({ code: "EPERM" }),
          expect.objectContaining({ code: "EIO" }),
        ]);
        expect(denied).toBe(true);
        expect(alive).toBe(false);
      } finally {
        write.mockRestore();
        syncBuiltinESMExports();
        kill.mockRestore();
      }
    },
  );

  test("rejects $PORT in stdio arguments before spawning", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-protocol-port-"));
    temporaryDirectories.push(directory);

    await expect(
      DapConnection.start({
        adapterId: "fixture",
        cwd: directory,
        command: process.execPath,
        args: [fixturePath, "$PORT"],
        environment: {},
        transport: "stdio",
        timeouts: { startupMs: 100, requestMs: 100, shutdownMs: 100 },
        stderrPath: resolve(directory, "adapter.stderr.log"),
      }),
    ).rejects.toMatchObject({ kind: "transport" });
  });

  test("reports spawn failures with the adapter stderr path", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-protocol-spawn-"));
    temporaryDirectories.push(directory);
    const stderrPath = resolve(directory, "adapter.stderr.log");

    await expect(
      DapConnection.start({
        adapterId: "missing",
        cwd: directory,
        command: resolve(directory, "missing-adapter"),
        args: [],
        environment: {},
        transport: "stdio",
        timeouts: { startupMs: 100, requestMs: 100, shutdownMs: 100 },
        stderrPath,
      }),
    ).rejects.toMatchObject({
      kind: "spawn",
      stderrPath,
      message: stringContaining(stderrPath),
    });
  });

  test("reports unexpected process exit and captures stderr", async () => {
    const client = await createClient();

    const error = await client.request("crash").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DapConnectionError);
    expect(error).toMatchObject({
      kind: stringMatching(/exit|transport/),
    });
    await expect
      .poll(() => readFile(client.stderrPath, "utf8"), { timeout: 10_000 })
      .toContain("fixture adapter crashed");
  });

  test("rejects event waiters immediately after a fatal adapter failure", async () => {
    const client = await createClient();
    const event = client.waitForEvent("never", { timeoutMs: 5_000 });

    await expect(client.request("crash")).rejects.toMatchObject({
      kind: stringMatching(/exit|transport/),
    });
    await expect(event).rejects.toMatchObject({
      kind: stringMatching(/exit|transport/),
    });
  });

  test("retains only the latest 1 MiB of Debug Adapter stderr", async () => {
    const client = await createClient();

    await client.request("stderr-crash", { bytes: 1024 * 1024 + 128 }).catch(() => undefined);
    // The tail is written asynchronously; wait for the adapter's last bytes rather than a fixed delay.
    await expect
      .poll(
        async () => (await readFile(client.stderrPath)).toString("utf8").endsWith("LATEST-STDERR"),
        {
          timeout: 10_000,
        },
      )
      .toBe(true);
    const stderr = await readFile(client.stderrPath);

    expect(stderr.length).toBe(1024 * 1024);
  });

  test("awaits graceful DAP shutdown and process exit", async () => {
    const client = await createClient();
    const pid = client.adapterPid;

    await client.dispose();
    await expect.poll(() => processExists(pid), { timeout: 10_000 }).toBe(false);
  });

  test("sends no terminate request when no terminate capability was advertised", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-request-log-"));
    temporaryDirectories.push(directory);
    const requestLogPath = resolve(directory, "requests.jsonl");
    const client = await createClient({
      environment: { FAKE_REQUEST_LOG: requestLogPath },
    });
    // A loaded host can start the adapter slower than shutdownMs; shutdown must reach a reading adapter.
    await client.request("echo");
    const pid = client.adapterPid;

    await client.dispose();

    const requests = await readFile(requestLogPath, "utf8");
    expect(requests).not.toContain('"command":"terminate"');
    expect(requests).toContain('"command":"disconnect","arguments":{"terminateDebuggee":true}');
    await expect.poll(() => processExists(pid), { timeout: 10_000 }).toBe(false);
  });

  test("keeps the shutdown request sequence frozen at the first call", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-request-log-"));
    temporaryDirectories.push(directory);
    const requestLogPath = resolve(directory, "requests.jsonl");
    const client = await createClient({
      environment: { FAKE_REQUEST_LOG: requestLogPath },
    });
    // A loaded host can start the adapter slower than shutdownMs; shutdown must reach a reading adapter.
    await client.request("echo");

    const shutdown = client.dispose();
    client.setSupportsTerminateRequest(true);
    await shutdown;

    const requests = await readFile(requestLogPath, "utf8");
    expect(requests).not.toContain('"command":"terminate"');
    expect(requests).toContain('"command":"disconnect","arguments":{"terminateDebuggee":true}');
  });

  test("writes the last adapter stderr snapshot during a shutdown inside the budget", async () => {
    const client = await createClient();

    await expect(client.request("fail-with-stderr")).rejects.toMatchObject({
      kind: "request",
    });
    await expect(client.dispose()).resolves.toBeUndefined();

    expect(await readFile(client.stderrPath, "utf8")).toBe("fixture stderr detail\n");
  });

  test.skipIf(process.platform === "win32").each(["dispose", "detach"] as const)(
    "%s finishes within shutdownMs when an adapter stderr snapshot write stalls",
    async (operation) => {
      const client = await createClient({
        environment: { FAKE_IGNORE_SHUTDOWN: "1" },
        timeouts: { startupMs: 5_000, requestMs: 5_000, shutdownMs: 250 },
      });
      const stderrPath = client.stderrPath;
      // A FIFO whose reader never reads stalls the next snapshot at the filesystem boundary.
      await rm(stderrPath, { force: true });
      await execFileText("mkfifo", [stderrPath]);
      const burst = client.request("stderr-fill", { bytes: 1024 * 1024 });
      const stalledSnapshot = await open(stderrPath, "r");
      await burst;

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const startedAt = performance.now();
        const [result] = await Promise.allSettled([client[operation]()]);
        const elapsed = performance.now() - startedAt;

        // The unbounded wait this replaces never settled at all.
        expect(elapsed).toBeLessThan(2_000);
        expect(result).toEqual({
          status: "rejected",
          reason: objectContaining({
            kind: "shutdown",
            message: stringContaining("stderr snapshot did not finish within shutdownMs"),
          }),
        });
        await expect(client.request("echo")).rejects.toMatchObject({
          kind: "shutdown",
        });
        await expect.poll(() => processExists(client.adapterPid), { timeout: 5_000 }).toBe(false);

        // The abandoned write settles only after the artifact is gone, and recreates nothing.
        await rm(stderrPath, { force: true });
        expect((await stalledSnapshot.readFile()).length).toBeGreaterThan(0);
        await new Promise((resolveTurn) => setImmediate(resolveTurn));
        await expect(stat(stderrPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(unhandled).toEqual([]);
      } finally {
        // A failed assertion must not leave the stalled write holding a worker thread open.
        await stalledSnapshot.close().catch(() => undefined);
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "stops an owned descendant after its adapter exits gracefully",
    async () => {
      const { client, pidPath } = await createClientWithDescendant();
      await expect(client.dispose()).resolves.toBeUndefined();
      await expectOwnedDescendantStopped(client, pidPath);
    },
  );

  test.skipIf(process.platform === "win32")(
    "stops an owned descendant after its adapter crashes",
    async () => {
      const { client, pidPath } = await createClientWithDescendant();
      await expect(client.request("crash")).rejects.toMatchObject({
        kind: stringMatching(/exit|transport/),
      });
      await expect(client.dispose()).resolves.toBeUndefined();
      await expectOwnedDescendantStopped(client, pidPath);
    },
  );

  test.skipIf(process.platform === "win32")(
    "stops an owned descendant after its adapter exits on SIGTERM",
    async () => {
      const { client, pidPath } = await createClientWithDescendant({
        environment: { FAKE_IGNORE_SHUTDOWN: "1" },
      });
      await expect(client.dispose()).resolves.toBeUndefined();
      await expectOwnedDescendantStopped(client, pidPath);
    },
  );

  test.skipIf(process.platform === "win32")(
    "reaps an exited adapter during fatal process-group cleanup",
    async () => {
      const onFailure = vi.fn<NonNullable<DapConnectionOptions["onFailure"]>>();
      const client = await createClient({ onFailure });
      await expect(client.request("crash")).rejects.toMatchObject({
        kind: stringMatching(/exit|transport/),
      });
      await expect(client.dispose()).resolves.toBeUndefined();
      expect(onFailure).toHaveBeenCalledOnce();
      await expect.poll(() => processExists(client.adapterPid), { timeout: 5_000 }).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "retains fatal cleanup failures and rejects reentrant shutdown without retrying signals",
    async () => {
      const reentrantResults: PromiseSettledResult<void>[] = [];
      const onFailure = vi.fn<NonNullable<DapConnectionOptions["onFailure"]>>(() => {
        void Promise.allSettled([client.dispose()]).then((results) => {
          reentrantResults.push(...results);
        });
      });
      const { client, pidPath } = await createClientWithDescendant({
        onFailure,
      });
      const groupPid = client.adapterPid;
      if (groupPid === undefined) throw new Error("Expected owned adapter PID");
      const realKill = process.kill;
      const permissionError = Object.assign(new Error("fixture process group denied"), {
        code: "EPERM",
      });
      const expectedCleanupFailure = objectContaining({
        kind: "shutdown",
        cause: permissionError,
      });
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -groupPid) throw permissionError;
        return realKill(pid, signal);
      });
      try {
        await expect(client.request("crash")).rejects.toMatchObject({
          kind: stringMatching(/exit|transport/),
        });
        await expect(client.dispose()).rejects.toEqual(expectedCleanupFailure);
        await expect(client.dispose()).rejects.toEqual(expectedCleanupFailure);
        expect(onFailure).toHaveBeenCalledOnce();
        const originalFailure = onFailure.mock.calls[0]?.[0];
        if (originalFailure === undefined) throw new Error("Expected original adapter failure");
        await expect(client.request("echo")).rejects.toMatchObject({
          kind: "shutdown",
          cause: objectContaining({
            errors: [originalFailure, expectedCleanupFailure],
          }),
        });
        await expect
          .poll(() => reentrantResults)
          .toEqual([{ status: "rejected", reason: expectedCleanupFailure }]);
        const reentrantResult = reentrantResults[0];
        if (reentrantResult?.status !== "rejected")
          throw new Error("Expected rejected reentrant shutdown");
        await expect(client.dispose()).rejects.toBe(reentrantResult.reason);
        expect(
          kill.mock.calls.filter(([pid, signal]) => pid === -groupPid && signal === "SIGTERM"),
        ).toHaveLength(1);
        expect(await descendantState(pidPath)).toBe("running");
      } finally {
        kill.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32").each(["live", "inaccessible"] as const)(
    "rejects fatal cleanup when the owned group remains %s after SIGKILL",
    async (state) => {
      const { client } = await createClientWithDescendant();
      const groupPid = client.adapterPid;
      if (groupPid === undefined) throw new Error("Expected owned adapter PID");
      const realKill = process.kill;
      const permissionError = Object.assign(new Error("fixture group inaccessible"), {
        code: "EPERM",
      });
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -groupPid) {
          if (signal === 0 && state === "inaccessible") throw permissionError;
          return true;
        }
        return realKill(pid, signal);
      });
      try {
        await expect(client.request("crash")).rejects.toMatchObject({
          kind: stringMatching(/exit|transport/),
        });
        await expect(client.dispose()).rejects.toMatchObject({
          kind: "shutdown",
          cause:
            state === "inaccessible"
              ? permissionError
              : objectContaining({ message: stringContaining("group") }),
        });
        expect(kill.mock.calls).toContainEqual([-groupPid, "SIGKILL"]);
      } finally {
        kill.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32").each(["refused", "present"] as const)(
    "keeps a refused SIGTERM and the SIGKILL outcome when the group stays %s",
    async (outcome) => {
      const { client } = await createClientWithDescendant();
      const groupPid = client.adapterPid;
      if (groupPid === undefined) throw new Error("Expected owned adapter PID");
      const realKill = process.kill;
      const termError = Object.assign(new Error("fixture SIGTERM denied"), {
        code: "EPERM",
      });
      const killError = Object.assign(new Error("fixture SIGKILL denied"), {
        code: "EPERM",
      });
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid !== -groupPid) return realKill(pid, signal);
        if (signal === "SIGTERM") throw termError;
        if (signal === "SIGKILL" && outcome === "refused") throw killError;
        return true;
      });
      try {
        await expect(client.request("crash")).rejects.toMatchObject({
          kind: stringMatching(/exit|transport/),
        });
        const disposed = await client.dispose().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(disposed).toMatchObject({ kind: "shutdown" });
        const cause = isRecord(disposed) ? disposed.cause : undefined;
        expect(cause).toBeInstanceOf(AggregateError);
        if (!(cause instanceof AggregateError)) throw new Error("Expected both cleanup failures");
        expect(cause.errors).toEqual([
          termError,
          outcome === "refused"
            ? killError
            : objectContaining({
                message: "Owned process group remains present",
              }),
        ]);
      } finally {
        kill.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "reports one cleanup cause when the group probe rethrows the refused SIGTERM error",
    async () => {
      const { client } = await createClientWithDescendant();
      const groupPid = client.adapterPid;
      if (groupPid === undefined) throw new Error("Expected owned adapter PID");
      const realKill = process.kill;
      const termError = Object.assign(new Error("fixture group denied"), {
        code: "EPERM",
      });
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid !== -groupPid) return realKill(pid, signal);
        if (signal === "SIGKILL") return true;
        throw termError;
      });
      try {
        await expect(client.request("crash")).rejects.toMatchObject({
          kind: stringMatching(/exit|transport/),
        });
        await expect(client.dispose()).rejects.toMatchObject({
          kind: "shutdown",
          cause: termError,
        });
      } finally {
        kill.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32").each(["dispose", "detach"] as const)(
    "%s finalizes transport and stderr after process-group cleanup rejects",
    async (operation) => {
      const onReverseRequest = vi.fn<NonNullable<DapConnectionOptions["onReverseRequest"]>>(
        async () => ({
          success: true,
        }),
      );
      const { client, child, reader, writer } = await createUncooperativeClient({
        onReverseRequest,
      });
      const pid = client.adapterPid;
      if (pid === undefined) throw new Error("Expected owned adapter PID");
      const permissionError = Object.assign(new Error("fixture group denied"), {
        code: "EPERM",
      });
      const realKill = process.kill;
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid && signal !== 0) throw permissionError;
        return realKill(target, signal);
      });
      const writeGate = Promise.withResolvers<void>();
      const realWriteFile = filesystem.writeFile;
      let pendingWrite: Promise<void> | undefined;
      const write = vi.spyOn(filesystem, "writeFile").mockImplementation((...args) => {
        if (args[0] !== client.stderrPath) return realWriteFile(...args);
        pendingWrite = writeGate.promise.then(() => realWriteFile(...args));
        return pendingWrite;
      });
      syncBuiltinESMExports();
      const readerFinalized = Promise.withResolvers<void>();
      reader.on("removeListener", (name) => {
        if (name === "data") readerFinalized.resolve();
      });
      try {
        await expect(
          client.request("fail-with-stderr", {}, { timeoutMs: 5_000 }),
        ).rejects.toMatchObject({
          kind: "request",
        });
        let settled = false;
        const completion = Promise.allSettled([client[operation]()]).then((results) => {
          settled = true;
          return results;
        });
        await Promise.race([readerFinalized.promise, completion]);
        const lateFrame = once(reader, "data", {
          signal: AbortSignal.timeout(5_000),
        });
        process.kill(pid, "SIGUSR2");
        const frame: unknown = (await lateFrame)[0];
        expect(String(frame)).toContain('"command":"runInTerminal"');
        expect(onReverseRequest).not.toHaveBeenCalled();
        expect(reader.listenerCount("data")).toBe(0);
        expect(writer.destroyed).toBe(true);
        expect(settled).toBe(false);
        writeGate.resolve();
        const [result] = await completion;
        expect(result).toEqual({
          status: "rejected",
          reason: objectContaining({
            kind: "shutdown",
            cause: permissionError,
          }),
        });
        if (result?.status !== "rejected")
          throw new Error("Expected rejected process-group cleanup");
        await expect(client[operation === "dispose" ? "detach" : "dispose"]()).rejects.toBe(
          result.reason,
        );
        const afterRejection = once(reader, "data", {
          signal: AbortSignal.timeout(5_000),
        });
        process.kill(pid, "SIGUSR2");
        const rejectedFrame: unknown = (await afterRejection)[0];
        expect(String(rejectedFrame)).toContain('"command":"runInTerminal"');
        expect(onReverseRequest).not.toHaveBeenCalled();
        expect(reader.listenerCount("data")).toBe(0);
        expect(await readFile(client.stderrPath, "utf8")).toBe("fixture stderr detail\n");
      } finally {
        writeGate.resolve();
        await Promise.allSettled([pendingWrite]);
        write.mockRestore();
        syncBuiltinESMExports();
        kill.mockRestore();
        await stopFixtureChild(child);
      }
    },
  );

  test.skipIf(process.platform === "win32").each([false, true])(
    "preserves stderr finalization failure (process-group cleanup also fails: %s)",
    async (cleanupFails) => {
      const { client, child, reader } = await createUncooperativeClient();
      const pid = client.adapterPid;
      if (pid === undefined) throw new Error("Expected owned adapter PID");
      const permissionError = Object.assign(new Error("fixture group denied"), {
        code: "EPERM",
      });
      const missingGroup = Object.assign(new Error("fixture group absent"), {
        code: "ESRCH",
      });
      const writeError = Object.assign(new Error("fixture stderr write failed"), { code: "EIO" });
      const realKill = process.kill;
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid) {
          if (!cleanupFails) throw missingGroup;
          if (signal !== 0) throw permissionError;
        }
        return realKill(target, signal);
      });
      const pendingWrite = Promise.withResolvers<void>();
      const realWriteFile = filesystem.writeFile;
      const write = vi.spyOn(filesystem, "writeFile").mockImplementation((...args) => {
        return args[0] === client.stderrPath ? pendingWrite.promise : realWriteFile(...args);
      });
      syncBuiltinESMExports();
      const readerFinalized = Promise.withResolvers<void>();
      reader.on("removeListener", (name) => {
        if (name === "data") readerFinalized.resolve();
      });
      try {
        await expect(
          client.request("fail-with-stderr", {}, { timeoutMs: 5_000 }),
        ).rejects.toMatchObject({ kind: "request" });
        const completion = Promise.allSettled([client.dispose()]);
        await readerFinalized.promise;
        pendingWrite.reject(writeError);
        const [result] = await completion;
        expect(result).toEqual({
          status: "rejected",
          reason: cleanupFails
            ? objectContaining({
                errors: [
                  objectContaining({
                    kind: "shutdown",
                    cause: permissionError,
                  }),
                  writeError,
                ],
              })
            : writeError,
        });
        if (result?.status !== "rejected") throw new Error("Expected rejected stderr finalization");
        expect(result.reason).toBeInstanceOf(cleanupFails ? AggregateError : Error);
        await expect(client.detach()).rejects.toBe(result.reason);
      } finally {
        pendingWrite.resolve();
        await Promise.allSettled([pendingWrite.promise]);
        write.mockRestore();
        syncBuiltinESMExports();
        kill.mockRestore();
        await stopFixtureChild(child);
      }
    },
  );

  test("forces an uncooperative Debug Adapter process down within shutdownMs", async () => {
    const client = await createClient({
      environment: { FAKE_IGNORE_SHUTDOWN: "1", FAKE_IGNORE_SIGTERM: "1" },
      timeouts: { startupMs: 5_000, requestMs: 25, shutdownMs: 250 },
    });
    const pid = client.adapterPid;
    if (pid === undefined) throw new Error("Expected owned adapter PID");
    // A response means the fixture has installed its SIGTERM handler; a signal sent before that
    // would end it by default and hide a missing SIGKILL.
    await client.request("echo", { value: "ready" }, { timeoutMs: 10_000 });
    // Virtual timers do not drive the real child's exit/reaping after SIGKILL.
    const realSetTimeout = globalThis.setTimeout;
    const kill = vi.spyOn(process, "kill");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const startedAt = Date.now();
      let settled = false;
      const shutdown = Promise.allSettled([client.dispose()]).then(([result]) => {
        settled = true;
        return result;
      });
      while (true) {
        if (settled) break;
        if (
          kill.mock.calls.some(
            ([target, signal]) => signal === "SIGKILL" && (target === pid || target === -pid),
          )
        ) {
          const reapDeadline = performance.now() + 10_000;
          while (processExists(pid)) {
            if (performance.now() >= reapDeadline)
              throw new Error("Fixture was not reaped after SIGKILL");
            await new Promise((resolveDelay) => realSetTimeout(resolveDelay, 1));
          }
        }
        // Move the clock only while shutdown waits on a timer; otherwise let real I/O finish.
        if (vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(1);
        else await new Promise((resolveDelay) => realSetTimeout(resolveDelay, 1));
      }
      expect(await shutdown).toEqual({ status: "fulfilled", value: undefined });
      expect(Date.now() - startedAt).toBeLessThanOrEqual(250);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }

    // The fixture ignores DAP shutdown, SIGTERM, and stdin closing, so only SIGKILL ends it.
    await expect.poll(() => processExists(pid), { timeout: 10_000 }).toBe(false);
  });
});
