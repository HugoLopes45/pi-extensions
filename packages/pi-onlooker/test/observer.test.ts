import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { onTestFinished, expect, it, vi } from "vite-plus/test";

import { onlookerFallbackTokenFactor } from "../src/onlooker-calibration.js";
import { projectEvidence, toolCallRef } from "../src/onlooker-evidence.js";
import { readOnlookerSettings } from "../src/onlooker-settings.js";
import { objectContaining, stringContaining, stringMatching } from "./fixtures/matchers.js";
import {
  activeFixture,
  conversation,
  expectPrefix,
  longSessionStream,
  seedPayload,
  type PrivateRequest,
  createObserver,
} from "./fixtures/observer-harness.js";
import { createSdkHarness } from "./fixtures/sdk-harness.js";

it.each(["none", "blocker"] as const)(
  "reviews %s without changing the observed request prefix or restarting headless completion",
  async (severity) => {
    const main: Context[] = [];
    const reviews: Context[] = [];
    globalThis.onlookerObserverTest = {
      stream(model, context) {
        const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
        (privateRole ? reviews : main).push(
          structuredClone({
            ...context,
            tools: (context.tools ?? []).map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          }),
        );
        const stream = createAssistantMessageEventStream();
        const message = {
          ...fauxAssistantMessage("Done"),
          model: model.id,
          provider: model.provider,
          api: model.api,
        };
        if (privateRole) {
          message.content = [
            {
              type: "toolCall",
              id: "report-1",
              name: "onlooker_report",
              arguments:
                severity === "none"
                  ? { severity }
                  : {
                      findings: [
                        {
                          severity,
                          message: "Completion lacks a verification run.",
                          evidence: { quote: "Done" },
                        },
                      ],
                    },
            },
          ];
          message.stopReason = "toolUse";
        }
        queueMicrotask(() =>
          stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
        );
        return stream;
      },
    };
    const session = await activeFixture();
    const observer = createObserver(
      session,
      { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: Infinity },
      "headless-root",
    );
    globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
    onTestFinished(() => observer.dispose());
    await session.prompt("Review this task, without changing it.");
    expect(observer.status.lastError).toBeNull();
    expect(observer.status).toMatchObject({
      state: "armed",
      backlog: 0,
      effectiveModel: "observer-fixture/model",
      effectiveThinkingLevel: "high",
    });
    expect(reviews).toHaveLength(1);
    expect(main).toHaveLength(1);
    expect(main[0]?.messages).toHaveLength(1);
    expect(main[0]?.tools).not.toContainEqual(expect.objectContaining({ name: "onlooker_report" }));
    expect(conversation(session.messages)).toHaveLength(severity === "none" ? 2 : 3);
    const delivered = objectContaining({ customType: "pi-onlooker", display: true });
    expect(session.messages.filter((message) => message.role === "custom")).toEqual(
      severity === "blocker" ? [delivered] : [],
    );
    expect(session.messages.at(-1)?.role).toBe(severity === "blocker" ? "custom" : "assistant");
  },
);

it("queues a streaming nit without steering the active agent", async () => {
  let mainCalls = 0;
  let reviews = 0;
  const mainContexts: string[] = [];
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "onlooker_report",
            arguments: {
              findings:
                reviews === 1
                  ? [
                      {
                        severity: "nit",
                        message: "Use the shorter expression.",
                        evidence: { quote: "Done" },
                      },
                    ]
                  : [],
            },
          },
        ];
        message.stopReason = "toolUse";
      } else {
        mainCalls++;
        mainContexts.push(JSON.stringify(context.messages));
        if (mainCalls === 1) {
          message.content = [
            {
              type: "toolCall",
              id: "main-read",
              name: "read",
              arguments: { path: "/no-onlooker-test-file" },
            },
          ];
          message.stopReason = "toolUse";
        }
      }
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: 1 },
    "interactive",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Use one tool");
  expect(mainCalls).toBe(2);
  expect(mainContexts[1]).not.toContain("Use the shorter expression.");
  expect(session.messages.at(-1)).toMatchObject({
    role: "custom",
    customType: "pi-onlooker",
    details: { severity: "nit", message: "Use the shorter expression." },
  });
});

