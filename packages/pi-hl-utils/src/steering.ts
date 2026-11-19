/**
 * The process-wide Queued Steer signal that lets waiting tools end with a Steer Yield.
 * Pi hands a Queued Steer to an agent only after every tool call in the current batch has
 * returned, and gives extensions no way to see a custom message queued as a steer, so packages
 * raise the signal for the steers they can see: user steers through {@link registerSteering}, and
 * the steers they send themselves through {@link queueSteering}. It lives on `globalThis` under a
 * registered symbol so every installed copy of pi-utils in one Pi process shares it, including the
 * copies loaded by in-process Child Agent sessions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./record.js";

interface SessionSteers {
  /** Whether a Queued Steer is pending: raised and not yet settled by the next turn start. */
  pending: boolean;
  readonly listeners: Set<() => void>;
}

const SESSIONS_KEY = Symbol.for("pi-hl-utils/steering/sessions.v1");

function isSessionSteers(value: unknown): value is SessionSteers {
  return (
    isRecord(value) &&
    typeof value.pending === "boolean" &&
    value.listeners instanceof Set &&
    [...value.listeners].every((listener: unknown) => typeof listener === "function")
  );
}

function isRegistry(value: unknown): value is Map<string, SessionSteers> {
  return (
    value instanceof Map &&
    [...value].every(
      ([id, steers]: [unknown, unknown]) => typeof id === "string" && isSessionSteers(steers),
    )
  );
}

function sessions(): Map<string, SessionSteers> {
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, SESSIONS_KEY)?.value;
  if (existing !== undefined) {
    if (!isRegistry(existing)) throw new Error("Invalid queued-steer registry");
    return existing;
  }
  const created = new Map<string, SessionSteers>();
  Object.defineProperty(globalThis, SESSIONS_KEY, {
    value: created,
    configurable: true,
  });
  return created;
}

function sessionSteers(sessionId: string): SessionSteers {
  const all = sessions();
  let steers = all.get(sessionId);
  if (steers === undefined) {
    steers = { pending: false, listeners: new Set() };
    all.set(sessionId, steers);
  }
  return steers;
}

/** Forget a session that has nothing pending and nobody listening. */
function release(sessionId: string, steers: SessionSteers): void {
  const all = sessions();
  if (all.get(sessionId) === steers && !steers.pending && steers.listeners.size === 0)
    all.delete(sessionId);
}

/**
 * Record that a steer was queued for the Pi session `sessionId`. Listeners run once, when the
 * session goes from nothing pending to a pending Queued Steer; raising again while one is pending
 * does nothing.
 */
export function queueSteering(sessionId: string): void {
  const steers = sessionSteers(sessionId);
  if (steers.pending) return;
  steers.pending = true;
  // A copy, so a listener subscribed during notification waits for the next steer.
  for (const listener of Array.from(steers.listeners)) listener();
}

/** Record that Pi took the session's Queued Steers, or discarded them with the run. */
export function clearSteering(sessionId: string): void {
  const steers = sessions().get(sessionId);
  if (steers === undefined) return;
  steers.pending = false;
  release(sessionId, steers);
}

/** Whether a Queued Steer is pending for the session. */
export function hasSteering(sessionId: string): boolean {
  return sessions().get(sessionId)?.pending === true;
}

/**
 * Run `listener` each time a Queued Steer becomes pending for the session. It does not run for a
 * steer already pending when it subscribes; check {@link hasSteering} for that. Returns the
 * unsubscribe function.
 */
export function subscribeSteering(sessionId: string, listener: () => void): () => void {
  const steers = sessionSteers(sessionId);
  // A wrapper, so the same function subscribed twice unsubscribes once each.
  const entry = () => listener();
  steers.listeners.add(entry);
  return () => {
    steers.listeners.delete(entry);
    release(sessionId, steers);
  };
}

/** An abort signal for one wait, and the subscription behind it. */
export interface QueuedSteerWatch {
  /** Aborted once a Queued Steer is pending for the session, at once when one already is. */
  readonly signal: AbortSignal;
  /** Stop watching; call it when the wait ends. */
  dispose(): void;
}

/** Watch the session for a Queued Steer for the length of one wait. */
export function watchSteering(sessionId: string): QueuedSteerWatch {
  const controller = new AbortController();
  if (hasSteering(sessionId)) {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  const unsubscribe = subscribeSteering(sessionId, () => {
    unsubscribe();
    controller.abort();
  });
  return { signal: controller.signal, dispose: unsubscribe };
}

const tracked = new WeakSet<ExtensionAPI>();

/**
 * Raise the signal for every steer the user (or an extension through `sendUserMessage`) queues in
 * a session `pi` runs in, and settle it when Pi starts the next turn or the run ends. Every package
 * that yields calls it on its own `pi`, so each works alone; settling and raising are idempotent,
 * so several packages tracking one session agree. A second call with the same `pi` does nothing.
 * Pi has no event for a steer entering the queue, so a steer that a later `input` handler handles
 * still raises the signal: a wait then ends early, which loses nothing.
 */
export function registerSteering(pi: ExtensionAPI): void {
  if (tracked.has(pi)) return;
  tracked.add(pi);
  pi.on("input", (event, context) => {
    if (event.streamingBehavior === "steer") {
      queueSteering(context.sessionManager.getSessionId());
    }
  });
  pi.on("turn_start", (_event, context) => {
    clearSteering(context.sessionManager.getSessionId());
  });
  pi.on("agent_end", (_event, context) => {
    clearSteering(context.sessionManager.getSessionId());
  });
}
