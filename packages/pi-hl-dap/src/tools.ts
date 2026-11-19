import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  defineTool,
  type AgentToolUpdateCallback,
  type Theme,
  type ToolAnnotations,
  type ToolDefinition,
  type ToolRenderResultOptions,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { errorText } from "pi-hl-utils/errors";
import { watchSteering } from "pi-hl-utils/steering";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { DapConnectionError } from "./adapter.js";
import type { DapArtifacts } from "./artifacts.js";
import {
  DapError,
  type DapEvaluateInput,
  type DapLaunchInput,
  type DapController,
  type DapResult,
  type DapSnapshot,
  type DapStackInput,
  type DapVariablesInput,
} from "./controller.js";
import { renderCall, renderResult, type DapResultRenderContext } from "./rendering.js";
import {
  DapEvaluateParametersSchema,
  DapLaunchParametersSchema,
  DapNoParametersSchema,
  DapSetBreakpointsParametersSchema,
  DapStackParametersSchema,
  DapToolOutputSchemas,
  DapVariablesParametersSchema,
  DapVariablesStrictParametersSchema,
  type DapOperation,
  type DapToolParameters,
  type DapToolRenderDetails,
} from "./schemas.js";
import { isDapExecutionWaitOperation, oneLine, type DapExecutionWaitEnd } from "./text.js";
import { createDapToolOutput, stateFailureResult, type DapToolResult } from "./tool-output.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting.js";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type DapToolController = Pick<
  DapController,
  | "launch"
  | "setBreakpoints"
  | "continue"
  | "next"
  | "stepIn"
  | "stepOut"
  | "pause"
  | "stack"
  | "variables"
  | "evaluate"
  | "status"
  | "stop"
  | "snapshot"
>;

/** Session-scoped resources resolved at execution time so Pi reloads replace settings safely. */
export interface DapToolRuntime {
  /** Active Debug Session owner for this Pi conversation session. */
  readonly controller: DapToolController;
  /** Private Result Spill storage owned by the same Pi conversation session. */
  readonly artifacts: DapArtifacts;
  /** Non-authoritative Observer UI hooks for tool presentation context. */
  readonly observer?: DapToolObserver;
}

/** Narrow Observer UI dependency that cannot dispatch Debug Adapter requests. */
export interface DapToolObserver {
  /** Record explicit tool arguments before execution begins. */
  onToolStart(parameters: DapToolParameters): void;
  /** Record one successful operation and its already-returned Debug Session result. */
  onToolSuccess(parameters: DapToolParameters, result: DapResult): void;
  /** Record one failed operation without changing its error. */
  onToolFailure(parameters: DapToolParameters, error: Error): void;
}

/**
 * Namespace shared by every DAP tool; codemode lists the tools under it. `instructions` exists only
 * in Pi 1.0.0's `ToolNamespace`: there, codemode's `describeNamespace()` returns it and `tool_search`
 * ranks with it. The object is deliberately untyped so it also type-checks against 0.99.0, whose
 * `ToolNamespace` lacks the field and would reject it as an excess property in a typed literal.
 */
export const DAP_TOOL_NAMESPACE = {
  name: "hl_dap",
  description:
    "Debug one program through one configured Debug Session (Debug Adapter Protocol): breakpoints, execution control, and stopped-state inspection.",
  instructions: [
    "Every hl_dap_* tool acts on the same single Debug Session of this Pi session. hl_dap_launch fails while one is active; hl_dap_stop ends it.",
    "Relative paths resolve from Pi's project directory.",
    "Desired Breakpoints set with hl_dap_set_breakpoints apply to the active Debug Session and to every later launch.",
    "hl_dap_launch, hl_dap_continue, hl_dap_next, hl_dap_step_in, and hl_dap_step_out wait until the Debuggee stops, exits, the execution timeout passes, or a steer message is queued for this session; after a timeout or such a steer yield the state is running (execution_wait_steered is true for a yield), so use hl_dap_status, hl_dap_pause, or hl_dap_stop.",
    "hl_dap_stack, hl_dap_variables, and hl_dap_evaluate need a stopped Debuggee. Stack Frame ids from hl_dap_stack feed hl_dap_variables and hl_dap_evaluate; a non-zero variables_reference lists child values with hl_dap_variables, and hl_dap_variables with frame_id lists expensive scopes such as Global without expanding them.",
    "Each successful call drains unread Debuggee output. Text results are limited to 2,000 lines or 50 KB and save the complete result as a Result Spill when storage succeeds; script results carry complete data (a frame's expensive scopes stay unexpanded).",
    "A call that fails because of the Debug Session state returns the current state with an error field instead of throwing.",
    "With an adapter that declares Debug targets, worker threads and child processes are Child sessions of the same Debug Session. One stop is reported at a time, and hl_dap_stack, hl_dap_variables, hl_dap_evaluate, hl_dap_continue, and the step tools act on the target that stopped; when another target is already stopped, they report its stop at once. hl_dap_pause pauses every target.",
  ].join("\n"),
};

