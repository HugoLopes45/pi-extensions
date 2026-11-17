import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import {
  setTimeout as delay,
  setImmediate as tick,
} from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import { Value } from "typebox/value";
import rpc from "vscode-jsonrpc/node";
const mode = process.argv[2];
// These servers outlive SIGTERM and a closed stdin, like a hung real server.
const stubborn =
  mode === "stubborn-server" ||
  mode === "stubborn-garbage" ||
  mode === "stubborn-mute";
if (stubborn) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
// A launch appends one line here, so a test can count launches without reading internals.
const spawnLog = process.argv[3];
if (spawnLog !== undefined && spawnLog !== "--ready")
  appendFileSync(spawnLog, `${process.pid}\n`);
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
  new rpc.StreamMessageWriter(
    mode === "fragmented" ? fragmented : process.stdout,
  ),
);
function frames(count: number, padding = 0): string {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "noise",
    params: { text: "x".repeat(padding) },
  });
  return `Content-Length: ${body.length}\r\n\r\n${body}`.repeat(count);
}
const rawReplies = new Map<string | undefined, () => string>([
  ["invalid-frame", () => "Content-Length: 2\r\n\r\n{x"],
  ["stubborn-garbage", () => "Content-Length: 2\r\n\r\n{x"],
  ["endless-header", () => `X-Pad: ${"a".repeat(9 * 1024 * 1024)}`],
  // Per-frame reader work dominates a burst of tiny frames, so each frame carries about 1 KiB.
  ["burst", () => frames(16_000, 1024)],
  [
    "mixed-case-length",
    () =>
      `content-length: 1000\r\nContent-Length: 30\r\n\r\n{"jsonrpc":"2.0","method":"x"}${frames(10)}`,
  ],
  [
    "hex-length",
    () =>
      `Content-Length: 0x1E\r\n\r\n{"jsonrpc":"2.0","method":"x"}${frames(10)}`,
  ],
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
// A descendant that ignores SIGTERM and leaves `ms` after its parent exits, closing its stdin.
async function lingering(ms: number) {
  const child = spawn(process.execPath, [
    "-e",
    `process.on('SIGTERM', () => {}); process.stdin.on('end', () => setTimeout(() => process.exit(0), ${ms})); process.stdin.resume(); console.log('ready');`,
  ]);
  await once(child.stdout, "data");
  return { contents: "" };
}
// Replies that tests read carry extra fields next to the empty hover contents, so the hover still validates.
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
  ["stubborn-server", () => ({ contents: "", pid: process.pid })],
  ["lingering-child", () => lingering(5)],
  ["slow-lingering-child", () => lingering(30)],
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
      const child = spawn("sh", [
        "-c",
        "trap '' TERM; echo ready; exec sleep 60",
      ]);
      await once(child.stdout, "data");
      return { contents: "", group: process.pid };
    },
  ],
]);
const navigationModes = new Set<string | undefined>([
  "navigation",
  "special-targets",
  "malformed-definition",
]);
// Pull modes advertise a static diagnosticProvider; pull-dynamic registers the method after initialized.
const staticPullModes = new Set<string | undefined>([
  "pull-static",
  "pull-and-push",
  "pull-duplicate",
  "pull-error",
  "pull-cancel-once",
  "pull-cancel-always",
]);
const pullRegistration = { id: "pull", method: "textDocument/diagnostic" };
const typeNavigationModes = new Set<string | undefined>(["type-navigation"]);
const callModes = new Set<string | undefined>([
  "call-hierarchy",
  "call-hierarchy-several",
  "call-hierarchy-bogus",
]);
// Loading modes report project work, and their workspace symbol replies log when the server answered.
const loadingModes = new Set<string | undefined>([
  "progress-load",
  "progress-stuck",
  "progress-late",
  "server-status",
]);
const renameModes = new Set<string | undefined>([
  "rename-changes",
  "rename-versioned",
  "rename-overlap",
  "rename-stale",
  "rename-resource",
  "rename-outside",
  "rename-prepare-null",
]);
const formattingModes = new Set<string | undefined>([
  "format",
  "format-race",
  "format-errors",
]);
const renameFileModes = new Set<string | undefined>([
  "rename-file",
  "rename-file-null",
]);
const renameRequest = Type.Object({
  textDocument: Type.Object({ uri: Type.String() }),
  newName: Type.String(),
});
const renameFilesRequest = Type.Object({
  files: Type.Array(
    Type.Object({ oldUri: Type.String(), newUri: Type.String() }),
  ),
});
function replaceAt(line: number, start: number, end: number, newText: string) {
  return {
    range: { start: { line, character: start }, end: { line, character: end } },
    newText,
  };
}
// The outside target is outside-<project directory name>.ts in the parent directory.
function outsideUri(uri: string): string {
  const name = new URL(".", uri).pathname.split("/").at(-2);
  return new URL(`../outside-${name}.ts`, uri).href;
}
const textDocumentUri = Type.Object({
  textDocument: Type.Object({ uri: Type.String() }),
});
const textDocumentPosition = Type.Object({
  textDocument: Type.Object({ uri: Type.String() }),
  position: Type.Object({ line: Type.Integer(), character: Type.Integer() }),
});
// Reports the 0-based position the controller sent, so tests can check the resolved target.
function echoPosition(params: unknown): object {
  if (!Value.Check(textDocumentPosition, params))
    throw new Error("Invalid hover fixture request");
  return { contents: `${params.position.line}:${params.position.character}` };
}
function span(line: number, character: number) {
  return {
    start: { line, character },
    end: { line, character: character + 1 },
  };
}
function location(uri: string, line: number, character: number) {
  return { uri, range: span(line, character) };
}
function fileOperations() {
  return renameFileModes.has(mode)
    ? { workspace: { fileOperations: { willRename: true, didRename: true } } }
    : {};
}
function capabilities() {
  return {
    textDocumentSync:
      mode === "sync-open-close" ? { openClose: true, change: 0 } : 1,
    hoverProvider: true,
    ...(navigationModes.has(mode) ? { definitionProvider: true } : {}),
    ...(staticPullModes.has(mode) ? { diagnosticProvider: true } : {}),
    ...(typeNavigationModes.has(mode)
      ? { typeDefinitionProvider: true, implementationProvider: true }
      : {}),
    ...(callModes.has(mode) ? { callHierarchyProvider: true } : {}),
    ...(mode === "workspace-symbols" || loadingModes.has(mode)
      ? { workspaceSymbolProvider: true }
      : {}),
    ...(renameModes.has(mode)
      ? { renameProvider: { prepareProvider: true } }
      : {}),
    documentFormattingProvider: formattingModes.has(mode),
    ...fileOperations(),
    positionEncoding: mode === "wrong-encoding" ? "utf-8" : "utf-16",
  };
}
// Loading modes announce work before the initialize reply, so the first query starts while the server is busy.
async function startLoading() {
  void connection
    .sendRequest("window/workDoneProgress/create", { token: "load" })
    .then(
      (reply) => log(`create ${reply === null ? "null" : "other"}`),
      () => log("create failed"),
    );
  await connection.sendNotification("$/progress", {
    token: "load",
    value: { kind: "begin", title: "Loading" },
  });
  log("begin");
  if (mode === "progress-stuck") return;
  setTimeout(() => {
    log(`end ${Date.now()}`);
    void connection.sendNotification("$/progress", {
      token: "load",
      value: { kind: "end" },
    });
  }, 400);
}
async function startStatus() {
  await connection.sendNotification("experimental/serverStatus", {
    health: "ok",
    quiescent: false,
  });
  setTimeout(() => {
    log(`quiet ${Date.now()}`);
    void connection.sendNotification("experimental/serverStatus", {
      health: "ok",
      quiescent: true,
    });
  }, 400);
}
connection.onRequest("initialize", async () => {
  if (mode === "slow-init") await delay(600);
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
  if (mode === "progress-load" || mode === "progress-stuck")
    await startLoading();
  if (mode === "server-status") await startStatus();
  return { capabilities: capabilities() };
});
connection.onRequest(
  "textDocument/hover",
  async (params: unknown, token: rpc.CancellationToken): Promise<object> => {
    if (mode === "ignore") {
      token.onCancellationRequested(() => log("cancel"));
      return new Promise<never>(() => {});
    }
    if (mode === "error-hover")
      throw new rpc.ResponseError(-32801, "content modified");
    if (mode === "long-error")
      throw new rpc.ResponseError(-32603, "z".repeat(5000));
    if (mode === "echo-position") return echoPosition(params);
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
const workspaceQuery = Type.Object({ query: Type.String() });
// Answers by query: "bogus" is malformed, "pathonly" omits the range, "many" exceeds the fifty-symbol cap.
// Other queries start the range at column 0, as tsserver does for a declaration, so the name sits later.
function workspaceSymbols(query: string): unknown[] {
  const uri = synchronized ?? "file:///fixture-unopened";
  if (query === "bogus") return [{ bogus: 1 }];
  if (query === "pathonly")
    return [{ name: query, kind: 13, location: { uri } }];
  if (query === "many")
    return Array.from({ length: 60 }, (_, line) => ({
      name: `${query}${line}`,
      kind: 13,
      location: location(uri, line, 0),
    }));
  return [{ name: query, kind: 13, location: location(uri, 0, 0) }];
}
connection.onRequest("workspace/symbol", (params: unknown): unknown[] => {
  if (!Value.Check(workspaceQuery, params))
    throw new Error("Invalid workspace symbol fixture request");
  if (loadingModes.has(mode)) log(`symbol ${Date.now()}`);
  return workspaceSymbols(params.query);
});
connection.onRequest(
  "textDocument/typeDefinition",
  (params: unknown): object => {
    if (!Value.Check(textDocumentUri, params))
      throw new Error("Invalid type definition fixture request");
    return location(params.textDocument.uri, 0, 6);
  },
);
connection.onRequest(
  "textDocument/implementation",
  (params: unknown): object => {
    if (!Value.Check(textDocumentUri, params))
      throw new Error("Invalid implementation fixture request");
    return location(new URL("./impl.ts", params.textDocument.uri).href, 2, 0);
  },
);
connection.onRequest(
  "textDocument/prepareRename",
  (params: unknown): object | null => {
    if (!Value.Check(textDocumentPosition, params))
      throw new Error("Invalid prepareRename fixture request");
    return mode === "rename-prepare-null" ? null : span(0, 6);
  },
);
// Formatting removes the indentation of each line, reading the file as the server sees it on disk.
connection.onRequest("textDocument/formatting", (params: unknown): object[] => {
  if (!Value.Check(textDocumentUri, params))
    throw new Error("Invalid formatting fixture request");
  const file = fileURLToPath(params.textDocument.uri);
  log("format");
  // A race rewrites the file after the server read it, as a save by another program would.
  if (mode === "format-race") writeFileSync(file, "    const other = 3;\n");
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      const indent = /^[ \t]*/u.exec(line)?.[0] ?? "";
      return indent.length === 0
        ? []
        : [replaceAt(index, 0, indent.length, "")];
    });
});
// index.ts holds `const value = 1;` and other.ts holds `import { value } from "./index";`.
connection.onRequest("textDocument/rename", (params: unknown): object => {
  if (!Value.Check(renameRequest, params))
    throw new Error("Invalid rename fixture request");
  const { uri } = params.textDocument;
  const sibling = new URL("./other.ts", uri).href;
  const local = replaceAt(0, 6, 11, params.newName);
  const imported = replaceAt(0, 9, 14, params.newName);
  if (mode === "rename-versioned")
    return {
      documentChanges: [
        { textDocument: { uri, version: 1 }, edits: [local] },
        { textDocument: { uri: sibling, version: null }, edits: [imported] },
      ],
    };
  if (mode === "rename-overlap")
    return { changes: { [uri]: [local, replaceAt(0, 8, 10, params.newName)] } };
  if (mode === "rename-stale")
    return {
      documentChanges: [{ textDocument: { uri, version: 7 }, edits: [local] }],
    };
  if (mode === "rename-resource")
    return { documentChanges: [{ kind: "create", uri: sibling }] };
  if (mode === "rename-outside")
    return {
      changes: {
        [uri]: [local],
        [outsideUri(uri)]: [replaceAt(0, 0, 4, params.newName)],
      },
    };
  return { changes: { [uri]: [local], [sibling]: [imported] } };
});
// Call hierarchy items are named after the item they answer for, so a test sees which item was sent.
function callItem(name: string, uri: string, line: number, character: number) {
  return {
    name,
    kind: 12,
    uri,
    range: span(line, character),
    selectionRange: span(line, character),
  };
}
const callItemParams = Type.Object({
  item: Type.Object({ name: Type.String(), uri: Type.String() }),
});
connection.onRequest(
  "textDocument/prepareCallHierarchy",
  (params: unknown): object[] => {
    if (!Value.Check(textDocumentPosition, params))
      throw new Error("Invalid prepare call hierarchy fixture request");
    const { uri } = params.textDocument;
    if (mode === "call-hierarchy-several")
      return [callItem("value", uri, 0, 6), callItem("other", uri, 1, 0)];
    return [callItem("value", uri, 0, 6)];
  },
);
connection.onRequest(
  "callHierarchy/incomingCalls",
  (params: unknown): object[] => {
    if (!Value.Check(callItemParams, params))
      throw new Error("Invalid incoming calls fixture request");
    if (mode === "call-hierarchy-bogus") return [{ bogus: 1 }];
    const from = callItem(
      `caller of ${params.item.name}`,
      new URL("./caller.ts", params.item.uri).href,
      2,
      4,
    );
    return [{ from, fromRanges: [span(2, 4)] }];
  },
);
connection.onRequest(
  "callHierarchy/outgoingCalls",
  (params: unknown): object[] => {
    if (!Value.Check(callItemParams, params))
      throw new Error("Invalid outgoing calls fixture request");
    const to = callItem(
      `callee of ${params.item.name}`,
      new URL("./callee.ts", params.item.uri).href,
      0,
      0,
    );
    return [{ to, fromRanges: [span(1, 2)] }];
  },
);
// index.ts imports "./lib"; the edit names the moved module "./util" at characters 23 to 28.
connection.onRequest(
  "workspace/willRenameFiles",
  (params: unknown): object | null => {
    if (!Value.Check(renameFilesRequest, params))
      throw new Error("Invalid willRenameFiles fixture request");
    if (mode === "rename-file-null") return null;
    const [moved] = params.files;
    if (moved === undefined)
      throw new Error("willRenameFiles fixture request has no file");
    return {
      changes: {
        [new URL("./index.ts", moved.oldUri).href]: [
          replaceAt(0, 23, 28, "./util"),
        ],
      },
    };
  },
);
connection.onRequest("textDocument/definition", (params: unknown): object => {
  if (mode === "malformed-definition") return { bogus: 1 };
  if (!Value.Check(textDocumentUri, params))
    throw new Error("Invalid definition fixture request");
  const { uri } = params.textDocument;
  if (mode === "special-targets")
    return [
      location(new URL("./link.ts", uri).href, 0, 0),
      location(new URL("./pipe.ts", uri).href, 0, 0),
    ];
  const link = {
    targetUri: uri,
    targetRange: span(0, 6),
    targetSelectionRange: span(0, 6),
  };
  return [link, link, location("file:///outside/elsewhere.ts", 2, 0)];
});
// Synchronization modes log each document notification with the version it carries.
const syncLog = mode === "sync-log" || mode === "sync-open-close";
const opened = Type.Object({
  textDocument: Type.Object({ uri: Type.String(), version: Type.Integer() }),
});
function finding(code: number | string) {
  return {
    message: "Untrusted diagnostic prose",
    code,
    severity: 1,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
  };
}
const changedText = Type.Object({
  contentChanges: Type.Tuple([Type.Object({ text: Type.String() })]),
});
const openedText = Type.Object({
  textDocument: Type.Object({ text: Type.String() }),
});
// Each line with ERROR is an error and each line with WARN a warning, so a test sets diagnostics through the text.
function errorLines(value: unknown): object[] {
  const text = Value.Check(openedText, value)
    ? value.textDocument.text
    : Value.Check(changedText, value)
      ? value.contentChanges[0].text
      : "";
  return text.split("\n").flatMap((line) => {
    if (line.includes("ERROR")) return [finding(2322)];
    if (line.includes("WARN")) return [{ ...finding(2322), severity: 2 }];
    return [];
  });
}
function reportedFindings(value: unknown): object[] {
  if (mode === "error-lines" || mode === "format-errors")
    return errorLines(value);
  const code = reportedCodes.get(mode);
  return code === undefined ? [] : [finding(code)];
}
// Modes whose publication carries the document version, and the code each mode reports.
const versionedModes = new Set<string | undefined>([
  "versioned",
  "error-lines",
  "format-errors",
  "string-code",
  "pull-and-push",
  "pull-duplicate",
  "pull-error",
  "pull-cancel-always",
]);
const reportedCodes = new Map<string | undefined, number | string>([
  ["versioned", 2322],
  ["encoded-uri", 2322],
  ["string-code", "reportMissingImports"],
  ["pull-and-push", 2322],
  ["pull-duplicate", 2322],
  ["pull-error", 2322],
  ["pull-cancel-always", 2322],
]);
// Modes that never publish; their diagnostics come only from pull.
const silentModes = new Set<string | undefined>([
  "silent",
  "pull-static",
  "pull-dynamic",
  "pull-late-registration",
  "pull-cancel-once",
]);
// The most recently synchronized document, which workspace symbols answer with.
let synchronized: string | undefined;
// `changed` marks didChange; dedupe-empty stays silent for it, as cli.mjs:21942 does.
async function publishDiagnostics(value: unknown, changed: boolean) {
  if (!Value.Check(opened, value))
    throw new Error("Invalid didOpen fixture message");
  const { uri, version } = value.textDocument;
  synchronized = uri;
  if (silentModes.has(mode) || (mode === "dedupe-empty" && changed)) return;
  if (mode === "staged") {
    await connection.sendNotification("textDocument/publishDiagnostics", {
      uri,
      diagnostics: [],
    });
    await delay(30);
    await connection.sendNotification("textDocument/publishDiagnostics", {
      uri,
      diagnostics: [finding(2322)],
    });
    return;
  }
  await connection.sendNotification("textDocument/publishDiagnostics", {
    uri: mode === "encoded-uri" ? uri.replaceAll("@", "%40") : uri,
    ...(versionedModes.has(mode) || syncLog ? { version } : {}),
    diagnostics: reportedFindings(value),
  });
}
// Late loading starts on didOpen, as typescript-language-server does, so the first query precedes its first progress.
function startLateLoading() {
  setTimeout(() => {
    log("begin");
    void connection.sendNotification("$/progress", {
      token: "load",
      value: { kind: "begin", title: "Loading" },
    });
    setTimeout(() => {
      log(`end ${Date.now()}`);
      void connection.sendNotification("$/progress", {
        token: "load",
        value: { kind: "end" },
      });
    }, 400);
  }, 200);
}
connection.onNotification("textDocument/didOpen", async (value: unknown) => {
  if (mode === "progress-late") startLateLoading();
  if (syncLog && Value.Check(opened, value))
    log(`didOpen ${value.textDocument.version}`);
  await publishDiagnostics(value, false);
  // Like basedpyright, the fixture registers the pull method in reply to the first open.
  if (mode === "pull-late-registration")
    await connection.sendRequest("client/registerCapability", {
      registrations: [pullRegistration],
    });
});
connection.onNotification("textDocument/didChange", async (value: unknown) => {
  if (syncLog && Value.Check(opened, value))
    log(`didChange ${value.textDocument.version}`);
  await publishDiagnostics(value, true);
});
connection.onNotification("textDocument/didClose", () => {
  if (syncLog) log("didClose");
});
connection.onNotification("test/invalid-progress", async () => {
  await connection.sendNotification("$/progress", { token: true, value: {} });
});
connection.onNotification("test/fail", async () => {
  await connection.sendNotification("textDocument/publishDiagnostics", {});
});
// Codes the pull modes return; the other pull modes fail or return the same item.
const pulledCodes = new Map<string | undefined, number | string>([
  ["pull-static", "E0308"],
  ["pull-dynamic", "E0308"],
  ["pull-late-registration", "E0308"],
  ["pull-cancel-once", "E0308"],
  ["pull-and-push", "E0308"],
  ["pull-duplicate", 2322],
]);
let pulls = 0;
connection.onRequest("textDocument/diagnostic", (params: unknown): object => {
  if (!Value.Check(textDocumentUri, params))
    throw new Error("Invalid pull fixture request");
  pulls += 1;
  log("pull");
  if (mode === "pull-error") throw new rpc.ResponseError(-32603, "pull failed");
  if (
    mode === "pull-cancel-always" ||
    (mode === "pull-cancel-once" && pulls === 1)
  )
    throw new rpc.ResponseError(-32802, "server cancelled the request");
  const code = pulledCodes.get(mode);
  return { kind: "full", items: code === undefined ? [] : [finding(code)] };
});
connection.onNotification("test/unregister", async () => {
  await connection.sendRequest("client/unregisterCapability", {
    unregisterations: [pullRegistration],
  });
});
connection.onNotification("initialized", async () => {
  // Exits once the handshake ends, so the first request meets a dead server.
  if (mode === "exit-after-init") process.exit(3);
  if (mode === "pull-dynamic" || mode === "pull-unregistered")
    await connection.sendRequest("client/registerCapability", {
      registrations: [pullRegistration],
    });
  if (mode === "bad-registration")
    await connection
      .sendRequest("client/registerCapability", { registrations: "bad" })
      .catch(() => log("rejected"));
  // Like basedpyright, the fixture exits when its refresh request is refused.
  if (mode === "diagnostic-refresh")
    await connection.sendRequest("workspace/diagnostic/refresh").then(
      () =>
        connection.sendNotification("textDocument/publishDiagnostics", {
          uri: "file:///refresh-answered",
          diagnostics: [],
        }),
      () => process.exit(1),
    );
});
const handshake = new Set([
  "handshake",
  "lingering-child",
  "slow-lingering-child",
  "mute-shutdown",
  "slow-shutdown",
  "stubborn-mute",
  "wrong-encoding",
]);
if (mode !== undefined && handshake.has(mode)) {
  connection.onRequest("shutdown", async () => {
    log("shutdown");
    if (mode === "mute-shutdown" || mode === "stubborn-mute")
      return new Promise<never>(() => {});
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
