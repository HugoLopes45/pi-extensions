import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { basename } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import * as rpc from "vscode-jsonrpc/node";

import type { ServerConfig } from "./settings.js";

const provider = Type.Optional(Type.Union([Type.Boolean(), Type.Object({})]));
const initializedSchema = Type.Object({
  capabilities: Type.Object({
    positionEncoding: Type.Optional(Type.String()),
    textDocumentSync: Type.Optional(
      Type.Union([
        Type.Integer({ minimum: 0, maximum: 2 }),
        Type.Object({
          openClose: Type.Optional(Type.Boolean()),
          change: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
        }),
      ]),
    ),
    hoverProvider: provider,
    definitionProvider: provider,
    typeDefinitionProvider: provider,
    implementationProvider: provider,
    referencesProvider: provider,
    documentFormattingProvider: provider,
    documentSymbolProvider: provider,
    diagnosticProvider: provider,
    workspaceSymbolProvider: provider,
    renameProvider: Type.Optional(
      Type.Union([Type.Boolean(), Type.Object({ prepareProvider: Type.Optional(Type.Boolean()) })]),
    ),
    callHierarchyProvider: provider,
    workspace: Type.Optional(
      Type.Object({
        fileOperations: Type.Optional(Type.Object({ willRename: provider, didRename: provider })),
      }),
    ),
    codeActionProvider: Type.Optional(
      Type.Union([Type.Boolean(), Type.Object({ resolveProvider: Type.Optional(Type.Boolean()) })]),
    ),
  }),
});
// The kinds this client sends to servers; each is a standard LSP code action kind.
const codeActionKinds = [
  "quickfix",
  "refactor",
  "refactor.extract",
  "refactor.inline",
  "refactor.rewrite",
  "source",
  "source.organizeImports",
  "source.fixAll",
];
export type Initialization = Static<typeof initializedSchema>;
const registration = Type.Object({ id: Type.String(), method: Type.String() });
const registrationParams = Type.Object({
  registrations: Type.Array(registration),
});
const unregistrationParams = Type.Object({
  unregisterations: Type.Array(registration),
});
const progressToken = Type.Union([Type.String(), Type.Integer()]);
const progressCreateParams = Type.Object({ token: progressToken });
const configurationParams = Type.Object({
  items: Type.Array(Type.Object({ section: Type.Optional(Type.String()) })),
});
const progressParams = Type.Object({
  token: progressToken,
  value: Type.Object({
    kind: Type.Union([Type.Literal("begin"), Type.Literal("report"), Type.Literal("end")]),
  }),
});
const serverStatusParams = Type.Object({ quiescent: Type.Boolean() });
// LSP 3.17 replies to server requests that need no client state, keyed by method.
const fixedRequestReplies = new Map<string, unknown>([
  ["window/showMessageRequest", null],
  ["window/showDocument", { success: false }],
  [
    "workspace/applyEdit",
    {
      applied: false,
      failureReason: "client applies edits only through its tools",
    },
  ],
  ["workspace/semanticTokens/refresh", null],
  ["workspace/inlayHint/refresh", null],
  ["workspace/inlineValue/refresh", null],
  ["workspace/codeLens/refresh", null],
]);
// Servers pause briefly between loading phases, so a server counts as ready only after this quiet window.
const READY_QUIET_MS = 300;
// Servers start loading after the first document opens, so a query in this window waits for the first signal.
const READY_GRACE_MS = 1000;
// The last 100 ms of the two-second disposal budget, kept after SIGKILL: macOS answers EPERM for a
// group whose only member is an unreaped zombie, so the group is probed again before failing.
const REAP_RESERVE_MS = 100;
// LSP ContentModified: the answer was computed for an older state; the spec lets the client send the request again.
const CONTENT_MODIFIED = -32801;
const RETRY_PAUSE_MS = 100;
// Real servers index the project before answering initialize; requests keep the shorter budget.
export const STARTUP_TIMEOUT_MS = 60_000;

const MAX_HEADER_BYTES = 4096;

class FrameSizes {
  readonly sizes: number[] = [];
  private header: Buffer = Buffer.alloc(0);
  private body: number | undefined;
  private size = 0;

  scan(chunk: Buffer): void {
    let rest = chunk;
    while (rest.length > 0 || this.body === 0)
      rest = this.body === undefined ? this.readHeader(rest) : this.readBody(rest, this.body);
  }

