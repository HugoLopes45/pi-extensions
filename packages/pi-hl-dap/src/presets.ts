/**
 * Adapter-declared facts the Debug Session core reads. Data only: no behavior, and no import from
 * the core, so adapter knowledge changes here without changing the DAP implementation.
 */
export interface DapChannelPolicy {
  /** `root`: the adapter debugs only on its session channel. `promoted`: it asks for targets with `startDebugging`. */
  readonly sessions: "root" | "promoted";
  /** The first promoted channel is the primary target; the root channel only launched it. */
  readonly firstSessionIsPrimary?: boolean;
  /** Configuration key holding the adapter's pending target id, for presentation only. */
  readonly targetIdKey?: string;
}

/** An adapter's Debuggee exit report for adapters that never send the standard `exited` event. */
export interface DapOutputExitReport {
  /** Output event category the report arrives in. */
  readonly category: string;
  /** Report pattern; the first capture group is the exit code. */
  readonly pattern: RegExp;
  /** Exit code the report implies when a clean run sends none. */
  readonly cleanExitCode: number;
  /** The rule applies only while these launch argument conditions hold. */
  readonly onlyWhenArgument?: {
    /** Each named argument is absent or equal to one of the listed values. */
    readonly absentOrIn?: Readonly<Record<string, readonly string[]>>;
    /** Each named argument is absent or not equal to one of the listed values. */
    readonly notIn?: Readonly<Record<string, readonly string[]>>;
  };
}

/** Data one adapter preset contributes to a resolved Adapter Definition. */
export interface DapAdapterPreset {
  /** Value sent as `initialize.adapterID` when the Launch Profile names none. */
  readonly adapterID?: string;
  /** Defaults for `hlDap.adapters.<id>.channels`; an Adapter Definition overrides the fields it sets. */
  readonly channels?: DapChannelPolicy;
  /** Exit reporting for adapters that never send the standard `exited` event. */
  readonly outputExitReport?: DapOutputExitReport;
}

/**
 * Known adapter presets, keyed by the `preset` value an Adapter Definition names. Trusted packaged
 * data: the pattern is reviewed with the code and never comes from settings.
 */
export const DAP_ADAPTER_PRESETS: Readonly<Record<string, DapAdapterPreset>> = {
  "vscode-js-debug": {
    adapterID: "pwa-node",
    channels: {
      sessions: "promoted",
      firstSessionIsPrimary: true,
      targetIdKey: "__pendingTargetId",
    },
    outputExitReport: {
      category: "stderr",
      pattern: /^Process exited with code (\d+)\r?\n?$/u,
      cleanExitCode: 0,
      onlyWhenArgument: {
        absentOrIn: { console: ["internalConsole"] },
        notIn: { outputCapture: ["std"] },
      },
    },
  },
  "lldb-dap": { adapterID: "lldb-dap" },
  debugpy: {
    adapterID: "python",
    channels: { sessions: "promoted", firstSessionIsPrimary: false },
  },
};