const DAP_PROMPT_GUIDELINE =
  "Use the hl_dap_* tools to set source breakpoints, launch one configured Debug Session, control the Debuggee, and inspect stopped Stack Frames and variables. Relative paths resolve from the project directory.";

/** The most aggregated failure causes a tool failure message lists. */
const MAX_FAILURE_CAUSES = 5;

/** The leaf failures of the first AggregateError in a cause chain, flattened, each once. */
function aggregatedCauses(failure: unknown): readonly unknown[] {
  // Cause chains can be cyclic: visit each error once, without recursion.
  const seen = new Set<unknown>([failure]);
  let current = failure;
  while (current instanceof Error && !(current instanceof AggregateError)) {
    current = current.cause;
    if (seen.has(current)) return [];
    seen.add(current);
  }
  if (!(current instanceof AggregateError)) return [];
  const leaves: unknown[] = [];
  const errors: readonly unknown[] = current.errors;
  const pending = [...errors];
  while (pending.length > 0) {
    const error = pending.shift();
    if (seen.has(error)) continue;
    seen.add(error);
    if (error instanceof AggregateError) {
      const nested: readonly unknown[] = error.errors;
      pending.unshift(...nested);
    } else {
      leaves.push(error);
    }
  }
  return leaves;
}

/** A failure message that names the individual causes of an aggregate cleanup failure. */
function failureText(cause: unknown): string {
  const message = errorText(cause);
  const causes = aggregatedCauses(cause).map((error) => oneLine(errorText(error)));
  if (causes.length === 0) return message;
  const listed = causes.slice(0, MAX_FAILURE_CAUSES);
  if (causes.length > MAX_FAILURE_CAUSES) {
    listed.push(`and ${causes.length - MAX_FAILURE_CAUSES} more`);
  }
  return `${message}; causes: ${listed.join("; ")}`;
}

function dapError(cause: unknown): Error {
  const message = failureText(cause);
  return new Error(message.startsWith("HL DAP:") ? message : `HL DAP: ${message}`, { cause });
}

function isCancelledProtocolError(cause: unknown): boolean {
  return cause instanceof DapConnectionError && cause.kind === "cancelled";
}

/** Configuration, adapter, protocol, and timeout failures are diagnosed by the Skill; state errors and adapter-rejected requests are not. */
function needsTroubleshootingHint(cause: unknown): boolean {
  if (cause instanceof DapError) {
    return cause.kind !== "state" && !isCancelledProtocolError(cause.cause);
  }
  return (
    cause instanceof DapConnectionError && cause.kind !== "cancelled" && cause.kind !== "request"
  );
}

/** Strict ingress parser for one tool's arguments, run before permission hooks and again at execution. */
function dapArgumentsParser<TParameters extends TSchema>(schema: TParameters) {
  return (input: unknown): Static<TParameters> => {
    if (Value.Check(schema, input)) return Value.Parse(schema, input);
    const [first] = Value.Errors(schema, input);
    const location = first?.instancePath ? first.instancePath : "arguments";
    // A `false` schema is how a strict object rejects an unknown property.
    const reason =
      first === undefined
        ? "arguments do not match the tool's schema"
        : `${location} ${first.keyword === "boolean" ? "is not allowed" : first.message}`;
    throw dapError(`invalid tool arguments: ${reason}`);
  };
}

