import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { DebugProtocol } from "@vscode/debugprotocol";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import {
  resolveProcessEnvironment,
  waitForOwnedProcessGroupExit,
  stopOwnedProcessGroup,
  waitUntil,
} from "./process.js";

const MAX_DAP_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_DAP_HEADER_BYTES = 64 * 1024;
const MAX_ADAPTER_STDERR_BYTES = 1024 * 1024;
const TCP_RETRY_DELAY_MS = 20;

const DapProtocolObjectSchema = Type.Object({}, { additionalProperties: true });
const DapRequestEnvelopeSchema = Type.Object(
  {
    // A reverse request's seq becomes our reply's request_seq, so it must stay positive.
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal("request"),
    command: Type.String({ minLength: 1 }),
    arguments: Type.Optional(DapProtocolObjectSchema),
  },
  { additionalProperties: false },
);
const DapResponseEnvelopeSchema = Type.Object(
  {
    // lldb-dap numbers every frame from 0; an inbound seq is never used for correlation.
    seq: Type.Integer({ minimum: 0 }),
    type: Type.Literal("response"),
    request_seq: Type.Integer({ minimum: 1 }),
    success: Type.Boolean(),
    command: Type.String({ minLength: 1 }),
    message: Type.Optional(Type.String()),
    body: Type.Optional(DapProtocolObjectSchema),
  },
  { additionalProperties: false },
);
const DapFailureBodySchema = Type.Object(
  {
    error: Type.Object(
      {
        format: Type.Optional(Type.String()),
        variables: Type.Optional(
          Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
const DapEventEnvelopeSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 0 }),
    type: Type.Literal("event"),
    event: Type.String({ minLength: 1 }),
    body: Type.Optional(DapProtocolObjectSchema),
  },
  { additionalProperties: false },
);
const DapEnvelopeSchema = Type.Union([
  DapRequestEnvelopeSchema,
  DapResponseEnvelopeSchema,
  DapEventEnvelopeSchema,
]);

type ParsedDapEnvelope = Static<typeof DapEnvelopeSchema>;
type ParsedDapRequest = Static<typeof DapRequestEnvelopeSchema>;
type ParsedDapResponse = Static<typeof DapResponseEnvelopeSchema>;

/** JSON object sent as DAP request arguments or returned as a response body. */
export type DapProtocolObject = Static<typeof DapProtocolObjectSchema>;

/** Stdio or TCP transport used to communicate with one configured Debug Adapter. */
export type DapTransport =
  | "stdio"
  | {
      readonly type: "tcp";
      readonly host: string;
      /** Zero asks the operating system to select a local port. */
      readonly port: number;
    };

/** Time budgets, in milliseconds, owned by one DAP Protocol Client. */
export interface DapConnectionTimeouts {
  /** Process spawn and TCP connection budget. */
  readonly startupMs: number;
  /** Ordinary DAP request budget. */
  readonly requestMs: number;
  /** Complete graceful and forced process shutdown budget, including the last stderr snapshot. */
  readonly shutdownMs: number;
}

/** Result returned after handling one Debug Adapter reverse request. */
export type DapReverseRequestResult =
  | { readonly success: true; readonly body?: DapProtocolObject }
  | {
      readonly success: false;
      readonly message: string;
      readonly body?: DapProtocolObject;
    };

/** Process, transport, and protocol configuration for one DAP Protocol Client. */
export interface DapConnectionOptions {
  /** Stable configured Adapter Definition ID. */
  readonly adapterId: string;
  /** Project working directory used as the Debug Adapter process cwd. */
  readonly cwd: string;
  /** Debug Adapter executable, started without a shell. */
  readonly command: string;
  /** Executable arguments; TCP transports replace every `$PORT` substring. */
  readonly args: readonly string[];
  /** Environment overrides; null removes an inherited key. */
  readonly environment: Readonly<Record<string, string | null>>;
  /** Configured stdio or TCP transport. */
  readonly transport: DapTransport;
  /** Startup, request, and shutdown budgets. */
  readonly timeouts: DapConnectionTimeouts;
  /** Session file retaining the latest 1 MiB of Debug Adapter stderr. */
  readonly stderrPath: string;
  /** Cancel Debug Adapter startup without retaining a process or transport. */
  readonly startupSignal?: AbortSignal | undefined;
  /** Handle a Debug Adapter request such as `runInTerminal`. */
  readonly onReverseRequest?:
    | ((
        request: DebugProtocol.Request,
      ) => Promise<DapReverseRequestResult> | DapReverseRequestResult)
    | undefined;
  /** Observe the first terminal process, transport, or protocol failure. */
  readonly onFailure?: ((error: DapConnectionError) => void) | undefined;
}

/** Per-request cancellation and timeout controls. */
export interface DapRequestOptions {
  /** Abort only this request wait. */
  readonly signal?: AbortSignal | undefined;
  /** Override the configured ordinary request budget. */
  readonly timeoutMs?: number | undefined;
}

/** Event wait controls used by Debug Session choreography. */
export interface DapEventWaitOptions {
  /** Abort only this event wait. */
  readonly signal?: AbortSignal | undefined;
  /** Override the configured ordinary request budget. */
  readonly timeoutMs?: number | undefined;
}

/** Overrides used when a TCP Debug Adapter asks for its primary target channel. */
export interface DapTargetChannelOptions {
  readonly startupSignal?: AbortSignal | undefined;
  readonly onReverseRequest?: DapConnectionOptions["onReverseRequest"];
  readonly onFailure?: DapConnectionOptions["onFailure"];
}

/** Error options for a DAP client failure. */
export interface DapConnectionErrorOptions extends ErrorOptions {
  /** Omit the stderr path from the message because the adapter wrote nothing to it. */
  readonly stderrEmpty?: boolean;
}

/** Classified Debug Adapter process, transport, protocol, timeout, and cancellation failure. */
export class DapConnectionError extends Error {
  rollbackFailed = false;
  /** Construct a searchable DAP client failure that names its stderr capture unless told it is empty. */
  constructor(
    readonly kind:
      | "cancelled"
      | "exit"
      | "protocol"
      | "request"
      | "shutdown"
      | "spawn"
      | "timeout"
      | "transport",
    readonly adapterId: string,
    readonly stderrPath: string,
    message: string,
    options?: DapConnectionErrorOptions,
  ) {
    const adapterContext =
      options?.stderrEmpty === true
        ? `adapter ${adapterId}`
        : `adapter ${adapterId}; stderr ${stderrPath}`;
    super(`DAP Protocol Client: ${message} (${adapterContext})`, options);
  }
}

interface PendingDapRequest {
  readonly command: string;
  readonly resolve: (body: DapProtocolObject | undefined) => void;
  readonly reject: (error: DapConnectionError) => void;
  readonly cleanup: () => void;
}

class DapFrameDecoder {
  private buffer = Buffer.alloc(0);
  private contentLength: number | undefined;

  constructor(private readonly receive: (envelope: ParsedDapEnvelope) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.contentLength === undefined) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          if (this.buffer.length > MAX_DAP_HEADER_BYTES) {
            throw new Error("DAP frame header exceeds 64 KiB");
          }
          return;
        }
        if (headerEnd > MAX_DAP_HEADER_BYTES) {
          throw new Error("DAP frame header exceeds 64 KiB");
        }
        this.contentLength = parseContentLength(this.buffer.subarray(0, headerEnd));
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) return;
      const payload = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = undefined;
      this.receive(parseDapEnvelope(payload));
    }
  }
}

