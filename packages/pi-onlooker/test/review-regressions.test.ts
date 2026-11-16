import type { Context } from "@earendil-works/pi-ai";
import { onTestFinished, expect, it } from "vite-plus/test";

import { readOnlookerSettings } from "../src/onlooker-settings.js";
import { createObserver } from "./fixtures/observer-harness.js";
import { fixture, response } from "./fixtures/onlooker-runtime.js";
import { reply, toolCall } from "./fixtures/sdk-harness.js";

it("keeps the default high thinking level when the observed agent changes its own", async () => {
  const levels: Array<string | undefined> = [];
  const sizes: number[] = [];
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      if (privateRole) {
        levels.push(options?.reasoning);
        sizes.push(context.messages.length);
      }
      return response(
        model,
        privateRole ? toolCall("onlooker_report", { severity: "none" }) : reply("Done"),
        options,
      );
    },
  };
  const { session } = await fixture();
  await session.prompt("First request");
  session.setThinkingLevel("max");
  await session.prompt("Second request");
  session.setThinkingLevel("off");
  await session.prompt("Third request");
  expect(levels).toEqual(["high", "high", "high"]);
  // Observed thinking changes do not discard the Onlooker Session: it only grows.
  expect(sizes[1]).toBeGreaterThan(sizes[0] ?? 0);
  expect(sizes[2]).toBeGreaterThan(sizes[1] ?? 0);
});

it("invalidates unconsumed Onlooker steering on disable without removing unrelated user steering", async () => {
  const secondRequest = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  let mainCalls = 0;
  const seenUserSteering: string[] = [];
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "onlooker_report"))
        return response(
          model,
          toolCall("onlooker_report", {
            findings: [
              {
                severity: "blocker",
                message: "Stale queued finding",
                evidence: { quote: "Observed task" },
              },
            ],
          }),
          options,
        );
      mainCalls++;
      if (JSON.stringify(context.messages).includes("Unrelated user instruction"))
        seenUserSteering.push("received");
      if (mainCalls === 1)
        return response(
          model,
          toolCall("read", { path: "/missing-onlooker-fixture-file" }),
          options,
        );
      if (mainCalls === 2) {
        secondRequest.resolve();
        return response(model, reply("Done"), options, releaseSecond.promise);
      }
      return response(model, reply("Done"), options);
    },
  };
  const { session, cleanupGates } = await fixture();
  cleanupGates.push(releaseSecond.resolve);
  const pending = session.prompt("Observed task");
  await secondRequest.promise;
  await expect.poll(() => session.agent.hasQueuedMessages()).toBe(true);
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-onlooker",
    ),
  ).toEqual([]);
  await session.steer("Unrelated user instruction");
  await session.prompt("/onlooker off");
  releaseSecond.resolve();
  await pending;
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-onlooker",
    ),
  ).toEqual([]);
  expect(seenUserSteering).not.toEqual([]);
  expect(mainCalls).toBe(3);
});

it("rejects abandoned-branch findings before later session_tree handlers receive the event", async () => {
  const reviewStarted = Promise.withResolvers<void>();
  const releaseReview = Promise.withResolvers<void>();
  const treeEntered = Promise.withResolvers<void>();
  const releaseTree = Promise.withResolvers<void>();
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      if (!context.tools?.some((tool) => tool.name === "onlooker_report"))
        return response(model, reply("Done"), options);
      reviewStarted.resolve();
      return response(
        model,
        toolCall("onlooker_report", {
          findings: [
            {
              severity: "blocker",
              message: "Abandoned-branch finding",
              evidence: { quote: "Done" },
            },
          ],
        }),
        options,
        releaseReview.promise,
      );
    },
  };
  const { session, cleanupGates } = await fixture({ enabled: false });
  cleanupGates.push(releaseReview.resolve, releaseTree.resolve);
  globalThis.onlookerReviewRegression.tree = async () => {
    treeEntered.resolve();
    await releaseTree.promise;
  };
  await session.prompt("Kept task");
  const target = session.sessionManager.getLeafId();
  if (!target) throw new Error("Missing native target leaf");
  await session.prompt("/onlooker on");
  const pending = session.prompt("Abandoned task");
  await reviewStarted.promise;
  await expect.poll(() => session.isStreaming).toBe(false);
  const navigating = session.navigateTree(target, { summarize: false });
  await treeEntered.promise;
  releaseReview.resolve();
  await pending;
  const findings = session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "pi-onlooker");
  releaseTree.resolve();
  await navigating;
  expect(findings).toEqual([]);
});

