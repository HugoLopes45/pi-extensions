import { appendFileSync, writeFileSync } from "node:fs";

import { Type } from "typebox";

import { fixtureMessageSchema, parseFixtureMessage } from "./protocol.mjs";

const argumentsSchema = Type.Object({
  requestStartDebugging: Type.Optional(Type.Boolean()),
  runInTerminalArgs: Type.Optional(Type.Array(Type.String())),
  runInTerminalOnTeardown: Type.Optional(
    Type.Object({
      args: Type.Array(Type.String()),
      replyPath: Type.Optional(Type.String()),
    }),
  ),
  delayInitializedMs: Type.Optional(Type.Number()),
  source: Type.Optional(Type.Object({ path: Type.Optional(Type.String()) })),
  breakpoints: Type.Optional(
    Type.Array(Type.Object({ line: Type.Number(), condition: Type.Optional(Type.String()) })),
  ),
  requireBreakpoint: Type.Optional(Type.Boolean()),
  outputCategories: Type.Optional(Type.Boolean()),
  startDebuggingChild: Type.Optional(Type.Boolean()),
  stopOnEntry: Type.Optional(Type.Boolean()),
  program: Type.Optional(Type.String()),
  startFrame: Type.Optional(Type.Number()),
  levels: Type.Optional(Type.Number()),
  variablesReference: Type.Optional(Type.Number()),
  start: Type.Optional(Type.Number()),
  count: Type.Optional(Type.Number()),
  crashOnContinue: Type.Optional(Type.Boolean()),
  crashOnTerminate: Type.Optional(Type.Boolean()),
  exitOnContinue: Type.Optional(Type.Boolean()),
  neverStop: Type.Optional(Type.Boolean()),
  refuseContinue: Type.Optional(Type.Boolean()),
  continueBeforeRefusal: Type.Optional(Type.Boolean()),
  expression: Type.Optional(Type.String()),
  launchError: Type.Optional(Type.String()),
  reportInitializeArguments: Type.Optional(Type.Boolean()),
});
const messageSchema = fixtureMessageSchema(argumentsSchema);
/** @typedef {import("typebox").Static<typeof messageSchema>} FixtureMessage */
/** @typedef {Extract<FixtureMessage, {type: "request"}>} FixtureRequest */
/** @typedef {Extract<FixtureMessage, {type: "response"}>} FixtureResponse */

let buffer = Buffer.alloc(0);
let nextSequence = 1;
const zeroSequence = process.env.FAKE_ZERO_SEQUENCE === "1";
/** @type {FixtureRequest | undefined} */
let pendingLaunch;
/** @type {import("typebox").Static<typeof argumentsSchema>} */
let launchArguments = {};
/** @type {Record<string, unknown>} */
let initializeArguments = {};
/** @type {Map<string, import("@vscode/debugprotocol").DebugProtocol.SourceBreakpoint[]>} */
const desiredBreakpoints = new Map();
/** @type {number | undefined} */
let reverseRequestSequence;

/**
 * @param {Record<string, unknown>} message
 */