  private readHeader(chunk: Buffer): Buffer {
    const data = this.header.length === 0 ? chunk : Buffer.concat([this.header, chunk]);
    const end = data.indexOf("\r\n\r\n");
    if (end < 0) {
      // Real headers hold one or two short fields; a growing header would be rescanned on every chunk.
      if (data.length > MAX_HEADER_BYTES) throw new Error("LSP frame header exceeds 4 KiB");
      this.header = data;
      return Buffer.alloc(0);
    }
    // The reader misses a terminator right after a CR, so both would split differently.
    if (data[end - 1] === 0x0d) throw new Error("LSP frame header ends with a bare CR");
    // Split like the vscode-jsonrpc reader so both agree on every frame's length.
    const [length, ...others] = data
      .subarray(0, end)
      .toString("ascii")
      .split("\r\n")
      .map((line) => line.split(":"))
      .filter(([key]) => key?.toLowerCase() === "content-length")
      .map(([, ...value]) => value.join(":").trim());
    if (length === undefined || others.length > 0 || !/^\d+$/u.test(length))
      throw new Error("LSP frame needs exactly one numeric Content-Length");
    const rest = data.subarray(end + 4);
    this.size = end + 4;
    this.body = Number(length);
    this.header = Buffer.alloc(0);
    return rest;
  }

  private readBody(chunk: Buffer, body: number): Buffer {
    const taken = Math.min(body, chunk.length);
    this.size += taken;
    this.body = body - taken;
    if (this.body === 0) {
      this.sizes.push(this.size);
      this.body = undefined;
    }
    return chunk.subarray(taken);
  }
}