it("records every finding before starting one Corrective Turn", async () => {
  const reviewStarted = Promise.withResolvers<void>();
  const releaseReview = Promise.withResolvers<void>();
  let mainCalls = 0;
  let reviews = 0;
  let correctiveContext = "";
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "onlooker_report",
            arguments:
              reviews === 1
                ? {
                    findings: [
                      {
                        severity: "nit",
                        message: "Simplify the helper.",
                        evidence: { quote: "Done" },
                      },
                      {
                        severity: "blocker",
                        message: "Verify the first invariant.",
                        evidence: { quote: "Done" },
                      },
                      {
                        severity: "blocker",
                        message: "Verify the second invariant.",
                        evidence: { quote: "Done" },
                      },
                    ],
                  }
                : { findings: [] },
          },
        ];
        message.stopReason = "toolUse";
        if (reviews === 1) {
          reviewStarted.resolve();
          void releaseReview.promise.then(() =>
            stream.push({ type: "done", reason: "toolUse", message }),
          );
        } else queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message }));
      } else {
        mainCalls++;
        if (mainCalls === 2) correctiveContext = JSON.stringify(context.messages);
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      }
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: Infinity,
      maxCorrectiveTurns: 1,
    },
    "interactive",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  const prompt = session.prompt("Complete once");
  await reviewStarted.promise;
  await prompt;
  releaseReview.resolve();
  await vi.waitFor(() => expect(mainCalls).toBe(2));
  await vi.waitFor(() => expect(observer.status.backlog).toBe(0));
  expect(correctiveContext.indexOf("Simplify the helper.")).toBeLessThan(
    correctiveContext.indexOf("Verify the first invariant."),
  );
  expect(correctiveContext.indexOf("Verify the first invariant.")).toBeLessThan(
    correctiveContext.indexOf("Verify the second invariant."),
  );
});

it("deduplicates a Review at its highest severity and permits later escalation", async () => {
  let reviews = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "onlooker_report",
            arguments: {
              findings:
                reviews === 1
                  ? [
                      { severity: "nit", message: "Check `foo_bar`.", evidence: { quote: "Done" } },
                      {
                        severity: "concern",
                        message: "**Check foo_bar.**",
                        evidence: { quote: "Done" },
                      },
                      {
                        severity: "nit",
                        message: "Lower priority first Review.",
                        evidence: { quote: "Done" },
                      },
                    ]
                  : [
                      { severity: "nit", message: "Check foo_bar.", evidence: { quote: "Done" } },
                      {
                        severity: "blocker",
                        message: "Check foo_bar.",
                        evidence: { quote: "Done" },
                      },
                      {
                        severity: "concern",
                        message: "Lower priority second Review.",
                        evidence: { quote: "Done" },
                      },
                    ],
            },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: Infinity,
      maxFindingsPerReview: 1,
    },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("First");
  await session.prompt("Second");
  expect(
    session.messages
      .filter((message) => message.role === "custom" && message.customType === "pi-onlooker")
      .map((message) => message.role === "custom" && JSON.stringify(message.details)),
  ).toEqual([
    JSON.stringify({
      severity: "concern",
      message: "**Check foo_bar.**",
      evidence: { quote: "Done" },
      name: "Onlooker",
    }),
    JSON.stringify({
      severity: "blocker",
      message: "Check foo_bar.",
      evidence: { quote: "Done" },
      name: "Onlooker",
    }),
  ]);
});

it("delivers every distinct Concern of consecutive Reviews", async () => {
  let reviews = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        const findings =
          reviews === 1
            ? [
                { severity: "concern", message: "First concern.", evidence: { quote: "Done" } },
                { severity: "concern", message: "Second concern.", evidence: { quote: "Done" } },
              ]
            : [
                { severity: "concern", message: "Third concern.", evidence: { quote: "Done" } },
                { severity: "concern", message: "Fourth concern.", evidence: { quote: "Done" } },
              ];
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "onlooker_report",
            arguments: { findings },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: Infinity },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Step 0");
  await session.prompt("Step 1");
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-onlooker",
    ),
  ).toHaveLength(4);
});

it("pauses when a Review omits its terminating report", async () => {
  globalThis.onlookerObserverTest = {
    stream(model) {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: 1 },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Complete normally");
  expect(observer.status).toMatchObject({
    state: "paused",
    lastError: "Onlooker Review did not call onlooker_report",
  });
});

it("pauses on the independent review deadline without cancelling the observed agent", async () => {
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (context.tools?.some((tool) => tool.name === "onlooker_report")) {
        options?.signal?.addEventListener(
          "abort",
          () => {
            stream.push({
              type: "error",
              reason: "aborted",
              error: { ...message, stopReason: "aborted" },
            });
          },
          { once: true },
        );
      } else queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: 1,
      reviewTimeoutMs: 20,
    },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Finish normally");
  expect(observer.status.state).toBe("paused");
  expect(observer.status.lastError).toMatch(/deadline/i);
  expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
});