function parseContentLength(header: Buffer): number {
  const fields = new Map<string, string>();
  for (const line of header.toString("ascii").split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("DAP frame contains a malformed header");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name.length === 0 || value.length === 0 || fields.has(name)) {
      throw new Error("DAP frame contains a malformed or duplicate header");
    }
    fields.set(name, value);
  }
  const rawLength = fields.get("content-length");
  if (rawLength === undefined || !/^(?:0|[1-9]\d*)$/.test(rawLength)) {
    throw new Error("DAP frame is missing a valid Content-Length header");
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_DAP_FRAME_BYTES) {
    throw new Error("DAP frame exceeds the 8 MiB limit");
  }
  return contentLength;
}

function parseDapEnvelope(payload: Buffer): ParsedDapEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch (cause) {
    throw new Error("DAP frame contains malformed JSON", { cause });
  }
  if (!Value.Check(DapEnvelopeSchema, value)) {
    const issue = Value.Errors(DapEnvelopeSchema, value)[0];
    throw new Error(
      `DAP frame contains an invalid protocol envelope${issue?.instancePath === undefined ? "" : ` at ${issue.instancePath || "/"}`}`,
    );
  }
  return value;
}

function dapFrame(message: DebugProtocol.ProtocolMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${String(payload.length)}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

function isDapStartupCancelled(options: DapConnectionOptions): boolean {
  return options.startupSignal?.aborted ?? false;
}

async function allocateTcpPort(host: string, requestedPort: number): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port: requestedPort });
  });
  const address = server.address();
  if (
    !Value.Check(Type.Object({ port: Type.Integer() }, { additionalProperties: true }), address)
  ) {
    await closeServer(server);
    throw new Error("TCP port allocation returned no numeric address");
  }
  const port = address.port;
  await closeServer(server);
  return port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function waitForChildSpawn(
  child: ChildProcessWithoutNullStreams,
  options: DapConnectionOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      options.startupSignal?.removeEventListener("abort", onAbort);
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (cause: Error) => {
      cleanup();
      reject(
        new DapConnectionError(
          "spawn",
          options.adapterId,
          options.stderrPath,
          `failed to spawn command ${options.command}`,
          { cause },
        ),
      );
    };
    const onAbort = () => {
      cleanup();
      reject(
        new DapConnectionError(
          "cancelled",
          options.adapterId,
          options.stderrPath,
          "Debug Adapter startup was cancelled",
        ),
      );
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    options.startupSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(
        new DapConnectionError(
          "timeout",
          options.adapterId,
          options.stderrPath,
          `startup timed out after ${String(options.timeouts.startupMs)}ms`,
        ),
      );
    }, options.timeouts.startupMs);
    timer.unref();
    if (isDapStartupCancelled(options)) onAbort();
  });
}

