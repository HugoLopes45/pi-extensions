import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { errorText } from "pi-hl-utils/errors";
import { Value } from "typebox/value";

import type { DapArtifacts } from "./artifacts.js";
import type { DapResult, DapSnapshot } from "./controller.js";
import {
  DapToolResultDetailsSchema,
  type DapBaseOutput,
  type DapOperation,
  type DapPresentationDetails,
  type DapToolOutput,
  type DapToolRenderDetails,
  type DapToolResultDetails,
} from "./schemas.js";
import {
  formatResult,
  isDapExecutionWaitOperation,
  oneLine,
  visibleText,
  type DapExecutionWaitEnd,
  type DapVisibleTextLimits,
} from "./text.js";

export type DapToolResult = AgentToolResult<DapToolRenderDetails | undefined>;

function boundedDapPresentationText(value: string): string {
  if (value.length <= 500) return value;
  const end = value.charCodeAt(498) >= 0xd800 && value.charCodeAt(498) <= 0xdbff ? 498 : 499;
  return `${value.slice(0, end)}…`;
}

/** Separates the visible result from a note that follows it inside Pi's text budget. */
const RESULT_NOTE_SEPARATOR = "\n\n";

/**
 * Result text cut to Pi's limits with `note` appended whole, so a reported Result Spill path stays
 * complete. A note that fills the whole budget leaves no result text; filesystem paths are far
 * shorter, so this only keeps the arithmetic honest instead of shortening a real path.
 */
function resultWithNote(text: string, note: string): string {
  const reservedLines = note.split("\n").length + 1;
  const reservedBytes = Buffer.byteLength(`${RESULT_NOTE_SEPARATOR}${note}`, "utf8");
  const limits: DapVisibleTextLimits = {
    maxBytes: Math.max(0, DEFAULT_MAX_BYTES - reservedBytes),
    maxLines: Math.max(1, DEFAULT_MAX_LINES - reservedLines),
  };
  return `${visibleText(text, limits).text}${RESULT_NOTE_SEPARATOR}${note}`;
}

function dapVariablePresentation(result: DapResult): DapPresentationDetails | undefined {
  const rows: Extract<DapPresentationDetails, { kind: "variables" }>["rows"][number][] = [];
  let totalRows = 0;
  const appendVariable = (
    variable: NonNullable<DapResult["variables"]>[number],
    group?: string,
  ) => {
    totalRows++;
    if (rows.length >= 20) return;
    const row: Extract<
      Extract<DapPresentationDetails, { kind: "variables" }>["rows"][number],
      { kind: "variable" }
    > = {
      kind: "variable",
      name: boundedDapPresentationText(variable.name),
      value: boundedDapPresentationText(variable.value),
      variables_reference: variable.variablesReference,
    };
    if (group !== undefined) row.group = boundedDapPresentationText(group);
    if (variable.type !== undefined) row.type = boundedDapPresentationText(variable.type);
    rows.push(row);
  };
  if (result.variableGroups !== undefined) {
    for (const group of result.variableGroups) {
      totalRows++;
      if (rows.length < 20) {
        rows.push({
          kind: "group",
          name: boundedDapPresentationText(group.scope.name),
          variables_reference: group.scope.variablesReference,
          expensive: group.scope.expensive,
        });
      }
      for (const variable of group.variables ?? []) appendVariable(variable, group.scope.name);
    }
  } else if (result.variables !== undefined) {
    for (const variable of result.variables) appendVariable(variable);
  } else {
    return undefined;
  }
  return {
    kind: "variables",
    rows,
    omitted_count: Math.max(0, totalRows - rows.length),
  };
}

