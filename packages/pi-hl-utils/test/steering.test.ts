import { expect, test, vi } from "vitest";

import {
  hasSteering,
  subscribeSteering,
  queueSteering,
  clearSteering,
  watchSteering,
} from "../src/steering.js";

const sessionsKey = Symbol.for("pi-hl-utils/steering/sessions.v1");

test("a steer notifies once per transition and stays isolated by session", () => {
  const listener = vi.fn<() => void>();
  const unsubscribe = subscribeSteering("transition", listener);
  queueSteering("transition");
  queueSteering("transition");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(hasSteering("transition")).toBe(true);
  expect(hasSteering("unrelated")).toBe(false);
  clearSteering("transition");
  expect(hasSteering("transition")).toBe(false);
  queueSteering("transition");
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  clearSteering("transition");
});

test("a watch aborts for a new or pending steer, but not after disposal", () => {
  const watch = watchSteering("watch");
  expect(watch.signal.aborted).toBe(false);
  queueSteering("watch");
  expect(watch.signal.aborted).toBe(true);
  const late = watchSteering("watch");
  expect(late.signal.aborted).toBe(true);
  watch.dispose();
  late.dispose();
  clearSteering("watch");
  const disposed = watchSteering("watch");
  disposed.dispose();
  queueSteering("watch");
  expect(disposed.signal.aborted).toBe(false);
  clearSteering("watch");
});

test("disposing a settled watch keeps a newer watch subscribed", () => {
  const settled = watchSteering("stale");
  queueSteering("stale");
  clearSteering("stale");
  const current = watchSteering("stale");
  settled.dispose();
  queueSteering("stale");
  expect(current.signal.aborted).toBe(true);
  current.dispose();
  clearSteering("stale");
});

test("a listener subscribed during a notification waits for the next steer", () => {
  const late = vi.fn<() => void>();
  const unsubscribes: (() => void)[] = [];
  unsubscribes.push(
    subscribeSteering("reentrant", () => {
      unsubscribes.push(subscribeSteering("reentrant", late));
    }),
  );
  queueSteering("reentrant");
  expect(late).not.toHaveBeenCalled();
  for (const unsubscribe of unsubscribes) unsubscribe();
  clearSteering("reentrant");
});

test("reloaded module copies share the pending steer", async () => {
  vi.resetModules();
  const copy = await import("../src/steering.js");
  queueSteering("copy");
  expect(copy.hasSteering("copy")).toBe(true);
  copy.clearSteering("copy");
  expect(hasSteering("copy")).toBe(false);
});

test("a failed listener does not strand another watcher", () => {
  const unlisten = subscribeSteering("failure", () => {
    throw new Error("listener failed");
  });
  const watch = watchSteering("failure");
  try {
    expect(() => queueSteering("failure")).toThrow("Queued steer notification failed");
    expect(watch.signal.aborted).toBe(true);
  } finally {
    unlisten();
    watch.dispose();
    clearSteering("failure");
  }
});

test("a malformed shared registry is rejected without discarding it", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, sessionsKey);
  const malformed = new Map([["broken", { pending: true, listeners: "invalid" }]]);
  Object.defineProperty(globalThis, sessionsKey, {
    value: malformed,
    configurable: true,
  });
  try {
    expect(() => queueSteering("broken")).toThrow("Invalid queued-steer registry");
    expect(Object.getOwnPropertyDescriptor(globalThis, sessionsKey)?.value).toBe(malformed);
  } finally {
    if (original) Object.defineProperty(globalThis, sessionsKey, original);
    else Reflect.deleteProperty(globalThis, sessionsKey);
  }
});
