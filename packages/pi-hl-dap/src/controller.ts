import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

import type { DebugProtocol } from "@vscode/debugprotocol";
import { errorText } from "pi-hl-utils/errors";
import { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  DapConnection,
  DapConnectionError,
  type DapRequestOptions,
  type DapTransport,
  type DapReverseRequestResult,
} from "./adapter.js";
import { DapOutputBuffer, type DapArtifacts } from "./artifacts.js";
import type { DapOutputExitReport } from "./presets.js";
import {
  resolveProcessEnvironment,
  stopOwnedProcessGroup,
  probeOwnedProcessGroup,
} from "./process.js";
import {
  DapAdapterProtocolIdSchema,
  DapCapabilitiesSchema,
  DapOutputEventBodySchema,
  DapStoppedEventBodySchema,
  DapContinuedEventBodySchema,
  DapExitedEventBodySchema,
  DapSetBreakpointsBodySchema,
  DapThreadsBodySchema,
  DapStackTraceBodySchema,
  DapScopesBodySchema,
  DapVariablesBodySchema,
  DapEvaluateBodySchema,
  RunInTerminalArgumentsSchema,
  StartDebuggingArgumentsSchema,
} from "./protocol.js";
import type { DapAdapterDefinition, DapLaunchProfile, ResolvedDapSettings } from "./settings.js";

/** State failure a Debug Session reports for every launch that follows its shutdown. */
const CLOSED_SESSION_MESSAGE = "Debug Session is closed by Pi session shutdown";

/** Number of Launch Profile IDs an error lists before it summarizes the rest. */
const VALID_PROFILE_LIST_LIMIT = 10;

/** Failure reply for a `runInTerminal` that teardown cannot own. */
const RUN_IN_TERMINAL_STOPPING_MESSAGE =
  "HL DAP: runInTerminal was refused because the Debug Session is stopping";

/** Classified configuration, state, protocol, or Debug Adapter failure. */
export class DapError extends Error {
  /** Construct a stable Debug Session failure for the Pi tool boundary. */
  constructor(
    readonly kind: "adapter" | "configuration" | "protocol" | "state",
    message: string,
    options?: ErrorOptions,
  ) {
    super(`DAP Session: ${message}`, options);
  }
}

/** Optional Launch Profile overrides supplied by one launch operation. */
export interface DapLaunchInput {
  readonly profile?: string;
  readonly program?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Launch arguments merged over the Launch Profile's `arguments`; `program`, `args`, and `cwd` still win. */
  readonly launchArguments?: DapLaunchProfile["arguments"];
}

/**
 * A child session the adapter asked HL DAP to debug, such as a worker thread or child process of
 * the Debuggee, that HL DAP could not debug, so breakpoints in the child never bind.
 */
export interface DapRejectedChildSession {
  readonly type?: string;
  readonly name?: string;
  /** The adapter's id for the child session's pending debug target. */
  readonly targetId?: string;
  /** Actionable, model-readable explanation naming the child session. */
  readonly message: string;
}

/** One desired source Breakpoint, with one-based line numbering. */
export interface DapDesiredBreakpoint {
  readonly line: number;
  readonly condition?: string;
}

/** Complete replacement of Desired Breakpoints for one source file. */
export interface DapSetBreakpointsInput {
  readonly filePath: string;
  readonly breakpoints: readonly DapDesiredBreakpoint[];
}

/** Paged Stack Frame request, defaulting to the stopped thread. */
export interface DapStackInput {
  readonly threadId?: number;
  readonly start?: number;
  readonly count?: number;
}

/** Paged variables request by Stack Frame or child variables reference. */
export type DapVariablesInput =
  | {
      readonly frameId: number;
      readonly variablesReference?: never;
      readonly start?: number;
      readonly count?: number;
    }
  | {
      readonly frameId?: never;
      readonly variablesReference: number;
      readonly start?: number;
      readonly count?: number;
    };

/** Expression evaluation request, defaulting to the top Stack Frame. */
export interface DapEvaluateInput {
  readonly expression: string;
  readonly frameId?: number;
}

/** Public exhaustive Debug Session lifecycle snapshot. */
export type DapSnapshot =
  | { readonly state: "idle" }
  | {
      readonly state: "launching" | "running";
      readonly adapterId: string;
      readonly profileId: string;
    }
  | {
      readonly state: "stopped";
      readonly adapterId: string;
      readonly profileId: string;
      readonly stopReason: string;
      readonly threadId?: number;
    }
  | {
      readonly state: "terminated";
      readonly adapterId: string;
      readonly profileId: string;
      readonly exitCode?: number;
      readonly terminationReason?: string;
    };

/** Desired Breakpoints retained for one source file across launches. */
export interface DapDesiredBreakpointFile {
  readonly filePath: string;
  readonly breakpoints: readonly DapDesiredBreakpoint[];
}

/**
 * One Stack Frame scope. `variables` is absent for an expensive scope that was listed but not
 * expanded; request its `variablesReference` to expand it.
 */
export interface DapVariableGroup {
  readonly scope: DebugProtocol.Scope;
  readonly variables?: readonly DebugProtocol.Variable[];
}

/** Where and why the Debuggee stopped, taken from the stopped event and the top Stack Frame. */
export interface DapStopDetails {
  /** The adapter's human-readable explanation of the stop, when it sent one. */
  readonly description?: string;
  /** Adapter ids of the Breakpoints that caused the stop, when it reported any. */
  readonly hitBreakpointIds?: readonly number[];
  /** Top Stack Frame, present when the operation waited for a stop and the frame could be read. */
  readonly topFrame?: DebugProtocol.StackFrame;
  /** The adapter's name for the Child session that stopped; absent for a stop in the Debuggee itself. */
  readonly childSession?: string;
}

/** Successful Debug Session operation including unread Debuggee output. */
export interface DapResult {
  readonly waitEnd?: "steered" | "cancelled";
  readonly snapshot: DapSnapshot;
  readonly stop?: DapStopDetails;
  readonly output: string;
  readonly discardedOutputBytes: number;
  readonly desiredBreakpoints: readonly DapDesiredBreakpointFile[];
  /** Child sessions HL DAP could not debug since the last result that reported them; set only when there are some. */
  readonly rejectedChildSessions?: readonly DapRejectedChildSession[];
  readonly breakpoints?: readonly DebugProtocol.Breakpoint[];
  readonly stackFrames?: readonly DebugProtocol.StackFrame[];
  readonly totalFrames?: number;
  readonly variableGroups?: readonly DapVariableGroup[];
  readonly variables?: readonly DebugProtocol.Variable[];
  readonly evaluation?: DebugProtocol.EvaluateResponse["body"];
}

/** Construction values owned for one conversation-level Debug Session controller. */
export interface DapControllerOptions {
  readonly cwd: string;
  readonly settings: ResolvedDapSettings;
  readonly artifacts: DapArtifacts;
  /** Observe lifecycle snapshots synchronously without gaining protocol authority. */
  readonly onSnapshotChange?: (snapshot: DapSnapshot) => void;
  /** Observe an asynchronous adapter or protocol failure not caused by an operation request. */
  readonly onUnexpectedFailure?: (error: Error) => void;
}

/** A stop a debuggable target reported that no operation has resumed yet. */
interface DapTargetStop {
  /** Orders waiting stops, so they are reported in the order they arrived. */
  readonly arrival: number;
  readonly reason: string;
  readonly description: string | undefined;
  /** The target's own Breakpoint ids, translated to the reported ids when the stop is reported. */
  readonly hitBreakpointIds: readonly number[] | undefined;
}

/**
 * One channel HL DAP debugs: the primary target (a promoted channel when the adapter opens one, or
 * the root channel) or a Child session's target channel.
 */
interface DapTarget {
  readonly client: DapConnection;
  /** The adapter's name for a Child session; absent for the primary target. */
  readonly childSessionName: string | undefined;
  /**
   * Adapter thread id to Pi thread id. Each promoted target numbers its own threads, so Pi assigns
   * ids that cannot collide; absent where Pi reports the adapter's thread ids unchanged.
   */
  readonly piThreadIds: Map<number, number> | undefined;
  /** The target's Breakpoint ids, each mapped to its Desired Breakpoint's key. */
  readonly breakpointKeys: Map<number, string>;
  /** Whether the target has initialized and accepts Breakpoints. */
  ready: boolean;
  /** Detaching targets remain owned for cleanup but no longer dispatch events. */
  detaching: boolean;
  /** Adapter thread id of the target's last stop or thread lookup. */
  threadId: number | undefined;
  /** Unresumed stop; queued while another target's stop is the one reported. */
  stop: DapTargetStop | undefined;
  /** Count of the target's continued events; a refused resume restores its stop only if unchanged. */
  continuedEvents: number;
}