function send(message) {
  const seq = zeroSequence ? 0 : nextSequence++;
  const body = Buffer.from(JSON.stringify({ seq, ...message }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

/**
 * @param {FixtureRequest} request
 * @param {unknown} [body]
 */
function respond(request, body) {
  /** @type {Omit<import("@vscode/debugprotocol").DebugProtocol.Response, "seq">} */
  const response = {
    type: "response",
    request_seq: request.seq,
    success: true,
    command: request.command,
  };
  if (body !== undefined) response.body = body;
  send(response);
}

/**
 * @param {FixtureRequest} request
 * @param {string} message
 */
function fail(request, message) {
  send({
    type: "response",
    request_seq: request.seq,
    success: false,
    command: request.command,
    message,
  });
}

/**
 * @param {string} event
 * @param {unknown} [body]
 */
function event(event, body) {
  /** @type {Omit<import("@vscode/debugprotocol").DebugProtocol.Event, "seq">} */
  const message = { type: "event", event };
  if (body !== undefined) message.body = body;
  send(message);
}

function stopped(reason = "breakpoint") {
  const hit =
    reason === "breakpoint"
      ? { description: "Paused on breakpoint", hitBreakpointIds: [7] }
      : { description: "Paused on " + reason };
  const description =
    launchArguments.reportInitializeArguments === true
      ? `initialize adapterID=${String(initializeArguments.adapterID)} supportsStartDebuggingRequest=${String(initializeArguments.supportsStartDebuggingRequest)}`
      : hit.description;
  event("stopped", {
    reason,
    threadId: 1,
    allThreadsStopped: true,
    description,
    ...(reason === "breakpoint" ? { hitBreakpointIds: [7] } : {}),
  });
}

/**
 * @param {FixtureRequest} request
 * @param {string} reason
 */
function executeAndStop(request, reason) {
  respond(request, { allThreadsContinued: true });
  event("continued", { threadId: 1, allThreadsContinued: true });
  setTimeout(() => stopped(reason), 5);
}

/**
 * @param {FixtureResponse} message
 */
function handleReverseResponse(message) {
  if (message.request_seq !== reverseRequestSequence) return;
  reverseRequestSequence = undefined;
  if (pendingLaunch === undefined) {
    const replyPath = launchArguments.runInTerminalOnTeardown?.replyPath;
    if (replyPath === undefined) throw new Error("fixture reverse response has no pending request");
    writeFileSync(
      replyPath,
      JSON.stringify({ success: message.success, message: message.message ?? "" }),
    );
    return;
  }
  if (launchArguments.requestStartDebugging === true) {
    if (message.success) {
      fail(pendingLaunch, "startDebugging unexpectedly succeeded");
    } else {
      fail(pendingLaunch, "startDebugging rejected");
    }
    pendingLaunch = undefined;
    return;
  }
  if (!message.success) {
    fail(pendingLaunch, "runInTerminal rejected");
    pendingLaunch = undefined;
  }
}

/**
 * @param {FixtureRequest} request
 */
function launch(request) {
  pendingLaunch = request;
  launchArguments = request.arguments ?? {};
  if (launchArguments.launchError !== undefined) {
    fail(request, launchArguments.launchError);
    return;
  }
  if (launchArguments.requestStartDebugging === true) {
    reverseRequestSequence = nextSequence;
    send({
      type: "request",
      command: "startDebugging",
      arguments: {
        request: "launch",
        configuration: { type: "pwa-node", name: "child [1]", __pendingTargetId: "child-1" },
      },
    });
  } else if (Array.isArray(launchArguments.runInTerminalArgs)) {
    reverseRequestSequence = nextSequence;
    send({
      type: "request",
      command: "runInTerminal",
      arguments: {
        kind: "integrated",
        cwd: process.cwd(),
        args: launchArguments.runInTerminalArgs,
        env: {},
        argsCanBeInterpretedByShell: false,
      },
    });
  }
  if (Number.isInteger(launchArguments.delayInitializedMs)) {
    setTimeout(() => event("initialized"), launchArguments.delayInitializedMs);
  } else {
    event("initialized");
  }
}

/**
 * @param {FixtureRequest} request
 */
function setBreakpoints(request) {
  const sourcePath = request.arguments?.source?.path ?? "";
  const requested = request.arguments?.breakpoints ?? [];
  if (requested.some((breakpoint) => breakpoint.condition === "fail")) {
    fail(request, "breakpoint rejected");
    return;
  }
  desiredBreakpoints.set(sourcePath, requested);
  respond(request, {
    breakpoints: requested.map((breakpoint, index) => ({
      id: index + 1,
      verified: true,
      line: breakpoint.line,
      source: { path: sourcePath },
    })),
  });
}

/**
 * @param {FixtureRequest} request
 */
function configurationDone(request) {
  if (launchArguments.requireBreakpoint === true && desiredBreakpoints.size === 0) {
    fail(request, "configurationDone arrived before breakpoints");
    return;
  }
  respond(request);
  if (pendingLaunch !== undefined) {
    respond(pendingLaunch);
    pendingLaunch = undefined;
    if (launchArguments.outputCategories === true) {
      event("output", { category: "telemetry", output: "js-debug/dap/operation" });
      event("output", { category: "stderr", output: "warned\n" });
      event("output", { category: "console", output: "console\n" });
      event("output", { category: "important", output: "important\n" });
      event("output", { output: "uncategorized\n" });
    }
    event("output", { category: "stdout", output: "launched\n" });
    if (launchArguments.startDebuggingChild === true) {
      // A worker the Debuggee started; the launch carries on whatever the reply.
      send({
        type: "request",
        command: "startDebugging",
        arguments: {
          request: "launch",
          configuration: { type: "pwa-node", name: "[worker 1]", __pendingTargetId: "w-1" },
        },
      });
    }
    if (launchArguments.stopOnEntry !== false) setTimeout(() => stopped("entry"), 5);
  }
}

/**
 * @param {FixtureRequest} request
 */
function stackTrace(request) {
  const frames = [
    {
      id: 10,
      name: "main",
      line: 4,
      column: 1,
      source: {
        name: "program.ts",
        path: launchArguments.program ?? "program.ts",
      },
    },
    { id: 11, name: "caller", line: 1, column: 1 },
  ];
  const start = request.arguments?.startFrame ?? 0;
  const levels = request.arguments?.levels ?? frames.length;
  respond(request, {
    stackFrames: frames.slice(start, start + levels),
    totalFrames: frames.length,
  });
}

/**
 * @param {FixtureRequest} request
 */
function variables(request) {
  if (request.arguments?.variablesReference === 30) {
    respond(request, {
      variables: [{ name: "globalThis", value: "Window", variablesReference: 0 }],
    });
    return;
  }
  const all = [
    {
      name: "answer",
      value: "42",
      variablesReference: 0,
      type: "number",
    },
    { name: "nested", value: "Object", variablesReference: 21 },
  ];
  // DAP: an adapter honors start and count only for a client that advertised variable paging.
  const start = request.arguments?.start ?? 0;
  respond(request, {
    variables:
      initializeArguments.supportsVariablePaging === true
        ? all.slice(start, start + (request.arguments?.count ?? all.length))
        : all,
  });
}

/**
 * @param {FixtureRequest} request
 */
function continueExecution(request) {
  if (launchArguments.refuseContinue === true) {
    if (launchArguments.continueBeforeRefusal === true) event("continued", { threadId: 1 });
    fail(request, "fixture refused continue");
    return;
  }
  respond(request, { allThreadsContinued: true });
  event("continued", { threadId: 1, allThreadsContinued: true });
  if (launchArguments.crashOnContinue === true) {
    process.stderr.write("fake adapter crash\n", () => process.exit(17));
  } else if (launchArguments.exitOnContinue === true) {
    setTimeout(() => {
      event("output", { category: "stdout", output: "finished\n" });
      event("exited", { exitCode: 0 });
      event("terminated");
    }, 5);
  } else if (launchArguments.neverStop !== true) {
    setTimeout(() => stopped("breakpoint"), 5);
  }
}

/**
 * A runInTerminal the fixture sends while HL DAP is already tearing the Debug Session down.
 */
function sendTeardownRunInTerminal() {
  const teardown = launchArguments.runInTerminalOnTeardown;
  if (teardown === undefined || reverseRequestSequence !== undefined) return;
  reverseRequestSequence = nextSequence;
  send({
    type: "request",
    command: "runInTerminal",
    arguments: {
      kind: "integrated",
      cwd: process.cwd(),
      args: teardown.args,
      env: {},
      argsCanBeInterpretedByShell: false,
    },
  });
}

/**
 * @param {FixtureRequest} request
 * @param {string} command
 */
function handleExecution(request, command) {
  switch (command) {
    case "continue":
      continueExecution(request);
      return;
    case "next":
      executeAndStop(request, "step");
      return;
    case "stepIn":
      executeAndStop(request, "step");
      return;
    case "stepOut":
      executeAndStop(request, "step");
      return;
    case "pause":
      respond(request);
      setTimeout(() => stopped("pause"), 5);
      return;
    case "terminate":
      if (launchArguments.crashOnTerminate === true) {
        process.stderr.write("fake adapter shutdown crash\n", () => process.exit(19));
      } else {
        sendTeardownRunInTerminal();
        respond(request);
        event("terminated");
      }
      return;
    case "disconnect":
      respond(request);
      setTimeout(() => process.exit(0), 5);
      return;
    default:
      fail(request, `unsupported ${request.command}`);
  }
}

/**
 * @param {FixtureRequest} request
 * @param {string} command
 */
function handleInspectionOrExecution(request, command) {
  switch (command) {
    case "threads":
      respond(request, { threads: [{ id: 1, name: "main" }] });
      return;
    case "stackTrace":
      stackTrace(request);
      return;
    case "scopes":
      respond(request, {
        scopes: [
          { name: "Local", variablesReference: 20, expensive: false },
          { name: "Global", variablesReference: 30, expensive: true },
        ],
      });
      return;
    case "variables":
      variables(request);
      return;
    case "evaluate":
      respond(request, {
        result: request.arguments?.expression ?? "",
        variablesReference: 0,
      });
      return;
    default:
      handleExecution(request, command);
  }
}

/**
 * Advertise terminate support unless the test asks for an adapter that omits or denies it.
 */
function terminateCapability() {
  switch (process.env.FAKE_TERMINATE_CAPABILITY) {
    case "absent":
      return {};
    case "false":
      return { supportsTerminateRequest: false };
    default:
      return { supportsTerminateRequest: true };
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
 * @param {FixtureRequest} request
 */
function handleRequest(request) {
  logRequest(request);
  const command = request.command;
  switch (command) {
    case "initialize":
      initializeArguments = request.arguments ?? {};
      respond(request, {
        supportsConfigurationDoneRequest: true,
        ...terminateCapability(),
      });
      return;
    case "launch":
      launch(request);
      return;
    case "setBreakpoints":
      setBreakpoints(request);
      return;
    case "configurationDone":
      configurationDone(request);
      return;
    default:
      handleInspectionOrExecution(request, command);
  }
}

/**
 * @param {Buffer} chunk
 */
function parseFrames(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const length = Number(/^Content-Length: (\d+)$/im.exec(header)?.[1]);
    if (!Number.isSafeInteger(length) || buffer.length < headerEnd + 4 + length) return;
    const bodyStart = headerEnd + 4;
    const message = parseFixtureMessage(
      messageSchema,
      buffer.subarray(bodyStart, bodyStart + length).toString("utf8"),
    );
    buffer = buffer.subarray(bodyStart + length);
    if (message.type === "request") handleRequest(message);
    if (message.type === "response") handleReverseResponse(message);
  }
}

process.stdin.on("data", parseFrames);
process.stdin.on("end", () => process.exit(0));

// Keep stderr non-empty so failures can point to a useful retained log.
process.stderr.write("fake DAP session adapter started\n");