it("enforces investigative calls independently of the catch-up setting", async () => {
  let calls = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      if (privateRole) {
        calls++;
        message.content = [
          {
            type: "toolCall",
            id: `read-${calls}`,
            name: "read",
            arguments: { path: "/no-onlooker-test-file" },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: Infinity,
      maxToolCalls: 1,
    },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Finish normally");
  expect(observer.status.lastError).toMatch(/tool-call limit/);
  // One allowed read, one blocked with a request to report, then the ignored request ends it.
  expect(calls).toBe(3);
  expect(conversation(session.messages)).toHaveLength(2);
});

async function batchedQuotaFixture(kind: "review" | "consultation") {
  let requests = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const consultation = JSON.stringify(
        context.messages.findLast((message) => message.role === "user"),
      ).includes("Consultation request");
      const exercise = privateRole && (kind === "review" || consultation);
      const message = {
        ...fauxAssistantMessage("Partial answer from the available evidence"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (exercise && ++requests === 1) {
        message.content = [0, 1, 2].map((index) => ({
          type: "toolCall",
          id: `batch-read-${index}`,
          name: "read",
          arguments: { path: "/no-onlooker-test-file" },
        }));
        message.stopReason = "toolUse";
      } else if (privateRole && !consultation) {
        message.content = [
          {
            type: "toolCall",
            id: "batch-report",
            name: "onlooker_report",
            arguments: { findings: [] },
          },
        ];
        message.stopReason = "toolUse";
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: Infinity,
      maxToolCalls: 1,
    },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Seed context");
  return {
    observer,
    get requests() {
      return requests;
    },
  };
}

it("lets a review conclude after a batch crosses the investigative limit", async () => {
  const fixture = await batchedQuotaFixture("review");
  expect(fixture.observer.status).toMatchObject({ state: "armed", lastError: null });
  expect(fixture.requests).toBe(2);
});

it("lets a consultation conclude after a batch crosses the investigative limit", async () => {
  const fixture = await batchedQuotaFixture("consultation");
  await expect(fixture.observer.consult("Review several files")).resolves.toBe(
    "Partial answer from the available evidence",
  );
  expect(fixture.observer.status).toMatchObject({ state: "armed", lastError: null });
  expect(fixture.requests).toBe(2);
});

it("keeps automatic reviews active after a consultation exhausts its tool quota", async () => {
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (context.tools?.some((tool) => tool.name === "onlooker_report")) {
        const consultation = JSON.stringify(
          context.messages.findLast((entry) => entry.role === "user"),
        ).includes("Consultation request");
        message.content = [
          {
            type: "toolCall",
            id: `quota-${context.messages.length}`,
            name: consultation ? "read" : "onlooker_report",
            arguments: consultation ? { path: "/no-onlooker-test-file" } : { findings: [] },
          },
        ];
        message.stopReason = "toolUse";
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: Infinity,
      maxToolCalls: 1,
    },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Seed context");
  await expect(observer.consult("Keep investigating")).rejects.toThrow(
    "Onlooker investigative tool-call limit exceeded",
  );
  expect(observer.status).toMatchObject({ state: "armed", lastError: null });
  const reviews = observer.status.spend.reviews.count;
  await session.prompt("Continue the main task");
  expect(observer.status.spend.reviews.count).toBeGreaterThan(reviews);
  expect(observer.status).toMatchObject({ state: "armed", lastError: null });
});

it("lets the Onlooker report once its investigative calls reach the limit", async () => {
  let calls = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      if (privateRole) {
        calls++;
        // Investigate until told the limit is reached, then report, as a compliant model does.
        const told = JSON.stringify(context.messages.at(-1)).includes("call onlooker_report now");
        message.content = [
          told
            ? {
                type: "toolCall",
                id: "report",
                name: "onlooker_report",
                arguments: { findings: [] },
              }
            : {
                type: "toolCall",
                id: `read-${calls}`,
                name: "read",
                arguments: { path: "/no-onlooker-test-file" },
              },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: Infinity,
      maxToolCalls: 1,
    },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Finish normally");
  expect(observer.status.lastError).toBeNull();
  expect(observer.status.state).toBe("armed");
  // One allowed read, one blocked read, then the report.
  expect(calls).toBe(3);
  expect(observer.status.spend.reviews.count).toBe(1);
});

it("format dedupe preserves distinct identifiers", async () => {
  const reports = ["Check `foo_bar`.", "**Check foo_bar.**", "Check foobar."];
  const severity = "blocker";
  const count = 2;
  let index = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        const finding = reports[index++];
        message.content = [
          {
            type: "toolCall",
            id: `report-${index}`,
            name: "onlooker_report",
            arguments: finding
              ? { findings: [{ severity, message: finding, evidence: { quote: "Done" } }] }
              : { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: Infinity },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  for (let turn = 0; turn < reports.length; turn++) await session.prompt(`Task step ${turn}`);
  expect(
    session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-onlooker",
    ),
  ).toHaveLength(count);
});

it("disabling an in-flight review discards its late finding", async () => {
  const started = Promise.withResolvers<void>();
  let release = () => {};
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        message.content = [
          {
            type: "toolCall",
            id: "late",
            name: "onlooker_report",
            arguments: {
              findings: [
                { severity: "blocker", message: "Stale advice", evidence: { quote: "Done" } },
              ],
            },
          },
        ];
        message.stopReason = "toolUse";
        release = () => stream.push({ type: "done", reason: "toolUse", message });
        started.resolve();
      } else queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
  };
  const session = await activeFixture();
  const config = {
    ...readOnlookerSettings(session).settings,
    enabled: true,
    catchUpThreshold: Infinity,
  };
  const observer = createObserver(session, config, "headless-root");
  onTestFinished(() => observer.dispose());
  await session.prompt("Continue");
  await started.promise;
  observer.configure({ ...config, enabled: false });
  release();
  await observer.settled(false);
  await observer.dispose();
  expect(conversation(session.messages)).toHaveLength(2);
  expect(observer.status.state).toBe("disabled");
});

it("preserves blockers after an error ending without a corrective continuation", async () => {
  const ending = "error";
  let mainCalls = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        message.content = [
          {
            type: "toolCall",
            id: "report",
            name: "onlooker_report",
            arguments: {
              findings: [
                {
                  severity: "blocker",
                  message: "Run verification.",
                  evidence: { quote: "Done" },
                },
              ],
            },
          },
        ];
        message.stopReason = "toolUse";
        queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message }));
      } else {
        mainCalls++;
        queueMicrotask(() =>
          stream.push({
            type: "error",
            reason: ending,
            error: { ...message, stopReason: ending },
          }),
        );
      }
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: Infinity },
    "headless-root",
  );
  onTestFinished(() => observer.dispose());
  observer.beforeTask();
  await session.prompt("Work");
  await observer.settled(false);
  expect(mainCalls).toBe(1);
  expect(session.messages.at(-1)).toMatchObject({ role: "custom", customType: "pi-onlooker" });
});