/** A Desired Breakpoint can precede its source file, but it cannot bind until a file exists. */
async function sourceFileWarnings(filePath: string): Promise<readonly string[]> {
  try {
    if ((await stat(filePath)).isFile()) return [];
    return [`not a file: ${filePath}; breakpoints will not bind`];
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "unknown";
    return code === "ENOENT"
      ? [`file not found: ${filePath}; breakpoints will not bind until it exists`]
      : [`could not check ${filePath}: ${code}`];
  }
}

interface DapDispatch {
  readonly result: DapResult;
  readonly warnings: readonly string[];
}

async function dispatchDapOperation(
  parameters: DapToolParameters,
  session: DapToolController,
  cwd: string,
  signal: AbortSignal | undefined,
  steerSignal: AbortSignal | undefined,
): Promise<DapDispatch> {
  if (parameters.operation !== "set_breakpoints") {
    return {
      result: await dispatchSessionOperation(parameters, session, cwd, signal, steerSignal),
      warnings: [],
    };
  }
  const filePath = resolve(cwd, parameters.file_path);
  const result = await session.setBreakpoints(
    { filePath, breakpoints: parameters.breakpoints },
    signal,
  );
  const warnings = parameters.breakpoints.length === 0 ? [] : await sourceFileWarnings(filePath);
  return { result, warnings };
}

function launchInput(
  parameters: Extract<DapToolParameters, { readonly operation: "launch" }>,
  cwd: string,
): DapLaunchInput {
  const input: Mutable<DapLaunchInput> = {};
  if (parameters.profile !== undefined) input.profile = parameters.profile;
  if (parameters.program !== undefined) input.program = resolve(cwd, parameters.program);
  if (parameters.args !== undefined) input.args = parameters.args;
  if (parameters.cwd !== undefined) input.cwd = resolve(cwd, parameters.cwd);
  if (parameters.launch_arguments !== undefined) {
    input.launchArguments = parameters.launch_arguments;
  }
  return input;
}

function stackInput(
  parameters: Extract<DapToolParameters, { readonly operation: "stack" }>,
): DapStackInput {
  const input: Mutable<DapStackInput> = {};
  if (parameters.thread_id !== undefined) input.threadId = parameters.thread_id;
  if (parameters.start !== undefined) input.start = parameters.start;
  if (parameters.count !== undefined) input.count = parameters.count;
  return input;
}

function variablesInput(
  parameters: Extract<DapToolParameters, { readonly operation: "variables" }>,
): DapVariablesInput {
  const page: Mutable<Pick<DapVariablesInput, "start" | "count">> = {};
  if (parameters.start !== undefined) page.start = parameters.start;
  if (parameters.count !== undefined) page.count = parameters.count;
  return "frame_id" in parameters
    ? { ...page, frameId: parameters.frame_id }
    : { ...page, variablesReference: parameters.variables_reference };
}

async function dispatchExecutionOperation(
  parameters: Extract<
    DapToolParameters,
    {
      readonly operation: "continue" | "next" | "step_in" | "step_out" | "pause";
    }
  >,
  session: DapToolController,
  signal: AbortSignal | undefined,
  steerSignal: AbortSignal | undefined,
): Promise<DapResult> {
  switch (parameters.operation) {
    case "continue":
      return session.continue(signal, steerSignal);
    case "next":
      return session.next(signal, steerSignal);
    case "step_in":
      return session.stepIn(signal, steerSignal);
    case "step_out":
      return session.stepOut(signal, steerSignal);
    case "pause":
      return session.pause(signal);
  }
}

async function dispatchSessionOperation(
  parameters: Exclude<DapToolParameters, { readonly operation: "set_breakpoints" }>,
  session: DapToolController,
  cwd: string,
  signal: AbortSignal | undefined,
  steerSignal: AbortSignal | undefined,
): Promise<DapResult> {
  switch (parameters.operation) {
    case "launch":
      return session.launch(launchInput(parameters, cwd), signal, steerSignal);
    case "stack":
      return session.stack(stackInput(parameters), signal);
    case "variables":
      return session.variables(variablesInput(parameters), signal);
    case "evaluate": {
      const input: Mutable<DapEvaluateInput> = {
        expression: parameters.expression,
      };
      if (parameters.frame_id !== undefined) input.frameId = parameters.frame_id;
      return session.evaluate(input, signal);
    }
    case "status":
      return session.status();
    case "stop":
      return session.stop();
    default:
      return dispatchExecutionOperation(parameters, session, signal, steerSignal);
  }
}