function dapPresentationDetails(result: DapResult): DapPresentationDetails | undefined {
  if (result.breakpoints !== undefined) {
    return {
      kind: "breakpoints",
      rows: result.breakpoints.slice(0, 20).map((breakpoint) => {
        const row: Extract<DapPresentationDetails, { kind: "breakpoints" }>["rows"][number] = {
          verified: breakpoint.verified,
        };
        if (breakpoint.id !== undefined) row.id = breakpoint.id;
        if (breakpoint.message !== undefined) {
          row.message = boundedDapPresentationText(breakpoint.message);
        }
        if (breakpoint.line !== undefined) row.line = breakpoint.line;
        if (breakpoint.source?.name !== undefined) {
          row.source_name = boundedDapPresentationText(breakpoint.source.name);
        }
        if (breakpoint.source?.path !== undefined) {
          row.source_path = boundedDapPresentationText(breakpoint.source.path);
        }
        return row;
      }),
      omitted_count: Math.max(0, result.breakpoints.length - 20),
    };
  }
  if (result.stackFrames !== undefined) {
    const totalCount = result.totalFrames ?? result.stackFrames.length;
    return {
      kind: "stack_frames",
      rows: result.stackFrames.slice(0, 20).map((frame) => {
        const row: Extract<DapPresentationDetails, { kind: "stack_frames" }>["rows"][number] = {
          id: frame.id,
          name: boundedDapPresentationText(frame.name),
          line: frame.line,
          column: frame.column,
        };
        if (frame.source?.name !== undefined) {
          row.source_name = boundedDapPresentationText(frame.source.name);
        }
        if (frame.source?.path !== undefined) {
          row.source_path = boundedDapPresentationText(frame.source.path);
        }
        return row;
      }),
      total_count: totalCount,
      omitted_count: Math.max(0, totalCount - Math.min(20, result.stackFrames.length)),
    };
  }
  const variables = dapVariablePresentation(result);
  if (variables !== undefined) return variables;
  if (result.evaluation === undefined) return undefined;
  const evaluation: Extract<DapPresentationDetails, { kind: "evaluation" }> = {
    kind: "evaluation",
    value: boundedDapPresentationText(result.evaluation.result),
    variables_reference: result.evaluation.variablesReference,
  };
  if (result.evaluation.type !== undefined) {
    evaluation.type = boundedDapPresentationText(result.evaluation.type);
  }
  return evaluation;
}

/** Snake-case lifecycle fields shared by Observer UI details and script-facing results. */
interface DapSnapshotFields {
  state: DapSnapshot["state"];
  adapter_id?: string;
  profile_id?: string;
  stop_reason?: string;
  thread_id?: number;
  exit_code?: number;
  termination_reason?: string;
}

function snapshotFields(snapshot: DapSnapshot): DapSnapshotFields {
  const fields: DapSnapshotFields = { state: snapshot.state };
  if ("adapterId" in snapshot) fields.adapter_id = snapshot.adapterId;
  if ("profileId" in snapshot) fields.profile_id = snapshot.profileId;
  if (snapshot.state === "stopped") {
    fields.stop_reason = snapshot.stopReason;
    if (snapshot.threadId !== undefined) fields.thread_id = snapshot.threadId;
  }
  if (snapshot.state === "terminated") {
    if (snapshot.exitCode !== undefined) fields.exit_code = snapshot.exitCode;
    if (snapshot.terminationReason !== undefined) {
      fields.termination_reason = snapshot.terminationReason;
    }
  }
  return fields;
}

function toolResultDetails(
  operation: DapOperation,
  result: DapResult,
  executionWaitEnd: DapExecutionWaitEnd | undefined,
): DapToolResultDetails {
  const details: DapToolResultDetails = {
    operation,
    ...snapshotFields(result.snapshot),
    output_discarded_bytes: result.discardedOutputBytes,
    output_truncated: result.discardedOutputBytes > 0,
  };
  if (result.stackFrames !== undefined) {
    details.stack_frame_ids = result.stackFrames.map((frame) => frame.id);
  }
  const presentation =
    executionWaitEnd !== undefined && isDapExecutionWaitOperation(operation)
      ? {
          kind: "execution_wait" as const,
          operation,
          ...(executionWaitEnd === "cancelled"
            ? { cancelled: true as const }
            : { steered: true as const }),
        }
      : dapPresentationDetails(result);
  if (presentation !== undefined) details.presentation = presentation;
  return Value.Parse(DapToolResultDetailsSchema, details);
}

type DapDesiredBreakpointsOutput = Required<Pick<DapToolOutput<"status">, "desired_breakpoints">>;
type DapStopOutput = Pick<
  DapToolOutput<"status">,
  "stop_description" | "hit_breakpoint_ids" | "top_frame" | "child_session"
>;
type DapRejectedChildSessionOutput = Pick<DapToolOutput<"status">, "rejected_child_sessions">;
type DapVariableOutput = NonNullable<DapToolOutput<"variables">["variables"]>[number];
type DapSourceOutput = Pick<
  DapVariableOutput & { source_name?: string; source_path?: string },
  "source_name" | "source_path"
>;

function sourceOutput(
  source: { readonly name?: string; readonly path?: string } | undefined,
): DapSourceOutput {
  const fields: DapSourceOutput = {};
  if (source?.name !== undefined) fields.source_name = source.name;
  if (source?.path !== undefined) fields.source_path = source.path;
  return fields;
}