interface ActiveDapSession {
  readonly adapter: DapAdapterDefinition;
  /** Value every channel sends as `initialize.adapterID`. */
  readonly adapterID: string;
  readonly profile: DapLaunchProfile;
  /** Effective launch arguments: the Launch Profile's, merged with this launch's overrides. */
  readonly launchArguments: DapLaunchProfile["arguments"];
  readonly rootClient: DapConnection;
  /** The root channel as a target; the primary target unless the adapter promotes another. */
  readonly rootTarget: DapTarget;
  primary: DapTarget;
  /** The target whose stop is reported and which inspection and stepping operations use. */
  focus: DapTarget;
  /** Child sessions being debugged, from attach until they terminate or the session ends. */
  readonly children: Set<DapTarget>;
  /** Pi thread id to its target and adapter thread id, for targets that map thread ids. */
  readonly threadOwners: Map<number, { readonly target: DapTarget; readonly threadId: number }>;
  nextThreadId: number;
  /** Desired Breakpoint key to the id reported for it: the primary target's, else the first child's. */
  readonly reportedBreakpointIds: Map<string, number>;
  targetClient?: DapConnection;
  targetChannelStarted: boolean;
  readonly debuggeeProcesses: Set<ChildProcessWithoutNullStreams>;
  readonly unsubscribeEvents: Set<() => void>;
  phase: "launching" | "running" | "stopped";
  /** Top Stack Frame of the current stop, once an operation has read it. */
  topFrame: DebugProtocol.StackFrame | undefined;
  /** Counts stopped events, so a frame read for an earlier stop is never attached to a later one. */
  stopSequence: number;
  /** Counts stops any target reported, to order waiting stops. */
  stopArrivals: number;
  exitCode: number | undefined;
  /** Whether the standard `exited` event reported the exit code, which no report may override. */
  exitedCode: boolean;
  /** Whether the primary target channel has reported `terminated`. */
  targetTerminated: boolean;
  /** Whether the root channel has reported `terminated`. */
  rootTerminated: boolean;
  /** Whether natural completion is waiting for the remaining channels. */
  completionStarted: boolean;
  /** Wakes natural completion when a channel ends or cleanup starts. */
  readonly settleTermination: Set<() => void>;
  cleanupPromise?: Promise<void>;
  failure?: Error;
  stopping: boolean;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type DapState =
  | { readonly kind: "idle" }
  | { readonly kind: "active"; readonly active: ActiveDapSession }
  | {
      readonly kind: "terminated";
      readonly adapterId: string;
      readonly profileId: string;
      readonly exitCode?: number;
      readonly terminationReason?: string;
      readonly cleanupPromise: Promise<void>;
    };

type ExecutionWaitOutcome = "cancelled" | "steered" | "timeout" | "transition";

/** One launch's startup barrier; a launch releases only the barrier it registered itself. */
interface StartupBarrier {
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

interface ExecutionWait {
  readonly promise: Promise<ExecutionWaitOutcome>;
  cancel(): void;
}

type DapLaunchResponseOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly error: Error };

function parseDapBody<T extends TSchema>(schema: T, value: unknown, operation: string): Static<T> {
  if (Value.Check(schema, value)) return value;
  const issue = Value.Errors(schema, value)[0];
  throw new DapError(
    "protocol",
    `${operation} returned an invalid body${issue?.instancePath === undefined ? "" : ` at ${issue.instancePath || "/"}`}`,
  );
}

function resolvedLaunchArguments(
  profile: DapLaunchProfile,
  input: DapLaunchInput,
  cwd: string,
): DapLaunchProfile["arguments"] {
  // ponytail: shallow merge suffices — only top-level launch keys are replaced.
  const launchArguments = { ...profile.arguments, ...input.launchArguments };
  if (input.program !== undefined) launchArguments.program = resolve(cwd, input.program);
  if (input.args !== undefined) launchArguments.args = [...input.args];
  if (input.cwd !== undefined) launchArguments.cwd = resolve(cwd, input.cwd);
  return launchArguments;
}

function launchFailure(cause: unknown): DapError {
  if (isProtocolCancellation(cause)) {
    return new DapError("adapter", "launch was cancelled and cleaned up", {
      cause,
    });
  }
  if (cause instanceof DapError) return cause;
  return new DapError("adapter", `launch failed: ${errorText(cause)}`, {
    cause,
  });
}

function terminatedSnapshot(terminated: Extract<DapState, { kind: "terminated" }>): DapSnapshot {
  const snapshot: Mutable<Extract<DapSnapshot, { state: "terminated" }>> = {
    state: "terminated",
    adapterId: terminated.adapterId,
    profileId: terminated.profileId,
  };
  if (terminated.exitCode !== undefined) snapshot.exitCode = terminated.exitCode;
  if (terminated.terminationReason !== undefined) {
    snapshot.terminationReason = terminated.terminationReason;
  }
  return snapshot;
}

function protocolTransport(adapter: DapAdapterDefinition): DapTransport {
  return adapter.transport.type === "stdio" ? "stdio" : adapter.transport;
}

/** What a `startDebugging` request names about the session it asks HL DAP to start. */
interface ChildSessionRequest {
  readonly configuration: Record<string, unknown>;
  readonly description: string;
  readonly name: string | undefined;
  /** The adapter's pending target id, read from the configured key; presentation only. */
  readonly targetId: string | undefined;
  readonly type: string | undefined;
  /** The `launch` or `attach` command the adapter asked for. */
  readonly request: "launch" | "attach";
}

/** A non-empty string the adapter put in an opaque configuration object. */
function textField(configuration: Record<string, unknown>, key: string): string | undefined {
  const value = configuration[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse a `startDebugging` request; `undefined` when its arguments do not match the spec shape. */
function childSessionRequest(
  request: DebugProtocol.Request,
  targetIdKey: string | undefined,
): ChildSessionRequest | undefined {
  if (!Value.Check(StartDebuggingArgumentsSchema, request.arguments)) return undefined;
  const { configuration, request: command } = request.arguments;
  const type = textField(configuration, "type");
  const name = textField(configuration, "name");
  const targetId = targetIdKey === undefined ? undefined : textField(configuration, targetIdKey);
  const parts = [
    type,
    name === undefined ? undefined : JSON.stringify(name),
    targetId === undefined ? undefined : `(target ${targetId})`,
  ].filter((part) => part !== undefined);
  return {
    configuration,
    description: parts.length === 0 ? "(unnamed)" : parts.join(" "),
    name,
    targetId,
    type,
    request: command,
  };
}

function rejectedChildSession(
  message: string,
  child: ChildSessionRequest,
): DapRejectedChildSession {
  const rejected: Mutable<DapRejectedChildSession> = { message };
  if (child.type !== undefined) rejected.type = child.type;
  if (child.name !== undefined) rejected.name = child.name;
  if (child.targetId !== undefined) rejected.targetId = child.targetId;
  return rejected;
}

/** Whether these launch arguments let the adapter's exit report describe the Debuggee's own exit. */
function outputReportApplies(
  report: DapOutputExitReport,
  launchArguments: DapLaunchProfile["arguments"],
): boolean {
  const { absentOrIn, notIn } = report.onlyWhenArgument ?? {};
  return (
    argumentConditionHolds(launchArguments, absentOrIn, (value, present, values) =>
      present ? value !== undefined && values.includes(value) : true,
    ) &&
    argumentConditionHolds(
      launchArguments,
      notIn,
      (value, _present, values) => value === undefined || !values.includes(value),
    )
  );
}

function argumentConditionHolds(
  launchArguments: DapLaunchProfile["arguments"],
  conditions: Readonly<Record<string, readonly string[]>> | undefined,
  holds: (value: string | undefined, present: boolean, values: readonly string[]) => boolean,
): boolean {
  if (conditions === undefined) return true;
  return Object.entries(conditions).every(([key, values]) => {
    const value: unknown = launchArguments[key];
    return holds(typeof value === "string" ? value : undefined, value !== undefined, values);
  });
}

/** The exit code an adapter's own output report states, if this output is one. */
function outputReportExitCode(
  body: Static<typeof DapOutputEventBodySchema>,
  report: DapOutputExitReport,
): number | undefined {
  if (body.category !== report.category) return undefined;
  const match = report.pattern.exec(body.output);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** HL DAP's `initialize` arguments; only the adapter id and two reverse-request flags vary. */
function initializeArguments(
  adapterID: string,
  supportsRunInTerminalRequest: boolean,
  supportsStartDebuggingRequest: boolean,
): DebugProtocol.InitializeRequestArguments {
  return {
    adapterID,
    clientID: "pi-hl-dap",
    clientName: "HL DAP",
    columnsStartAt1: true,
    linesStartAt1: true,
    locale: "en-US",
    pathFormat: "path",
    supportsRunInTerminalRequest,
    supportsStartDebuggingRequest,
    supportsVariablePaging: true,
  };
}

function dapTarget(
  client: DapConnection,
  childSessionName: string | undefined,
  mapsThreadIds: boolean,
): DapTarget {
  return {
    client,
    childSessionName,
    piThreadIds: mapsThreadIds ? new Map() : undefined,
    breakpointKeys: new Map(),
    ready: false,
    detaching: false,
    threadId: undefined,
    stop: undefined,
    continuedEvents: 0,
  };
}

/** Identifies a Desired Breakpoint by file and position, the same on every target. */
function breakpointKey(filePath: string, index: number): string {
  return `${filePath}\0${String(index)}`;
}

/** Launch Profile IDs for a recovery message, sorted and bounded so a large settings map cannot flood it. */
function validProfileList(profiles: ReadonlyMap<string, DapLaunchProfile>): string {
  const ids = [...profiles.keys()].toSorted((left, right) => left.localeCompare(right));
  const listed = ids
    .slice(0, VALID_PROFILE_LIST_LIMIT)
    .map((id) => `"${id}"`)
    .join(", ");
  const omitted = ids.length - Math.min(ids.length, VALID_PROFILE_LIST_LIMIT);
  return omitted === 0 ? listed : `${listed} and ${String(omitted)} more`;
}

/**
 * Whether this adapter asks for promoted Debug sessions and can host the channel they need. The
 * client advertises the capability from this answer, so a stdio adapter never offers children.
 */
function promotionSupported(adapter: DapAdapterDefinition): boolean {
  return adapter.channels?.sessions === "promoted" && adapter.transport.type === "tcp";
}

/** The launch response as a value, so its failure can be reported before `initialized` arrives. */
function launchOutcomeOf(response: Promise<unknown>): Promise<DapLaunchResponseOutcome> {
  return response.then(
    () => ({ kind: "success" }),
    (cause: unknown) => ({
      kind: "failure",
      error: cause instanceof Error ? cause : new Error(String(cause)),
    }),
  );
}

/**
 * Wait for `initialized` unless the launch already failed, so a rejected launch reports its own
 * error instead of the startup timeout that would mask it. Only a failure ends this wait early; the
 * caller checks a failure that arrives later by awaiting the launch outcome.
 */
async function awaitInitialized(
  initialized: Promise<unknown>,
  launchOutcome: Promise<DapLaunchResponseOutcome>,
): Promise<void> {
  const launchFailure = launchOutcome.then((outcome) => {
    if (outcome.kind === "success") return new Promise<never>(() => {});
    throw outcome.error;
  });
  launchFailure.catch(() => undefined);
  await Promise.race([initialized, launchFailure]);
}

function isAdapterRefusal(error: unknown): boolean {
  return error instanceof DapConnectionError && error.kind === "request";
}

function isProtocolCancellation(error: unknown): boolean {
  return error instanceof DapConnectionError && error.kind === "cancelled";
}

function dapRequestOptions(signal: AbortSignal | undefined, timeoutMs?: number): DapRequestOptions {
  if (signal === undefined && timeoutMs === undefined) return {};
  if (signal === undefined) return { timeoutMs };
  if (timeoutMs === undefined) return { signal };
  return { signal, timeoutMs };
}

/** Own one configured Debug Session at a time and retain Desired Breakpoints across launches. */
export class DapController {
  private readonly output = new DapOutputBuffer();
  private readonly desiredBreakpoints = new Map<string, readonly DapDesiredBreakpoint[]>();
  private readonly executionWaiters = new Set<() => void>();
  /** Child sessions HL DAP could not debug during the current launch and not yet reported in a result. */
  private readonly rejectedChildSessions: DapRejectedChildSession[] = [];
  private state: DapState = { kind: "idle" };
  private disposePromise: Promise<void> | undefined;
  /** Whether the Pi session shut this Debug Session down, which ends it for good. */
  private closed = false;
  /** Aborts an adapter startup this session can no longer use after its shutdown. */
  private readonly closeSignal = new AbortController();
  /**
   * Barrier of the launch whose startup is in flight: settles after that launch publishes its Debug
   * Session or finishes rolling back, so `dispose` outlives both and never waits on a stale one.
   */
  private startup: StartupBarrier | undefined;
  private rollbackFailure: DapError | undefined;

  /** Construct an inert Debug Session controller; launch starts the first Debug Adapter. */
  constructor(private readonly options: DapControllerOptions) {}

  /** Register this launch's barrier; a launch that is already starting owns the current one. */
  private beginStartup(): StartupBarrier {
    if (this.startup !== undefined)
      throw new DapError("state", "launch is already starting a Debug Session");
    const { promise, resolve } = Promise.withResolvers<void>();
    const barrier: StartupBarrier = { settled: promise, settle: resolve };
    this.startup = barrier;
    return barrier;
  }

  /** Release `barrier` once its launch published or rolled back, leaving a later launch's untouched. */
  private endStartup(barrier: StartupBarrier): void {
    if (this.startup !== barrier) return;
    this.startup = undefined;
    barrier.settle();
  }

  /** Reject a launch or a startup step that a Debug Session shutdown has made unusable. */
  private requireOpen(): void {
    if (this.rollbackFailure) throw this.rollbackFailure;
    if (this.closed) throw new DapError("state", CLOSED_SESSION_MESSAGE);
  }

  /** The failure to report for a launch that ended without publishing a Debug Session. */
  private startupFailure(cause: unknown, active: ActiveDapSession | undefined): Error {
    if (active !== undefined || !this.closed || cause instanceof DapError)
      return launchFailure(cause);
    return new DapError("state", CLOSED_SESSION_MESSAGE, { cause });
  }

  /** Cancel adapter startup when either the caller cancels or this Debug Session shuts down. */
  private startupSignal(signal: AbortSignal | undefined): AbortSignal {
    return signal === undefined
      ? this.closeSignal.signal
      : AbortSignal.any([signal, this.closeSignal.signal]);
  }

  /**
   * Launch one configured Launch Profile and wait for its first stop, exit, cancellation, Steer
   * Yield (the steer signal aborting), or execution timeout.
   */
  async launch(
    input: DapLaunchInput = {},
    signal?: AbortSignal,
    steerSignal?: AbortSignal,
  ): Promise<DapResult> {
    if (this.prepareOperation() !== undefined) {
      throw new DapError("state", "launch requires no active Debug Session");
    }
    this.requireOpen();
    const startup = this.beginStartup();
    let active: ActiveDapSession | undefined;
    let client: DapConnection | undefined;
    const debuggeeProcesses = new Set<ChildProcessWithoutNullStreams>();
    try {
      await this.awaitPreviousCleanup();
      this.requireOpen();
      this.output.drain();
      this.rejectedChildSessions.length = 0;

      const { adapter, profile, launchArguments, adapterID } = this.resolveLaunch(input);

      const stderrPath = await this.options.artifacts.getAdapterStderrPath();
      this.requireOpen();
      client = await DapConnection.start({
        adapterId: adapter.id,
        cwd: this.options.cwd,
        command: adapter.command,
        args: adapter.args,
        environment: adapter.environment,
        transport: protocolTransport(adapter),
        timeouts: {
          startupMs: this.options.settings.timeouts.startupMs,
          requestMs: this.options.settings.timeouts.requestMs,
          shutdownMs: this.options.settings.timeouts.shutdownMs,
        },
        stderrPath,
        startupSignal: this.startupSignal(signal),
        onReverseRequest: (request) =>
          this.handleReverseRequest(request, debuggeeProcesses, () => active, signal),
        onFailure: (error) => {
          if (active !== undefined) this.handleAdapterFailure(active, error);
        },
      });
      // A startup this shutdown aborted must not publish an active Debug Session that shutdown
      // already passed; the rollback below stops the adapter and any Debuggee it spawned.
      this.requireOpen();
      const rootTarget = dapTarget(client, undefined, promotionSupported(adapter));
      const startedActive: ActiveDapSession = {
        adapter,
        adapterID,
        profile,
        launchArguments,
        rootClient: client,
        rootTarget,
        primary: rootTarget,
        focus: rootTarget,
        children: new Set(),
        threadOwners: new Map(),
        nextThreadId: 1,
        reportedBreakpointIds: new Map(),
        debuggeeProcesses,
        targetChannelStarted: false,
        unsubscribeEvents: new Set(),
        phase: "launching",
        topFrame: undefined,
        stopSequence: 0,
        stopArrivals: 0,
        exitCode: undefined,
        exitedCode: false,
        completionStarted: false,
        targetTerminated: false,
        rootTerminated: false,
        settleTermination: new Set(),
        stopping: false,
      };
      active = startedActive;
      this.state = { kind: "active", active: startedActive };
      this.publishSnapshot();
      // The execution wait that follows is outside the barrier: only startup must outlive shutdown.
      this.endStartup(startup);
      startedActive.unsubscribeEvents.add(
        client.onEvent((event) => this.handleDapEvent(startedActive, event, "root", rootTarget)),
      );

      await this.initializeActiveSession(active, signal);
      if (this.isCurrentActive(active) && active.phase === "launching") {
        this.transitionActiveToRunning(active);
      }
      let outcome: ExecutionWaitOutcome | undefined;
      if (this.isCurrentActive(active) && active.phase === "running") {
        const wait = this.waitForExecutionTransition(signal, steerSignal);
        outcome = await wait.promise;
      }
      await active.cleanupPromise;
      return await this.launchResult(active, outcome);
    } catch (cause) {
      if (active !== undefined) {
        await this.finishActiveSession(active, "launch failed", cause);
      } else {
        await this.cleanUpUnstartedSession(debuggeeProcesses, cause, client);
      }
      throw this.startupFailure(cause, active);
    } finally {
      this.endStartup(startup);
    }
  }

  /** The result of a launch that ended, unless a channel failure ended it before the user saw it. */
  private async launchResult(
    active: ActiveDapSession,
    outcome: ExecutionWaitOutcome | undefined,
  ): Promise<DapResult> {
    if (active.failure !== undefined) throw this.startupFailure(active.failure, active);
    return await this.stoppedResult(active, outcome);
  }

  private async initializeActiveSession(
    active: ActiveDapSession,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const client = active.rootClient;
    const initialized = client.waitForEvent(
      "initialized",
      dapRequestOptions(signal, this.options.settings.timeouts.startupMs),
    );
    // An `initialize` that fails early would otherwise leave this waiter unobserved.
    initialized.catch(() => undefined);
    // A promoted target replaces the primary target meanwhile; this decision is the root channel's.
    const capabilities = parseDapBody(
      DapCapabilitiesSchema,
      await client.request(
        "initialize",
        initializeArguments(active.adapterID, true, promotionSupported(active.adapter)),
        dapRequestOptions(signal, this.options.settings.timeouts.startupMs),
      ),
      "initialize",
    );
    client.setSupportsTerminateRequest(capabilities.supportsTerminateRequest === true);
    const launchOutcome = launchOutcomeOf(
      client.request("launch", active.launchArguments, dapRequestOptions(signal)),
    );
    await awaitInitialized(initialized, launchOutcome);
    active.rootTarget.ready = true;
    await this.applyDesiredBreakpoints(active, active.rootTarget, signal);
    if (capabilities.supportsConfigurationDoneRequest === true) {
      await client.request("configurationDone", {}, dapRequestOptions(signal));
    }
    const launchResult = await launchOutcome;
    if (launchResult.kind === "failure") throw launchResult.error;
  }

  /**
   * Replace all Desired Breakpoints for one file. The prior list stays if the primary target refuses
   * the update; once it accepts, the new list stays even if a live Child session then refuses it.
   */
  async setBreakpoints(input: DapSetBreakpointsInput, signal?: AbortSignal): Promise<DapResult> {
    const filePath = resolve(this.options.cwd, input.filePath);
    const breakpoints = input.breakpoints.map((breakpoint) => ({
      ...breakpoint,
    }));
    const active = this.prepareOperation();
    if (active === undefined) {
      this.retainBreakpoints(filePath, breakpoints);
      return this.result();
    }
    const primary = await this.sendBreakpoints(
      active,
      active.primary,
      filePath,
      breakpoints,
      signal,
    );
    this.retainBreakpoints(filePath, breakpoints);
    // Children change only after the primary target accepted the list; each one settles first.
    const childResults = await Promise.allSettled(
      [...active.children]
        .filter((child) => child.ready)
        .map((child) =>
          this.unlessChildEnded(
            active,
            child,
            this.sendBreakpoints(active, child, filePath, breakpoints, signal),
          ),
        ),
    );
    const childBodies = childResults.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    // Code a child session loads is unknown to the primary target: verified where any target is.
    const reported = primary.breakpoints.map((breakpoint, index) => {
      const verified = breakpoint.verified
        ? breakpoint
        : (childBodies.find((body) => body?.breakpoints[index]?.verified === true)?.breakpoints[
            index
          ] ?? breakpoint);
      const id = active.reportedBreakpointIds.get(breakpointKey(filePath, index));
      return id === undefined ? verified : { ...verified, id };
    });
    return this.result({ breakpoints: reported });
  }

  /** An empty list clears the file, so it drops out of Desired Breakpoints instead of lingering. */
  private retainBreakpoints(filePath: string, breakpoints: readonly DapDesiredBreakpoint[]): void {
    if (breakpoints.length === 0) this.desiredBreakpoints.delete(filePath);
    else this.desiredBreakpoints.set(filePath, breakpoints);
  }

  /** Continue a stopped Debuggee and wait for its next stop or termination; the steer signal aborting ends the wait early. */
  continue(signal?: AbortSignal, steerSignal?: AbortSignal): Promise<DapResult> {
    return this.executeLifecycleRequest("continue", signal, steerSignal);
  }

  /** Step over in a stopped Debuggee and wait for its next stop or termination; the steer signal aborting ends the wait early. */
  next(signal?: AbortSignal, steerSignal?: AbortSignal): Promise<DapResult> {
    return this.executeLifecycleRequest("next", signal, steerSignal);
  }

  /** Step into in a stopped Debuggee and wait for its next stop or termination; the steer signal aborting ends the wait early. */
  stepIn(signal?: AbortSignal, steerSignal?: AbortSignal): Promise<DapResult> {
    return this.executeLifecycleRequest("stepIn", signal, steerSignal);
  }

  /** Step out in a stopped Debuggee and wait for its next stop or termination; the steer signal aborting ends the wait early. */
  stepOut(signal?: AbortSignal, steerSignal?: AbortSignal): Promise<DapResult> {
    return this.executeLifecycleRequest("stepOut", signal, steerSignal);
  }

  /** Pause a running Debuggee and wait for its stopped event; a Queued Steer does not end this wait. */
  pause(signal?: AbortSignal): Promise<DapResult> {
    return this.pauseTargets(signal);
  }

  /** Retrieve a page of Stack Frames from the stopped thread. */
  async stack(input: DapStackInput = {}, signal?: AbortSignal): Promise<DapResult> {
    const active = this.requireActivePhase("stopped", "stack");
    const stopSequence = active.stopSequence;
    const target = active.focus;
    const threadId =
      input.threadId === undefined
        ? await this.resolveThreadId(active, target, signal)
        : this.adapterThreadId(active, input.threadId);
    const body = parseDapBody(
      DapStackTraceBodySchema,
      await target.client.request(
        "stackTrace",
        { threadId, startFrame: input.start ?? 0, levels: input.count ?? 20 },
        dapRequestOptions(signal),
      ),
      "stackTrace",
    );
    this.requireTarget(active, target, stopSequence, "stack");
    return this.result({
      stackFrames: body.stackFrames,
      totalFrames: body.totalFrames ?? body.stackFrames.length,
    });
  }

  /** Retrieve paged variables by Stack Frame scopes or child variables reference. */
  async variables(input: DapVariablesInput, signal?: AbortSignal): Promise<DapResult> {
    const active = this.requireActivePhase("stopped", "variables");
    const start = input.start ?? 0;
    const count = input.count ?? 100;
    const target = active.focus;
    const stopSequence = active.stopSequence;
    if (input.variablesReference !== undefined) {
      const body = await this.requestVariables(
        target,
        input.variablesReference,
        start,
        count,
        signal,
      );
      this.requireTarget(active, target, stopSequence, "variables");
      return this.result({ variables: body.variables });
    }
    const scopes = parseDapBody(
      DapScopesBodySchema,
      await target.client.request("scopes", { frameId: input.frameId }, dapRequestOptions(signal)),
      "scopes",
    ).scopes;
    this.requireTarget(active, target, stopSequence, "variables");
    // An expensive scope can hold thousands of rows; list it, don't expand it.
    const variableGroups = await Promise.all(
      scopes.map(async (scope): Promise<DapVariableGroup> => {
        if (scope.expensive) return { scope };
        const { variables } = await this.requestVariables(
          target,
          scope.variablesReference,
          start,
          count,
          signal,
        );
        return { scope, variables };
      }),
    );
    this.requireTarget(active, target, stopSequence, "variables");
    return this.result({ variableGroups });
  }

  /** Evaluate an expression in a chosen or top stopped Stack Frame. */
  async evaluate(input: DapEvaluateInput, signal?: AbortSignal): Promise<DapResult> {
    const active = this.requireActivePhase("stopped", "evaluate");
    const target = active.focus;
    const stopSequence = active.stopSequence;
    let frameId = input.frameId;
    if (frameId === undefined) {
      const stackResult = parseDapBody(
        DapStackTraceBodySchema,
        await target.client.request(
          "stackTrace",
          {
            threadId: await this.resolveThreadId(active, target, signal),
            startFrame: 0,
            levels: 1,
          },
          dapRequestOptions(signal),
        ),
        "stackTrace",
      );
      this.requireTarget(active, target, stopSequence, "evaluate");
      frameId = stackResult.stackFrames.at(0)?.id;
      if (frameId === undefined) {
        throw new DapError("state", "evaluate requires a top Stack Frame");
      }
    }
    const evaluation = parseDapBody(
      DapEvaluateBodySchema,
      await target.client.request(
        "evaluate",
        { expression: input.expression, frameId, context: "repl" },
        dapRequestOptions(signal),
      ),
      "evaluate",
    );
    this.requireTarget(active, target, stopSequence, "evaluate");
    return this.result({ evaluation });
  }

  /** Return the current lifecycle snapshot and drain currently unread Debuggee output. */
  status(): DapResult {
    this.prepareOperation();
    return this.result({
      ...this.stopPayload(),
      ...this.drainRejectedChildSessions(),
    });
  }

  /** Idempotently stop the active Debug Session and preserve Desired Breakpoints. */
  async stop(): Promise<DapResult> {
    const active = this.currentActive();
    if (active === undefined) {
      await this.awaitPreviousCleanup();
      return this.result();
    }
    await this.finishOperation(active, "stopped by request");
    return this.result();
  }

  private async awaitPreviousCleanup(): Promise<void> {
    const previous = this.state;
    if (previous.kind !== "terminated") return;
    try {
      await previous.cleanupPromise;
    } catch (cause) {
      if (this.state !== previous) return;
      this.state = { kind: "idle" };
      this.publishSnapshot();
      throw new DapError(
        "state",
        "previous cleanup failed; processes may have survived. State reset to idle; retry launch to start a new Debug Session",
        { cause },
      );
    }
  }

  /** Close the active Debug Session during Pi session shutdown, permanently. */
  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.closed = true;
    this.closeSignal.abort();
    this.disposePromise = (async () => {
      // Outlive a startup this shutdown aborted, so no adapter or Debuggee escapes the cleanup.
      await this.startup?.settled;
      if (this.rollbackFailure) throw this.rollbackFailure;
      const active = this.currentActive();
      if (active !== undefined) {
        await this.finishOperation(active, "Pi session shutdown");
      } else if (this.state.kind === "terminated") {
        await this.state.cleanupPromise;
      }
    })();
    return this.disposePromise;
  }

  private resolveLaunch(input: DapLaunchInput) {
    const profile = this.resolveLaunchProfile(input.profile);
    const adapter = this.options.settings.adapters.get(profile.adapterId);
    if (adapter === undefined) {
      throw new DapError(
        "configuration",
        `Launch Profile ${profile.id} references unavailable Adapter Definition ${profile.adapterId}`,
      );
    }
    const launchArguments = resolvedLaunchArguments(profile, input, this.options.cwd);
    const launchArgumentID = Value.Check(DapAdapterProtocolIdSchema, launchArguments.type)
      ? launchArguments.type
      : adapter.id;
    const adapterID = profile.adapterID ?? adapter.adapterID ?? launchArgumentID;
    return { adapter, profile, launchArguments, adapterID };
  }

  private resolveLaunchProfile(profileId: string | undefined): DapLaunchProfile {
    const profiles = this.options.settings.profiles;
    if (profileId !== undefined) {
      const profile = profiles.get(profileId);
      if (profile !== undefined) return profile;
      throw new DapError(
        "configuration",
        profiles.size === 0
          ? `unknown Launch Profile ${profileId}; no valid Launch Profile is configured`
          : `unknown Launch Profile ${profileId}; valid profiles: ${validProfileList(profiles)}${profiles.size === 1 ? " (profile may be omitted)" : ""}`,
      );
    }
    if (profiles.size === 1) {
      const only = profiles.values().next().value;
      if (only !== undefined) return only;
    }
    throw new DapError(
      "configuration",
      profiles.size === 0
        ? "launch requires a valid Launch Profile; no valid Launch Profile is configured"
        : `launch requires profile when there is not exactly one valid Launch Profile; valid profiles: ${validProfileList(profiles)}`,
    );
  }

  private async applyDesiredBreakpoints(
    active: ActiveDapSession,
    target: DapTarget,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const [filePath, breakpoints] of this.desiredBreakpoints) {
      await this.sendBreakpoints(active, target, filePath, breakpoints, signal);
    }
  }

  /** Send one file's Breakpoints to one target and record the ids it gave them. */
  private async sendBreakpoints(
    active: ActiveDapSession,
    target: DapTarget,
    filePath: string,
    breakpoints: readonly DapDesiredBreakpoint[],
    signal: AbortSignal | undefined,
  ): Promise<Static<typeof DapSetBreakpointsBodySchema>> {
    const response = parseDapBody(
      DapSetBreakpointsBodySchema,
      await target.client.request(
        "setBreakpoints",
        {
          source: { name: filePath.split(/[\\/]/).at(-1), path: filePath },
          breakpoints: breakpoints.map((breakpoint) => ({ ...breakpoint })),
          lines: breakpoints.map(({ line }) => line),
          sourceModified: false,
        },
        dapRequestOptions(signal),
      ),
      "setBreakpoints",
    );
    const filePrefix = breakpointKey(filePath, 0).slice(0, -1);
    for (const [id, key] of target.breakpointKeys) {
      if (key.startsWith(filePrefix)) target.breakpointKeys.delete(id);
    }
    const isPrimary = target === active.primary;
    if (isPrimary) {
      for (const key of active.reportedBreakpointIds.keys()) {
        if (key.startsWith(filePrefix)) active.reportedBreakpointIds.delete(key);
      }
    }
    response.breakpoints.forEach(({ id }, index) => {
      if (id === undefined) return;
      const key = breakpointKey(filePath, index);
      target.breakpointKeys.set(id, key);
      if (isPrimary || !active.reportedBreakpointIds.has(key)) {
        active.reportedBreakpointIds.set(key, id);
      }
    });
    return response;
  }

  /** Resume or step the target whose stop is reported, then wait for the next stop. */
  private async executeLifecycleRequest(
    command: "continue" | "next" | "stepIn" | "stepOut",
    signal: AbortSignal | undefined,
    steerSignal: AbortSignal | undefined,
  ): Promise<DapResult> {
    const active = this.requireActivePhase("stopped", command);
    const target = active.focus;
    const threadId = await this.resolveThreadId(active, target, signal);
    const { stop, continuedEvents } = target;
    target.stop = undefined;
    this.transitionActiveToRunning(active);
    return this.waitAfter(active, signal, steerSignal, async () => {
      // request() rejects an already-aborted signal without writing the request.
      const unsent = signal?.aborted === true;
      try {
        await target.client.request(command, { threadId }, dapRequestOptions(signal));
      } catch (cause) {
        // An unsent or refused request did not resume the target; waitAfter refocuses its stop.
        const unchanged = target.stop === undefined && target.continuedEvents === continuedEvents;
        if ((unsent || isAdapterRefusal(cause)) && unchanged) target.stop = stop;
        throw cause;
      }
    });
  }

  /** A Child session can end while its request is in flight; only a live child's failure counts. */
  private async unlessChildEnded<T>(
    active: ActiveDapSession,
    child: DapTarget,
    request: Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await request;
    } catch (cause) {
      if (!active.children.has(child) || child.detaching) return undefined;
      throw cause;
    }
  }

  /** Pause the primary target and every live Child session; the first stop is reported. */
  private async pauseTargets(signal: AbortSignal | undefined): Promise<DapResult> {
    const active = this.requireActivePhase("running", "pause");
    const pause = async (target: DapTarget) => {
      const threadId = await this.resolveThreadId(active, target, signal);
      await target.client.request("pause", { threadId }, dapRequestOptions(signal));
    };
    const children = [...active.children].filter((child) => child.ready);
    return this.waitAfter(active, signal, undefined, async () => {
      const results = await Promise.allSettled([
        pause(active.primary),
        ...children.map((child) => this.unlessChildEnded(active, child, pause(child))),
      ]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    });
  }

  /**
   * Send an execution request, then wait for a stop, exit, cancellation, Steer Yield, or the
   * execution timeout. A wait that ends before the request returns still lets it finish.
   */
  private async waitAfter(
    active: ActiveDapSession,
    signal: AbortSignal | undefined,
    steerSignal: AbortSignal | undefined,
    send: () => Promise<void>,
  ): Promise<DapResult> {
    const wait = this.waitForExecutionTransition(signal, steerSignal);
    try {
      await send();
    } catch (cause) {
      wait.cancel();
      // A target that stopped meanwhile stays reportable even though this request failed.
      this.focusQueuedStop(active);
      if (isProtocolCancellation(cause)) return this.stoppedResult(active, await wait.promise);
      throw cause;
    }
    // Another target stopped while this one was stopped: its stop is reported next, right away.
    this.focusQueuedStop(active);
    const outcome = await wait.promise;
    await active.cleanupPromise;
    return this.stoppedResult(active, outcome);
  }

  /** Result that, when the Debuggee is stopped, says where and why without a separate stack call. */
  private async stoppedResult(
    active: ActiveDapSession,
    outcome?: ExecutionWaitOutcome,
  ): Promise<DapResult> {
    if (this.isCurrentActive(active) && active.phase === "stopped") {
      const stopSequence = active.stopSequence;
      const topFrame = await this.readTopFrame(active);
      if (
        topFrame !== undefined &&
        this.isCurrentActive(active) &&
        active.phase === "stopped" &&
        active.stopSequence === stopSequence
      ) {
        active.topFrame = topFrame;
      }
    }
    return this.result({
      ...(outcome === "steered" || outcome === "cancelled" ? { waitEnd: outcome } : {}),
      ...this.stopPayload(),
      ...this.drainRejectedChildSessions(),
    });
  }

  /** Unreported child sessions HL DAP could not debug, once, like unread Debuggee output. */
  private drainRejectedChildSessions(): Pick<DapResult, "rejectedChildSessions"> {
    if (this.rejectedChildSessions.length === 0) return {};
    return { rejectedChildSessions: this.rejectedChildSessions.splice(0) };
  }

  /**
   * Best effort: a stop is still reported when the adapter cannot give its top Stack Frame. The read
   * ignores the tool's cancellation signal so a cancel after the stop cannot discard the location.
   */
  private async readTopFrame(
    active: ActiveDapSession,
  ): Promise<DebugProtocol.StackFrame | undefined> {
    const target = active.focus;
    try {
      const body = parseDapBody(
        DapStackTraceBodySchema,
        await target.client.request(
          "stackTrace",
          {
            threadId: await this.resolveThreadId(active, target, undefined),
            startFrame: 0,
            levels: 1,
          },
          dapRequestOptions(undefined),
        ),
        "stackTrace",
      );
      return body.stackFrames.at(0);
    } catch {
      return undefined;
    }
  }

  private stopPayload(): Pick<DapResult, "stop"> {
    const active = this.currentActive();
    if (active === undefined || active.phase !== "stopped") return {};
    const { focus } = active;
    const stop: Mutable<DapStopDetails> = {};
    if (focus.stop?.description !== undefined) stop.description = focus.stop.description;
    if (focus.stop?.hitBreakpointIds !== undefined) {
      stop.hitBreakpointIds = focus.stop.hitBreakpointIds.map((id) => {
        const key = focus.breakpointKeys.get(id);
        return key === undefined ? id : (active.reportedBreakpointIds.get(key) ?? id);
      });
    }
    if (active.topFrame !== undefined) stop.topFrame = active.topFrame;
    if (focus.childSessionName !== undefined) stop.childSession = focus.childSessionName;
    return { stop };
  }

  /** The adapter thread id of the target's stop, else of its first thread. */
  private async resolveThreadId(
    active: ActiveDapSession,
    target: DapTarget,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    if (target.threadId !== undefined) return target.threadId;
    const body = parseDapBody(
      DapThreadsBodySchema,
      await target.client.request("threads", {}, dapRequestOptions(signal)),
      "threads",
    );
    const threadId = body.threads.at(0)?.id;
    if (threadId === undefined) {
      throw new DapError("state", "Debuggee has no thread available for this operation");
    }
    target.threadId = threadId;
    this.assignPiThreadId(active, target, threadId);
    return threadId;
  }

  /** Assign, once, the thread id Pi reports for a target's adapter thread id. */
  private assignPiThreadId(
    active: ActiveDapSession,
    target: DapTarget,
    adapterThreadId: number,
  ): number {
    if (target.piThreadIds === undefined) return adapterThreadId;
    const known = target.piThreadIds.get(adapterThreadId);
    if (known !== undefined) return known;
    const threadId = active.nextThreadId++;
    target.piThreadIds.set(adapterThreadId, threadId);
    active.threadOwners.set(threadId, { target, threadId: adapterThreadId });
    return threadId;
  }

  /** The adapter thread id behind a reported thread id, which must belong to the stopped target. */
  private adapterThreadId(active: ActiveDapSession, threadId: number): number {
    if (active.focus.piThreadIds === undefined) return threadId;
    const owner = active.threadOwners.get(threadId);
    if (owner === undefined || owner.target !== active.focus) {
      throw new DapError(
        "state",
        `stack requires a thread of the stopped target; thread ${String(threadId)} is not one`,
      );
    }
    return owner.threadId;
  }

  /** Frame and variable ids are target-local, so an answer is void once another stop has the focus. */
  private requireTarget(
    active: ActiveDapSession,
    target: DapTarget,
    sequence: number,
    operation: string,
  ): void {
    if (
      !this.isCurrentActive(active) ||
      active.phase !== "stopped" ||
      active.focus !== target ||
      active.stopSequence !== sequence
    ) {
      throw new DapError("state", `${operation} requires the stopped target it started on`);
    }
  }

  private requestVariables(
    target: DapTarget,
    variablesReference: number,
    start: number,
    count: number,
    signal: AbortSignal | undefined,
  ): Promise<Static<typeof DapVariablesBodySchema>> {
    return target.client
      .request("variables", { variablesReference, start, count }, dapRequestOptions(signal))
      .then((body) => parseDapBody(DapVariablesBodySchema, body, "variables"));
  }

  private requireActivePhase(phase: "running" | "stopped", operation: string): ActiveDapSession {
    const active = this.prepareOperation();
    if (active === undefined || active.phase !== phase) {
      throw new DapError("state", `${operation} requires a ${phase} Debuggee`);
    }
    return active;
  }

  private prepareOperation(): ActiveDapSession | undefined {
    const active = this.currentActive();
    if (active === undefined) return undefined;
    try {
      for (const child of active.debuggeeProcesses) {
        if (probeOwnedProcessGroup(child) === false) active.debuggeeProcesses.delete(child);
      }
    } catch (cause) {
      const error = new DapError("adapter", "owned Debuggee group probe failed", {
        cause,
      });
      this.handleAdapterFailure(active, error);
      throw error;
    }
    return active;
  }

  private async finishOperation(active: ActiveDapSession, reason: string): Promise<void> {
    try {
      this.prepareOperation();
    } catch (cause) {
      await this.finishActiveSession(active, reason, cause);
      throw cause;
    }
    await this.finishActiveSession(active, reason);
  }

  private currentActive(): ActiveDapSession | undefined {
    return this.state.kind === "active" ? this.state.active : undefined;
  }

  private isCurrentActive(active: ActiveDapSession): boolean {
    return this.state.kind === "active" && this.state.active === active;
  }

  private handleDapEvent(
    active: ActiveDapSession,
    event: DebugProtocol.Event,
    channel: "root" | "target" | "child",
    target: DapTarget,
  ): void {
    if (!this.isCurrentActive(active)) return;
    if (channel === "child" && (!active.children.has(target) || target.detaching)) return;
    try {
      this.dispatchDapEvent(active, event, channel, target);
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error("DAP Session: invalid Debug Adapter event", { cause });
      // A Child session that misbehaves is dropped; the Debuggee's own session goes on.
      if (channel === "child") {
        this.removeChildSession(active, target, error);
        return;
      }
      this.handleAdapterFailure(active, error);
    }
  }

  private dispatchDapEvent(
    active: ActiveDapSession,
    event: DebugProtocol.Event,
    channel: "root" | "target" | "child",
    target: DapTarget,
  ): void {
    switch (event.event) {
      case "output":
        this.handleOutputEvent(active, event, channel);
        return;
      case "stopped":
        this.handleStoppedEvent(active, event, target);
        return;
      case "continued":
        this.handleContinuedEvent(active, event, target);
        return;
      case "exited":
        // A Child session's exit is not the Debuggee's; its `terminated` ends its channel.
        if (channel === "child") return;
        active.exitCode = parseDapBody(
          DapExitedEventBodySchema,
          event.body,
          "exited event",
        ).exitCode;
        active.exitedCode = true;
        if (!active.stopping) {
          void this.finishAfterChannelsTerminate(active).catch(() => undefined);
        }
        return;
      case "terminated":
        this.handleTerminatedEvent(active, channel, target);
        return;
      default:
        return;
    }
  }

  private handleOutputEvent(
    active: ActiveDapSession,
    event: DebugProtocol.Event,
    channel: "root" | "target" | "child",
  ): void {
    const body = parseDapBody(DapOutputEventBodySchema, event.body, "output event");
    // Adapters can send diagnostics with category "telemetry"; they are not Debuggee output.
    if (body.category !== "telemetry") this.output.append(body.output);
    // An adapter-declared exit report stands in for a missing `exited` event on the root channel.
    // The last report wins over an earlier report, but never over the standard `exited` event.
    const report = active.adapter.outputExitReport;
    if (
      report !== undefined &&
      channel === "root" &&
      active.targetClient !== undefined &&
      !active.exitedCode &&
      outputReportApplies(report, active.launchArguments)
    ) {
      const exitCode = outputReportExitCode(body, report);
      if (exitCode !== undefined) active.exitCode = exitCode;
    }
  }

  private handleStoppedEvent(
    active: ActiveDapSession,
    event: DebugProtocol.Event,
    target: DapTarget,
  ): void {
    const body = parseDapBody(DapStoppedEventBodySchema, event.body, "stopped event");
    target.stop = {
      arrival: ++active.stopArrivals,
      reason: body.reason,
      description: body.description,
      hitBreakpointIds: body.hitBreakpointIds,
    };
    target.threadId = body.threadId;
    if (body.threadId !== undefined) this.assignPiThreadId(active, target, body.threadId);
    // One stop is reported at a time; a stop in another target waits its turn.
    if (active.phase !== "stopped" || active.focus === target) this.focusStop(active, target);
  }

  private handleContinuedEvent(
    active: ActiveDapSession,
    event: DebugProtocol.Event,
    target: DapTarget,
  ): void {
    const body = parseDapBody(DapContinuedEventBodySchema, event.body, "continued event");
    target.stop = undefined;
    target.continuedEvents++;
    if (body.threadId !== undefined) {
      target.threadId = body.threadId;
      this.assignPiThreadId(active, target, body.threadId);
    }
    if (active.focus === target) {
      this.transitionActiveToRunning(active);
      this.focusQueuedStop(active);
    }
  }

  private handleTerminatedEvent(
    active: ActiveDapSession,
    channel: "root" | "target" | "child",
    target: DapTarget,
  ): void {
    if (active.stopping) return;
    if (channel === "child") {
      this.removeChildSession(active, target, undefined, true);
      return;
    }
    if (channel === "root") active.rootTerminated = true;
    else active.targetTerminated = true;
    // finishActiveSession reports cleanup failures and retains the rejected outcome.
    void this.finishAfterChannelsTerminate(active).catch(() => undefined);
  }

  /** Report a target's stop: it becomes the target inspection and stepping operations use. */
  private focusStop(active: ActiveDapSession, target: DapTarget): void {
    active.focus = target;
    active.phase = "stopped";
    active.topFrame = undefined;
    active.stopSequence++;
    this.publishSnapshot();
    this.settleExecutionWaiters();
  }

  /** While running, report the stop that has waited longest, if any target has one. */
  private focusQueuedStop(active: ActiveDapSession): void {
    if (!this.isCurrentActive(active) || active.phase === "stopped") return;
    let queued: DapTarget | undefined;
    for (const target of [active.primary, ...active.children]) {
      if (target.stop === undefined) continue;
      if (queued?.stop === undefined || target.stop.arrival < queued.stop.arrival) queued = target;
    }
    if (queued !== undefined) this.focusStop(active, queued);
  }

  /** Forget a Child session that ended or failed, and detach its channel. */
  private removeChildSession(
    active: ActiveDapSession,
    target: DapTarget,
    firstFailure?: Error,
    alreadyTerminated = false,
  ): void {
    if (!active.children.has(target) || target.detaching) return;
    target.detaching = true;
    target.ready = false;
    target.stop = undefined;
    this.wakeTerminationWaiters(active);
    void target.client.detach(alreadyTerminated).then(
      () => {
        active.children.delete(target);
        if (firstFailure !== undefined) this.recordFailedChildSession(target, firstFailure);
      },
      (cause: unknown) =>
        this.handleAdapterFailure(
          active,
          firstFailure ??
            (cause instanceof Error
              ? cause
              : new DapError("adapter", "child channel cleanup failed", {
                  cause,
                })),
        ),
    );
    if (active.focus !== target) return;
    active.focus = active.primary;
    if (active.phase === "stopped") {
      this.transitionActiveToRunning(active);
      this.focusQueuedStop(active);
    }
  }

  /**
   * A promoted adapter reports `terminated` on both the primary target channel and the root channel,
   * in either order. The root channel's comes last of its events and follows any exit report, which
   * is also where a late root output event would otherwise be lost. Children drain independently,
   * so retain each until it terminates or fails, within the same shutdown budget. When the adapter
   * declares an exit report and its rule applies, a clean run sends none, so a root `terminated`
   * with no earlier code means the report's clean exit code. Otherwise the exit code stays whatever
   * the Debuggee's `runInTerminal` child recorded, or unknown. A timeout finishes with the exit code
   * unknown unless the root ended.
   *
   * This assumes one primary target channel, as the V1 boundary allows; more would need a count.
   */
  private async finishAfterChannelsTerminate(active: ActiveDapSession): Promise<void> {
    this.wakeTerminationWaiters(active);
    if (active.completionStarted) return;
    active.completionStarted = true;
    await new Promise<void>((resolveWait) => {
      const finish = () => {
        clearTimeout(timer);
        active.settleTermination.delete(settle);
        resolveWait();
      };
      const settle = () => {
        if (active.stopping || this.channelsTerminated(active)) finish();
      };
      const timer = setTimeout(finish, this.options.settings.timeouts.shutdownMs);
      active.settleTermination.add(settle);
      settle();
    });
    if (!this.isCurrentActive(active) || active.stopping) return;
    const report = active.adapter.outputExitReport;
    if (
      report !== undefined &&
      active.rootTerminated &&
      active.exitCode === undefined &&
      !active.exitedCode &&
      outputReportApplies(report, active.launchArguments)
    ) {
      active.exitCode = report.cleanExitCode;
    }
    await this.finishActiveSession(
      active,
      active.exitedCode ? "Debuggee exited" : "Debug Session terminated",
    );
  }

  private wakeTerminationWaiters(active: ActiveDapSession): void {
    for (const settle of active.settleTermination) settle();
  }

  private channelsTerminated(active: ActiveDapSession): boolean {
    const parentsEnded =
      active.exitedCode ||
      (active.rootTerminated && (active.targetClient === undefined || active.targetTerminated));
    return parentsEnded && [...active.children].every((child) => child.detaching);
  }

  private handleAdapterFailure(active: ActiveDapSession, error: Error): void {
    active.failure ??= error;
    if (!this.isCurrentActive(active) || active.stopping) return;
    void this.finishActiveSession(active, error.message);
  }

  private handleReverseRequest(
    request: DebugProtocol.Request,
    debuggeeProcesses: Set<ChildProcessWithoutNullStreams>,
    getActive: () => ActiveDapSession | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DapReverseRequestResult> | DapReverseRequestResult {
    if (request.command === "startDebugging") {
      return this.handleStartDebugging(request, getActive, signal);
    }
    if (request.command !== "runInTerminal") {
      return {
        success: false,
        message: `HL DAP: unsupported reverse request ${request.command}`,
      };
    }
    if (!Value.Check(RunInTerminalArgumentsSchema, request.arguments)) {
      return {
        success: false,
        message: "HL DAP: runInTerminal arguments are invalid",
      };
    }
    return this.spawnRunInTerminal(request.arguments, debuggeeProcesses, getActive);
  }

  /**
   * Serve a `startDebugging` request: it carries only the `launch` or `attach` arguments for the
   * session it asks for. The Adapter Definition decides whether this adapter may start one, and its
   * transport must be able to host another channel; nothing in the request selects an endpoint.
   */
  private handleStartDebugging(
    request: DebugProtocol.Request,
    getActive: () => ActiveDapSession | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DapReverseRequestResult> | DapReverseRequestResult {
    const active = getActive();
    const child = childSessionRequest(request, active?.adapter.channels?.targetIdKey);
    if (child === undefined) {
      return {
        success: false,
        message: "HL DAP: startDebugging arguments are invalid",
      };
    }
    if (active === undefined) {
      return {
        success: false,
        message: `HL DAP refused child session ${child.description}: no Debug Session is active.`,
      };
    }
    if (this.isStopping(active)) {
      return {
        success: false,
        message: "HL DAP: startDebugging was refused because the Debug Session is stopping",
      };
    }
    return this.startRequestedSession(active, child, signal);
  }

  /** Serve the session a `startDebugging` request asks for once its Debug Session can host one. */
  private startRequestedSession(
    active: ActiveDapSession,
    child: ChildSessionRequest,
    signal: AbortSignal | undefined,
  ): Promise<DapReverseRequestResult> | DapReverseRequestResult {
    if (active.adapter.channels?.sessions !== "promoted") {
      return this.refuseChildSession(child, "the Debug Adapter declares no Debug targets");
    }
    if (active.adapter.transport.type !== "tcp") {
      return this.refuseChildSession(
        child,
        "the Debug Adapter's transport cannot host another session channel",
      );
    }
    if (active.adapter.channels.firstSessionIsPrimary === true && !active.targetChannelStarted) {
      return this.startPrimaryTarget(active, child, signal).catch((cause: unknown) => {
        // A stale or stopping session must not record a new primary failure after its own end.
        if (this.isCurrentActive(active) && !active.stopping) {
          this.handleAdapterFailure(
            active,
            cause instanceof Error ? cause : new Error(String(cause)),
          );
        }
        throw cause;
      });
    }
    return this.dapChildSession(active, child);
  }

  /** Name a Child session that failed mid-run once in the next operation result. */
  private recordFailedChildSession(target: DapTarget, failure: Error): void {
    const name = target.childSessionName ?? "unnamed";
    const message = `HL DAP stopped debugging child session ${name}: ${failure.message}. Breakpoints in it no longer bind.`;
    this.rejectedChildSessions.push(
      target.childSessionName === undefined ? { message } : { name, message },
    );
  }

  /** Refuse a Child session, naming it once in the next operation result. */
  private refuseChildSession(child: ChildSessionRequest, reason: string): DapReverseRequestResult {
    const message = `HL DAP could not debug child session ${child.description}: ${reason}. Breakpoints in it will not bind.`;
    this.rejectedChildSessions.push(rejectedChildSession(message, child));
    return { success: false, message };
  }

  /**
   * Debug a Child session (a worker thread, a child process, or a child's own child) that the
   * adapter asks for on its parent's channel: open a session channel for it against the same
   * adapter endpoint, apply Desired Breakpoints, and start it with the `launch` or `attach`
   * arguments it sent. Its stops are reported one at a time with the primary target's. A Child
   * session HL DAP cannot start is reported in the next operation result; a channel that attached
   * and then failed is detached, which lets the adapter run the child without a debugger.
   */
  private async dapChildSession(
    active: ActiveDapSession,
    child: ChildSessionRequest,
  ): Promise<DapReverseRequestResult> {
    try {
      await this.attachChildSession(active, child);
      return { success: true };
    } catch (cause) {
      return this.refuseChildSession(child, errorText(cause));
    }
  }

  /**
   * The channel joins the Child sessions before it starts, so its stops, its own children, and its
   * `terminated` are handled like any target's; it leaves them when it terminates or fails.
   */
  private async attachChildSession(
    active: ActiveDapSession,
    child: ChildSessionRequest,
  ): Promise<void> {
    const { startupMs, requestMs } = this.options.settings.timeouts;
    let attached: DapTarget | undefined;
    const client = await active.rootClient.connectTargetChannel({
      onReverseRequest: (nested) =>
        this.handleReverseRequest(nested, active.debuggeeProcesses, () => active, undefined),
      onFailure: (error) => {
        if (attached !== undefined) this.removeChildSession(active, attached, error);
      },
    });
    if (!this.isCurrentActive(active) || this.isStopping(active)) {
      await this.detachStoppedChannel(client);
    }
    const target = dapTarget(client, child.name ?? child.description, true);
    attached = target;
    active.children.add(target);
    active.unsubscribeEvents.add(
      client.onEvent((event) => this.handleDapEvent(active, event, "child", target)),
    );
    try {
      const initialized = client.waitForEvent("initialized", {
        timeoutMs: startupMs,
      });
      initialized.catch(() => undefined);
      const capabilities = parseDapBody(
        DapCapabilitiesSchema,
        await client.request(
          "initialize",
          // A Child session's own children are asked for on its channel.
          initializeArguments(active.adapterID, false, true),
          { timeoutMs: startupMs },
        ),
        "initialize child session",
      );
      const launchOutcome = launchOutcomeOf(
        client.request(child.request, { ...child.configuration }, { timeoutMs: requestMs }),
      );
      await awaitInitialized(initialized, launchOutcome);
      target.ready = true;
      await this.applyDesiredBreakpoints(active, target, undefined);
      if (capabilities.supportsConfigurationDoneRequest === true) {
        await client.request("configurationDone", {}, { timeoutMs: requestMs });
      }
      const launchResult = await launchOutcome;
      if (launchResult.kind === "failure") throw launchResult.error;
    } catch (cause) {
      this.removeChildSession(active, target);
      throw cause;
    }
  }

  /**
   * The first promoted channel of an adapter whose policy says the root channel only launched it.
   * It becomes the primary target, so its capabilities, Breakpoint ids, and `terminated` govern.
   */
  private async startPrimaryTarget(
    active: ActiveDapSession,
    child: ChildSessionRequest,
    signal: AbortSignal | undefined,
  ): Promise<DapReverseRequestResult> {
    active.targetChannelStarted = true;
    const targetClient = await active.rootClient.connectTargetChannel({
      startupSignal: signal,
      onReverseRequest: (request) =>
        this.handleReverseRequest(request, active.debuggeeProcesses, () => active, signal),
      onFailure: (error) => this.handleAdapterFailure(active, error),
    });
    if (!this.isCurrentActive(active) || this.isStopping(active)) {
      await this.detachStoppedChannel(targetClient);
    }
    const primary = dapTarget(targetClient, undefined, true);
    active.targetClient = targetClient;
    active.primary = primary;
    active.focus = primary;
    active.unsubscribeEvents.add(
      targetClient.onEvent((event) => this.handleDapEvent(active, event, "target", primary)),
    );

    const initialized = targetClient.waitForEvent(
      "initialized",
      dapRequestOptions(signal, this.options.settings.timeouts.startupMs),
    );
    // An `initialize` that fails early would otherwise leave this waiter unobserved.
    initialized.catch(() => undefined);
    const capabilities = parseDapBody(
      DapCapabilitiesSchema,
      await targetClient.request(
        "initialize",
        // The primary target asks for its own Child sessions on this channel.
        initializeArguments(active.adapterID, true, true),
        dapRequestOptions(signal, this.options.settings.timeouts.startupMs),
      ),
      "initialize primary target",
    );
    targetClient.setSupportsTerminateRequest(capabilities.supportsTerminateRequest === true);
    const launchOutcome = launchOutcomeOf(
      targetClient.request(child.request, { ...child.configuration }, dapRequestOptions(signal)),
    );
    await awaitInitialized(initialized, launchOutcome);
    primary.ready = true;
    await this.applyDesiredBreakpoints(active, primary, signal);
    if (capabilities.supportsConfigurationDoneRequest === true) {
      await targetClient.request("configurationDone", {}, dapRequestOptions(signal));
    }
    const launchResult = await launchOutcome;
    if (launchResult.kind === "failure") throw launchResult.error;
    return { success: true };
  }

  /**
   * Detach a channel whose Debug Session teardown already passed. The detach result is kept so a
   * failed detach is not reported as a clean end.
   */
  private async detachStoppedChannel(client: DapConnection): Promise<never> {
    const ended = "the Debug Session ended";
    try {
      await client.detach();
    } catch (cause) {
      throw new Error(`${ended}: the channel did not detach: ${errorText(cause)}`, { cause });
    }
    throw new Error(ended);
  }

  /** Whether this Debug Session is ending, so nothing new may start in it. */
  private isStopping(active: ActiveDapSession | undefined): boolean {
    return this.closed || active?.stopping === true || active?.completionStarted === true;
  }

  private async spawnRunInTerminal(
    argumentsValue: Static<typeof RunInTerminalArgumentsSchema>,
    debuggeeProcesses: Set<ChildProcessWithoutNullStreams>,
    getActive: () => ActiveDapSession | undefined,
  ): Promise<DapReverseRequestResult> {
    const environment = resolveProcessEnvironment(argumentsValue.env ?? {});
    const interpretedByShell = argumentsValue.argsCanBeInterpretedByShell === true;
    const command = interpretedByShell ? argumentsValue.args.join(" ") : argumentsValue.args[0];
    if (command === undefined)
      return {
        success: false,
        message: "HL DAP: runInTerminal has no command",
      };
    const commandArguments = interpretedByShell ? [] : argumentsValue.args.slice(1);
    // A terminal started after cleanup's sweep would outlive the Debug Session, so teardown
    // refuses it before spawning.
    if (this.isStopping(getActive())) {
      return { success: false, message: RUN_IN_TERMINAL_STOPPING_MESSAGE };
    }
    const child = spawn(command, commandArguments, {
      cwd: argumentsValue.cwd,
      detached: process.platform !== "win32",
      env: environment,
      shell: interpretedByShell,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.output.append(chunk));
    child.stderr.on("data", (chunk: string) => this.output.append(chunk));
    try {
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
    } catch (cause) {
      return {
        success: false,
        message: `HL DAP: runInTerminal failed: ${errorText(cause)}`,
      };
    }
    debuggeeProcesses.add(child);
    const activeAtSpawn = getActive();
    // Teardown can start while this child spawns: the sweep may already have run, so stop it here.
    if (this.isStopping(activeAtSpawn)) {
      await stopOwnedProcessGroup(child, Date.now() + this.options.settings.timeouts.shutdownMs);
      return { success: false, message: RUN_IN_TERMINAL_STOPPING_MESSAGE };
    }
    // An active owner is needed to route probe errors through session cleanup.
    if (activeAtSpawn !== undefined) {
      child.once("close", () => {
        if (activeAtSpawn.stopping) return;
        try {
          if (probeOwnedProcessGroup(child) === false) debuggeeProcesses.delete(child);
        } catch (cause) {
          this.handleAdapterFailure(
            activeAtSpawn,
            cause instanceof Error
              ? cause
              : new DapError("adapter", "owned Debuggee group probe failed", {
                  cause,
                }),
          );
        }
      });
    }
    // The owned child's exit status is a fallback for adapters without a standard exited event.
    // A stop requested by Pi must not look like a Debuggee exit.
    child.once("exit", (code) => {
      const active = getActive();
      if (code !== null && active !== undefined && !active.stopping && !active.exitedCode)
        active.exitCode = code;
    });
    return {
      success: true,
      body: { processId: child.pid, shellProcessId: child.pid },
    };
  }

  private waitForExecutionTransition(
    signal: AbortSignal | undefined,
    steerSignal: AbortSignal | undefined,
  ): ExecutionWait {
    let finish: ((outcome: ExecutionWaitOutcome) => void) | undefined;
    const promise = new Promise<ExecutionWaitOutcome>((resolveWait) => {
      const timer = setTimeout(
        () => finish?.("timeout"),
        this.options.settings.timeouts.executionMs,
      );
      const onAbort = () => finish?.("cancelled");
      const onSteer = () => finish?.("steered");
      finish = (outcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        steerSignal?.removeEventListener("abort", onSteer);
        this.executionWaiters.delete(onTransition);
        finish = undefined;
        resolveWait(outcome);
      };
      const onTransition = () => finish?.("transition");
      this.executionWaiters.add(onTransition);
      signal?.addEventListener("abort", onAbort, { once: true });
      steerSignal?.addEventListener("abort", onSteer, { once: true });
      // Cancellation outranks a Steer Yield when both are already true.
      if (signal?.aborted === true) finish("cancelled");
      else if (steerSignal?.aborted === true) finish("steered");
    });
    return { promise, cancel: () => finish?.("cancelled") };
  }

  private settleExecutionWaiters(): void {
    for (const settle of this.executionWaiters) settle();
  }

  private finishActiveSession(
    active: ActiveDapSession,
    terminationReason: string,
    initialFailure?: unknown,
  ): Promise<void> {
    if (active.cleanupPromise !== undefined) return active.cleanupPromise;
    active.stopping = true;
    // Interrupt natural completion so explicit stop and failure cleanup never wait for its timer.
    this.wakeTerminationWaiters(active);
    const cleanup = Promise.resolve().then(() => this.cleanUpActiveSession(active, initialFailure));
    active.cleanupPromise = cleanup;
    void cleanup.then(
      () => {
        if (active.failure !== undefined) this.publishUnexpectedFailure(active.failure);
      },
      (cause: unknown) =>
        this.publishUnexpectedFailure(
          cause instanceof Error ? cause : new DapError("adapter", "cleanup failed", { cause }),
        ),
    );
    if (this.isCurrentActive(active)) {
      const terminated: Mutable<Extract<DapState, { kind: "terminated" }>> = {
        kind: "terminated",
        adapterId: active.adapter.id,
        profileId: active.profile.id,
        cleanupPromise: cleanup,
      };
      if (active.exitCode !== undefined) terminated.exitCode = active.exitCode;
      if (terminationReason.length > 0) terminated.terminationReason = terminationReason;
      this.state = terminated;
      this.publishSnapshot();
    }
    this.settleExecutionWaiters();
    return cleanup;
  }

  private async cleanUpActiveSession(
    active: ActiveDapSession,
    initialFailure: unknown,
  ): Promise<void> {
    for (const unsubscribe of active.unsubscribeEvents) unsubscribe();
    active.unsubscribeEvents.clear();
    const results = await Promise.allSettled(
      [...active.children].map((child) => child.client.detach()),
    );
    results.push(...(await Promise.allSettled([active.targetClient?.dispose()])));
    results.push(...(await Promise.allSettled([active.rootClient.dispose()])));
    results.push(
      ...(await Promise.allSettled(
        [...active.debuggeeProcesses].map((child) =>
          stopOwnedProcessGroup(child, Date.now() + this.options.settings.timeouts.shutdownMs),
        ),
      )),
    );
    const errors: unknown[] = results.flatMap((result): unknown[] =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 0) return;
    const firstFailure = active.failure ?? initialFailure;
    if (firstFailure !== undefined && !errors.includes(firstFailure)) errors.unshift(firstFailure);
    throw new DapError("adapter", "Debug Session cleanup failed", {
      cause: new AggregateError(errors, "Debug Session failure and cleanup failures"),
    });
  }

  private async cleanUpUnstartedSession(
    debuggeeProcesses: Set<ChildProcessWithoutNullStreams>,
    cause: unknown,
    client: DapConnection | undefined,
  ): Promise<void> {
    // Stop the adapter first so it cannot spawn a Debuggee the sweep below would miss.
    const results = await Promise.allSettled([client?.dispose()]);
    results.push(
      ...(await Promise.allSettled(
        [...debuggeeProcesses].map((child) =>
          stopOwnedProcessGroup(child, Date.now() + this.options.settings.timeouts.shutdownMs),
        ),
      )),
    );
    this.state = { kind: "idle" };
    this.publishSnapshot();
    const errors: unknown[] = results.flatMap((result): unknown[] =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (!errors.length && !(cause instanceof DapConnectionError && cause.rollbackFailed)) return;
    const error = new DapError("adapter", "launch and Debuggee cleanup failed", {
      cause: new AggregateError([cause, ...errors], "Launch failure and cleanup failures"),
    });
    this.rollbackFailure = error;
    this.publishUnexpectedFailure(error);
    throw error;
  }

  private transitionActiveToRunning(active: ActiveDapSession): void {
    if (!this.isCurrentActive(active)) return;
    const changed = active.phase !== "running";
    active.phase = "running";
    active.topFrame = undefined;
    if (changed) this.publishSnapshot();
  }

  private publishSnapshot(): void {
    try {
      this.options.onSnapshotChange?.(this.snapshot());
    } catch {
      // Observer UI failures cannot change Debug Session cleanup or protocol behavior.
    }
  }

  private publishUnexpectedFailure(error: Error): void {
    try {
      this.options.onUnexpectedFailure?.(error);
    } catch {
      // Observer UI failures cannot change Debug Session cleanup or protocol behavior.
    }
  }

  /** Current lifecycle snapshot, without draining unread Debuggee output. */
  snapshot(): DapSnapshot {
    if (this.state.kind === "idle") return { state: "idle" };
    if (this.state.kind === "terminated") {
      return terminatedSnapshot(this.state);
    }
    const active = this.state.active;
    if (active.phase === "stopped") {
      const snapshot: Mutable<Extract<DapSnapshot, { state: "stopped" }>> = {
        state: "stopped",
        adapterId: active.adapter.id,
        profileId: active.profile.id,
        stopReason: active.focus.stop?.reason ?? "unknown",
      };
      const { piThreadIds, threadId } = active.focus;
      const reported =
        threadId === undefined || piThreadIds === undefined ? threadId : piThreadIds.get(threadId);
      if (reported !== undefined) snapshot.threadId = reported;
      return snapshot;
    }
    return {
      state: active.phase,
      adapterId: active.adapter.id,
      profileId: active.profile.id,
    };
  }

  private result(
    payload: Omit<
      DapResult,
      "snapshot" | "output" | "discardedOutputBytes" | "desiredBreakpoints"
    > = {},
  ): DapResult {
    const output = this.output.drain();
    return {
      snapshot: this.snapshot(),
      output: output.text,
      discardedOutputBytes: output.discardedBytes,
      desiredBreakpoints: [...this.desiredBreakpoints]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([filePath, breakpoints]) => ({ filePath, breakpoints })),
      ...payload,
    };
  }
}