function notifyDapToolObserver(operation: () => void): void {
  try {
    operation();
  } catch {
    // Observer UI failures cannot change model-facing Debug Session behavior.
  }
}

/** How an execution wait that returned without the Debuggee stopping or exiting was cut short. */
function executionWaitEnd(
  waits: boolean,
  signal: AbortSignal | undefined,
  steerSignal: AbortSignal | undefined,
  state: DapSnapshot["state"],
): DapExecutionWaitEnd | undefined {
  if (waits && signal?.aborted === true && state === "running") return "cancelled";
  // A Steer Yield leaves the Debuggee running; a stop or exit that raced it is reported as itself.
  if (steerSignal?.aborted === true && state === "running") return "steered";
  return undefined;
}

function dapOperationFailure(
  cause: unknown,
  error: Error,
  session: DapToolController,
): DapToolResult {
  if (cause instanceof DapError && cause.kind === "state") {
    return stateFailureResult(error, session.snapshot());
  }
  throw needsTroubleshootingHint(cause)
    ? new Error(`${error.message}\n\n${TROUBLESHOOTING_HINT}`, { cause })
    : error;
}

async function executeDapOperation(
  parameters: DapToolParameters,
  runtime: DapToolRuntime | undefined,
  context: ExtensionToolContext,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<DapToolRenderDetails | undefined> | undefined,
): Promise<DapToolResult> {
  if (runtime === undefined) throw dapError("Pi conversation session is not active");
  notifyDapToolObserver(() => runtime.observer?.onToolStart(parameters));
  const operation = parameters.operation;
  const cwd = context.cwd;
  const waits = isDapExecutionWaitOperation(operation);
  // hl_dap_pause only confirms the stop it requested, so it never yields: a Steer Yield there would
  // report a Debuggee as running moments before it stops.
  const steerWatch = waits ? watchSteering(context.sessionManager.getSessionId()) : undefined;
  const startedAt = Date.now();
  const updateProgress = () => {
    if (!isDapExecutionWaitOperation(operation)) return;
    onUpdate?.({
      content: [{ type: "text", text: `${operation} waiting` }],
      details: {
        kind: "progress",
        operation,
        elapsed_ms: Date.now() - startedAt,
      },
    });
  };
  updateProgress();
  const progressInterval = waits ? setInterval(updateProgress, 1_000) : undefined;
  progressInterval?.unref?.();
  try {
    const { result, warnings } = await dispatchDapOperation(
      parameters,
      runtime.controller,
      cwd,
      signal,
      steerWatch?.signal,
    );
    const output = await createDapToolOutput(
      operation,
      result,
      runtime.artifacts,
      cwd,
      executionWaitEnd(waits, signal, steerWatch?.signal, result.snapshot.state),
      warnings,
    );
    notifyDapToolObserver(() => runtime.observer?.onToolSuccess(parameters, result));
    return output;
  } catch (cause) {
    const error = dapError(cause);
    notifyDapToolObserver(() => runtime.observer?.onToolFailure(parameters, error));
    return dapOperationFailure(cause, error, runtime.controller);
  } finally {
    clearInterval(progressInterval);
    steerWatch?.dispose();
  }
}

type DapToolDefinition<TParameters extends TSchema> = ToolDefinition<
  TParameters,
  DapToolRenderDetails | undefined
>;

