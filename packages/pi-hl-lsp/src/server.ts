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
      env: {
        HOME: homedir(),
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      },
    });
    let bytes = 0;
    this.input = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) done(new Error("LSP wire budget exceeded"));
        else done(null, chunk);
      },
    });
    this.child.stdout.pipe(this.input);
    const reader = new rpc.StreamMessageReader(this.input);
    // Operation deadlines replace recursive partial-frame notifications.
    reader.partialMessageTimeout = 0;
    this.connection = rpc.createMessageConnection(
      reader,
      new rpc.StreamMessageWriter(this.child.stdin),
    );
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
    });
    this.input.on("error", (error: Error) => this.fail(error));
    this.connection.onClose(() => this.fail(new Error("LSP connection closed")));
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
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    const deadline = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    try {
      await this.exited;
    } finally {
      clearTimeout(deadline);
    }
  }
}