it("never starts an automatic Corrective Turn inside native manual compaction", async () => {
  const reviewStarted = Promise.withResolvers<void>();
  const releaseReview = Promise.withResolvers<void>();
  const compactionEntered = Promise.withResolvers<void>();
  const releaseCompaction = Promise.withResolvers<void>();
  const compactionStates: boolean[] = [];
  const { session, cleanupGates } = await fixture({ interactive: true });
  cleanupGates.push(releaseReview.resolve, releaseCompaction.resolve);
  let reviews = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "onlooker_report")) {
        reviews++;
        reviewStarted.resolve();
        return response(
          model,
          toolCall(
            "onlooker_report",
            reviews === 1
              ? {
                  findings: [
                    {
                      severity: "blocker",
                      message: "Late corrective finding",
                      evidence: { quote: "Done" },
                    },
                  ],
                }
              : { severity: "none" },
          ),
          options,
          releaseReview.promise,
        );
      }
      compactionStates.push(session.isCompacting);
      return response(model, reply("Done"), options);
    },
  };
  globalThis.onlookerReviewRegression.compact = async () => {
    compactionEntered.resolve();
    await releaseCompaction.promise;
  };
  await session.prompt("Completed task " + "history ".repeat(3000));
  await reviewStarted.promise;
  const compacting = session.compact();
  await compactionEntered.promise;
  expect(session.isCompacting).toBe(true);
  releaseReview.resolve();
  // Await delivery or invalidation of the held Review, not a fixed sleep.
  await expect
    .poll(async () => {
      await session.prompt("/onlooker status");
      const status = session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");
      return status?.type === "custom" ? JSON.stringify(status.data) : "";
    })
    .not.toContain('"state":"reviewing"');
  releaseCompaction.resolve();
  await compacting;
  expect(compactionStates).not.toContain(true);
});

it("does not restart after cancellation during post-run compaction", async () => {
  const compacting = Promise.withResolvers<void>();
  const releaseCompaction = Promise.withResolvers<void>();
  const { session, cleanupGates } = await fixture({ interactive: true });
  cleanupGates.push(releaseCompaction.resolve);
  session.settingsManager.setCompactionEnabled(true);
  let calls = 0;
  let reviews = 0;
  let consumedFinding = false;
  globalThis.onlookerReviewRegression.agentEnd = async () => {
    delete globalThis.onlookerReviewRegression.agentEnd;
    await expect.poll(() => session.agent.hasQueuedMessages()).toBe(true);
  };
  globalThis.onlookerReviewRegression.compact = async () => {
    compacting.resolve();
    await releaseCompaction.promise;
  };
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "onlooker_report")) {
        reviews++;
        return response(
          model,
          toolCall("onlooker_report", {
            findings:
              reviews === 1
                ? [
                    {
                      severity: "concern",
                      message: "Check before finishing",
                      evidence: { quote: "Done" },
                    },
                  ]
                : [],
          }),
          options,
        );
      }
      calls++;
      const answer = reply("Done");
      if (calls === 2) {
        consumedFinding = JSON.stringify(context.messages).includes("Check before finishing");
        answer.usage = { ...answer.usage, input: 199_000, totalTokens: 199_010 };
      }
      return response(model, answer, options);
    },
  };
  const pending = session.prompt("Complete a task " + "history ".repeat(3000));
  await compacting.promise;
  expect(consumedFinding).toBe(true);
  expect(calls).toBe(2);
  const aborting = session.abort();
  releaseCompaction.resolve();
  await Promise.all([pending, aborting]);
  await expect
    .poll(async () => {
      await session.prompt("/onlooker status");
      const status = session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");
      return status?.type === "custom" ? JSON.stringify(status.data) : "";
    })
    .toContain('"state":"armed"');
  await session.waitForIdle();
  expect(calls).toBe(2);
  expect(session.messages).not.toContainEqual(
    expect.objectContaining({ customType: "pi-onlooker-continuation" }),
  );
  session.settingsManager.setCompactionEnabled(false);
  await session.prompt("A new user request");
  expect(calls).toBe(3);
});