function variableOutput(variable: NonNullable<DapResult["variables"]>[number]): DapVariableOutput {
  const row: DapVariableOutput = {
    name: variable.name,
    value: variable.value,
    variables_reference: variable.variablesReference,
  };
  if (variable.type !== undefined) row.type = variable.type;
  if (variable.evaluateName !== undefined) row.evaluate_name = variable.evaluateName;
  return row;
}

function rejectedChildSessionOutput(result: DapResult): DapRejectedChildSessionOutput {
  if (result.rejectedChildSessions === undefined) return {};
  return {
    rejected_child_sessions: result.rejectedChildSessions.map((child) => {
      const row: NonNullable<DapRejectedChildSessionOutput["rejected_child_sessions"]>[number] = {
        message: child.message,
      };
      if (child.type !== undefined) row.type = child.type;
      if (child.name !== undefined) row.name = child.name;
      if (child.targetId !== undefined) row.target_id = child.targetId;
      return row;
    }),
  };
}

/** Why and where the Debuggee stopped, in the script-facing shape; empty unless it is stopped. */
function stopOutput(result: DapResult): DapStopOutput {
  const fields: DapStopOutput = {};
  const stop = result.stop;
  if (stop?.description !== undefined) fields.stop_description = stop.description;
  if (stop?.hitBreakpointIds !== undefined) fields.hit_breakpoint_ids = [...stop.hitBreakpointIds];
  if (stop?.topFrame !== undefined) {
    fields.top_frame = {
      id: stop.topFrame.id,
      name: stop.topFrame.name,
      line: stop.topFrame.line,
      column: stop.topFrame.column,
      ...sourceOutput(stop.topFrame.source),
    };
  }
  if (stop?.childSession !== undefined) fields.child_session = stop.childSession;
  return fields;
}

/** Fields every script-facing result carries: state and drained Debuggee output. */
function baseOutput(result: DapResult): DapBaseOutput {
  return {
    ...snapshotFields(result.snapshot),
    output: result.output,
    output_discarded_bytes: result.discardedOutputBytes,
  };
}

/** Desired Breakpoints, carried only by `hl_dap_set_breakpoints`, `hl_dap_launch`, and `hl_dap_status`. */
function desiredBreakpointsOutput(result: DapResult): DapDesiredBreakpointsOutput {
  return {
    desired_breakpoints: result.desiredBreakpoints.map((file) => ({
      file_path: file.filePath,
      breakpoints: file.breakpoints.map((breakpoint) =>
        breakpoint.condition === undefined
          ? { line: breakpoint.line }
          : { line: breakpoint.line, condition: breakpoint.condition },
      ),
    })),
  };
}

function breakpointToolOutput(
  base: DapBaseOutput,
  result: DapResult,
  warnings: readonly string[],
): DapToolOutput<"set_breakpoints"> {
  const output: DapToolOutput<"set_breakpoints"> = {
    ...base,
    ...desiredBreakpointsOutput(result),
  };
  if (warnings.length > 0) output.warnings = [...warnings];
  return result.breakpoints === undefined
    ? output
    : {
        ...output,
        breakpoints: result.breakpoints.map((breakpoint) => {
          const row: NonNullable<DapToolOutput<"set_breakpoints">["breakpoints"]>[number] = {
            verified: breakpoint.verified,
            ...sourceOutput(breakpoint.source),
          };
          if (breakpoint.id !== undefined) row.id = breakpoint.id;
          if (breakpoint.message !== undefined) row.message = breakpoint.message;
          if (breakpoint.line !== undefined) row.line = breakpoint.line;
          if (breakpoint.column !== undefined) row.column = breakpoint.column;
          return row;
        }),
      };
}

function variablesToolOutput(base: DapBaseOutput, result: DapResult): DapToolOutput<"variables"> {
  const output: DapToolOutput<"variables"> = { ...base };
  if (result.variableGroups !== undefined) {
    output.scopes = result.variableGroups.map(({ scope, variables }) => {
      const row: NonNullable<DapToolOutput<"variables">["scopes"]>[number] = {
        name: scope.name,
        variables_reference: scope.variablesReference,
        expensive: scope.expensive,
      };
      if (variables !== undefined) row.variables = variables.map(variableOutput);
      return row;
    });
  }
  if (result.variables !== undefined) output.variables = result.variables.map(variableOutput);
  return output;
}

function evaluationToolOutput(base: DapBaseOutput, result: DapResult): DapToolOutput<"evaluate"> {
  if (result.evaluation === undefined) return base;
  const evaluation: NonNullable<DapToolOutput<"evaluate">["evaluation"]> = {
    result: result.evaluation.result,
    variables_reference: result.evaluation.variablesReference,
  };
  if (result.evaluation.type !== undefined) evaluation.type = result.evaluation.type;
  return { ...base, evaluation };
}