it("coalesces backlog and releases threshold seven below seven, not only at zero", async () => {
  let mainCalls = 0;
  let reviews = 0;
  let first = () => {};
  let second = () => {};
  const eighth = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "onlooker_report",
            arguments: { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
        const complete = () => stream.push({ type: "done", reason: "toolUse", message });
        if (reviews === 1) first = complete;
        else if (reviews === 2) {
          second = complete;
          secondStarted.resolve();
        } else queueMicrotask(complete);
      } else {
        mainCalls++;
        if (mainCalls < 8) {
          message.content = [
            {
              type: "toolCall",
              id: `main-${mainCalls}`,
              name: "read",
              arguments: { path: "/no-onlooker-test-file" },
            },
          ];
          message.stopReason = "toolUse";
        } else eighth.resolve();
        queueMicrotask(() =>
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          }),
        );
      }
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: 7 },
    "headless-root",
  );
  onTestFinished(() => observer.dispose());
  const prompt = session.prompt("Run eight observed turns");
  await vi.waitFor(() => expect(observer.status.backlog).toBe(7));
  expect(mainCalls).toBe(7);
  expect(reviews).toBe(1);
  first();
  await eighth.promise;
  await secondStarted.promise;
  expect(mainCalls).toBe(8);
  expect(observer.status.backlog).toBeGreaterThan(0);
  second();
  await prompt;
  await observer.settled(false);
  expect(observer.status.backlog).toBe(0);
  expect(reviews).toBe(3);
});

it("seeds Reviews and Consultations with observed-model evidence, not stored signatures, details or metadata", async () => {
  const callId = `call_${"x".repeat(200)}`;
  const image = {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  } as const;
  /** Each private request's prompt text and native image count. */
  const privateRequests: { text: string; images: number }[] = [];
  let mainCalls = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
        responseId: "resp_fixture",
      };
      if (privateRole) {
        const request = context.messages.at(-1);
        const blocks =
          request?.role === "user" && Array.isArray(request.content) ? request.content : [];
        const text = blocks
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
        privateRequests.push({
          text,
          images: blocks.filter((block) => block.type === "image").length,
        });
        if (!text.startsWith("Consultation request")) {
          message.content = [
            {
              type: "toolCall",
              id: "report",
              name: "onlooker_report",
              arguments: { findings: [] },
            },
          ];
          message.stopReason = "toolUse";
        }
      } else if (++mainCalls === 1) {
        message.content = [
          {
            type: "thinking",
            thinking: "Check the missing file first.",
            thinkingSignature: "SIG".repeat(500),
          },
          {
            type: "toolCall",
            id: callId,
            name: "read",
            arguments: { path: "/no-onlooker-evidence-file" },
            thoughtSignature: "THOUGHT".repeat(100),
          },
        ];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        }),
      );
      return stream;
    },
    toolResult: (event) => ({
      content: [...event.content, image],
      details: { screen: "#".repeat(5000) },
    }),
  };
  const session = await activeFixture();
  const config = { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: 1 };
  const observer = createObserver(session, config, "headless-root");
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Read the missing file", { images: [image] });
  expect(observer.status.lastError).toBeNull();
  const stored = session.messages.find((message) => message.role === "toolResult");
  expect(stored).toMatchObject({ isError: true, details: { screen: "#".repeat(5000) } });
  // A configuration change rebuilds the Onlooker Session, so the Consultation carries a full seed.
  observer.configure({ ...config, thinkingLevel: "low" });
  await expect(observer.consult("Was the read failure handled?")).resolves.toBe("Done");

  const ref = toolCallRef(callId);
  const seeds = [
    privateRequests.find(({ text }) => text.includes("Current context seed.")),
    privateRequests.find(({ text }) => text.startsWith("Consultation request")),
  ];
  for (const seed of seeds) {
    const payload = seed?.text.slice(seed.text.indexOf("\n") + 1) ?? "{}";
    const keys = new Set<string>();
    JSON.parse(payload, (key, value: unknown) => {
      keys.add(key);
      return value;
    });
    const { evidence } = seedPayload(seed);
    for (const field of [
      "thinkingSignature",
      "thoughtSignature",
      "signature",
      "details",
      "responseId",
      "api",
    ])
      expect(keys).not.toContain(field);
    expect(payload).not.toContain(callId);
    expect(payload).not.toContain(image.data);
    expect(seed?.images).toBe(2);
    expect(evidence.observedSetup?.tools).toContainEqual({
      name: "read",
      summary: stringMatching(/^\S.{0,159}$/),
    });
    expect(evidence.messages.slice(0, 3)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Read the missing file" },
          { type: "image", attachment: 1 },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Check the missing file first." },
          {
            type: "toolCall",
            ref,
            name: "read",
            arguments: { path: "/no-onlooker-evidence-file" },
          },
        ],
      },
      {
        role: "toolResult",
        ref,
        toolName: "read",
        isError: true,
        content: [
          { type: "text", text: stringContaining("no-onlooker-evidence-file") },
          { type: "image", attachment: 2 },
        ],
      },
    ]);
  }
});

