import { fileURLToPath } from "node:url";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { EvidenceBlock } from "pi-hl-utils/evidence";
import { onTestFinished, expect, it, vi } from "vitest";

import type { OnlookerFinding } from "../src/onlooker-contract.js";
import { type OnlookerMode } from "../src/onlooker-observer.js";
import { onlookerSettings } from "../src/onlooker-settings.js";
import {
  activeFixture,
  conversation,
  effectful,
  expectPrefix,
  longSessionStream,
  seedPayload,
  type PrivateRequest,
  createObserver,
  type ObserverSettings,
} from "./fixtures/observer-harness.js";

/** Short, successful observed tool results unless a test marks some as errors. */
const ok = { result: (id: string) => `ok ${id}`, isError: () => false };

async function observe(
  config: Partial<ObserverSettings>,
  settings: Parameters<typeof activeFixture>[0] = {},
  extensions: string[] = [],
  mode: OnlookerMode = "headless-root",
) {
  const session = await activeFixture(settings, extensions);
  const observer = createObserver(
    session,
    {
      ...onlookerSettings.readSettings(session).settings,
      enabled: true,
      catchUpThreshold: 1,
      ...config,
    },
    mode,
  );
  // An interactive observer here sees only native agent events, not the settled hook.
  if (mode === "headless-root")
    globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  return { session, observer };
}

function blockText(block: EvidenceBlock): string {
  if (block.type === "text") return block.text;
  return block.type === "toolCall" ? block.name : "";
}

/** Observed messages a Review received, as role/text pairs for compact comparison. */
function received(request: PrivateRequest | undefined): string[] {
  return seedPayload(request).evidence.messages.map(
    (message) =>
      `${message.role}:${typeof message.content === "string" ? message.content : message.content.map(blockText).join("")}`,
  );
}

it('reviews a multi-turn request once, at its completion, under reviewEvery "request"', async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "First request": 5, "Second request": 3 },
    privateRequests,
    ok,
  );
  const { session, observer } = await observe({ reviewEvery: "request" });
  await session.prompt("First request: refactor the parser.");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  // One Review covers all six turns: the request, five tool batches, and the final answer.
  expect(privateRequests).toHaveLength(1);
  const first = received(privateRequests[0]);
  expect(first).toHaveLength(12);
  expect(first[0]).toBe("user:First request: refactor the parser.");
  expect(first.at(-1)).toBe("assistant:Done");
  expect(first.filter((message) => message.startsWith("toolResult:"))).toHaveLength(5);

  await session.prompt("Second request: add tests.");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  expect(privateRequests).toHaveLength(2);
  expect(seedPayload(privateRequests[1]).header).toContain("Incremental update.");
  const second = received(privateRequests[1]);
  expect(second).toHaveLength(8);
  expect(second[0]).toBe("user:Second request: add tests.");
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it("waits for Pi's automatic retry before reviewing the request", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "Retried task": 2 }, privateRequests, {
    ...ok,
    firstError: "529 overloaded_error: Overloaded",
  });
  const { session, observer } = await observe(
    { reviewEvery: "request" },
    { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
  );
  await session.prompt("Retried task");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  // The failed attempt ended a run that Pi retried, so only the retried run's end is reviewed.
  expect(privateRequests).toHaveLength(1);
  const messages = received(privateRequests[0]);
  expect(messages[0]).toBe("user:Retried task");
  expect(messages.at(-1)).toBe("assistant:Done");
});

it("lets a slow whole-request Review finish within the headless final drain", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "Slow review": 4 }, privateRequests, {
    ...ok,
    reviewDelayMs: 40_000,
    report: () => ({
      findings: [
        {
          severity: "concern",
          message: "Verify the slow path.",
          evidence: { quote: "Done" },
        },
      ],
    }),
  });
  const { session, observer } = await observe({ reviewEvery: "request" });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finished = false;
  const prompt = session.prompt("Slow review").then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(privateRequests).toHaveLength(1));
  // Past the 30-second Catch-up Wait ceiling, the final drain still waits for the Review.
  await vi.advanceTimersByTimeAsync(35_000);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  await prompt;
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  expect(received(privateRequests[0])).toHaveLength(10);
  expect(session.messages.at(-1)).toMatchObject({
    role: "custom",
    customType: "pi-onlooker",
    content: 'Onlooker concern: Verify the slow path.\n[observed through turn 5; quote: "Done"]',
  });
});

