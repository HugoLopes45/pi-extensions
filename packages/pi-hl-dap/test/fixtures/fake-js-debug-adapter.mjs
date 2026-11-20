// Offline stand-in for vscode-js-debug's TCP channels: a root channel that sends `startDebugging`,
// one primary target channel, and, for the `children` scripts, Child session channels the primary
// target asks for. FAKE_JS_DEBUG_SCRIPT picks how the Debuggee ends and what its children do. The
// `listen-gate` script keeps the transport unconnected until the test creates its gate file.
import { appendFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { Type } from "typebox";

import { fixtureMessageSchema, parseFixtureMessage } from "./protocol.mjs";

const messageSchema = fixtureMessageSchema(
  Type.Object({
    breakpoints: Type.Optional(Type.Array(Type.Unknown())),
  }),
);
/** @typedef {import("typebox").Static<typeof messageSchema>} FixtureMessage */
/** @typedef {Extract<FixtureMessage, {type: "request"}>} FixtureRequest */
/** @typedef {(message: Record<string, unknown>) => boolean} Send */

const port = Number(process.argv[2]);
const script = process.env.FAKE_JS_DEBUG_SCRIPT ?? "clean";
const evidencePath = process.env.FAKE_JS_DEBUG_EVIDENCE_PATH;
const rootWithoutConfigurationDone = process.env.FAKE_ROOT_CONFIGURATION_DONE === "false";
// Without root configurationDone, the root's Breakpoints reply waits for the target's capabilities.
/** @type {(() => void) | undefined} */
let pendingRootBreakpoints;
let nextSequence = 1;
/** @type {Send | undefined} */
let root;
/** @type {Send | undefined} */
let target;
/** @type {{send: Send, request: FixtureRequest} | undefined} */
let pendingRootLaunch;
/** Initialize arguments the root channel received, for the `advertise` script. */
/** @type {Record<string, unknown>} */
let rootInitializeArguments = {};
/** The `generic-primary` and `generic-child` scripts send a configuration without any adapter-specific marker. */
const genericStartDebugging = script === "generic-primary" || script === "generic-child";
/** Child session names the primary target asks for, by script. */
/** @type {Record<string, string[]>} */
const childrenByScript = {
  children: ["worker-a", "worker-b"],
  "child-running": ["worker-a"],
  "child-late-output": ["worker-a"],
  "child-detaching": ["worker-a"],
};
const childNames = childrenByScript[script] ?? [];
const pendingChildNames = [...childNames];
let liveChildren = childNames.length;

/**
 * Terminate capability a channel advertises, from FAKE_TERMINATE_ROOT or FAKE_TERMINATE_TARGET:
 * "true" and "false" advertise the value, anything else omits it.
 * @param {"root" | "target"} role
 */
function terminateCapability(role) {
  const value = process.env[role === "root" ? "FAKE_TERMINATE_ROOT" : "FAKE_TERMINATE_TARGET"];
  if (value === "true") return { supportsTerminateRequest: true };
  if (value === "false") return { supportsTerminateRequest: false };
  return {};
}

/** Append one JSON line to the evidence file the test asked for, if any. */
/** @param {Record<string, unknown>} entry */
function record(entry) {
  if (evidencePath !== undefined) appendFileSync(evidencePath, `${JSON.stringify(entry)}\n`);
}

/** @param {Record<string, unknown>} message */
function frame(message) {
  const payload = Buffer.from(JSON.stringify({ seq: nextSequence++, ...message }));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

/**
 * @param {import("node:net").Socket} socket
 * @param {(message: FixtureMessage, send: Send) => void} onMessage
 */
function channel(socket, onMessage) {
  let input = Buffer.alloc(0);
  /** @type {Send} */
  const send = (message) => socket.write(frame(message));
  socket.on("error", () => {});
  socket.on(
    "data",
    /** @param {Buffer} chunk */ (chunk) => {
      input = Buffer.concat([input, chunk]);
      for (;;) {
        const end = input.indexOf("\r\n\r\n");
        if (end < 0) return;
        const match = /Content-Length: (\d+)/u.exec(input.subarray(0, end).toString());
        if (match === null) throw new Error("fixture received malformed frame");
        const length = Number(match[1]);
        if (input.length < end + 4 + length) return;
        const message = parseFixtureMessage(
          messageSchema,
          input.subarray(end + 4, end + 4 + length).toString(),
        );
        input = input.subarray(end + 4 + length);
        onMessage(message, send);
      }
    },
  );
  return send;
}

/**
 * @param {Send} send
 * @param {FixtureRequest} request
 * @param {unknown} [body]
 */
const respond = (send, request, body = {}) =>
  send({
    type: "response",
    request_seq: request.seq,
    success: true,
    command: request.command,
    body,
  });
/**
 * @param {Send} send
 * @param {string} name
 * @param {unknown} [body]
 */
const event = (send, name, body = {}) => send({ type: "event", event: name, body });
/** @param {Send} send @param {FixtureRequest} request @param {string} text */
const fail = (send, request, text) =>
  send({
    type: "response",
    request_seq: request.seq,
    success: false,
    command: request.command,
    message: text,
  });

function endDebuggee() {
  const rootSend = root;
  const targetSend = target;
  if (rootSend === undefined || targetSend === undefined)
    throw new Error("fixture has no active target");
  /** @param {Send} send @param {number} code */
  const exitReport = (send, code) =>
    event(send, "output", { category: "stderr", output: `Process exited with code ${code}\r\n` });
  /** @param {number} milliseconds @param {() => void} action */
  const later = (milliseconds, action) => setTimeout(() => action(), milliseconds);
  switch (script) {
    case "target-first":
      event(targetSend, "terminated");
      later(30, () => exitReport(rootSend, 3));
      later(60, () => event(rootSend, "terminated", { restart: false }));
      break;
    case "root-first":
      exitReport(rootSend, 3);
      event(rootSend, "terminated", { restart: false });
      later(60, () => event(targetSend, "terminated"));
      break;
    case "children":
    case "clean":
    case "generic-primary":
      event(targetSend, "terminated");
      later(30, () => event(rootSend, "terminated", { restart: false }));
      break;
    case "spoof":
      // Debuggee output on the target channel never carries the adapter's exit report.
      event(targetSend, "output", { category: "stderr", output: "Process exited with code 7\n" });
      event(targetSend, "terminated");
      later(30, () => event(rootSend, "terminated", { restart: false }));
      break;
    case "target-only":
      event(targetSend, "terminated");
      break;
  }
}

/** Requests any target answers the same way, naming the target so routing is observable. */
/**
 * @param {Send} send
 * @param {FixtureRequest} message
 * @param {string} name
 */
function targetRequest(send, message, name) {
  switch (message.command) {
    case "threads":
      respond(send, message, { threads: [{ id: 1, name: "main" }] });
      return;
    case "stackTrace":
      respond(send, message, {
        stackFrames: [{ id: 1, name, line: 1, column: 1, source: { path: `/${name}.js` } }],
      });
      return;
    case "scopes":
      respond(send, message, { scopes: [] });
      return;
    case "evaluate":
      respond(send, message, { result: name, variablesReference: 0 });
      return;
    case "pause":
      respond(send, message);
      event(send, "stopped", { reason: "pause", threadId: 1 });
      return;
    case "terminate":
      record({ event: "terminate", role: name });
      respond(send, message);
      return;
    default:
      respond(send, message);
  }
}

/** @param {FixtureRequest} message */
function breakpointCount(message) {
  const count = message.arguments?.breakpoints?.length;
  if (count === undefined) throw new Error("fixture expected breakpoints");
  return count;
}

/** @param {Send} send @param {FixtureRequest} message @param {number} idBase */
function configureChild(send, message, idBase) {
  respond(send, message);
  if (process.env.FAKE_TERMINAL_EXIT_GATE !== undefined) return startLateOutputTerminal(send);
  if (script === "children" || script === "child-detaching" || script === "child-late-output") {
    setTimeout(
      () =>
        event(send, "stopped", { reason: "breakpoint", threadId: 1, hitBreakpointIds: [idBase] }),
      20,
    );
  }
}

/** @param {Send} send @param {FixtureRequest} message */
function continueChild(send, message) {
  if (script === "child-late-output") return continueLateOutputChild(send, message);
  respond(send, message);
  if (script === "generic-child") {
    event(send, "terminated");
    return;
  }
  if (script !== "children" && script !== "child-detaching") return;
  event(send, "terminated");
  if (script === "children") {
    liveChildren -= 1;
    if (liveChildren === 0) setTimeout(endDebuggee, 20);
  }
}

/** @param {Send} send @param {FixtureRequest} message */
function launchRoot(send, message) {
  if (script === "advertise") return advertiseRoot(send, message);
  if (script === "stop-then-promote") return stopThenPromote(send, message);
  if (script === "fail-primary-launch" || script === "fail-child-launch") {
    return requestFailingChannel(send, message);
  }
  if (script === "thread-collision") return startThreadCollisionRoot(send, message);
  if (script === "invalid-start-debugging") return requestInvalidStartDebugging(send, message);
  pendingRootLaunch = { send, request: message };
  event(send, "initialized");
  send({
    type: "request",
    command: "startDebugging",
    arguments: {
      request: "launch",
      configuration: genericStartDebugging
        ? { name: script === "generic-primary" ? "generic target" : "generic child" }
        : { type: "pwa-node", __pendingTargetId: "target-1" },
    },
  });
}

/** @param {Send} send @param {FixtureRequest} message */
function advertiseRoot(send, message) {
  respond(send, message);
  event(send, "initialized");
  event(send, "stopped", {
    reason: "entry",
    threadId: 1,
    description: `initialize adapterID=${String(rootInitializeArguments.adapterID)} supportsStartDebuggingRequest=${String(rootInitializeArguments.supportsStartDebuggingRequest)}`,
  });
}

/** The Debuggee exits, then the adapter asks for one more Debug target while teardown has begun. */
/** @param {Send} send @param {FixtureRequest} message */
function stopThenPromote(send, message) {
  respond(send, message);
  event(send, "initialized");
  event(send, "exited", { exitCode: 0 });
  send({
    type: "request",
    command: "startDebugging",
    arguments: { request: "launch", configuration: { name: "late target" } },
  });
}

/** Ask for one channel whose launch the adapter then rejects before any `initialized` event. */
/** @param {Send} send @param {FixtureRequest} message */
function requestFailingChannel(send, message) {
  pendingRootLaunch = { send, request: message };
  event(send, "initialized");
  send({
    type: "request",
    command: "startDebugging",
    arguments: {
      request: script === "fail-child-launch" ? "attach" : "launch",
      configuration: { name: script === "fail-child-launch" ? "failing child" : "failing target" },
    },
  });
}

/** Ask for a Debug target with arguments the DAP spec does not allow. */
/** @param {Send} send @param {FixtureRequest} message */
function requestInvalidStartDebugging(send, message) {
  respond(send, message);
  event(send, "initialized");
  send({ type: "request", command: "startDebugging", arguments: { request: "launch" } });
}

/** @param {Send} send @param {FixtureRequest} message */
function startThreadCollisionRoot(send, message) {
  respond(send, message);
  event(send, "initialized");
  event(send, "stopped", { reason: "entry", threadId: 1 });
}

/** The standard `exited` event arrives after the adapter's own report and must win. */
function reportThenExited() {
  const rootSend = root;
  const targetSend = target;
  if (rootSend === undefined || targetSend === undefined)
    throw new Error("fixture has no active target");
  event(targetSend, "terminated");
  setTimeout(
    () =>
      event(rootSend, "output", {
        category: "stderr",
        output: "Process exited with code 9\r\n",
      }),
    20,
  );
  setTimeout(() => event(rootSend, "exited", { exitCode: 4 }), 60);
  setTimeout(() => event(rootSend, "terminated", { restart: false }), 80);
}

/** A report-shaped stderr line on the root channel, with no `exited` event and no preset rule in play. */
function reportOnly() {
  const rootSend = root;
  const targetSend = target;
  if (rootSend === undefined || targetSend === undefined)
    throw new Error("fixture has no active target");
  event(targetSend, "terminated");
  event(rootSend, "output", {
    category: "stderr",
    output: "Process exited with code 5\r\n",
  });
  setTimeout(() => event(rootSend, "terminated", { restart: false }), 20);
}

/** @param {Send} send @param {FixtureRequest} message */
function configurePromotedTarget(send, message) {
  respond(send, message);
  if (script === "generic-child") {
    setTimeout(
      () => event(send, "stopped", { reason: "breakpoint", threadId: 1, hitBreakpointIds: [1] }),
      20,
    );
    return;
  }
  if (childNames.length === 0) {
    setTimeout(
      script === "report-then-exited"
        ? reportThenExited
        : script === "report-only"
          ? reportOnly
          : endDebuggee,
      50,
    );
  }
  for (const name of childNames) {
    send({
      type: "request",
      command: "startDebugging",
      arguments: {
        request: "launch",
        configuration: { type: "pwa-node", name, __pendingTargetId: name },
      },
    });
  }
}

/** @param {Record<string, unknown>} message */
function handleRootResponse(message) {
  if (message.command === "runInTerminal") {
    if (message.success !== true || lateOutputChild === undefined)
      throw new Error("Owned terminal did not start");
    event(lateOutputChild, "stopped", { reason: "breakpoint", threadId: 1 });
    return;
  }
  if (message.command === "diagnosticBarrier") return lateOutputBarrier();
  record({ event: "reply", message: message.message ?? "", success: message.success === true });
  if (pendingRootLaunch === undefined) return;
  respond(pendingRootLaunch.send, pendingRootLaunch.request);
  pendingRootLaunch = undefined;
}

/** @param {FixtureMessage} message @param {Send} send */
function handleRootMessage(message, send) {
  if (message.type === "response") return handleRootResponse(message);
  if (message.command === "initialize") return handleRootInitialize(message, send);
  if (message.command === "launch") return launchRoot(send, message);
  handleRootIdleCommand(message, send);
}

/** @param {FixtureRequest} message @param {Send} send */
function handleRootDisconnect(message, send) {
  record({ event: "disconnect", role: "root" });
  // The stopping race needs the socket open while teardown waits, so only that script stays unanswered.
  if (script === "stop-then-promote") return;
  respond(send, message);
}

/** @param {FixtureRequest} message @param {Send} send */
function handleRootInitialize(message, send) {
  rootInitializeArguments = message.arguments ?? {};
  record({
    event: "initialize",
    role: "root",
    adapterID: message.arguments?.adapterID,
    supportsStartDebuggingRequest: message.arguments?.supportsStartDebuggingRequest,
  });
  respond(send, message, {
    supportsConfigurationDoneRequest: !rootWithoutConfigurationDone,
    ...terminateCapability("root"),
  });
}

/** @param {FixtureRequest} message @param {Send} send */
function handleRootIdleCommand(message, send) {
  if (message.command === "setBreakpoints") {
    pendingRootBreakpoints = () => respond(send, message, { breakpoints: [] });
    if (!rootWithoutConfigurationDone) pendingRootBreakpoints();
    return;
  }
  if (message.command === "configurationDone") return handleRootConfigurationDone(send, message);
  if (message.command === "continue") return handleRootContinue(send, message);
  if (message.command === "disconnect") return handleRootDisconnect(message, send);
  if (message.command === "terminate") {
    record({ event: "terminate", role: "root" });
    return respond(send, message);
  }
  respond(send, message);
}

/** @param {Send} send @param {FixtureRequest} message */
function handleRootConfigurationDone(send, message) {
  if (rootWithoutConfigurationDone)
    return fail(send, message, "root never advertised configurationDone");
  respond(send, message);
  if (script !== "thread-collision") return;
  send({
    type: "request",
    command: "startDebugging",
    arguments: { request: "launch", configuration: { name: "thread child" } },
  });
}

/** @param {Send} send @param {FixtureRequest} message */
function handleRootContinue(send, message) {
  respond(send, message, { allThreadsContinued: true });
  if (script === "thread-collision") {
    event(send, "continued", { allThreadsContinued: true, threadId: 1 });
  }
}

/** @param {FixtureMessage} message @param {Send} send */
function handleTargetMessage(message, send) {
  if (message.type === "response") return handleTargetResponse(message);
  if (message.command === "initialize") return handleTargetInitialize(message, send);
  if (message.command === "configurationDone") return configureTarget(send, message);
  if (message.command === "launch" || message.command === "attach") {
    if (script === "fail-primary-launch") return fail(send, message, "target launch exploded");
    if (script === "fail-child-launch") return fail(send, message, "child launch exploded");
  }
  if (message.command === process.env.FAKE_TARGET_REFUSE) {
    return fail(send, message, `target refused ${message.command}`);
  }
  if (message.command === "setBreakpoints") return respondTargetBreakpoints(send, message);
  targetRequest(send, message, "primary");
}

/** @param {Send} send @param {FixtureRequest} message */
function configureTarget(send, message) {
  if (script !== "thread-collision") return configurePromotedTarget(send, message);
  respond(send, message);
  // Same adapter thread id as the root channel: Pi must still tell the two apart.
  event(send, "stopped", { reason: "breakpoint", threadId: 1 });
}

/** @param {FixtureMessage} message */
function handleTargetResponse(message) {
  if (message.command === "diagnosticBarrier") lateOutputBarrier();
}

/** @param {FixtureRequest} message @param {Send} send */
function handleTargetInitialize(message, send) {
  respond(send, message, {
    supportsConfigurationDoneRequest: true,
    ...terminateCapability("target"),
  });
  if (rootWithoutConfigurationDone) setTimeout(() => pendingRootBreakpoints?.(), 100);
  record({
    event: "initialize",
    role: "target",
    adapterID: message.arguments?.adapterID,
    supportsStartDebuggingRequest: message.arguments?.supportsStartDebuggingRequest,
  });
  if (script === "fail-primary-launch" || script === "fail-child-launch") return;
  event(send, "initialized");
}

/** @param {Send} send @param {FixtureRequest} message */
function respondTargetBreakpoints(send, message) {
  const count = breakpointCount(message);
  const verified = childNames.length > 0 || script === "generic-child";
  const breakpoints = Array.from({ length: count }, (_, index) => ({ id: index + 1, verified }));
  respond(send, message, { breakpoints: verified ? breakpoints : [] });
}

/** @param {FixtureMessage} message @param {Send} send @param {string} name @param {number} idBase */
function handleChildMessage(message, send, name, idBase) {
  if (message.type === "response") return;
  if (message.command === "initialize") {
    respond(send, message, { supportsConfigurationDoneRequest: true });
    record({
      event: "initialize",
      role: "child",
      name,
      adapterID: message.arguments?.adapterID,
      supportsStartDebuggingRequest: message.arguments?.supportsStartDebuggingRequest,
    });
    event(send, "initialized");
    return;
  }
  if (message.command === process.env.FAKE_CHILD_REFUSE) {
    return fail(send, message, `child refused ${message.command}`);
  }
  if (message.command === "setBreakpoints") return respondChildBreakpoints(send, message, idBase);
  if (message.command === "configurationDone") return configureChild(send, message, idBase);
  if (message.command === "continue") return continueChild(send, message);
  if (message.command === "disconnect") return disconnectChild(send, message, name);
  childRequest(send, message, name);
}

let childEndCount = 0;

/** @param {Send} send @param {FixtureRequest} message @param {string} name */
function childRequest(send, message, name) {
  // The child ends while its answer to the FAKE_CHILD_END_AT-th such request is in flight.
  if (
    message.command === process.env.FAKE_CHILD_END_ON &&
    ++childEndCount === Number(process.env.FAKE_CHILD_END_AT)
  )
    event(send, "terminated");
  targetRequest(send, message, name);
}

/** @param {Send} send @param {FixtureRequest} message @param {string} name */
function disconnectChild(send, message, name) {
  if (script === "child-late-output" && !lateOutputSent) {
    pendingLateDisconnect = { send, message };
    return;
  }
  if (script === "child-detaching") {
    // Leave detach pending while a late stop arrives on the same channel.
    event(send, "stopped", { reason: "breakpoint", threadId: 1 });
    return;
  }
  targetRequest(send, message, name);
}

/** @param {Send} send @param {FixtureRequest} message @param {number} idBase */
function respondChildBreakpoints(send, message, idBase) {
  record({ event: "setBreakpoints", role: "child" });
  const count = breakpointCount(message);
  respond(send, message, {
    breakpoints: Array.from({ length: count }, (_, index) => ({
      id: idBase + index,
      verified: true,
    })),
  });
}

const server = createServer((socket) => {
  if (root === undefined) {
    root = channel(socket, handleRootMessage);
    record({ event: "connect", role: "root" });
    return;
  }
  if (target === undefined) {
    target = channel(socket, handleTargetMessage);
    record({ event: "connect", role: "target" });
    return;
  }
  const name = pendingChildNames.shift() ?? "unexpected";
  const idBase = (childNames.indexOf(name) + 1) * 100;
  channel(socket, (message, send) => handleChildMessage(message, send, name, idBase));
  record({ event: "connect", role: "child", name });
});

if (script === "listen-gate") {
  const pidPath = process.env.FAKE_JS_DEBUG_PID_PATH;
  const gatePath = process.env.FAKE_JS_DEBUG_LISTEN_GATE;
  if (pidPath === undefined || gatePath === undefined) {
    throw new Error("listen-gate needs FAKE_JS_DEBUG_PID_PATH and FAKE_JS_DEBUG_LISTEN_GATE");
  }
  await writeFile(pidPath, String(process.pid));
  while (!existsSync(gatePath)) await delay(10);
}

server.listen(port, "127.0.0.1");

/** @type {Send | undefined} */
let lateOutputChild;
let lateOutputBarriers = 2;
let lateOutputSent = false;
/** @type {{send: Send, message: FixtureRequest} | undefined} */
let pendingLateDisconnect;
/** @param {Send} send @param {FixtureRequest} message */
function continueLateOutputChild(send, message) {
  if (root === undefined || target === undefined) throw new Error("Missing parent channels");
  lateOutputChild = send;
  respond(send, message);
  event(send, "continued", { threadId: 1 });
  event(target, "output", { category: "stdout", output: "worker exited 0\n" });
  lateOutputParentEnd(target, "target");
  target({ type: "request", command: "diagnosticBarrier" });
  lateOutputParentEnd(root, "root");
  root({ type: "request", command: "diagnosticBarrier" });
}
/** @param {Send} send @param {"root" | "target"} channelName */
function lateOutputParentEnd(send, channelName) {
  if (process.env.FAKE_CHILD_PARENT_EXITED === channelName) event(send, "exited", { exitCode: 7 });
  else event(send, "terminated");
}

/** @param {Send} send */
function startLateOutputTerminal(send) {
  if (root === undefined) throw new Error("Missing root channel");
  lateOutputChild = send;
  root({
    type: "request",
    command: "runInTerminal",
    arguments: {
      kind: "integrated",
      cwd: process.cwd(),
      args: [
        process.execPath,
        "--input-type=module",
        "-e",
        `import { existsSync } from "node:fs"; import { setTimeout } from "node:timers/promises"; while (!existsSync(${JSON.stringify(process.env.FAKE_TERMINAL_EXIT_GATE)})) await setTimeout(10);`,
      ],
    },
  });
}

async function finishLateOutputAfterTerminal() {
  const exitGate = process.env.FAKE_TERMINAL_EXIT_GATE;
  const drainGate = process.env.FAKE_CHILD_DRAIN_GATE;
  const send = lateOutputChild;
  if (exitGate === undefined || drainGate === undefined || send === undefined)
    throw new Error("Missing terminal exit gates or child channel");
  await writeFile(exitGate, "release terminal after standard exited");
  while (!existsSync(drainGate)) await delay(10);
  event(send, "terminated");
}

// Each reply proves its channel's earlier terminal event reached the client before worker output.
function lateOutputBarrier() {
  if (--lateOutputBarriers !== 0) return;
  if (lateOutputChild === undefined) throw new Error("Missing child channel");
  event(lateOutputChild, "output", { category: "stdout", output: "worker value 1\n" });
  record({ event: "child-output" });
  if (process.env.FAKE_TERMINAL_EXIT_GATE !== undefined) void finishLateOutputAfterTerminal();
  else if (process.env.FAKE_CHILD_END === "failure")
    event(lateOutputChild, "output", { output: 42 });
  else if (process.env.FAKE_CHILD_END !== "never") event(lateOutputChild, "terminated");
  lateOutputSent = true;
  if (pendingLateDisconnect !== undefined)
    respond(pendingLateDisconnect.send, pendingLateDisconnect.message);
}
