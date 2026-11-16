import { appendFileSync } from "node:fs";

import { Type } from "typebox";
import { Value } from "typebox/value";
import rpc from "vscode-jsonrpc/node";
const mode = process.argv[2];
// A launch appends one line here, so a test can count launches without reading internals.
const spawnLog = process.argv[3];
if (spawnLog !== undefined && spawnLog !== "--ready") appendFileSync(spawnLog, `${process.pid}\n`);
const reader = new rpc.StreamMessageReader(process.stdin);
reader.partialMessageTimeout = 0;
const connection = rpc.createMessageConnection(reader, new rpc.StreamMessageWriter(process.stdout));
connection.onRequest("initialize", async () => {
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
connection.onClose(() => process.exit(0));
connection.listen();
if (spawnLog === "--ready")
  await connection.sendNotification("textDocument/publishDiagnostics", {
    uri: "file:///fixture-ready",
    diagnostics: [],
  });
