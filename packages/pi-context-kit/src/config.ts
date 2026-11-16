import type { PruneOptions } from "./prune.ts";
import type { ShakeOptions } from "./shake.ts";

/** Where maintenance starts. `"pi"` leaves only Pi's own compaction threshold. */
export type Threshold = { tokens: number } | { percent: number } | "pi";

/**
 * `handoff`: compact with a note written by the session model.
 * `shake`: elide large blocks and images from older messages, without a model call.
 * `soft`: leave compaction to Pi's own summary.
 */
export type Method = "handoff" | "shake" | "soft";

/** Named method orders, so most users never edit `advanced.methodOrder`. */
export type Strategy = "balanced" | "frugal" | "pi-summary";

export const STRATEGIES: Readonly<
  Record<Strategy, { methodOrder: readonly Method[]; background: boolean }>
> = {
  balanced: { methodOrder: ["handoff", "shake", "soft"], background: true },
  frugal: { methodOrder: ["shake", "handoff", "soft"], background: false },
  "pi-summary": { methodOrder: ["soft"], background: false },
};

export interface ContextKitConfig {
  /** Turns off maintenance and handoff compaction. `recall` stays available. */
  enabled: boolean;
  threshold: Threshold;
  strategy: Strategy;
  /** What to try, in order, when the context stays above the threshold after pruning. */
  methodOrder: Method[];
  /** `advanced.methodOrder` sets the method order, so `strategy` does not. */
  customOrder: boolean;
  /** Write the handoff note in the background before the threshold. */
  background: boolean;
  /** Replace older reads of a file that was read again. */
  supersedeReads: boolean;
  prune: PruneOptions & { enabled: boolean };
  shake: ShakeOptions;
  /** Pruning and shaking must reach this fraction of the threshold, or compaction runs instead. */
  progressRatio: number;
}

export interface ConfigResult {
  config: ContextKitConfig;
  /** One message per ineffective combination of options. */
  problems: string[];
}

export const isStrategy = (value: unknown): value is Strategy =>
  value === "balanced" || value === "frugal" || value === "pi-summary";
export const isMethod = (value: unknown): value is Method =>
  value === "handoff" || value === "shake" || value === "soft";

/** Soft ends the extension's strategy chain, even when other methods follow it. */
export function before(methods: readonly Method[], a: Method, b: Method): boolean {
  const index = methods.indexOf(a);
  const other = methods.indexOf(b);
  const soft = methods.indexOf("soft");
  const stop = Math.min(
    other >= 0 ? other : Number.POSITIVE_INFINITY,
    soft >= 0 ? soft : Number.POSITIVE_INFINITY,
  );
  return index >= 0 && index < stop;
}

/** Whether the method order writes handoff notes at all. */
export function writesHandoff(methods: readonly Method[]): boolean {
  return before(methods, "handoff", "soft");
}

/** The configured threshold for this context window, or +Infinity when only Pi's threshold applies. */
export function ownThreshold(config: ContextKitConfig, contextWindow: number): number {
  const value = config.threshold;
  if (value === "pi") return Number.POSITIVE_INFINITY;
  if ("tokens" in value) return Math.min(contextWindow - 1, value.tokens);
  return Math.floor((contextWindow * Math.min(99, value.percent)) / 100);
}

/**
 * How many tokens before the threshold the background note starts: an eighth of the threshold,
 * so the band scales with the window, bounded so small windows do not start a note every turn
 * and large ones do not miss too much history.
 */
export function speculationLead(threshold: number): number {
  return Number.isFinite(threshold) && threshold > 0
    ? Math.min(32_000, Math.floor(threshold / 8))
    : 0;
}