function endpoint(address: string | undefined, port: number | undefined): string {
  if (address === undefined || port === undefined)
    throw new Error("TCP connection has no endpoint");
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

// Match the server end of this established stream, not a listening port that can change owners.
async function peerVisible(
  pid: number,
  name: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const { stdout } = await promisify(execFile)(
      process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
      ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED", "-Fpn"],
      { timeout: Math.max(1, deadline - Date.now()), signal },
    );
    const fields = stdout.split("\n");
    return fields.includes("p" + String(pid)) && fields.includes(name);
  } catch (error) {
    // lsof exits 1 with no diagnostics when the adapter hasn't accepted the stream yet.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === 1 &&
      "stderr" in error &&
      error.stderr === ""
    )
      return false;
    throw error;
  }
}

async function verifyPeer(
  socket: Socket,
  child: ChildProcessWithoutNullStreams,
  options: DapConnectionOptions,
  deadline: number,
): Promise<Socket> {
  const onError = () => socket.destroy();
  socket.once("error", onError);
  try {
    const pid = child.pid;
    if (pid === undefined) throw new Error("Debug Adapter has no PID");
    // socket is Pi's client socket. Its remote endpoint is local to the adapter PID inspected by lsof.
    const name =
      "n" +
      endpoint(socket.remoteAddress, socket.remotePort) +
      "->" +
      endpoint(socket.localAddress, socket.localPort);
    while (
      !socket.destroyed &&
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() < deadline
    ) {
      if (await peerVisible(pid, name, deadline, options.startupSignal)) return socket;
      await delay(Math.min(TCP_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())), undefined, {
        signal: options.startupSignal,
      });
    }
    throw new Error("Connected socket is not owned by the Debug Adapter");
  } catch (cause) {
    socket.destroy();
    throw new DapConnectionError(
      isDapStartupCancelled(options) ? "cancelled" : "transport",
      options.adapterId,
      options.stderrPath,
      "Cannot verify TCP peer ownership for the spawned Debug Adapter",
      { cause },
    );
  } finally {
    socket.off("error", onError);
  }
}

async function connectTcpWithRetry(
  host: string,
  port: number,
  child: ChildProcessWithoutNullStreams,
  options: DapConnectionOptions,
): Promise<Socket> {
  const deadline = Date.now() + options.timeouts.startupMs;
  let lastCause: unknown;
  while (Date.now() < deadline) {
    if (isDapStartupCancelled(options)) {
      throw new DapConnectionError(
        "cancelled",
        options.adapterId,
        options.stderrPath,
        "Debug Adapter startup was cancelled",
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new DapConnectionError(
        "exit",
        options.adapterId,
        options.stderrPath,
        `Debug Adapter exited before TCP connection (code ${String(child.exitCode)}, signal ${String(child.signalCode)})`,
      );
    }
    try {
      const connected = await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host, port });
        // A dropped SYN neither connects nor errors before the OS timeout.
        const timer = setTimeout(
          () => onError(new Error("TCP connect attempt timed out")),
          Math.max(0, deadline - Date.now()),
        );
        const cleanup = () => {
          clearTimeout(timer);
          options.startupSignal?.removeEventListener("abort", onAbort);
          socket.off("connect", onConnect);
          socket.off("error", onError);
        };
        const onConnect = () => {
          cleanup();
          resolve(socket);
        };
        const onError = (error: Error) => {
          cleanup();
          socket.destroy();
          reject(error);
        };
        const onAbort = () => {
          cleanup();
          socket.destroy();
          reject(
            new DapConnectionError(
              "cancelled",
              options.adapterId,
              options.stderrPath,
              "Debug Adapter startup was cancelled",
            ),
          );
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
        options.startupSignal?.addEventListener("abort", onAbort, {
          once: true,
        });
        if (isDapStartupCancelled(options)) onAbort();
      });
      return await verifyPeer(connected, child, options, deadline);
    } catch (cause) {
      if (cause instanceof DapConnectionError) throw cause;
      lastCause = cause;
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(TCP_RETRY_DELAY_MS, remaining));
    }
  }
  throw new DapConnectionError(
    "timeout",
    options.adapterId,
    options.stderrPath,
    `TCP startup timed out after ${String(options.timeouts.startupMs)}ms connecting to ${host}:${String(port)}`,
    { cause: lastCause },
  );
}