it("finishes a request's Review across observed compaction after the request, then reseeds", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "Big request": 3, "Next request": 1 },
    privateRequests,
    {
      isError: () => false,
      report: (review) => ({
        findings:
          review === 1
            ? [
                {
                  severity: "nit",
                  message: "Name the parser helper.",
                  evidence: { quote: "Done" },
                },
              ]
            : [],
      }),
    },
  );
  const { session, observer } = await observe(
    { reviewEvery: "request" },
    { compaction: { enabled: false, keepRecentTokens: 1_000 } },
    [],
    "interactive",
  );
  await session.prompt("Big request");
  // The observed session compacts while the Review its request's end started is in flight.
  expect(observer.status.state).toBe("reviewing");
  await session.compact();
  await vi.waitFor(() => expect(observer.status.state).toBe("armed"));
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  // That Review still covers the whole request and delivers its finding.
  expect(privateRequests).toHaveLength(1);
  expect(received(privateRequests[0])).toHaveLength(8);
  expect(
    session.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom_message" && entry.customType === "pi-onlooker"),
  ).toBe(true);
  // The next Review rebuilds the Onlooker Session from the compacted observed context.
  await session.prompt("Next request");
  await vi.waitFor(() => expect(privateRequests).toHaveLength(2));
  await vi.waitFor(() => expect(observer.status.state).toBe("armed"));
  expect(observer.status.lastError).toBeNull();
  const next = seedPayload(privateRequests[1]);
  expect(next.header).toContain("Current context seed.");
  expect(JSON.stringify(next.evidence.messages)).toContain(
    "Summary: the user asked to refactor the parser.",
  );
});

it('reviews a tool-error turn at once, then the rest of the request, under reviewEvery "request"', async () => {
  const reviewEvery = "request";
  const privateRequests: PrivateRequest[] = [];
  // The second tool batch (`0-1`) fails; batches are named `<request index>-<batch>`.
  globalThis.onlookerObserverTest = longSessionStream({ "Fix the build": 5 }, privateRequests, {
    ...ok,
    isError: (id) => id === "0-1",
  });
  const { session, observer } = await observe({ reviewEvery });
  await session.prompt("Fix the build");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  expect(privateRequests).toHaveLength(2);
  // The first Review stops at the failed batch: the request and two tool batches.
  const [failed, rest] = privateRequests.map(received);
  expect(failed).toHaveLength(5);
  expect(failed?.at(-1)).toBe("toolResult:ok 0-1");
  // The second covers every remaining turn: three more batches and the final answer.
  expect(rest).toHaveLength(7);
  expect(rest?.at(-1)).toBe("assistant:Done");
  expect([...(failed ?? []), ...(rest ?? [])]).toHaveLength(conversation(session.messages).length);
});

const annotatedTools = fileURLToPath(
  new URL("./fixtures/annotated-tools-extension.ts", import.meta.url),
);
const readTurn = { name: "read", arguments: { path: "/missing" } };

it("reviews a run of read-only turns once, with the edit that follows them", async () => {
  const privateRequests: PrivateRequest[] = [];
  // Three reads, then a command with effects: batches `0-0` to `0-3`.
  globalThis.onlookerObserverTest = longSessionStream({ "Explore then edit": 4 }, privateRequests, {
    ...ok,
    call: (id) => (id === "0-3" ? effectful(id) : readTurn),
  });
  const { session, observer } = await observe({});
  // Backlog at each turn's end, before the Onlooker counts that turn: reads add to it unreviewed.
  const backlogs: number[] = [];
  session.subscribe((event) => {
    if (event.type === "turn_end") backlogs.push(observer.status.backlog);
  });
  await session.prompt("Explore then edit");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  expect(backlogs).toEqual([0, 1, 2, 3, 0]);
  // One Review covers the request, all three read turns, and the command; one the answer.
  expect(privateRequests.map((request) => received(request).length)).toEqual([9, 1]);
  expect(
    received(privateRequests[0]).filter((message) => message.startsWith("toolResult:")),
  ).toHaveLength(4);
  expect(received(privateRequests[1])).toEqual(["assistant:Done"]);
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it("tells a Review whether the agent is still working on the request", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "Edit once": 1 }, privateRequests, {
    ...ok,
    call: effectful,
  });
  const { session } = await observe({});
  await session.prompt("Edit once");
  expect(privateRequests.map((request) => request.text.includes("still working"))).toEqual([
    true,
    false,
  ]);
});