/** Fields every DAP tool shares: naming, namespace, typed script result, ordering, and rendering. */
function dapToolCommon(operation: DapOperation, label: string) {
  return {
    name: `hl_dap_${operation}`,
    label,
    promptGuidelines: [DAP_PROMPT_GUIDELINE],
    outputSchema: DapToolOutputSchemas[operation],
    namespace: DAP_TOOL_NAMESPACE,
    // Every tool acts on the one Debug Session, so batched calls must keep their order.
    executionMode: "sequential" as const,
    renderResult: (
      result: DapToolResult,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: DapResultRenderContext,
    ) => renderResult(operation, result, options, theme, context),
  };
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Runs Debuggee code, whose side effects reach beyond HL DAP: launching, resuming, or evaluating. */
const RUNS_DEBUGGEE_CODE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const EXECUTION_WAIT =
  "and wait until the Debuggee stops, exits, the execution timeout passes, or a steer message is queued for this session (then it is still running; check with hl_dap_status or interrupt it with hl_dap_pause).";
const STATE_FAILURE =
  "A call the Debug Session state does not allow returns an error result with the current `state` and an `error` message.";

type DapNoParametersOperation = Extract<
  DapToolParameters,
  {
    readonly operation: "continue" | "next" | "step_in" | "step_out" | "pause" | "status" | "stop";
  }
>["operation"];

const parseNoParameters = dapArgumentsParser(DapNoParametersSchema);
const parseLaunchParameters = dapArgumentsParser(DapLaunchParametersSchema);
const parseSetBreakpointsParameters = dapArgumentsParser(DapSetBreakpointsParametersSchema);
const parseStackParameters = dapArgumentsParser(DapStackParametersSchema);
const parseVariablesParameters = dapArgumentsParser(DapVariablesStrictParametersSchema);
const parseEvaluateParameters = dapArgumentsParser(DapEvaluateParametersSchema);

function createNoParametersTool(
  operation: DapNoParametersOperation,
  label: string,
  description: string,
  annotations: ToolAnnotations,
  getRuntime: () => DapToolRuntime | undefined,
): DapToolDefinition<typeof DapNoParametersSchema> {
  return defineTool<typeof DapNoParametersSchema, DapToolRenderDetails | undefined>({
    ...dapToolCommon(operation, label),
    description,
    exposure: "direct",
    annotations,
    parameters: DapNoParametersSchema,
    prepareArguments: parseNoParameters,
    renderCall: (_arguments, theme, context) => renderCall({ operation }, theme, context),
    execute: async (_toolCallId, input, signal, onUpdate, context) =>
      executeDapOperation(
        { operation, ...parseNoParameters(input) },
        getRuntime(),
        context,
        signal,
        onUpdate,
      ),
  });
}

/**
 * Create one strict Pi tool per DAP operation, each bound to current session resources. Every
 * tool is `direct`.
 */
export function createDapTools(getRuntime: () => DapToolRuntime | undefined) {
  return [
    defineTool<typeof DapLaunchParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("launch", "DAP launch"),
      description: `Start a Debug Session from a Launch Profile ${EXECUTION_WAIT} The profile may be omitted only when exactly one valid Launch Profile exists; program, args, and cwd replace the profile's arguments, and launch_arguments merges adapter launch arguments over the profile's arguments for this launch (program, args, and cwd still win). With an adapter that declares Debug targets, Child sessions (worker threads and child processes, such as a test runner's workers) are debugged too: breakpoints bind in them, and a stop in one names it in child_session. Fails while a Debug Session is active. ${STATE_FAILURE}`,
      promptSnippet: "Debug a program through one configured Debug Session",
      exposure: "direct",
      annotations: RUNS_DEBUGGEE_CODE,
      parameters: DapLaunchParametersSchema,
      prepareArguments: parseLaunchParameters,
      renderCall: (input, theme, context) =>
        renderCall({ ...input, operation: "launch" }, theme, context),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          { operation: "launch", ...parseLaunchParameters(input) },
          getRuntime(),
          context,
          signal,
          onUpdate,
        ),
    }),
    defineTool<typeof DapSetBreakpointsParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("set_breakpoints", "DAP set breakpoints"),
      description:
        "Replace the Desired Breakpoints of one source file; lines are one-based and [] clears the file. They apply to the active Debug Session and to every later launch. A breakpoint condition runs as Debuggee code.",
      exposure: "direct",
      annotations: { ...RUNS_DEBUGGEE_CODE, idempotentHint: true },
      parameters: DapSetBreakpointsParametersSchema,
      prepareArguments: parseSetBreakpointsParameters,
      renderCall: (input, theme, context) =>
        renderCall({ ...input, operation: "set_breakpoints" }, theme, context),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          {
            operation: "set_breakpoints",
            ...parseSetBreakpointsParameters(input),
          },
          getRuntime(),
          context,
          signal,
          onUpdate,
        ),
    }),
    createNoParametersTool(
      "continue",
      "DAP continue",
      `Resume the stopped Debuggee ${EXECUTION_WAIT} ${STATE_FAILURE}`,
      RUNS_DEBUGGEE_CODE,
      getRuntime,
    ),
    createNoParametersTool(
      "next",
      "DAP step over",
      `Step the stopped Debuggee over the current line ${EXECUTION_WAIT} ${STATE_FAILURE}`,
      RUNS_DEBUGGEE_CODE,
      getRuntime,
    ),
    createNoParametersTool(
      "step_in",
      "DAP step in",
      `Step the stopped Debuggee into the call on the current line ${EXECUTION_WAIT} ${STATE_FAILURE}`,
      RUNS_DEBUGGEE_CODE,
      getRuntime,
    ),
    createNoParametersTool(
      "step_out",
      "DAP step out",
      `Run the stopped Debuggee until the current function returns ${EXECUTION_WAIT} ${STATE_FAILURE}`,
      RUNS_DEBUGGEE_CODE,
      getRuntime,
    ),
    createNoParametersTool(
      "pause",
      "DAP pause",
      `Pause the running Debuggee, for example after an execution wait timed out, and wait for it to stop. ${STATE_FAILURE}`,
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      getRuntime,
    ),
    defineTool<typeof DapStackParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("stack", "DAP stack"),
      description: `List Stack Frames of the stopped Debuggee. Defaults to the stopped thread, start 0, and count 20. ${STATE_FAILURE}`,
      exposure: "direct",
      annotations: READ_ONLY,
      parameters: DapStackParametersSchema,
      prepareArguments: parseStackParameters,
      renderCall: (input, theme, context) =>
        renderCall({ ...input, operation: "stack" }, theme, context),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          { operation: "stack", ...parseStackParameters(input) },
          getRuntime(),
          context,
          signal,
          onUpdate,
        ),
    }),
    defineTool<typeof DapVariablesParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("variables", "DAP variables"),
      description: `List variables of the stopped Debuggee. Exactly one of frame_id (the scopes of a Stack Frame; expensive scopes such as Global are listed but not expanded) or variables_reference (children of a value or of an unexpanded scope) is required, never both; start and count (default 100) page each list. ${STATE_FAILURE}`,
      exposure: "direct",
      annotations: READ_ONLY,
      parameters: DapVariablesParametersSchema,
      prepareArguments: parseVariablesParameters,
      renderCall: (input, theme, context) =>
        renderCall({ ...input, operation: "variables" }, theme, context),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          { operation: "variables", ...parseVariablesParameters(input) },
          getRuntime(),
          context,
          signal,
          onUpdate,
        ),
    }),
    defineTool<typeof DapEvaluateParametersSchema, DapToolRenderDetails | undefined>({
      ...dapToolCommon("evaluate", "DAP evaluate"),
      description: `Evaluate an expression in the stopped Debuggee, in frame_id or the top Stack Frame. The expression runs as Debuggee code and can change its state. ${STATE_FAILURE}`,
      exposure: "direct",
      annotations: RUNS_DEBUGGEE_CODE,
      parameters: DapEvaluateParametersSchema,
      prepareArguments: parseEvaluateParameters,
      renderCall: (input, theme, context) =>
        renderCall({ ...input, operation: "evaluate" }, theme, context),
      execute: async (_toolCallId, input, signal, onUpdate, context) =>
        executeDapOperation(
          { operation: "evaluate", ...parseEvaluateParameters(input) },
          getRuntime(),
          context,
          signal,
          onUpdate,
        ),
    }),
    createNoParametersTool(
      "status",
      "DAP status",
      "Report the Debug Session state and drain unread Debuggee output without changing the Debuggee.",
      READ_ONLY,
      getRuntime,
    ),
    createNoParametersTool(
      "stop",
      "DAP stop",
      "End the Debug Session and terminate its Debuggee. Desired Breakpoints remain for the next launch. Safe to repeat.",
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      getRuntime,
    ),
  ];
}