it("bounds late interactive corrections across native before_agent_start hooks", async () => {
  let mainCalls = 0;
  let reviews = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "onlooker_report",
            arguments:
              reviews < 5
                ? {
                    findings: [
                      {
                        severity: "blocker",
                        message: `Blocker ${reviews}`,
                        evidence: { quote: "Done" },
                      },
                    ],
                  }
                : { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
      } else mainCalls++;
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: Infinity,
      maxCorrectiveTurns: 2,
    },
    "interactive",
  );
  onTestFinished(() => observer.dispose());
  globalThis.onlookerObserverTest.beforeTask = () => observer.beforeTask();
  await session.prompt("Work");
  await vi.waitFor(() =>
    expect(
      session.messages.filter(
        (message) => message.role === "custom" && message.customType === "pi-onlooker",
      ),
    ).toHaveLength(3),
  );
  expect(mainCalls).toBe(3);
  expect(observer.status.backlog).toBe(0);
});

it.each([
  [true, "concern", 1],
  [false, "blocker", 0],
] as const)(
  "with correct %s, a %s starts %i advisory Corrective Turns",
  async (correct, severity, corrections) => {
    const mainContexts: string[] = [];
    let reviews = 0;
    globalThis.onlookerObserverTest = {
      stream(model, context) {
        const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
        const stream = createAssistantMessageEventStream();
        const message = {
          ...fauxAssistantMessage("Done"),
          model: model.id,
          provider: model.provider,
          api: model.api,
        };
        if (privateRole) {
          reviews++;
          const findings =
            reviews === 1 ? [{ severity, message: "Untested.", evidence: { quote: "Done" } }] : [];
          message.content = [
            {
              type: "toolCall",
              id: `report-${reviews}`,
              name: "onlooker_report",
              arguments: { findings },
            },
          ];
          message.stopReason = "toolUse";
        } else mainContexts.push(JSON.stringify(context.messages));
        queueMicrotask(() =>
          stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
        );
        return stream;
      },
    };
    const session = await activeFixture();
    const observer = createObserver(
      session,
      {
        ...readOnlookerSettings(session).settings,
        enabled: true,
        correct,
        catchUpThreshold: Infinity,
      },
      "interactive",
    );
    onTestFinished(() => observer.dispose());
    await session.prompt("Work");
    await vi.waitFor(() => expect(observer.status.backlog).toBe(0));
    await vi.waitFor(() => expect(mainContexts).toHaveLength(1 + corrections));
    const advice =
      "Consider the findings reported above. Act on those that apply; you decide. Then continue the user's task until it is done.";
    expect(mainContexts.filter((context) => context.includes(advice))).toHaveLength(corrections);
  },
);

it("a Concern found before settlement continues the same run", async () => {
  const mainContexts: string[] = [];
  let reviews = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) {
        reviews++;
        const findings =
          reviews === 1
            ? [{ severity: "concern", message: "Untested.", evidence: { quote: "Done" } }]
            : [];
        message.content = [
          {
            type: "toolCall",
            id: `report-${reviews}`,
            name: "onlooker_report",
            arguments: { findings },
          },
        ];
        message.stopReason = "toolUse";
      } else mainContexts.push(JSON.stringify(context.messages));
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    // Each turn waits for its Review, so the Concern arrives before the run ends.
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: 1 },
    "interactive",
  );
  onTestFinished(() => observer.dispose());
  globalThis.onlookerObserverTest.beforeTask = () => observer.beforeTask();
  globalThis.onlookerObserverTest.beforeSettle = (event) => observer.beforeSettle(event);
  let settlements = 0;
  globalThis.onlookerObserverTest.settled = () => {
    settlements++;
    return observer.settled(false);
  };
  await session.prompt("Work");
  expect(settlements).toBe(1);
  // The task, the turn for the steered Concern, then the Corrective Turn.
  expect(mainContexts).toHaveLength(3);
  expect(mainContexts[1]).toContain("Onlooker concern: Untested.");
  expect(mainContexts[2]).toContain("Act on those that apply; you decide.");
});