it("reviews an errored read-only call at once, with the read turns before it", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "Explore badly": 4 }, privateRequests, {
    ...ok,
    call: () => readTurn,
    isError: (id) => id === "0-1",
  });
  const { session, observer } = await observe({});
  await session.prompt("Explore badly");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  // The first Review stops at the failed read; the next covers the reads after it.
  expect(privateRequests.map((request) => received(request).length)).toEqual([5, 5]);
  expect(received(privateRequests[0]).at(-1)).toBe("toolResult:ok 0-1");
  expect(received(privateRequests[1]).at(-1)).toBe("assistant:Done");
});

it.each([
  ["a built-in read tool", [readTurn], true],
  [
    "grep, find and ls together",
    [
      { name: "grep", arguments: { pattern: "x" } },
      { name: "find", arguments: { pattern: "*.ts" } },
      { name: "ls", arguments: {} },
    ],
    true,
  ],
  ["a tool annotated readOnlyHint: true", [{ name: "lookup", arguments: {} }], true],
  ["a tool annotated readOnlyHint: false", [{ name: "mutate", arguments: {} }], false],
  ["an unknown tool", [{ name: "missing_tool", arguments: {} }], false],
  ["a read alongside bash", [readTurn, { name: "bash", arguments: { command: "true" } }], false],
])("classifies a turn that calls %s for its Review", async (_name, calls, readOnly) => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "One batch": 1 }, privateRequests, {
    ...ok,
    call: () => calls,
  });
  const { session, observer } = await observe({}, {}, [annotatedTools]);
  // Pi activates only some built-in tools by default; an inactive one would fail before the hook.
  session.setActiveToolsByName([...session.getActiveToolNames(), "grep", "find", "ls"]);
  await session.prompt("One batch");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  const sizes = privateRequests.map((request) => received(request).length);
  // A read-only batch waits for the answer's Review; any other turn is reviewed at once.
  expect(sizes).toEqual(readOnly ? [calls.length + 3] : [calls.length + 2, 1]);
});

it("leaves reviewEvery 3 unchanged for read-only turns", async () => {
  const reviewEvery = 3;
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "Long read": 7 }, privateRequests, {
    ...ok,
    call: () => readTurn,
  });
  const { session, observer } = await observe({ reviewEvery });
  await session.prompt("Long read");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  expect(privateRequests.map((request) => received(request).length)).toEqual([7, 6, 3]);
});

/** Pi's estimate of an Onlooker context, without the newest prompt that started the request. */
function sessionTokens(request: PrivateRequest | undefined): number {
  return (request?.messages ?? [])
    .slice(0, -1)
    .reduce((sum, message) => sum + estimateTokens(message), 0);
}