type Settings = NonNullable<ServerConfig["settings"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Walks a dotted section path; a missing key anywhere in the path yields undefined.
function sectionValue(settings: Settings, section: string): unknown {
  let value: unknown = settings;
  for (const key of section.split(".")) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

// Unset settings and a missing section answer null, so servers keep their defaults; no section asks for the whole object.
function configurationReplies(
  params: Static<typeof configurationParams>,
  settings: Settings | undefined,
): unknown[] {
  return params.items.map(({ section }) => {
    if (settings === undefined) return null;
    if (section === undefined) return settings;
    return sectionValue(settings, section) ?? null;
  });
}

export class LanguageServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: rpc.MessageConnection;
  private readonly input: Transform;
  private closing: Promise<void> | undefined;
  private failure: Error | undefined;
  private stopped = false;
  private initialized = false;
  private diagnosticProvider = false;
  private readonly registered = new Set<string>();
  private readonly progressTokens = new Set<string | number>();
  private activity = Promise.withResolvers<void>();
  private readonly pullListeners = new Set<() => void>();
  private readonly refreshListeners = new Set<() => void>();
  private quiescent = true;
  private lastProgressAt = Number.NEGATIVE_INFINITY;
  private signaled = false;
  private graceUntil = Number.NEGATIVE_INFINITY;
  private changed = Promise.withResolvers<void>();
  private stderr = "";

  constructor(
    private readonly config: ServerConfig,
    private readonly root: string,
    private readonly timeoutMs: number,
    publish: (value: unknown) => void,
    private readonly onClose: (error: Error) => void = () => {},
  ) {
    this.child = spawn(config.command, config.args, {
      cwd: root,
      stdio: "pipe",
      detached: process.platform !== "win32",
      env: {
        HOME: homedir(),
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      },
    });
    // Bytes stay held until the connection dequeues their message, because the
    // reader and the connection both queue messages before handling them.
    const frames = new FrameSizes();
    let held = 0;
    this.input = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
        held += chunk.length;
        if (held > 8 * 1024 * 1024) return done(new Error("LSP wire budget exceeded"));
        try {
          frames.scan(chunk);
        } catch (error) {
          return done(error instanceof Error ? error : new Error("Invalid LSP frame"));
        }
        done(null, chunk);
      },
    });
    this.child.stdout.pipe(this.input);
    const reader = new rpc.StreamMessageReader(this.input);
    // Operation deadlines replace recursive partial-frame notifications.
    reader.partialMessageTimeout = 0;
    this.connection = rpc.createMessageConnection(
      reader,
      new rpc.StreamMessageWriter(this.child.stdin),
      undefined,
      {
        messageStrategy: {
          handleMessage: (message, next) => {
            held -= frames.sizes.shift() ?? 0;
            return next(message);
          },
        },
      },
    );
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
    });
    this.input.on("error", (error: Error) => this.fail(error));
    this.connection.onClose(() => this.fail(new Error("LSP connection closed")));
    this.connection.onError(([error]) => this.fail(error));
    this.child.once("error", (error: Error) => this.fail(error));
    this.child.once("exit", (code) => {
      if (!this.stopped) this.fail(new Error(`LSP process exited (${code}): ${this.stderr}`));
    });
    this.connection.onRequest("client/registerCapability", (value: unknown) => {
      if (!Value.Check(registrationParams, value))
        return this.reject("Invalid client/registerCapability payload");
      for (const { method } of value.registrations) this.registered.add(method);
      if (value.registrations.some(({ method }) => method === "textDocument/diagnostic"))
        for (const listener of this.pullListeners) listener();
      return null;
    });
    this.connection.onRequest("client/unregisterCapability", (value: unknown) => {
      if (!Value.Check(unregistrationParams, value))
        return this.reject("Invalid client/unregisterCapability payload");
      for (const { method } of value.unregisterations) this.registered.delete(method);
      return null;
    });
    this.connection.onRequest("window/workDoneProgress/create", (value: unknown) => {
      if (!Value.Check(progressCreateParams, value))
        return this.reject("Invalid window/workDoneProgress/create payload");
      return null;
    });
    for (const [method, reply] of fixedRequestReplies)
      this.connection.onRequest(method, () => reply);
    this.connection.onRequest("workspace/configuration", (value: unknown) => {
      if (!Value.Check(configurationParams, value))
        return this.reject("Invalid workspace/configuration payload");
      return configurationReplies(value, this.config.settings);
    });
    this.connection.onRequest("workspace/workspaceFolders", () => [this.workspaceFolder()]);
    this.connection.onNotification("$/progress", (value: unknown) => {
      if (!Value.Check(progressParams, value))
        return this.fail(new Error("Invalid progress notification"));
      const { token, value: progress } = value;
      if (progress.kind === "begin") this.progressTokens.add(token);
      if (progress.kind === "end") this.progressTokens.delete(token);
      this.markActivity();
      this.lastProgressAt = performance.now();
      this.wake();
    });
    this.connection.onNotification("experimental/serverStatus", (value: unknown) => {
      if (!Value.Check(serverStatusParams, value))
        return this.fail(new Error("Invalid server status notification"));
      this.quiescent = value.quiescent;
      this.wake();
    });
    this.connection.onRequest("workspace/diagnostic/refresh", () => {
      for (const listener of this.refreshListeners) listener();
      return null;
    });
    this.connection.onNotification("textDocument/publishDiagnostics", (value: unknown) => {
      if (this.stopped) return;
      try {
        publish(value);
        this.markActivity();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid diagnostic publication"));
      }
    });
    this.connection.listen();
  }

  private fail(cause: Error): void {
    this.failure ??= cause;
    // Callers of dispose() receive the same rejection; this path only starts the cleanup.
    this.dispose().catch(() => {});
  }

  // A malformed server request fails the instance like a malformed publication.
  private reject(message: string): never {
    const error = new Error(message);
    this.fail(error);
    throw error;
  }

  get active(): boolean {
    return !this.stopped && !this.failure;
  }

  get pullDiagnostics(): boolean {
    return this.diagnosticProvider || this.registered.has("textDocument/diagnostic");
  }

  get busy(): boolean {
    return this.progressTokens.size > 0;
  }

  // Resolves on the next progress event or publication; the quiet window restarts on it.
  get nextActivity(): Promise<void> {
    return this.activity.promise;
  }

  private markActivity(): void {
    this.activity.resolve();
    this.activity = Promise.withResolvers<void>();
  }

  // Resolves true once no work-done progress is open, or false when signal aborts first.
  async awaitIdle(signal: AbortSignal): Promise<boolean> {
    const stopped = Promise.withResolvers<void>();
    const stop = () => stopped.resolve();
    signal.addEventListener("abort", stop, { once: true });
    try {
      while (this.busy && !signal.aborted)
        await Promise.race([this.changed.promise, stopped.promise]);
    } finally {
      signal.removeEventListener("abort", stop);
    }
    return !this.busy;
  }

  // Resolves when the server is ready, or when budgetMs ends the wait. An abort of signal rejects.
  async settled(signal: AbortSignal, budgetMs: number): Promise<void> {
    const stop = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
    const stopped = Promise.withResolvers<void>();
    stop.addEventListener("abort", () => stopped.resolve(), { once: true });
    for (let wait = this.readyIn(); wait > 0 && !stop.aborted; wait = this.readyIn())
      await Promise.race([
        this.changed.promise,
        stopped.promise,
        // The signal clears the timer on abort; stopped settles first, so the race never sees its AbortError.
        ...(wait === Infinity ? [] : [delay(wait, undefined, { signal: stop })]),
      ]);
    signal.throwIfAborted();
  }

  // Milliseconds until the server counts as ready; Infinity while progress is active or the server is busy.
  private readyIn(): number {
    if (this.progressTokens.size > 0 || !this.quiescent) return Infinity;
    if (!this.signaled) return Math.max(0, this.graceUntil - performance.now());
    return Math.max(0, this.lastProgressAt + READY_QUIET_MS - performance.now());
  }

  private wake(): void {
    this.signaled = true;
    this.changed.resolve();
    this.changed = Promise.withResolvers<void>();
  }

  // Runs when pull diagnostics get registered; the returned function removes the listener.
  onPullRegistration(listener: () => void): () => void {
    this.pullListeners.add(listener);
    return () => {
      this.pullListeners.delete(listener);
    };
  }

  // Runs when the server asks for pulled diagnostics again; the returned function removes the listener.
  onDiagnosticRefresh(listener: () => void): () => void {
    this.refreshListeners.add(listener);
    return () => {
      this.refreshListeners.delete(listener);
    };
  }

  async initialize(signal?: AbortSignal): Promise<Initialization> {
    try {
      return await this.handshake(signal);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  // Some servers search other files of the project only when initialize names a workspace folder.
  private workspaceFolder() {
    return { uri: pathToFileURL(this.root).href, name: basename(this.root) };
  }

  private async handshake(signal?: AbortSignal): Promise<Initialization> {
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [this.workspaceFolder()],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          textDocument: {
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            callHierarchy: {},
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: codeActionKinds },
              },
              resolveSupport: { properties: ["edit"] },
              dataSupport: true,
            },
          },
          workspace: {
            fileOperations: { willRename: true, didRename: true },
            workspaceFolders: true,
            diagnostics: { refreshSupport: true },
          },
          window: { workDoneProgress: true },
          experimental: { serverStatusNotification: true },
        },
        initializationOptions: this.config.initializationOptions,
      },
      signal,
      STARTUP_TIMEOUT_MS,
    );
    if (!Value.Check(initializedSchema, result))
      throw new Error("Invalid LSP initialization response");
    if (
      result.capabilities.positionEncoding !== undefined &&
      result.capabilities.positionEncoding !== "utf-16"
    ) {
      throw new Error("Unsupported LSP position encoding");
    }
    this.diagnosticProvider = Boolean(result.capabilities.diagnosticProvider);
    await this.notify("initialized", {}, signal, STARTUP_TIMEOUT_MS);
    if (this.config.settings !== undefined)
      await this.notify(
        "workspace/didChangeConfiguration",
        { settings: this.config.settings },
        signal,
        STARTUP_TIMEOUT_MS,
      );
    this.graceUntil = performance.now() + READY_GRACE_MS;
    this.initialized = true;
    return result;
  }

  // An abort or an LSP error response leaves the server running; only a broken transport stops it.
  // A ContentModified answer is sent again until the deadline.
  async request(
    method: string,
    params: object,
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.stopped) throw new Error("LSP instance is closed");
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const cancellation = new rpc.CancellationTokenSource();
    const aborted = Promise.withResolvers<never>();
    const abort = () => {
      // During stop() only exit may follow shutdown, and stop() closes the connection itself.
      if (!this.stopped) cancellation.cancel();
      aborted.reject(combined.reason);
    };
    combined.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        combined.throwIfAborted();
        const answer = await this.attempt(method, params, cancellation.token, aborted.promise);
        if (answer) return answer.result;
        await delay(RETRY_PAUSE_MS, undefined, { signal: combined });
      }
    } catch (error) {
      combined.throwIfAborted();
      throw this.failure ?? error;
    } finally {
      combined.removeEventListener("abort", abort);
      cancellation.dispose();
      if (this.failure) await this.dispose();
    }
  }

  // Undefined when the server answers ContentModified.
  private async attempt(
    method: string,
    params: object,
    token: rpc.CancellationToken,
    aborted: Promise<never>,
  ): Promise<{ result: unknown } | undefined> {
    const reply = this.connection.sendRequest<unknown>(method, params, token);
    // A reply that lands after the caller gave up has no listener left.
    reply.catch(() => {});
    try {
      return { result: await Promise.race([reply, aborted]) };
    } catch (error) {
      if (error instanceof rpc.ResponseError && error.code === CONTENT_MODIFIED) return undefined;
      throw error;
    }
  }

  async notify(
    method: string,
    params: object,
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.stopped) throw new Error("LSP instance is closed");
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const aborted = Promise.withResolvers<never>();
    const abort = () => {
      try {
        combined.throwIfAborted();
      } catch (error) {
        aborted.reject(error);
      }
    };
    combined.addEventListener("abort", abort, { once: true });
    try {
      combined.throwIfAborted();
      await Promise.race([this.connection.sendNotification(method, params), aborted.promise]);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error("LSP notification failed");
      throw this.failure;
    } finally {
      combined.removeEventListener("abort", abort);
      if (combined.aborted || this.failure) await this.dispose();
    }
  }

  dispose(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    const graceful = this.initialized && !this.failure;
    this.stopped = true;
    this.onClose(this.failure ?? new Error("LSP instance is closed"));
    const deadline = performance.now() + 2000;
    const killAt = deadline - REAP_RESERVE_MS;
    if (graceful) await this.shutdown(killAt);
    this.connection.dispose();
    this.child.stdout.unpipe(this.input);
    this.input.destroy();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.signal("SIGTERM");
    // Pi may exit once dispose resolves, so a pending SIGKILL timer would never fire.
    // Probes double from 1 ms up to 8 ms, the nominal longest wait; a late timer can extend it.
    // Over the 2 s deadline a lingering group costs about 250 wakeups; a wait that ended early
    // does not count as elapsed.
    let wait = 1;
    while (this.signal(0) !== "gone" && performance.now() < killAt) {
      const started = performance.now();
      await delay(wait);
      if (performance.now() - started >= wait) wait = Math.min(wait * 2, 8);
    }
    // A sent SIGKILL is enforced by the kernel; a refused one leaves the group alive.
    if (this.signal("SIGKILL") === "refused" && !(await this.reaped(deadline)))
      throw new Error("LSP process group did not stop");
  }

  /** Whether a refused group was only awaiting its reap, and is now gone. */
  private async reaped(deadline: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      return this.signal(0) === "gone";
    const exit = once(this.child, "exit").then(() => true);
    const late = delay(Math.max(0, deadline - performance.now()), false, {
      ref: false,
    });
    return (await Promise.race([exit, late])) && this.signal(0) === "gone";
  }

  // Lets a healthy server finish its work; the same deadline still bounds the signals after it.
  private async shutdown(deadline: number): Promise<void> {
    const remaining = () => delay(Math.max(0, deadline - performance.now()), false, { ref: false });
    // A connection closed by an aborted request throws synchronously, which means no answer.
    const send = async (message: () => Promise<unknown>) => {
      await message();
      return true;
    };
    const answered = send(() => this.connection.sendRequest("shutdown")).catch(() => false);
    if (!(await Promise.race([answered, remaining()]))) return;
    const sent = send(() => this.connection.sendNotification("exit")).catch(() => false);
    if (!(await Promise.race([sent, remaining()]))) return;
    if (this.child.exitCode === null && this.child.signalCode === null)
      await Promise.race([once(this.child, "exit"), remaining()]);
  }

  private signal(signal: NodeJS.Signals | 0): "sent" | "gone" | "refused" {
    const pid = this.child.pid;
    if (process.platform === "win32" || pid === undefined)
      return this.child.kill(signal) ? "sent" : "gone";
    try {
      process.kill(-pid, signal);
      return "sent";
    } catch (error) {
      // Only ESRCH proves the group is gone; EPERM from a setuid member means it remains.
      return error instanceof Error && "code" in error && error.code === "ESRCH"
        ? "gone"
        : "refused";
    }
  }
}
