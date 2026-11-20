import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, closeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";

import { fixtureMessageSchema, parseFixtureMessage } from "./protocol.mjs";

const messageSchema = fixtureMessageSchema(
  Type.Object({
    value: Type.Optional(Type.Unknown()),
    chunks: Type.Optional(Type.Array(Type.Number())),
    bytes: Type.Optional(Type.Number()),
    terminateDebuggee: Type.Optional(Type.Boolean()),
    descendant_pid_path: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    arguments: Type.Optional(Type.Unknown()),
  }),
);
/** @typedef {import("typebox").Static<typeof messageSchema>} FixtureMessage */
/** @typedef {Extract<FixtureMessage, {type: "request"}>} FixtureRequest */

let input = Buffer.alloc(0);
let nextSequence = 1;
const zeroSequence = process.env.FAKE_ZERO_SEQUENCE === "1";

/** Number for the next outbound frame; the zero-sequence mode imitates lldb-dap from seq 0. */
function takeSequence() {
  return zeroSequence ? 0 : nextSequence++;
}
/** @type {import("node:stream").Writable} */
let output;
/** @type {import("node:stream").Readable} */
let inputStream;
/** @type {Map<number, FixtureRequest>} */
const pendingReverseRequests = new Map();

/**
 * @param {unknown} message
 */
function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

/**
 * @param {unknown} message
 */
function send(message) {
  output.write(frame(message));
}

/**
 * @param {FixtureRequest} request
 * @param {boolean} success
 * @param {unknown} [body]
 * @param {string} [message]
 */
function respond(request, success, body, message) {
  /** @type {import("@vscode/debugprotocol").DebugProtocol.Response} */
  const response = {
    seq: takeSequence(),
    type: "response",
    request_seq: request.seq,
    success,
    command: request.command,
  };
  if (body !== undefined) response.body = body;
  if (message !== undefined) response.message = message;
  send(response);
}

/** @type {Record<string, unknown>} */
const invalidEnvelopes = {
  "invalid-envelope": { seq: 1, type: "event" },
  "seq-negative": { seq: -1, type: "event", event: "fixture" },
  "seq-fraction": { seq: 0.5, type: "event", event: "fixture" },
  "seq-string": { seq: "0", type: "event", event: "fixture" },
  "reverse-seq-zero": { seq: 0, type: "request", command: "runInTerminal" },
  "request-seq-zero": {
    seq: 1,
    type: "response",
    request_seq: 0,
    success: true,
    command: "echo",
  },
  "stray-response": {
    seq: 1,
    type: "response",
    request_seq: 999,
    success: true,
    command: "echo",
  },
};

/** @param {string} mode */
function sendEnvelopeFrame(mode) {
  const payload = Buffer.from(JSON.stringify(invalidEnvelopes[mode]));
  output.write(`Content-Length: ${payload.length}\r\n\r\n`);
  output.write(payload);
}

function sendMalformedMode() {
  switch (process.env.FAKE_MODE) {
    case "malformed-header":
      output.write("Content-Length nope\r\n\r\n{}");
      break;
    case "missing-header":
      output.write("Content-Type: application/json\r\n\r\n{}");
      break;
    case "malformed-json":
      output.write("Content-Length: 1\r\n\r\n{");
      break;
    case "oversize":
      output.write(`Content-Length: ${8 * 1024 * 1024 + 1}\r\n\r\n`);
      break;
    default:
      if (process.env.FAKE_MODE !== undefined && process.env.FAKE_MODE in invalidEnvelopes)
        sendEnvelopeFrame(process.env.FAKE_MODE);
      break;
  }
}

/**
 * @param {FixtureRequest} request
 */