it.each([
  ["reported context usage", true],
  ["estimated size without usage", false],
])(
  "compacts the Onlooker Session natively to stay under maxSessionTokens with %s, keeping its bookkeeping",
  async (_usage, reportContextTokens) => {
    const privateRequests: PrivateRequest[] = [];
    const summaries: Context[] = [];
    const parser: OnlookerFinding = {
      severity: "concern",
      message: "The parser change lacks a test.",
      evidence: { quote: "Done" },
    };
    const lexer: OnlookerFinding = {
      severity: "concern",
      message: "The lexer change lacks a test.",
      evidence: { quote: "Done" },
    };
    // The third Review repeats the first Concern, which stays suppressed.
    const concerns = new Map([
      [1, [parser]],
      [2, [lexer]],
      [3, [parser]],
    ]);
    const requests = Array.from({ length: 12 }, (_, index) => `Request ${index + 1}.`);
    globalThis.onlookerObserverTest = longSessionStream(
      Object.fromEntries(requests.map((request) => [request, 1])),
      privateRequests,
      {
        result: (id) => `result ${id} ${"x".repeat(8_000)}`,
        isError: () => false,
        reportContextTokens,
        summaries,
        report: (review) => ({ findings: concerns.get(review) ?? [] }),
      },
    );
    const { session, observer } = await observe(
      { reviewEvery: "request", maxSessionTokens: 4_000 },
      { compaction: { enabled: false, keepRecentTokens: 1_000 } },
    );
    for (const request of requests) await session.prompt(request);
    expect(observer.status.lastError).toBeNull();
    expect(privateRequests).toHaveLength(12);

    // Native compaction ran through Pi's summarizer, and each later Review starts under the cap.
    expect(summaries.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...privateRequests.slice(1).map(sessionTokens))).toBeLessThanOrEqual(4_000);
    expect(sessionTokens(privateRequests.at(-1))).toBeLessThan(4_000);
    const summary = "Summary: the user asked to refactor the parser.";
    expect(JSON.stringify(privateRequests.at(-1)?.messages)).toContain(summary);

    // The first compaction followed the second Review; the third still continues incrementally.
    expect(JSON.stringify(privateRequests[1]?.messages)).not.toContain(summary);
    expect(JSON.stringify(privateRequests[2]?.messages)).toContain(summary);
    const third = seedPayload(privateRequests[2]);
    expect(third.header).toContain("Incremental update.");
    const thirdMessages = received(privateRequests[2]);
    expect(thirdMessages).toHaveLength(5);
    expect(thirdMessages[0]).toBe(
      'user:Onlooker concern: The lexer change lacks a test.\n[observed through turn 4; quote: "Done"]',
    );
    expect(thirdMessages[1]).toBe("user:Request 3.");
    expect(thirdMessages.at(-1)).toBe("assistant:Done");
    // Prior findings survive: the repeated Concern is not delivered twice.
    const delivered = session.messages.flatMap((message) =>
      message.role === "custom" && message.customType === "pi-onlooker" ? [message.content] : [],
    );
    expect(delivered).toEqual([
      'Onlooker concern: The parser change lacks a test.\n[observed through turn 2; quote: "Done"]',
      'Onlooker concern: The lexer change lacks a test.\n[observed through turn 4; quote: "Done"]',
    ]);
    expectStableAcrossCompaction(privateRequests);
  },
);

/**
 * Onlooker cache proof across compaction: every request keeps the system prompt and tools, and
 * each Review without a compaction since the previous one extends its history unchanged.
 */
function expectStableAcrossCompaction(privateRequests: PrivateRequest[]) {
  for (const [index, request] of privateRequests.entries()) {
    const previous = privateRequests[index - 1];
    if (!previous) continue;
    expect(request.systemPrompt).toEqual(previous.systemPrompt);
    expect(request.tools).toEqual(previous.tools);
    if (request.summariesBefore === previous.summariesBefore) expectPrefix(request, previous);
  }
}

it("lets the headless final drain wait for a running Onlooker Session compaction", async () => {
  const privateRequests: PrivateRequest[] = [];
  const summaries: Context[] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "Request 1.": 0, "Request 2.": 0, "Request 3.": 0 },
    privateRequests,
    {
      isError: () => false,
      summaries,
      summaryDelayMs: 300,
    },
  );
  // No Catch-up Wait, so only the final drain can wait for the compaction.
  const { session, observer } = await observe(
    { maxSessionTokens: 1_000, catchUpThreshold: Infinity },
    { compaction: { enabled: false, keepRecentTokens: 1_000 } },
    [],
    "headless-root",
  );
  // The drain starts once the Review itself has finished, while its compaction still runs.
  const reviewed = () => vi.waitFor(() => expect(observer.status.backlog).toBe(0));
  globalThis.onlookerObserverTest.settled = async () => {
    await reviewed();
    await observer.settled(false);
  };
  const finish = (request: string) => session.prompt(request);
  // Each request is one turn, reviewed at once; padding makes the second compact.
  await finish("Request 1.");
  await finish(`Request 2. ${"pad ".repeat(1_500)}`);
  expect(summaries).toHaveLength(1);
  await finish("Request 3.");
  expect(observer.status.lastError).toBeNull();
  expect(privateRequests).toHaveLength(3);
  // The drain waited, so the compacted Onlooker Session continues rather than being discarded.
  expect(seedPayload(privateRequests[2]).header).toContain("Incremental update.");
  expect(JSON.stringify(privateRequests[2]?.messages)).toContain(
    "Summary: the user asked to refactor the parser.",
  );
});

