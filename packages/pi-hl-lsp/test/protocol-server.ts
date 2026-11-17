import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";

import { Type } from "typebox";
import { Value } from "typebox/value";
import rpc from "vscode-jsonrpc/node";
const mode = process.argv[2];
// These servers outlive SIGTERM and a closed stdin, like a hung real server.
const stubborn =
  mode === "stubborn-server" || mode === "stubborn-garbage" || mode === "stubborn-mute";
if (stubborn) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
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
  ["stubborn-garbage", () => "Content-Length: 2\r\n\r\n{x"],
  ["endless-header", () => `X-Pad: ${"a".repeat(9 * 1024 * 1024)}`],
  ["burst", () => frames(400_000)],
  [
    "mixed-case-length",
    () =>
      `content-length: 1000\r\nContent-Length: 30\r\n\r\n{"jsonrpc":"2.0","method":"x"}${frames(10)}`,
  ],
  ["hex-length", () => `Content-Length: 0x1E\r\n\r\n{"jsonrpc":"2.0","method":"x"}${frames(10)}`],
  ["cr-cr", () => `Content-Length: 2\r\r\n\r\n{}${frames(10)}`],
  [
    "double-length",
    () =>
      `Content-Length: 1000\r\nContent-Length: 30x\r\n\r\n{"jsonrpc":"2.0","method":"x"}${frames(10)}`,
  ],
]);
const log = (event: string) => {
  if (spawnLog !== undefined) appendFileSync(spawnLog, `${event}\n`);
};
const replies = new Map<
  string | undefined,
  (token: rpc.CancellationToken) => object | Promise<object>
>([
  [
    "slow-shutdown",
    (token) => {
      token.onCancellationRequested(() => log("cancel"));
      return new Promise<never>(() => {});
    },
  ],
  ["chatty", () => ({ contents: "x".repeat(1024 * 1024) })],
  ["stubborn-server", () => ({ pid: process.pid })],
  [
    "grandchild",
    () => {
      spawn("sleep", ["60"]);
      return { group: process.pid };
    },
  ],
  [
    "stubborn-grandchild",
    async () => {
      const child = spawn("sh", ["-c", "trap '' TERM; echo ready; exec sleep 60"]);
      await once(child.stdout, "data");
      return { group: process.pid };
    },
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
      textDocumentSync: mode === "sync-open-close" ? { openClose: true, change: 0 } : 1,
      hoverProvider: true,
      positionEncoding: mode === "wrong-encoding" ? "utf-8" : "utf-16",
    },
  };
});
connection.onRequest(
  "textDocument/hover",
  async (_params: unknown, token: rpc.CancellationToken): Promise<object> => {
    if (mode === "ignore") return new Promise<never>(() => {});
    const raw = rawReplies.get(mode);
    if (raw) {
      process.stdout.write(raw());
      return new Promise<never>(() => {});
    }
    const reply = replies.get(mode);
    if (reply) return reply(token);
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
  },
);
// Synchronization modes log each document notification with the version it carries.
const syncLog = mode === "sync-log" || mode === "sync-open-close";
const opened = Type.Object({
  textDocument: Type.Object({ uri: Type.String(), version: Type.Integer() }),
});
async function publishDiagnostics(value: unknown) {
  if (!Value.Check(opened, value)) throw new Error("Invalid didOpen fixture message");
  await connection.sendNotification("textDocument/publishDiagnostics", {
    uri: value.textDocument.uri,
    ...(mode === "versioned" || syncLog ? { version: value.textDocument.version } : {}),
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
connection.onNotification("textDocument/didOpen", async (value: unknown) => {
  if (syncLog && Value.Check(opened, value)) log(`didOpen ${value.textDocument.version}`);
  await publishDiagnostics(value);
});
connection.onNotification("textDocument/didChange", async (value: unknown) => {
  if (syncLog && Value.Check(opened, value)) log(`didChange ${value.textDocument.version}`);
  await publishDiagnostics(value);
});
connection.onNotification("textDocument/didClose", () => {
  if (syncLog) log("didClose");
});
connection.onNotification("test/fail", async () => {
  await connection.sendNotification("textDocument/publishDiagnostics", {});
});
const handshake = new Set([
  "handshake",
  "mute-shutdown",
  "slow-shutdown",
  "stubborn-mute",
  "wrong-encoding",
]);
if (mode !== undefined && handshake.has(mode)) {
  connection.onRequest("shutdown", async () => {
    log("shutdown");
    if (mode === "mute-shutdown" || mode === "stubborn-mute") return new Promise<never>(() => {});
    if (mode === "slow-shutdown") await delay(500);
    return null;
  });
  connection.onNotification("exit", () => {
    log("exit");
    process.exit(0);
  });
}
connection.onClose(() => {
  if (!stubborn) process.exit(0);
});
connection.listen();
if (spawnLog === "--ready")
  await connection.sendNotification("textDocument/publishDiagnostics", {
    uri: "file:///fixture-ready",
    diagnostics: [],
  });