class BoundedAdapterStderr {
  private retained = Buffer.alloc(0);
  private dirty = false;
  private closed = false;
  private writePromise: Promise<void> | undefined;
  private writeError: Error | undefined;

  constructor(
    readable: Readable,
    readonly adapterId: string,
    readonly path: string,
  ) {
    readable.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const combined = Buffer.concat([this.retained, bytes]);
      this.retained =
        combined.length <= MAX_ADAPTER_STDERR_BYTES
          ? combined
          : combined.subarray(combined.length - MAX_ADAPTER_STDERR_BYTES);
      this.dirty = true;
      if (!this.closed && this.writePromise === undefined) this.startSnapshotWrite();
    });
  }

  get isEmpty(): boolean {
    return this.retained.length === 0;
  }

  /**
   * Finish pending snapshot writes within what is left of the shutdown budget. JavaScript cannot
   * cancel a stalled filesystem write, so an ended budget abandons it: the last bytes may be missing
   * from the stderr path, and no later snapshot recreates a path its owner removed. Target channels
   * share this stderr, so redirecting the flush must not stop snapshots that still matter.
   */
  async flush(deadline: number): Promise<void> {
    const pending = this.writePromise;
    if (pending !== undefined && !(await waitUntil(pending, deadline))) {
      this.closed = true;
      throw new DapConnectionError(
        "shutdown",
        this.adapterId,
        this.path,
        "Debug Adapter stderr snapshot did not finish within shutdownMs",
      );
    }
    if (this.writeError !== undefined) throw this.writeError;
  }

  private startSnapshotWrite(): void {
    this.writeError = undefined;
    this.writePromise = this.writeLatestSnapshots();
  }

  private async writeLatestSnapshots(): Promise<void> {
    try {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        await writeFile(this.path, this.retained);
      }
    } catch (cause) {
      // Recorded for the final flush: an abandoned write must not reject unobserved.
      this.writeError =
        cause instanceof Error
          ? cause
          : new Error("Debug Adapter stderr snapshot write failed", { cause });
    } finally {
      this.writePromise = undefined;
    }
  }
}

/** Build failed-response text from `message`, then `body.error.format` with `{name}` placeholders filled. */
function failedRequestText(command: string, response: ParsedDapResponse): string {
  const parts: string[] = [];
  if (response.message !== undefined && response.message !== "") parts.push(response.message);
  const format = adapterErrorMessage(response.body);
  if (format !== undefined && !parts.includes(format)) parts.push(format);
  return `${command} request failed${parts.length === 0 ? "" : `: ${parts.join(": ")}`}`;
}

function adapterErrorMessage(body: DapProtocolObject | undefined): string | undefined {
  if (!Value.Check(DapFailureBodySchema, body)) return undefined;
  const { format, variables = {} } = body.error;
  if (format === undefined || format === "") return undefined;
  return format.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : placeholder,
  );
}

/**
 * Clean up a half-started Debug Adapter without hiding why it failed: a rejected signal or a failed
 * stderr snapshot must not skip the stages after it.
 */
async function cleanupFailedStart(
  child: ChildProcessWithoutNullStreams,
  stderr: BoundedAdapterStderr,
  deadline: number,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await stopOwnedProcessGroup(child, deadline);
  } catch (cause) {
    errors.push(cause);
  }
  try {
    await stderr.flush(deadline);
  } catch (cause) {
    errors.push(cause);
  }
  return errors;
}

async function prepareAdapterTransport(options: DapConnectionOptions) {
  let selectedPort: number | undefined;
  let args = [...options.args];
  const environment = resolveProcessEnvironment(options.environment);
  if (options.transport === "stdio") {
    if (args.some((argument) => argument.includes("$PORT"))) {
      throw new DapConnectionError(
        "transport",
        options.adapterId,
        options.stderrPath,
        "stdio Adapter Definition arguments cannot contain $PORT",
      );
    }
  } else {
    try {
      selectedPort = await allocateTcpPort(options.transport.host, options.transport.port);
    } catch (cause) {
      throw new DapConnectionError(
        "transport",
        options.adapterId,
        options.stderrPath,
        "failed to allocate a TCP port",
        { cause },
      );
    }
    if (isDapStartupCancelled(options)) {
      throw new DapConnectionError(
        "cancelled",
        options.adapterId,
        options.stderrPath,
        "Debug Adapter startup was cancelled",
      );
    }
    const portText = String(selectedPort);
    args = args.map((argument) => argument.replaceAll("$PORT", portText));
    environment.PORT = portText;
  }
  return { selectedPort, args, environment };
}