it("disabled observation leaves the ordered native tools, prompt and conversation unchanged", async () => {
  const { session } = await createSdkHarness([]);
  const stream = session.agent.streamFunction;
  const tools = structuredClone(session.getAllTools());
  const prompt = session.systemPrompt;
  const messages = structuredClone(session.messages);
  const observer = createObserver(session, readOnlookerSettings(session).settings, "headless-root");
  onTestFinished(() => observer.dispose());
  await observer.settled(false);
  expect(observer.status).toMatchObject({
    state: "disabled",
    backlog: 0,
    cost: null,
  });
  observer.configure({
    ...readOnlookerSettings(session).settings,
    model: "configured/model",
    thinkingLevel: "low",
  });
  expect(session.getAllTools()).toEqual(tools);
  expect(session.systemPrompt).toBe(prompt);
  expect(session.messages).toEqual(messages);
  const disposal = observer.dispose();
  expect(observer.dispose()).toBe(disposal);
  await disposal;
  expect(session.agent.streamFunction).toBe(stream);
});

it("prioritizes consultation after the active Review and promptly cancels queued asks", async () => {
  const reviewStarted = Promise.withResolvers<void>();
  const releaseReview = Promise.withResolvers<void>();
  const consultationStarted = Promise.withResolvers<void>();
  const releaseConsultation = Promise.withResolvers<void>();
  const privatePrompts: string[] = [];
  const order: string[] = [];
  let reviews = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report") ?? false;
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (!privateRole) {
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
        return stream;
      }
      const prompt = JSON.stringify(context.messages.at(-1));
      privatePrompts.push(prompt);
      if (prompt.includes("Consultation request")) {
        order.push("consultation-start");
        consultationStarted.resolve();
        void releaseConsultation.promise.then(() => {
          order.push("consultation-end");
          stream.push({
            type: "done",
            reason: "stop",
            message: { ...message, content: [{ type: "text", text: "Inspect the shared seam." }] },
          });
        });
      } else {
        const review = ++reviews;
        order.push(`review-${review}-start`);
        const finish = () => {
          order.push(`review-${review}-end`);
          stream.push({
            type: "done",
            reason: "toolUse",
            message: {
              ...message,
              content: [
                {
                  type: "toolCall",
                  id: `report-${review}`,
                  name: "onlooker_report",
                  arguments: { severity: "none" },
                },
              ],
              stopReason: "toolUse",
            },
          });
        };
        if (review === 1) {
          reviewStarted.resolve();
          void releaseReview.promise.then(finish);
        } else queueMicrotask(finish);
      }
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: Infinity },
    "interactive",
  );
  onTestFinished(() => observer.dispose());

  await session.prompt("First completed step");
  await reviewStarted.promise;
  await session.prompt("Second completed step");
  const cancellation = new AbortController();
  const cancelled = observer.consult("Cancel this queued ask", cancellation.signal);
  cancellation.abort(new Error("User stopped the queued ask"));
  await expect(cancelled).rejects.toThrow("User stopped the queued ask");
  expect(order).toEqual(["review-1-start"]);

  const answer = observer.consult("Which seam should I inspect?");
  releaseReview.resolve();
  await consultationStarted.promise;
  expect(observer.status).toMatchObject({ state: "consulting", backlog: 1 });
  const queuedCancellation = new AbortController();
  const cancelledBehindConsultation = observer.consult(
    "Cancel this ask behind another Consultation",
    queuedCancellation.signal,
  );
  queuedCancellation.abort(new Error("User stopped the second queued ask"));
  await expect(cancelledBehindConsultation).rejects.toThrow("User stopped the second queued ask");
  expect(order).toEqual(["review-1-start", "review-1-end", "consultation-start"]);
  releaseConsultation.resolve();
  await expect(answer).resolves.toBe("Inspect the shared seam.");
  await expect.poll(() => observer.status.backlog).toBe(0);

  expect(order).toEqual([
    "review-1-start",
    "review-1-end",
    "consultation-start",
    "consultation-end",
    "review-2-start",
    "review-2-end",
  ]);
  expect(privatePrompts[1]).toContain("Second completed step");
  expect(privatePrompts[1]).toContain("Which seam should I inspect?");
  expect(privatePrompts[1]).not.toContain("First completed step");
  expect(privatePrompts[2]).toContain('\\"messages\\":[]');
});

