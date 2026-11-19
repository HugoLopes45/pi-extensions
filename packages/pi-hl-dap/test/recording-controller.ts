import type {
  DapEvaluateInput,
  DapLaunchInput,
  DapResult,
  DapSnapshot,
  DapSetBreakpointsInput,
  DapStackInput,
  DapVariablesInput,
} from "../src/controller.js";

export type RecordedDapInput =
  | DapEvaluateInput
  | DapLaunchInput
  | DapSetBreakpointsInput
  | DapStackInput
  | DapVariablesInput;

interface RecordedCall {
  input?: RecordedDapInput;
  readonly name: string;
  signal?: AbortSignal;
  steerSignal?: AbortSignal;
}

export class RecordingDapController {
  readonly calls: RecordedCall[] = [];
  wait: Promise<void> | undefined;
  /** Hold each call until its steer signal aborts, as a real execution wait does. */
  yieldOnSteer = false;
  result: DapResult = {
    snapshot: { state: "idle" },
    output: "",
    discardedOutputBytes: 0,
    desiredBreakpoints: [],
  };

  private async record(
    name: string,
    input?: RecordedDapInput,
    signal?: AbortSignal,
    steerSignal?: AbortSignal,
  ): Promise<DapResult> {
    const call: RecordedCall = { name };
    if (input !== undefined) call.input = input;
    if (signal !== undefined) call.signal = signal;
    if (steerSignal !== undefined) call.steerSignal = steerSignal;
    this.calls.push(call);
    await this.wait;
    if (this.yieldOnSteer && steerSignal !== undefined) {
      await new Promise<void>((settle) => {
        if (steerSignal.aborted) settle();
        else steerSignal.addEventListener("abort", () => settle(), { once: true });
      });
    }
    return this.result;
  }

  launch(
    input: DapLaunchInput = {},
    signal?: AbortSignal,
    steerSignal?: AbortSignal,
  ): Promise<DapResult> {
    return this.record("launch", input, signal, steerSignal);
  }

  setBreakpoints(input: DapSetBreakpointsInput, signal?: AbortSignal): Promise<DapResult> {
    return this.record("setBreakpoints", input, signal);
  }

  continue(signal?: AbortSignal, steerSignal?: AbortSignal): Promise<DapResult> {
    return this.record("continue", undefined, signal, steerSignal);
  }

  next(signal?: AbortSignal, steerSignal?: AbortSignal): Promise<DapResult> {
    return this.record("next", undefined, signal, steerSignal);
  }

  stepIn(signal?: AbortSignal, steerSignal?: AbortSignal): Promise<DapResult> {
    return this.record("stepIn", undefined, signal, steerSignal);
  }

  stepOut(signal?: AbortSignal, steerSignal?: AbortSignal): Promise<DapResult> {
    return this.record("stepOut", undefined, signal, steerSignal);
  }

  pause(signal?: AbortSignal): Promise<DapResult> {
    return this.record("pause", undefined, signal);
  }

  stack(input: DapStackInput = {}, signal?: AbortSignal): Promise<DapResult> {
    return this.record("stack", input, signal);
  }

  variables(input: DapVariablesInput, signal?: AbortSignal): Promise<DapResult> {
    return this.record("variables", input, signal);
  }

  evaluate(input: DapEvaluateInput, signal?: AbortSignal): Promise<DapResult> {
    return this.record("evaluate", input, signal);
  }

  status(): DapResult {
    this.calls.push({ name: "status" });
    return this.result;
  }

  snapshot(): DapSnapshot {
    this.calls.push({ name: "snapshot" });
    return this.result.snapshot;
  }

  stop(): Promise<DapResult> {
    return this.record("stop");
  }
}