it("starts a pending interactive correction only at the native settlement boundary", async () => {
  const ended = Promise.withResolvers<void>();
  const releaseEnd = Promise.withResolvers<void>();
  let mainCalls = 0;
  let reviews = 0;
  const { session, cleanupGates } = await fixture({ interactive: true });
  cleanupGates.push(releaseEnd.resolve);
  globalThis.onlookerReviewRegression.agentEnd = async () => {
    ended.resolve();
    await releaseEnd.promise;
  };
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "onlooker_report")) {
        reviews++;
        return response(
          model,
          toolCall(
            "onlooker_report",
            reviews === 1
              ? {
                  findings: [
                    {
                      severity: "blocker",
                      message: "Correct after settlement",
                      evidence: { quote: "Done" },
                    },
                  ],
                }
              : { severity: "none" },
          ),
          options,
        );
      }
      mainCalls++;
      return response(model, reply("Done"), options);
    },
  };
  const pending = session.prompt("Complete a task");
  await ended.promise;
  await expect.poll(() => session.agent.hasQueuedMessages()).toBe(true);
  expect(session.isIdle).toBe(false);
  expect(mainCalls).toBe(1);
  releaseEnd.resolve();
  await pending;
  // The task, the run Pi starts for the queued finding, then the Corrective Turn in the same run.
  expect(mainCalls).toBe(3);
});

it("keeps a queued finding's attribution when renamed before correction", async () => {
  const ended = Promise.withResolvers<void>();
  const releaseEnd = Promise.withResolvers<void>();
  const { session, cleanupGates } = await fixture({ interactive: true });
  cleanupGates.push(releaseEnd.resolve);
  await session.prompt('/onlooker set name "Marcel"');
  globalThis.onlookerReviewRegression.agentEnd = async () => {
    ended.resolve();
    await releaseEnd.promise;
  };
  let reviews = 0;
  let correctiveContext = "";
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "onlooker_report")) {
        reviews++;
        return response(
          model,
          toolCall("onlooker_report", {
            findings:
              reviews === 1
                ? [
                    {
                      severity: "blocker",
                      message: "Check the result",
                      evidence: { quote: "Done" },
                    },
                  ]
                : [],
          }),
          options,
        );
      }
      correctiveContext = JSON.stringify(context.messages);
      return response(model, reply("Done"), options);
    },
  };
  const pending = session.prompt("Complete a task");
  await ended.promise;
  await expect.poll(() => session.agent.hasQueuedMessages()).toBe(true);
  await session.prompt('/onlooker set name "Inspector gadget"');
  releaseEnd.resolve();
  await pending;
  await expect.poll(() => correctiveContext).toContain("Consider the");
  expect(correctiveContext).toContain("Marcel blocker: Check the result");
  expect(correctiveContext).toContain("Consider the findings reported above.");
  expect(correctiveContext).not.toContain("Consider the Inspector gadget findings");
});

