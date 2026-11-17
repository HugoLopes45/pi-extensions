import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";

import { Type } from "typebox";
import { Value } from "typebox/value";
import rpc from "vscode-jsonrpc/node";
const mode = process.argv[2];
// A launch appends one line here, so a test can count launches without reading internals.
const spawnLog = process.argv[3];
if (spawnLog !== undefined && spawnLog !== "--ready") appendFileSync(spawnLog, `${process.pid}\n`);
const reader = new rpc.StreamMessageReader(process.stdin);
reader.partialMessageTimeout = 0;
const fragmented = new Writable({
  write(chunk: Buffer, _encoding, done) {
    void (async () => {
      for (const byte of chunk) {
        process.stdout.write(Buffer.of(byte));
        await tick();
      }
      done();
    })();
  },
});
const connection = rpc.createMessageConnection(
  reader,
  new rpc.StreamMessageWriter(mode === "fragmented" ? fragmented : process.stdout),
);
function frames(count: number): string {
  const body = JSON.stringify({ jsonrpc: "2.0", method: "noise", params: {} });
  return `Content-Length: ${body.length}\r\n\r\n${body}`.repeat(count);
}
const rawReplies = new Map<string | undefined, () => string>([
  ["invalid-frame", () => "Content-Length: 2\r\n\r\n{x"],
  ["endless-header", () => `X-Pad: ${"a".repeat(9 * 1024 * 1024)}`],
  ["burst", () => frames(400_000)],
  [
    "mixed-case-length",
    () =>
      `content-length: 1000\r\nContent-Length: 30\r\n\r\n{"jsonrpc":"2.0","method":"x"}${frames(10)}`,
  ],
  ["cr-cr", () => `Content-Length: 2\r\r\n\r\n{}${frames(10)}`],
  [
    "double-length",
    () =>
      `Content-Length: 1000\r\nContent-Length: 30x\r\n\r\n{"jsonrpc":"2.0","method":"x"}${frames(10)}`,
  ],
]);
connection.onRequest("initialize", async () => {
  if (mode === "tab-length")
    process.stdout.write(
      'X-Pad: a\nb\r\nContent-Length:\t30\r\n\r\n{"jsonrpc":"2.0","method":"x"}',
    );
  if (mode === "backpressure")
    setImmediate(() => {
      process.stdin.pause();
      setTimeout(() => {}, 60000);
    });
  if (mode === "oversized")
    await connection.sendNotification("noise", {
      text: "x".repeat(9 * 1024 * 1024),
    });
  return {
    capabilities: {
      textDocumentSync: 1,
      hoverProvider: true,
      positionEncoding: mode === "wrong-encoding" ? "utf-8" : "utf-16",
    },
  };
});
connection.onRequest("textDocument/hover", async (): Promise<object> => {
  if (mode === "ignore") return new Promise<never>(() => {});
  const raw = rawReplies.get(mode);
  if (raw) {
    process.stdout.write(raw());
    return new Promise<never>(() => {});
  }
  if (mode === "stubborn-server") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return { pid: process.pid };
  }
  if (mode === "chatty") return { contents: "x".repeat(1024 * 1024) };
  if (mode === "grandchild") return { pid: spawn("sleep", ["60"]).pid };
  if (mode === "stubborn-grandchild") {
    const child = spawn("sh", ["-c", "trap '' TERM; echo ready; exec sleep 60"]);
    await once(child.stdout, "data");
    return { pid: child.pid };
  }
  if (mode === "effects") {
    try {
      await connection.sendRequest("workspace/applyEdit", {
        edit: { changes: {} },
      });
    } catch (error) {
      if (error instanceof rpc.ResponseError) return { rejected: error.code };
      throw error;
    }
  }
  return { contents: { kind: "plaintext", value: "const value: number" } };
});
const opened = Type.Object({
  textDocument: Type.Object({ uri: Type.String(), version: Type.Integer() }),
});
async function publishDiagnostics(value: unknown) {
  if (!Value.Check(opened, value)) throw new Error("Invalid didOpen fixture message");
  await connection.sendNotification("textDocument/publishDiagnostics", {
    uri: value.textDocument.uri,
    ...(mode === "versioned" ? { version: value.textDocument.version } : {}),
    diagnostics:
      mode === "versioned"
        ? [
            {
              message: "Untrusted diagnostic prose",
              code: 2322,
              severity: 1,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
            },
          ]
        : [],
  });
}
connection.onNotification("textDocument/didOpen", publishDiagnostics);
connection.onNotification("textDocument/didChange", publishDiagnostics);
connection.onNotification("test/fail", async () => {
  await connection.sendNotification("textDocument/publishDiagnostics", {});
});
connection.onClose(() => {
  if (mode !== "stubborn-server") process.exit(0);
});
connection.listen();
if (spawnLog === "--ready")
  await connection.sendNotification("textDocument/publishDiagnostics", {
    uri: "file:///fixture-ready",
    diagnostics: [],
  });