function inspectionToolOutput(
  operation: "set_breakpoints" | "stack" | "variables" | "evaluate",
  base: DapBaseOutput,
  result: DapResult,
  warnings: readonly string[],
): DapToolOutput {
  switch (operation) {
    case "set_breakpoints":
      return breakpointToolOutput(base, result, warnings);
    case "stack":
      return result.stackFrames === undefined
        ? base
        : {
            ...base,
            stack_frames: result.stackFrames.map((frame) => ({
              id: frame.id,
              name: frame.name,
              line: frame.line,
              column: frame.column,
              ...sourceOutput(frame.source),
            })),
            total_frames: result.totalFrames ?? result.stackFrames.length,
          };
    case "variables":
      return variablesToolOutput(base, result);
    case "evaluate":
      return evaluationToolOutput(base, result);
  }
}

/**
 * Complete script-facing result of one operation: every row, full values, and all drained Debuggee
 * output. It carries only the fields the operation's output schema declares.
 */
function toolOutput(
  operation: DapOperation,
  result: DapResult,
  executionWaitEnd: DapExecutionWaitEnd | undefined,
  warnings: readonly string[],
): DapToolOutput {
  const base = baseOutput(result);
  const withWaitEnd = <TOutput extends object>(output: TOutput) =>
    executionWaitEnd === undefined
      ? output
      : executionWaitEnd === "cancelled"
        ? { ...output, execution_wait_cancelled: true }
        : { ...output, execution_wait_steered: true };
  switch (operation) {
    case "launch":
      return withWaitEnd({
        ...base,
        ...desiredBreakpointsOutput(result),
        ...stopOutput(result),
        ...rejectedChildSessionOutput(result),
      });
    case "continue":
    case "next":
    case "step_in":
    case "step_out":
      return withWaitEnd({
        ...base,
        ...stopOutput(result),
        ...rejectedChildSessionOutput(result),
      });
    case "pause":
      return {
        ...base,
        ...stopOutput(result),
        ...rejectedChildSessionOutput(result),
      };
    case "status":
      return {
        ...base,
        ...desiredBreakpointsOutput(result),
        ...stopOutput(result),
        ...rejectedChildSessionOutput(result),
      };
    case "stop":
      return base;
    default:
      return inspectionToolOutput(operation, base, result, warnings);
  }
}

export async function createDapToolOutput(
  operation: DapOperation,
  result: DapResult,
  artifacts: DapArtifacts,
  cwd: string,
  executionWaitEnd: DapExecutionWaitEnd | undefined,
  warnings: readonly string[],
): Promise<DapToolResult> {
  const text = formatResult({
    operation,
    result,
    cwd,
    executionWaitEnd,
    warnings,
  });
  const details = toolResultDetails(operation, result, executionWaitEnd);
  const structuredContent = toolOutput(operation, result, executionWaitEnd, warnings);
  const visible = visibleText(text);
  if (!visible.truncated) {
    return { content: [{ type: "text", text }], details, structuredContent };
  }

  let spillPath: string;
  try {
    spillPath = await artifacts.writeResultSpill(text);
  } catch (cause) {
    const spillError = boundedDapPresentationText(oneLine(errorText(cause))) || "no error message";
    const warning = `Warning: Result Spill storage failed after the action completed; output truncated. Do not repeat the call. Cause: ${spillError}`;
    return {
      content: [
        {
          type: "text",
          text: resultWithNote(text, warning),
        },
      ],
      details: Value.Parse(DapToolResultDetailsSchema, {
        ...details,
        output_truncated: true,
        spill_error: spillError,
      }),
      structuredContent,
    };
  }
  const normalizedDetails = Value.Parse(DapToolResultDetailsSchema, {
    ...details,
    output_truncated: true,
    spill_path: spillPath,
  });
  return {
    content: [
      {
        type: "text",
        text: resultWithNote(
          text,
          `[HL DAP: output truncated; complete Result Spill: ${spillPath}]`,
        ),
      },
    ],
    details: normalizedDetails,
    structuredContent,
  };
}

/** A Debug Session state failure still reports the current state, without draining output. */
export function stateFailureResult(error: Error, snapshot: DapSnapshot): DapToolResult {
  const state = snapshotFields(snapshot);
  return {
    content: [
      {
        type: "text",
        text: `${error.message}\nDebug Session: ${JSON.stringify(state)}`,
      },
    ],
    details: undefined,
    structuredContent: { ...state, error: error.message },
    isError: true,
  };
}