it("keeps the Onlooker Session when Pi declines to compact a session that is all recent history", async () => {
  const privateRequests: PrivateRequest[] = [];
  const summaries: Context[] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "Request 1.": 1, "Request 2.": 1 },
    privateRequests,
    { isError: () => false, summaries },
  );
  // The first Review's Context Seed alone exceeds the cap, but Pi keeps it as recent history.
  const { session, observer } = await observe(
    { reviewEvery: "request", maxSessionTokens: 1_000 },
    { compaction: { enabled: false, keepRecentTokens: 1_000 } },
  );
  await session.prompt("Request 1.");
  expect(observer.status.lastError).toBeNull();
  expect(seedPayload(privateRequests[0]).tokens).toBeGreaterThan(1_000);
  expect(summaries).toEqual([]);
  // A declined compaction called no model.
  expect(observer.status.spend.compactions.count).toBe(0);
  await session.prompt("Request 2.");
  expect(observer.status.lastError).toBeNull();
  // Declining is not a failure: the same Onlooker Session continues incrementally.
  expect(seedPayload(privateRequests[1]).header).toContain("Incremental update.");
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it("reseeds instead of pausing when Onlooker Session compaction times out", async () => {
  const privateRequests: PrivateRequest[] = [];
  const summaries: Context[] = [];
  const requests = ["Request 1.", "Request 2.", "Request 3."];
  globalThis.onlookerObserverTest = longSessionStream(
    Object.fromEntries(requests.map((request) => [request, 1])),
    privateRequests,
    { isError: () => false, summaries, hangSummaries: true },
  );
  // Without a headless final drain, only the compaction deadline can end a hung compaction.
  const { session, observer } = await observe(
    { reviewEvery: "request", maxSessionTokens: 4_000, reviewTimeoutMs: 1_000 },
    { compaction: { enabled: false, keepRecentTokens: 1_000 } },
    [],
    "interactive",
  );
  for (const request of requests) {
    await session.prompt(request);
    await vi.waitFor(() => expect(observer.status.state).toBe("armed"), {
      timeout: 5_000,
    });
  }
  expect(observer.status.lastError).toBeNull();
  expect(privateRequests).toHaveLength(3);
  // The second Review's compaction failed after its findings were delivered.
  expect(seedPayload(privateRequests[1]).header).toContain("Incremental update.");
  expect(summaries).toHaveLength(1);
  // The next Review starts a fresh Onlooker Session from a budgeted Context Seed.
  const third = seedPayload(privateRequests[2]);
  expect(third.header).toContain("Current context seed.");
  expect(privateRequests[2]?.messages).toHaveLength(1);
  expect(observer.status.spend.reviews.count).toBe(3);
  expect(observer.status.spend.compactions.count).toBe(1);
});

it("accounts Reviews, consultations and compactions separately in status", async () => {
  const summaries: Context[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "Request 1.": 0, "Request 2.": 0 }, [], {
    ...ok,
    summaries,
    reviewDelayMs: 30,
    usage: {
      input: 1_000,
      output: 100,
      cacheRead: 500,
      cacheWrite: 20,
      totalTokens: 1_620,
      cost: { input: 0.003, output: 0.001, cacheRead: 0.0005, cacheWrite: 0, total: 0.0045 },
    },
  });
  const { session, observer } = await observe(
    { maxSessionTokens: 1_000, catchUpThreshold: Infinity },
    { compaction: { enabled: false, keepRecentTokens: 1_000 } },
  );
  globalThis.onlookerObserverTest.settled = async () => {
    await vi.waitFor(() => expect(observer.status.backlog).toBe(0));
    await observer.settled(false);
  };
  await session.prompt("Request 1.");
  // Padding makes the second Review's Onlooker Session compact.
  await session.prompt(`Request 2. ${"pad ".repeat(1_500)}`);
  expect(summaries).toHaveLength(1);
  await expect(observer.consult("Is the parser done?")).resolves.toBe("Done");
  expect(observer.status.lastError).toBeNull();

  const once = { count: 1, calls: 1, input: 1_000, output: 100, cacheRead: 500, cacheWrite: 20 };
  const { reviews, consultations, compactions, evidence } = observer.status.spend;
  const twice = { count: 2, calls: 2, input: 2_000, output: 200, cacheRead: 1_000, cacheWrite: 40 };
  expect(reviews).toMatchObject(twice);
  expect(reviews.cost).toBeCloseTo(0.009);
  expect(reviews.ms).toBeGreaterThanOrEqual(50);
  expect(compactions).toMatchObject(once);
  expect(compactions.cost).toBeCloseTo(0.0045);
  expect(consultations).toMatchObject(once);
  expect(consultations.cost).toBeCloseTo(0.0045);
  expect(evidence.seeds).toBe(1);
});