async function sendFragmentedResponse(request) {
  const response = frame({
    seq: takeSequence(),
    type: "response",
    request_seq: request.seq,
    success: true,
    command: request.command,
    body: { value: request.arguments?.value },
  });
  const chunks = request.arguments?.chunks ?? [1];
  let offset = 0;
  let index = 0;
  while (offset < response.length) {
    const length = Math.max(1, chunks[index % chunks.length] ?? 1);
    output.write(response.subarray(offset, offset + length));
    offset += length;
    index += 1;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * @param {FixtureRequest} request
 * @param {string} command
 */
function handleShutdownOrCrash(request, command) {
  switch (command) {
    case "terminate":
      if (process.env.FAKE_IGNORE_SHUTDOWN !== "1") respond(request, true, {});
      return;
    case "disconnect":
      disconnectFixture(request);
      return;
    case "crash":
      process.stderr.write("fixture adapter crashed\n", () => process.exit(23));
      return;
    case "stderr-crash": {
      const bytes = request.arguments?.bytes ?? 32;
      const prefix = "old-stderr-".repeat(Math.ceil(bytes / 11)).slice(0, bytes);
      process.stderr.write(`${prefix}LATEST-STDERR`, () => process.exit(24));
      return;
    }
    default:
      respond(request, false, undefined, `unknown fixture command ${request.command}`);
  }
}

/**
 * @param {FixtureRequest} request
 * @param {string} command
 */
function handleFailureOrShutdown(request, command) {
  switch (command) {
    case "fail":
      respond(request, false, { reason: "fixture" }, "fixture failure");
      return;
    case "fail-error-format":
      respond(request, false, {
        error: {
          id: 7,
          format: "ReferenceError: {name} is not defined ({name}, {missing})",
          variables: { name: "nope" },
        },
      });
      return;
    case "fail-with-stderr":
      process.stderr.write("fixture stderr detail\n", () =>
        setTimeout(() => respond(request, false, undefined, "fixture failure"), 200),
      );
      return;
    case "hang":
      return;
    case "stop-reading":
    case "close-input":
      stopInput(request);
      return;
    default:
      handleShutdownOrCrash(request, command);
  }
}

/** @param {FixtureRequest} request */
function sendReverseRequest(request) {
  const reverseSequence = takeSequence();
  pendingReverseRequests.set(reverseSequence, request);
  send({
    seq: reverseSequence,
    type: "request",
    command: request.arguments?.command ?? "runInTerminal",
    arguments: request.arguments?.arguments ?? { title: "fixture" },
  });
}

/** @param {FixtureRequest} request */
async function spawnDescendant(request) {
  const pidPath = request.arguments?.descendant_pid_path;
  if (pidPath === undefined) throw new Error("fixture requires descendant_pid_path");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./sigterm-resistant-child.mjs", import.meta.url)), pidPath],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const ready = once(child.stdout, "data");
  await once(child, "spawn");
  if (child.pid === undefined) throw new Error("fixture descendant has no PID");
  await writeFile(pidPath, String(child.pid));
  await ready;
  respond(request, true, { descendant_pid: child.pid });
}

/**
 * Stay alive without reading input, so the client's writes back up or fail.
 * @param {FixtureRequest} request
 */
function stopInput(request) {
  setInterval(() => {}, 1_000);
  inputStream.pause();
  // Destroying process.stdin keeps fd 0 open; only closing the fd makes the client's writes fail.
  if (request.command === "close-input") closeSync(0);
  respond(request, true, {});
}

/** @param {FixtureRequest} request */
function fillStderr(request) {
  const bytes = request.arguments?.bytes ?? 1024;
  if (bytes > 1024 * 1024) {
    respond(request, false, {}, "stderr-fill allows at most 1 MiB");
    return;
  }
  process.stderr.write(Buffer.alloc(bytes, "x"));
  respond(request, true, {});
}

/**
 * @param {FixtureRequest} request
 */
async function handleRequest(request) {
  const command = request.command;
  switch (command) {
    case "echo":
      respond(request, true, request.arguments);
      return;
    case "fragment":
      await sendFragmentedResponse(request);
      return;
    case "stderr-fill":
      fillStderr(request);
      return;
    case "spawn-descendant":
      await spawnDescendant(request);
      return;
    case "coalesced":
      output.write(
        Buffer.concat([
          frame({
            seq: takeSequence(),
            type: "event",
            event: "fixture",
            body: { coalesced: true },
          }),
          frame({
            seq: takeSequence(),
            type: "response",
            request_seq: request.seq,
            success: true,
            command: request.command,
            body: { coalesced: true },
          }),
        ]),
      );
      return;
    case "inspect":
      respond(request, true, {
        argv: process.argv.slice(2),
        port: process.env.PORT,
        inherited: process.env.DEBUG_FIXTURE_INHERITED,
        removed: process.env.DEBUG_FIXTURE_REMOVED,
        pid: process.pid,
      });
      return;
    case "reverse":
      sendReverseRequest(request);
      return;
    default:
      handleFailureOrShutdown(request, command);
  }
}

/**
 * Record an inbound request when the test sets FAKE_REQUEST_LOG, so a regression can assert the
 * exact shutdown requests the client sent.
 * @param {FixtureRequest} request
 */
function logRequest(request) {
  const path = process.env.FAKE_REQUEST_LOG;
  if (path === undefined) return;
  appendFileSync(
    path,
    `${JSON.stringify({ command: request.command, arguments: request.arguments ?? null })}\n`,
  );
}

/**
 * @param {FixtureMessage} message
 */
function receive(message) {
  if (message.type === "request") {
    logRequest(message);
    void handleRequest(message);
    return;
  }
  if (message.type === "response") {
    const original = pendingReverseRequests.get(message.request_seq);
    if (original === undefined) return;
    pendingReverseRequests.delete(message.request_seq);
    respond(original, true, {
      reverseSuccess: message.success,
      reverseBody: message.body,
      reverseMessage: message.message,
    });
  }
}

/** @param {FixtureRequest} request */
function disconnectFixture(request) {
  if (request.arguments?.terminateDebuggee === false && process.env.FAKE_CHILD_DISCONNECT) {
    if (process.env.FAKE_CHILD_DISCONNECT === "refuse")
      respond(request, false, undefined, "refused disconnect");
    if (process.env.FAKE_CHILD_DISCONNECT === "ack") respond(request, true, {});
    return;
  }
  if (process.env.FAKE_IGNORE_SHUTDOWN !== "1") {
    respond(request, true, {});
    setTimeout(() => process.exit(0), 5);
  }
}

/**
 * @param {Buffer} chunk
 */
function push(chunk) {
  input = Buffer.concat([input, chunk]);
  for (;;) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    const match = /^Content-Length: (\d+)$/m.exec(header);
    if (match === null) throw new Error("fixture received malformed frame");
    const length = Number(match[1]);
    if (input.length < headerEnd + 4 + length) return;
    const payload = input.subarray(headerEnd + 4, headerEnd + 4 + length);
    input = input.subarray(headerEnd + 4 + length);
    receive(parseFixtureMessage(messageSchema, payload.toString("utf8")));
  }
}

/**
 * @param {import("node:stream").Readable} readable
 * @param {import("node:stream").Writable} writable
 */
function attach(readable, writable) {
  output = writable;
  inputStream = readable;
  readable.on("data", push);
  writable.on("error", () => {});
  sendMalformedMode();
  if (process.env.FAKE_MODE === "exit-on-connect") {
    process.stderr.write("fixture exited unexpectedly\n", () => process.exit(22));
  }
}

if (process.env.FAKE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
  // Stay alive after stdin closes too, so only SIGKILL ends an uncooperative adapter.
  setInterval(() => {}, 1_000);
}

if (process.env.FAKE_REVERSE_ON_SIGUSR2 === "1") {
  process.on("SIGUSR2", () =>
    send({
      seq: takeSequence(),
      type: "request",
      command: "runInTerminal",
      arguments: {},
    }),
  );
}

const tcpIndex = process.argv.indexOf("--tcp");
if (tcpIndex >= 0) {
  const port = Number(process.argv[tcpIndex + 1]);
  if (process.env.FAKE_MODE === "no-listen") {
    setInterval(() => {}, 1000);
  } else {
    const server = createServer((socket) => {
      if (process.env.FAKE_MULTI_CONNECT !== "1") server.close();
      attach(socket, socket);
    });
    setTimeout(
      () => server.listen(port, "127.0.0.1"),
      Number(process.env.FAKE_LISTEN_DELAY_MS ?? 0),
    );
  }
} else {
  attach(process.stdin, process.stdout);
}