it("retracts queued findings after a model-only change while preserving unrelated steering", async () => {
  const secondRequest = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  let mainCalls = 0;
  let reviews = 0;
  let userSteeringObserved = false;
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      if (context.tools?.some((tool) => tool.name === "onlooker_report")) {
        reviews++;
        return response(
          model,
          toolCall(
            "onlooker_report",
            reviews === 1
              ? {
                  findings: [
                    {
                      severity: "blocker",
                      message: "Finding from the child's previous model",
                      evidence: { quote: "Owned child task" },
                    },
                  ],
                }
              : { severity: "none" },
          ),
          options,
        );
      }
      mainCalls++;
      if (JSON.stringify(context.messages).includes("Keep this unrelated user steer"))
        userSteeringObserved = true;
      if (mainCalls === 1)
        return response(
          model,
          toolCall("read", { path: "/missing-onlooker-fixture-file" }),
          options,
        );
      if (mainCalls === 2) {
        secondRequest.resolve();
        return response(model, reply("Done"), options, releaseSecond.promise);
      }
      return response(model, reply("Done"), options);
    },
  };
  // The root extension is disabled: the explicit observer has the child owner's lifecycle.
  const { session, cleanupGates } = await fixture({ enabled: false });
  cleanupGates.push(releaseSecond.resolve);
  session.setThinkingLevel("medium");
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: Infinity,
      maxCorrectiveTurns: 0,
    },
    "headless-root",
  );
  onTestFinished(async () => {
    releaseSecond.resolve();
    await observer.dispose();
  });
  observer.beforeTask();
  const pending = session.prompt("Owned child task");
  await secondRequest.promise;
  await expect.poll(() => session.agent.hasQueuedMessages()).toBe(true);
  await expect.poll(() => observer.status.state).toBe("armed");
  await session.steer("Keep this unrelated user steer");
  const alternate = session.modelRuntime.getModel("observer-fixture", "alternate");
  if (!alternate) throw new Error("Missing alternate fixture model");
  const previousThinking = session.thinkingLevel;
  await session.setModel(alternate);
  expect(session.thinkingLevel).toBe(previousThinking);
  releaseSecond.resolve();
  await pending;
  await observer.settled(false);
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-onlooker",
    ),
  ).toEqual([]);
  expect(userSteeringObserved).toBe(true);
  expect(mainCalls).toBe(3);
});

/** The loaded extension, not a hand-built observer: Pi emits `model_select` on `setModel`. */
async function reviewAcrossModelChange(onlooker: { model?: string }) {
  const requests: Context[] = [];
  const onlookerModels: string[] = [];
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      if (privateRole) {
        requests.push(structuredClone(context));
        onlookerModels.push(model.id);
      }
      return response(
        model,
        privateRole ? toolCall("onlooker_report", { findings: [] }) : reply("Done"),
        options,
      );
    },
  };
  const { session } = await fixture({ onlooker });
  await session.prompt("First request");
  const alternate = session.modelRuntime.getModel("observer-fixture", "alternate");
  if (!alternate) throw new Error("Missing alternate fixture model");
  await session.setModel(alternate);
  await session.prompt("Second request");
  await expect.poll(() => requests.length).toBe(2);
  const [first, second] = requests;
  return { first, second, onlookerModels, update: JSON.stringify(second?.messages.at(-1)) };
}

it("own model keeps the Onlooker Session across an observed model change through the extension", async () => {
  const { first, second, onlookerModels, update } = await reviewAcrossModelChange({
    model: "observer-fixture/priced",
  });
  expect(onlookerModels).toEqual(["priced", "priced"]);
  expect(update).toContain("Incremental update.");
  expect(second?.systemPrompt).toBe(first?.systemPrompt);
  expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages);
});

it("inherited model reseeds the Onlooker Session across an observed model change through the extension", async () => {
  const { second, onlookerModels, update } = await reviewAcrossModelChange({});
  expect(onlookerModels).toEqual(["model", "alternate"]);
  expect(update).not.toContain("Incremental update.");
  expect(second?.messages).toHaveLength(1);
});