function deadlineOn(hung: number[], batches: Record<string, number> = {}) {
  const fixture = longSessionStream(batches, [], { ...ok, isError: () => true });
  let reviews = 0;
  globalThis.onlookerObserverTest = {
    ...fixture,
    stream(model, context, options) {
      if (
        !context.tools?.some((tool) => tool.name === "onlooker_report") ||
        !hung.includes(++reviews)
      )
        return fixture.stream(model, context, options);
      const stream = createAssistantMessageEventStream();
      const aborted = {
        ...fauxAssistantMessage(""),
        model: model.id,
        provider: model.provider,
        api: model.api,
        stopReason: "aborted" as const,
      };
      options?.signal?.addEventListener(
        "abort",
        () => stream.push({ type: "error", reason: "aborted", error: aborted }),
        { once: true },
      );
      return stream;
    },
  };
  return () => reviews;
}

it("leaves a Review past its deadline to the next turn without pausing", async () => {
  const reviews = deadlineOn([1]);
  const { session, observer } = await observe({ reviewTimeoutMs: 20 });
  await session.prompt("First");
  expect(reviews()).toBe(1);
  expect(observer.status.lastError).toBeNull();
  await session.prompt("Second");
  expect(reviews()).toBe(2);
  expect(observer.status.lastError).toBeNull();
  expect(observer.status.backlog).toBe(0);
});

it("reviews turns that finish during a late Review without waiting for another turn", async () => {
  const reviews = deadlineOn([1], { "Two turns": 1 });
  const { session, observer } = await observe(
    { reviewTimeoutMs: 250, catchUpThreshold: 10 },
    {},
    [],
    "interactive",
  );
  await session.prompt("Two turns");
  await vi.waitFor(() => expect(observer.status.backlog).toBe(0));
  expect(reviews()).toBe(2);
});

it("starts a fresh count of Review deadlines after /onlooker on", async () => {
  const reviews = deadlineOn([1, 2, 3, 4]);
  const { session, observer } = await observe({ reviewTimeoutMs: 20 });
  for (const prompt of ["1", "2", "3"]) await session.prompt(prompt);
  expect(observer.status.state).toBe("paused");
  const { name, thinkingLevel, reviewEvery, correct } =
    onlookerSettings.readSettings(session).settings;
  observer.configure({ enabled: true, name, thinkingLevel, reviewEvery, correct });
  await session.prompt("4");
  expect(reviews()).toBe(4);
  expect(observer.status.lastError).toBeNull();
});

it("counts only Review deadlines in a row toward the pause", async () => {
  const reviews = deadlineOn([1, 2, 4, 5]);
  const { session, observer } = await observe({ reviewTimeoutMs: 20 });
  for (const prompt of ["1", "2", "3", "4", "5"]) await session.prompt(prompt);
  expect(reviews()).toBe(5);
  expect(observer.status.lastError).toBeNull();
});

