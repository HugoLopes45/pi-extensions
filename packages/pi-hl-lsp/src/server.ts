import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { Transform, type TransformCallback } from "node:stream";
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
    referencesProvider: provider,
    documentSymbolProvider: provider,
  }),
});
export type Initialization = Static<typeof initializedSchema>;

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
      this.header = data;
      return Buffer.alloc(0);
    }
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

export class LanguageServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: rpc.MessageConnection;
  private readonly input: Transform;
  private readonly exited: Promise<void>;
  private closing: Promise<void> | undefined;
  private failure: Error | undefined;
  private stopped = false;
  private stderr = "";

  constructor(
    config: ServerConfig,
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
    this.exited = new Promise((resolve) => {
      this.child.once("error", (error: Error) => {
        this.fail(error);
        resolve();
      });
      this.child.once("exit", (code) => {
        if (!this.stopped) this.fail(new Error(`LSP process exited (${code}): ${this.stderr}`));
        resolve();
      });
    });
    this.connection.onNotification("textDocument/publishDiagnostics", (value: unknown) => {
      if (this.stopped) return;
      try {
        publish(value);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid diagnostic publication"));
      }
    });
    this.connection.listen();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    void this.dispose();
  }

  get active(): boolean {
    return !this.stopped && !this.failure;
  }

  async initialize(signal?: AbortSignal): Promise<Initialization> {
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.root).href,
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          textDocument: { publishDiagnostics: { versionSupport: true } },
        },
      },
      signal,
    );
    if (!Value.Check(initializedSchema, result))
      throw new Error("Invalid LSP initialization response");
    if (
      result.capabilities.positionEncoding !== undefined &&
      result.capabilities.positionEncoding !== "utf-16"
    ) {
      throw new Error("Unsupported LSP position encoding");
    }
    await this.notify("initialized", {}, signal);
    return result;
  }

  async request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.stopped) throw new Error("LSP instance is closed");
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const cancellation = new rpc.CancellationTokenSource();
    const abort = () => {
      cancellation.cancel();
      this.connection.dispose();
    };
    combined.addEventListener("abort", abort, { once: true });
    try {
      combined.throwIfAborted();
      return await this.connection.sendRequest<unknown>(method, params, cancellation.token);
    } catch (error) {
      combined.throwIfAborted();
      throw this.failure ?? error;
    } finally {
      combined.removeEventListener("abort", abort);
      cancellation.dispose();
      if (combined.aborted || this.failure) await this.dispose();
    }
  }

  async notify(method: string, params: object, signal?: AbortSignal): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.stopped) throw new Error("LSP instance is closed");
    const deadline = AbortSignal.timeout(this.timeoutMs);
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
    this.stopped = true;
    this.onClose(this.failure ?? new Error("LSP instance is closed"));
    this.connection.dispose();
    this.child.stdout.unpipe(this.input);
    this.input.destroy();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.signal("SIGTERM");
    const deadline = setTimeout(() => this.signal("SIGKILL"), 2000);
    await this.exited;
    // Descendants that ignore SIGTERM outlive the server; keep their deadline.
    if (!this.signal(0)) clearTimeout(deadline);
  }

  /** Signals the server's process group on POSIX; returns whether it still exists. */
  private signal(signal: NodeJS.Signals | 0): boolean {
    const pid = this.child.pid;
    if (process.platform === "win32" || pid === undefined) return this.child.kill(signal);
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      // EPERM: a member exists but cannot be signalled, so the deadline stays.
      if (error.code === "EPERM") return true;
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }
}