it("cancels an on-demand consultation without pausing later advice", async () => {
  const consultationStarted = Promise.withResolvers<void>();
  let consultations = 0;
  const consultationPrompts: string[] = [];
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report") ?? false;
      const prompt = JSON.stringify(context.messages.at(-1));
      if (privateRole && prompt.includes("Consultation request")) consultationPrompts.push(prompt);
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      const stream = createAssistantMessageEventStream();
      if (!privateRole) {
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      } else if (prompt.includes("Consultation request")) {
        if (++consultations === 1) {
          consultationStarted.resolve();
          options?.signal?.addEventListener(
            "abort",
            () =>
              stream.push({
                type: "error",
                reason: "aborted",
                error: { ...message, stopReason: "aborted" },
              }),
            { once: true },
          );
        } else
          queueMicrotask(() =>
            stream.push({
              type: "done",
              reason: "stop",
              message: { ...message, content: [{ type: "text", text: "Recovered advice" }] },
            }),
          );
      } else
        queueMicrotask(() =>
          stream.push({
            type: "done",
            reason: "toolUse",
            message: {
              ...message,
              content: [
                {
                  type: "toolCall",
                  id: "report",
                  name: "onlooker_report",
                  arguments: { severity: "none" },
                },
              ],
              stopReason: "toolUse",
            },
          }),
        );
      return stream;
    },
  };
  const session = await activeFixture();
  const observer = createObserver(
    session,
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: Infinity },
    "interactive",
  );
  onTestFinished(() => observer.dispose());
  await session.prompt("Seed context");
  await expect.poll(() => observer.status.backlog).toBe(0);

  const cancellation = new AbortController();
  const cancelled = observer.consult("Help before cancellation", cancellation.signal);
  await consultationStarted.promise;
  cancellation.abort(new Error("User stopped the main turn"));
  await expect(cancelled).rejects.toThrow("User stopped the main turn");
  expect(observer.status).toMatchObject({ state: "armed", lastError: null, backlog: 0 });
  await expect(observer.consult("Try again")).resolves.toBe("Recovered advice");
  // Cancellation discarded the Onlooker Session, so its replacement starts from a Context Seed.
  expect(consultationPrompts.at(-1)).toContain("observedSetup");
  expect(consultationPrompts.at(-1)).toContain("Seed context");
});

it("renames delivered findings without rebuilding the private session", async () => {
  const requests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({}, requests, {
    report: (review) => ({
      findings: [{ severity: "blocker", message: `Check ${review}`, evidence: { quote: "Done" } }],
    }),
  });
  const session = await activeFixture();
  const config = {
    ...readOnlookerSettings(session).settings,
    enabled: true,
    name: "Marcel",
    reviewEvery: "request" as const,
  };
  const observer = createObserver(session, config, "headless-root");
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("First task");
  expect(session.messages).toContainEqual(
    expect.objectContaining({
      customType: "pi-onlooker",
      content: stringContaining("Marcel blocker:"),
      details: objectContaining({ name: "Marcel" }),
    }),
  );
  observer.configure({ ...config, name: "Inspector gadget" });
  expect(observer.status).toMatchObject({ name: "Inspector gadget", lastError: null });
  await session.prompt("Second task");
  expect(requests).toHaveLength(2);
  expect(seedPayload(requests[1]).header).toContain("Incremental update.");
  expect(session.messages).toContainEqual(
    expect.objectContaining({
      customType: "pi-onlooker",
      content: stringContaining("Inspector gadget blocker:"),
      details: objectContaining({ name: "Inspector gadget" }),
    }),
  );
  expect(session.messages).toContainEqual(
    expect.objectContaining({
      customType: "pi-onlooker",
      details: objectContaining({ name: "Marcel" }),
    }),
  );
});

it("describes omitted seed messages when the observed session has no file", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "Original request": 6 }, privateRequests, {
    result: (id) => `result ${id} ${"x".repeat(8_000)}`,
  });
  const session = await activeFixture({}, [], SessionManager.inMemory());
  await session.prompt("Original request: refactor the parser.");
  const config = {
    ...readOnlookerSettings(session).settings,
    enabled: true,
    catchUpThreshold: 1,
    maxToolResultChars: 1_000_000,
    seedBudgetTokens: 1_000,
  };
  const observer = createObserver(session, config, "headless-root");
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Final check");
  expect(observer.status.lastError).toBeNull();
  expect(session.sessionManager.getSessionFile()).toBeUndefined();
  // An unsaved observed session keeps its Onlooker Session unsaved too, out of the project.
  expect(existsSync(resolve("onlookers", session.sessionId))).toBe(false);
  const seed = seedPayload(privateRequests[0]);
  expect(seed.header).toContain("the seed budget (1000 tokens)");
  expect(seed.header).toMatch(/and omits the other \d+/);
  expect(seed.header).toContain(". The full observed messages are not available to this Onlooker.");
  expect(seed.header).not.toContain("Granted tools such as read or grep");
});