it("charges a cancelled Review the usage its provider reports after the abort", async () => {
  const fixture = longSessionStream({}, [], ok);
  globalThis.onlookerObserverTest = {
    ...fixture,
    stream(model, context, options) {
      if (!context.tools?.some((tool) => tool.name === "onlooker_report"))
        return fixture.stream(model, context, options);
      const stream = createAssistantMessageEventStream();
      // As a provider does: the aborted response, with its usage so far, arrives after the abort.
      const aborted = {
        ...fauxAssistantMessage(""),
        model: model.id,
        provider: model.provider,
        api: model.api,
        stopReason: "aborted" as const,
      };
      aborted.usage = { ...aborted.usage, input: 1_000, totalTokens: 1_000 };
      options?.signal?.addEventListener(
        "abort",
        () =>
          setTimeout(() => stream.push({ type: "error", reason: "aborted", error: aborted }), 10),
        { once: true },
      );
      return stream;
    },
  };
  const { session, observer } = await observe({ reviewTimeoutMs: 50 });
  await session.prompt("First");
  await vi.waitFor(() => expect(observer.status.spend.reviews).toMatchObject({ count: 1 }));
  expect(observer.status.spend.reviews).toMatchObject({ calls: 1, input: 1_000 });
});

it("counts the evidence each Context Seed omits or shortens and each capped tool result", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "Long request": 6 }, privateRequests, {
    isError: () => false,
  });
  const { session, observer } = await observe({
    reviewEvery: "request",
    seedBudgetTokens: 3_000,
    maxToolResultChars: 2_000,
  });
  await session.prompt("Long request: inspect every file.");
  expect(observer.status.lastError).toBeNull();
  const sent = privateRequests[0]?.text ?? "";
  const omitted = Number(/omits the other (\d+)/.exec(sent)?.[1]);
  const shortened = Number(/; (\d+) kept messages are shortened/.exec(sent)?.[1] ?? 0);
  // Every tool result here exceeds the cap, so each kept one counts as capped, even when the seed
  // shortens it past its cap marker.
  const capped = sent.split('"role":"toolResult"').length - 1;
  expect(omitted).toBeGreaterThan(0);
  expect(sent).toContain("characters omitted from this tool result");
  expect(observer.status.spend.evidence).toEqual({
    seeds: 1,
    omittedMessages: omitted,
    shortenedMessages: shortened,
    cappedResults: capped,
  });
});

it("does not count a short tool result that quotes the capped-result marker as capped", async () => {
  globalThis.onlookerObserverTest = longSessionStream({ "Request 1.": 1, "Request 2.": 1 }, [], {
    isError: () => false,
    result: () => "12 characters omitted from this tool result",
  });
  const { session, observer } = await observe({ reviewEvery: "request" });
  await session.prompt("Request 1.");
  await session.prompt("Request 2.");
  expect(observer.status.lastError).toBeNull();
  // The first Review sends a Context Seed, the second an incremental update.
  expect(observer.status.spend).toMatchObject({
    reviews: { count: 2 },
    evidence: { seeds: 1, cappedResults: 0 },
  });
});

it("sends the observed agent's reasoning in the Context Seed and in incremental updates", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "Request 1.": 1, "Request 2.": 1 },
    privateRequests,
    { ...ok, thinking: "PRIVATE-PLAN" },
  );
  const { session, observer } = await observe({ reviewEvery: "request" });
  await session.prompt("Request 1.");
  await session.prompt("Request 2.");
  expect(observer.status.lastError).toBeNull();
  expect(seedPayload(privateRequests[1]).header).toContain("Incremental update.");
  expect(privateRequests.map((request) => request.text.includes("PRIVATE-PLAN"))).toEqual([
    true,
    true,
  ]);
});

it("reports a Review without usage on a priced model as a known $0", async () => {
  globalThis.onlookerObserverTest = longSessionStream({}, [], ok);
  const { session, observer } = await observe({
    model: "observer-fixture/priced",
  });
  await session.prompt("First");
  expect(observer.status.lastError).toBeNull();
  expect(observer.status.spend.reviews).toMatchObject({ count: 1, calls: 1, cost: 0 });
});

it("reports an unknown cost when an unpriced model reports no cost", async () => {
  globalThis.onlookerObserverTest = longSessionStream({}, [], ok);
  const { session, observer } = await observe({});
  await session.prompt("First");
  expect(observer.status.lastError).toBeNull();
  expect(observer.status.spend.reviews).toMatchObject({ count: 1, cost: null });
});