/** Owns one framed Debug Adapter transport and its correlated DAP requests. */
export class DapConnection {
  private readonly pendingRequests = new Map<number, PendingDapRequest>();
  private readonly pendingEventWaitRejectors = new Set<(error: DapConnectionError) => void>();
  private readonly abandonedRequestSequences = new Set<number>();
  private readonly eventListeners = new Set<(event: DebugProtocol.Event) => void>();
  private readonly decoder: DapFrameDecoder;
  private nextSequence = 1;
  private failure: DapConnectionError | undefined;
  private shuttingDown = false;
  private disposePromise: Promise<void> | undefined;
  private supportsTerminateRequest = false;

  private constructor(
    private readonly options: DapConnectionOptions,
    private readonly child: ChildProcessWithoutNullStreams | undefined,
    private readonly reader: Readable,
    private readonly writer: Writable,
    private readonly socket: Socket | undefined,
    private readonly stderr: BoundedAdapterStderr | undefined,
    readonly selectedPort: number | undefined,
  ) {
    this.decoder = new DapFrameDecoder((envelope) => this.receiveEnvelope(envelope));
    this.reader.on("data", (chunk: Buffer | string) => {
      try {
        this.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (cause) {
        this.fail(
          new DapConnectionError(
            "protocol",
            this.adapterId,
            this.stderrPath,
            cause instanceof Error ? cause.message : "failed to parse a DAP frame",
            { cause },
          ),
        );
      }
    });
    const onTransportError = (cause: Error) => {
      if (!this.shuttingDown) {
        this.fail(
          new DapConnectionError(
            "transport",
            this.adapterId,
            this.stderrPath,
            "Debug Adapter transport failed",
            { cause },
          ),
        );
      }
    };
    this.reader.on("error", onTransportError);
    // A stdio writer is a separate stream; an unhandled EPIPE on it would crash Pi.
    if (this.socket === undefined) this.writer.on("error", onTransportError);
    this.reader.on("end", () => {
      if (!this.shuttingDown && this.failure === undefined) {
        this.fail(
          new DapConnectionError(
            "transport",
            this.adapterId,
            this.stderrPath,
            "Debug Adapter transport ended unexpectedly",
          ),
        );
      }
    });
    if (this.child !== undefined) {
      this.child.on("error", (cause) => {
        if (!this.shuttingDown) {
          this.fail(
            new DapConnectionError(
              "spawn",
              this.adapterId,
              this.stderrPath,
              "Debug Adapter process failed",
              { cause },
            ),
          );
        }
      });
      this.child.on("exit", (code, signal) => {
        const error = new DapConnectionError(
          "exit",
          this.adapterId,
          this.stderrPath,
          `Debug Adapter exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
        );
        if (this.shuttingDown) this.rejectPending(error);
        else this.fail(error);
      });
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        this.fail(
          new DapConnectionError(
            "exit",
            this.adapterId,
            this.stderrPath,
            `Debug Adapter exited unexpectedly (code ${String(this.child.exitCode)}, signal ${String(this.child.signalCode)})`,
          ),
        );
      }
    }
  }

  /** Start a configured Debug Adapter and connect its stdio or TCP transport. */
  static async start(options: DapConnectionOptions): Promise<DapConnection> {
    if (isDapStartupCancelled(options)) {
      throw new DapConnectionError(
        "cancelled",
        options.adapterId,
        options.stderrPath,
        "Debug Adapter startup was cancelled",
      );
    }
    await mkdir(dirname(options.stderrPath), { recursive: true });
    await writeFile(options.stderrPath, "");

    const { selectedPort, args, environment } = await prepareAdapterTransport(options);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: environment,
        shell: false,
        stdio: "pipe",
      });
    } catch (cause) {
      throw new DapConnectionError(
        "spawn",
        options.adapterId,
        options.stderrPath,
        `failed to spawn command ${options.command}`,
        { cause },
      );
    }
    const stderr = new BoundedAdapterStderr(child.stderr, options.adapterId, options.stderrPath);

    try {
      await waitForChildSpawn(child, options);
      if (options.transport === "stdio") {
        return new DapConnection(
          options,
          child,
          child.stdout,
          child.stdin,
          undefined,
          stderr,
          undefined,
        );
      }
      child.stdout.resume();
      const socket = await connectTcpWithRetry(
        options.transport.host,
        selectedPort ?? options.transport.port,
        child,
        options,
      );
      return new DapConnection(options, child, socket, socket, socket, stderr, selectedPort);
    } catch (cause) {
      const startupError =
        cause instanceof DapConnectionError
          ? cause
          : new DapConnectionError(
              "transport",
              options.adapterId,
              options.stderrPath,
              "failed to start the Debug Adapter transport",
              { cause },
            );
      const cleanupErrors = await cleanupFailedStart(
        child,
        stderr,
        Date.now() + options.timeouts.shutdownMs,
      );
      if (cleanupErrors.length === 0) throw startupError;
      startupError.rollbackFailed = true;
      startupError.cause = new AggregateError(
        startupError.cause === undefined ? cleanupErrors : [startupError.cause, ...cleanupErrors],
        "Debug Adapter startup failure and cleanup failures",
      );
      throw startupError;
    }
  }

  /** Stable Adapter Definition ID associated with this client. */
  get adapterId(): string {
    return this.options.adapterId;
  }

  /** PID of the owned Debug Adapter process. */
  get adapterPid(): number | undefined {
    return this.child?.pid;
  }

  /** Session path retaining the latest 1 MiB of Debug Adapter stderr. */
  get stderrPath(): string {
    return this.options.stderrPath;
  }

  /** Connect the primary adapter-owned target channel without spawning another process. */
  async connectTargetChannel(overrides: DapTargetChannelOptions = {}): Promise<DapConnection> {
    if (
      this.options.transport === "stdio" ||
      this.selectedPort === undefined ||
      this.child === undefined
    ) {
      throw new DapConnectionError(
        "transport",
        this.adapterId,
        this.stderrPath,
        "primary target channels require a started TCP Debug Adapter",
      );
    }
    const options: DapConnectionOptions = {
      ...this.options,
      startupSignal: overrides.startupSignal,
      onReverseRequest: overrides.onReverseRequest,
      onFailure: overrides.onFailure,
    };
    const socket = await connectTcpWithRetry(
      this.options.transport.host,
      this.selectedPort,
      this.child,
      options,
    );
    return new DapConnection(
      options,
      undefined,
      socket,
      socket,
      socket,
      this.stderr,
      this.selectedPort,
    );
  }

  /** Subscribe to parsed Debug Adapter events; returns an unsubscribe operation. */
  onEvent(listener: (event: DebugProtocol.Event) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Wait for one parsed Debug Adapter event by name, predicate, timeout, or cancellation. */
  async waitForEvent(
    eventName: string,
    options: DapEventWaitOptions = {},
  ): Promise<DebugProtocol.Event> {
    this.throwIfUnavailable();
    if (options.signal?.aborted === true) throw this.cancelledError(`waiting for ${eventName}`);
    const timeoutMs = options.timeoutMs ?? this.options.timeouts.requestMs;
    return new Promise<DebugProtocol.Event>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.eventListeners.delete(onEvent);
        this.pendingEventWaitRejectors.delete(rejectWait);
      };
      const onEvent = (event: DebugProtocol.Event) => {
        if (event.event !== eventName) return;
        cleanup();
        resolve(event);
      };
      const onAbort = () => {
        cleanup();
        reject(this.cancelledError(`waiting for ${eventName}`));
      };
      const rejectWait = (error: DapConnectionError) => {
        cleanup();
        reject(error);
      };
      this.eventListeners.add(onEvent);
      this.pendingEventWaitRejectors.add(rejectWait);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(this.timeoutError(`waiting for ${eventName}`, timeoutMs));
      }, timeoutMs);
      timer.unref();
    });
  }

  /** Send one correlated DAP request and return its successful response body. */
  async request(
    command: string,
    argumentsValue?: DapProtocolObject,
    options: DapRequestOptions = {},
  ): Promise<DapProtocolObject | undefined> {
    this.throwIfUnavailable();
    if (options.signal?.aborted === true) throw this.cancelledError(`${command} request`);
    const sequence = this.nextSequence++;
    const timeoutMs = options.timeoutMs ?? this.options.timeouts.requestMs;
    const request: DebugProtocol.Request = {
      seq: sequence,
      type: "request",
      command,
    };
    if (argumentsValue !== undefined) request.arguments = argumentsValue;

    const response = new Promise<DapProtocolObject | undefined>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        this.pendingRequests.delete(sequence);
        this.abandonedRequestSequences.add(sequence);
        cleanup();
        reject(this.cancelledError(`${command} request`));
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      this.pendingRequests.set(sequence, {
        command,
        resolve,
        reject,
        cleanup,
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        this.pendingRequests.delete(sequence);
        this.abandonedRequestSequences.add(sequence);
        cleanup();
        reject(this.timeoutError(`${command} request`, timeoutMs));
      }, timeoutMs);
      timer.unref();
    });

    // The write is not awaited: an adapter that stops reading must not hold off the timeout.
    void this.writeMessage(request).catch((cause: unknown) => {
      const pending = this.pendingRequests.get(sequence);
      this.pendingRequests.delete(sequence);
      pending?.cleanup();
      const error =
        cause instanceof DapConnectionError
          ? cause
          : new DapConnectionError(
              "transport",
              this.adapterId,
              this.stderrPath,
              `failed to write ${command} request`,
              { cause },
            );
      pending?.reject(error);
    });

    return response;
  }

  /** Attempt DAP terminate when advertised, then disconnect and stop the owned POSIX process group. */
  async dispose(): Promise<void> {
    // Cache before transport callbacks can reenter shutdown, and freeze the request sequence the
    // adapter's advertised capabilities selected at that first call.
    if (this.disposePromise === undefined) {
      const requests: (readonly [string, Record<string, boolean>])[] = [];
      // The DAP spec allows `terminate` only when the adapter advertises it. `disconnect` with
      // `terminateDebuggee: true` remains the shutdown request every adapter receives.
      if (this.supportsTerminateRequest) requests.push(["terminate", {}]);
      requests.push(["disconnect", { terminateDebuggee: true }]);
      this.disposePromise = Promise.resolve().then(() => this.performShutdown(requests));
    }
    return this.disposePromise;
  }

  /** Record whether the adapter advertised `supportsTerminateRequest` in its `initialize` result. */
  setSupportsTerminateRequest(supports: boolean): void {
    this.supportsTerminateRequest = supports;
  }

  /**
   * Close a target channel without terminating its Debuggee: send `disconnect` with
   * `terminateDebuggee: false`, then close the socket. A live child must acknowledge the request.
   */
  async detach(alreadyTerminated = false): Promise<void> {
    this.disposePromise ??= Promise.resolve().then(async () => {
      const args = { terminateDebuggee: false };
      if (alreadyTerminated || this.child !== undefined)
        return this.performShutdown([["disconnect", args]]);
      try {
        await this.request("disconnect", args, {
          timeoutMs: Math.max(
            1,
            Math.min(
              this.options.timeouts.requestMs,
              Math.floor(this.options.timeouts.shutdownMs / 3),
            ),
          ),
        });
      } finally {
        await this.performShutdown([]);
      }
    });
    return this.disposePromise;
  }

  private async sendShutdownRequests(
    commands: readonly (readonly [string, Record<string, boolean>])[],
    deadline: number,
  ): Promise<void> {
    for (const [command, argumentsValue] of commands) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await this.request(command, argumentsValue, {
          timeoutMs: Math.max(
            1,
            Math.min(this.options.timeouts.requestMs, Math.floor(remaining / 3)),
          ),
        });
      } catch {
        // Shutdown is best effort; process-group ownership is the final guarantee.
      }
    }
  }

  private async performShutdown(
    commands: readonly (readonly [string, Record<string, boolean>])[],
  ): Promise<void> {
    const wasAvailable = this.failure === undefined;
    const deadline = Date.now() + this.options.timeouts.shutdownMs;
    if (wasAvailable) await this.sendShutdownRequests(commands, deadline);
    this.shuttingDown = true;
    const shutdownError = new DapConnectionError(
      "shutdown",
      this.adapterId,
      this.stderrPath,
      "Debug Adapter client is shutting down",
    );
    this.rejectPending(shutdownError);
    this.rejectEventWaits(shutdownError);
    if (this.socket !== undefined) this.socket.end();
    else this.child?.stdin.end();

    if (this.child === undefined) {
      this.reader.removeAllListeners();
      this.writer.destroy();
      return;
    }

    const errors: unknown[] = [];
    try {
      await this.stopOwnedProcessGroup(this.child, deadline);
    } catch (cause) {
      errors.push(cause);
    } finally {
      try {
        this.reader.removeAllListeners();
        this.writer.destroy();
        await this.stderr?.flush(deadline);
      } catch (cause) {
        errors.push(cause);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Debug Adapter process cleanup and finalization failed");
    }
  }

  private async stopOwnedProcessGroup(
    child: ChildProcessWithoutNullStreams,
    deadline: number,
  ): Promise<void> {
    try {
      const gracefulDeadline = Date.now() + Math.max(0, Math.floor((deadline - Date.now()) / 2));
      if (await waitForOwnedProcessGroupExit(child, gracefulDeadline)) return;
      await stopOwnedProcessGroup(child, deadline);
    } catch (cause) {
      throw new DapConnectionError(
        "shutdown",
        this.adapterId,
        this.stderrPath,
        "failed to stop owned adapter process group within shutdownMs",
        { cause },
      );
    }
  }

  private receiveEnvelope(envelope: ParsedDapEnvelope): void {
    switch (envelope.type) {
      case "response":
        this.receiveResponse(envelope);
        return;
      case "event":
        this.eventListeners.forEach((listener) => listener(envelope));
        return;
      case "request":
        void this.receiveReverseRequest(envelope);
        return;
    }
  }

  private receiveResponse(response: ParsedDapResponse): void {
    const pending = this.pendingRequests.get(response.request_seq);
    if (pending === undefined) {
      if (this.abandonedRequestSequences.delete(response.request_seq)) return;
      this.fail(
        new DapConnectionError(
          "protocol",
          this.adapterId,
          this.stderrPath,
          `received an unexpected response for request ${String(response.request_seq)}`,
        ),
      );
      return;
    }
    this.pendingRequests.delete(response.request_seq);
    pending.cleanup();
    if (response.command !== pending.command) {
      const error = new DapConnectionError(
        "protocol",
        this.adapterId,
        this.stderrPath,
        `response command ${response.command} does not match request ${pending.command}`,
      );
      pending.reject(error);
      this.fail(error);
      return;
    }
    if (!response.success) {
      pending.reject(
        new DapConnectionError(
          "request",
          this.adapterId,
          this.stderrPath,
          failedRequestText(pending.command, response),
          { stderrEmpty: this.stderr?.isEmpty === true },
        ),
      );
      return;
    }
    pending.resolve(response.body);
  }

  private async receiveReverseRequest(request: ParsedDapRequest): Promise<void> {
    let result: DapReverseRequestResult;
    try {
      result = (await this.options.onReverseRequest?.(request)) ?? {
        success: false,
        message: `unsupported reverse request: ${request.command}`,
      };
    } catch (cause) {
      result = {
        success: false,
        message:
          cause instanceof Error ? cause.message : `reverse request ${request.command} failed`,
      };
    }
    const response: DebugProtocol.Response = {
      seq: this.nextSequence++,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success: result.success,
    };
    if (result.body !== undefined) response.body = result.body;
    if (!result.success) response.message = result.message;
    try {
      await this.writeMessage(response);
    } catch (cause) {
      this.fail(
        cause instanceof DapConnectionError
          ? cause
          : new DapConnectionError(
              "transport",
              this.adapterId,
              this.stderrPath,
              `failed to answer reverse request ${request.command}`,
              { cause },
            ),
      );
    }
  }

  private writeMessage(message: DebugProtocol.ProtocolMessage): Promise<void> {
    this.throwIfUnavailable();
    return new Promise((resolve, reject) => {
      this.writer.write(dapFrame(message), (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private throwIfUnavailable(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.shuttingDown) {
      throw new DapConnectionError(
        "shutdown",
        this.adapterId,
        this.stderrPath,
        "Debug Adapter client is shutting down",
      );
    }
  }

  private fail(error: DapConnectionError): void {
    if (this.failure !== undefined || this.shuttingDown) return;
    this.failure = error;
    this.rejectPending(error);
    this.rejectEventWaits(error);
    this.socket?.destroy();
    if (this.socket === undefined && this.child !== undefined) {
      this.child.stdin.destroy();
      this.child.stdout.destroy();
    }
    if (this.child !== undefined) void this.cleanUpAfterFailure(error);
    this.options.onFailure?.(error);
  }

  private async cleanUpAfterFailure(error: DapConnectionError): Promise<void> {
    try {
      await this.dispose();
    } catch (cause) {
      this.failure = new DapConnectionError(
        "shutdown",
        this.adapterId,
        this.stderrPath,
        "owned process group cleanup failed after adapter failure",
        {
          cause: new AggregateError([error, cause], "Adapter failure and cleanup failure"),
        },
      );
    }
  }

  private rejectPending(error: DapConnectionError): void {
    for (const pending of this.pendingRequests.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private rejectEventWaits(error: DapConnectionError): void {
    for (const rejectWait of this.pendingEventWaitRejectors) rejectWait(error);
    this.pendingEventWaitRejectors.clear();
  }

  private cancelledError(operation: string): DapConnectionError {
    return new DapConnectionError(
      "cancelled",
      this.adapterId,
      this.stderrPath,
      `${operation} was cancelled`,
    );
  }

  private timeoutError(operation: string, timeoutMs: number): DapConnectionError {
    return new DapConnectionError(
      "timeout",
      this.adapterId,
      this.stderrPath,
      `${operation} timed out after ${String(timeoutMs)}ms`,
    );
  }
}