it("bounds the first Review of a long session by the automatic seed budget", async () => {
  const batches = 60;
  const result = (id: string) => `result ${id} ${"x".repeat(8_000)}`;
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "Original request": batches },
    privateRequests,
    { result },
  );
  const session = await activeFixture();
  await session.prompt("Original request: refactor the parser.");
  const config = {
    ...readOnlookerSettings(session).settings,
    enabled: true,
    catchUpThreshold: 1,
    // This test bounds the seed by its budget alone, so tool results stay uncapped.
    maxToolResultChars: 1_000_000,
  };
  const observer = createObserver(session, config, "headless-root");
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Final check");
  expect(observer.status.lastError).toBeNull();

  // The fixture model's window is 200k tokens, so `auto` is a 50k budget.
  const budget = 50_000;
  const observedMessages = conversation(session.messages);
  const seed = seedPayload(privateRequests[0]);
  const full = Math.ceil(
    JSON.stringify({
      observedSetup: seed.evidence.observedSetup,
      messages: projectEvidence(convertToLlm(observedMessages)).messages,
    }).length / 4,
  );
  // Recorded seed sizes: the unbounded seed exceeds the budget; the sent prompt payload fits.
  expect(full).toBeGreaterThan(budget * 1.5);
  // Before the Onlooker model reports usage, the seed is fitted at the fallback factor.
  const estimated = budget / onlookerFallbackTokenFactor;
  expect(seed.tokens).toBeLessThanOrEqual(estimated);
  expect(seed.tokens).toBeGreaterThan(estimated * 0.75);
  expect(seed.header).toContain("Current context seed.");
  expect(seed.header).toContain(`the seed budget (${budget} tokens)`);
  expect(seed.header).toMatch(
    new RegExp(
      `keeps the messages at positions 1, \\d+–${observedMessages.length} of the ${observedMessages.length} in the observed context and omits the other \\d+`,
    ),
  );
  expect(seed.header).toContain("The raw session journal is private.");
  expect(seed.header).not.toContain(session.sessionManager.getSessionFile());
  expect(seed.evidence.observedSetup?.systemPrompt).toBe(session.systemPrompt);
  expect(seed.evidence.messages[0]).toEqual({
    role: "user",
    content: [{ type: "text", text: "Original request: refactor the parser." }],
  });
  expect(seed.evidence.messages.slice(-2)).toEqual([
    { role: "user", content: [{ type: "text", text: "Final check" }] },
    { role: "assistant", content: [{ type: "text", text: "Done" }] },
  ]);

  // Later Reviews add only new messages; the omitted history is not re-sent.
  await session.prompt("Follow-up");
  expect(observer.status.lastError).toBeNull();
  const update = seedPayload(privateRequests[1]);
  expect(update.header).toContain("Incremental update.");
  expect(update.evidence.observedSetup).toBeUndefined();
  expect(update.evidence.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Follow-up" }] },
    { role: "assistant", content: [{ type: "text", text: "Done" }] },
  ]);
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it("keeps an in-flight Review current when the observed model changes under an Onlooker with its own", async () => {
  const privateRequests: PrivateRequest[] = [];
  const reviewHeld = Promise.withResolvers<void>();
  const releaseReview = Promise.withResolvers<void>();
  globalThis.onlookerObserverTest = longSessionStream({}, privateRequests, {
    hold: (review) => {
      if (review !== 1) return undefined;
      reviewHeld.resolve();
      return releaseReview.promise;
    },
  });
  const session = await activeFixture();
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: Infinity,
      model: "observer-fixture/priced",
    },
    "headless-root",
  );
  onTestFinished(async () => {
    releaseReview.resolve();
    await observer.dispose();
  });
  await session.prompt("First");
  await reviewHeld.promise;
  const alternate = session.modelRuntime.getModel("observer-fixture", "alternate");
  if (!alternate) throw new Error("Missing alternate fixture model");
  await session.setModel(alternate);
  expect(observer.status.state).toBe("reviewing");
  releaseReview.resolve();
  await vi.waitFor(() => expect(observer.status).toMatchObject({ state: "armed", backlog: 0 }));
  expect(observer.status.lastError).toBeNull();
  expect(privateRequests).toHaveLength(1);
});

it("seeds the compaction summary and the first user request after it, not findings or commands", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "Original request": 30, "Now also add tests.": 6 },
    privateRequests,
  );
  const session = await activeFixture();
  await session.prompt("Original request: refactor the parser.");
  await session.compact();
  await session.sendCustomMessage(
    {
      customType: "pi-onlooker",
      content: "Onlooker nit: rename the helper.",
      display: true,
      details: { severity: "nit", message: "rename the helper." },
    },
    { triggerTurn: false },
  );
  session.recordBashResult("ls", {
    output: "src",
    exitCode: 0,
    cancelled: false,
    truncated: false,
  });
  await session.prompt("Now also add tests.");
  const observer = createObserver(
    session,
    {
      ...readOnlookerSettings(session).settings,
      enabled: true,
      catchUpThreshold: 1,
      seedBudgetTokens: 4_000,
    },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  await session.prompt("Continue");
  expect(observer.status.lastError).toBeNull();
  const seed = seedPayload(privateRequests[0]);
  expect(seed.header).toMatch(
    /keeps the messages at positions 1, \d+, \d+–\d+ of the \d+ in the observed context and omits the other/,
  );
  const [summary, request] = seed.evidence.messages;
  expect(JSON.stringify(summary)).toContain("Summary: the user asked to refactor the parser.");
  expect(request).toEqual({
    role: "user",
    content: [{ type: "text", text: "Now also add tests." }],
  });
  expect(seed.evidence.messages.slice(-2)).toEqual([
    { role: "user", content: [{ type: "text", text: "Continue" }] },
    { role: "assistant", content: [{ type: "text", text: "Done" }] },
  ]);
});
