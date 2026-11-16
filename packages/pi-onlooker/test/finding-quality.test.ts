import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { onTestFinished, expect, it } from "vite-plus/test";

import {
  onlookerPrompt,
  readOnlookerSettings,
  type OnlookerConfig,
} from "../src/onlooker-settings.js";
import {
  activeFixture,
  effectful,
  longSessionStream,
  seedPayload,
  type LongSessionOptions,
  type PrivateRequest,
  createObserver,
  type ObserverSettings,
} from "./fixtures/observer-harness.js";
import { fixture, response } from "./fixtures/onlooker-runtime.js";
import { reply, toolCall } from "./fixtures/sdk-harness.js";

async function observe(
  config: Partial<ObserverSettings>,
  mode: "headless-root" | "interactive" = "headless-root",
) {
  const session = await activeFixture();
  const settings: OnlookerConfig = {
    ...readOnlookerSettings(session).settings,
    enabled: true,
    catchUpThreshold: 1,
    ...config,
  };
  const observer = createObserver(session, settings, mode);
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  // The fixture's native before_agent_start hook starts each request, as the extension's does.
  globalThis.onlookerObserverTest.beforeTask = () => observer.beforeTask();
  onTestFinished(() => observer.dispose());
  return { session, observer, settings };
}

/** Interventions recorded in the observed session, as their model-visible text. */
function delivered(session: AgentSession): string[] {
  return session.messages.flatMap((message) =>
    message.role !== "custom" || message.customType !== "pi-onlooker"
      ? []
      : Array.isArray(message.content)
        ? []
        : [message.content],
  );
}

/** Tool-Call References of the observed tool calls a private request supplied. */
function refsIn(request: PrivateRequest | undefined): string[] {
  return seedPayload(request).evidence.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.ref] : []))
      : [],
  );
}

/** Resolves once the observed agent has completed `count` turns, after its handlers settle. */
function afterTurns(session: AgentSession, count: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let turns = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "turn_end" || ++turns < count) return;
    unsubscribe();
    setTimeout(resolve, 0);
  });
  return promise;
}

/** Each Review in one private Onlooker Session has the same system prompt and tools. */
function expectStableOnlookerPrefix(requests: PrivateRequest[]) {
  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests.slice(1)) {
    expect(request.systemPrompt).toEqual(requests[0]?.systemPrompt);
    expect(request.tools).toEqual(requests[0]?.tools);
  }
}

/** Successful tool calls with effects, so every turn starts a Review under the default cadence. */
const ok: LongSessionOptions = {
  result: (id) => `ok ${id}`,
  isError: () => false,
  call: effectful,
};

it("delivers a Review's findings when newer turns completed during the Review", async () => {
  const privateRequests: PrivateRequest[] = [];
  let release: Promise<void> | undefined;
  globalThis.onlookerObserverTest = longSessionStream({ "Fix the parser": 1 }, privateRequests, {
    ...ok,
    // The first Review, of the tool batch, answers only after the final answer has completed.
    hold: (review) => (review === 1 ? release : undefined),
    report: (review, request) => ({
      findings:
        review === 1
          ? [
              {
                severity: "concern",
                message: "The parser fix was not verified.",
                evidence: { refs: refsIn(request).slice(0, 1) },
              },
              {
                severity: "nit",
                message: "Name the parser helper consistently.",
                evidence: { quote: "ok 0-0" },
              },
            ]
          : [],
    }),
  });
  const { session, observer } = await observe({ catchUpThreshold: Infinity });
  release = afterTurns(session, 2);
  await session.prompt("Fix the parser");
  expect(observer.status).toMatchObject({ lastError: null, backlog: 0 });
  expect(privateRequests).toHaveLength(2);
  expect(delivered(session)).toEqual([
    "Onlooker concern: The parser fix was not verified.",
    "Onlooker nit: Name the parser helper consistently.",
  ]);
  expectStableOnlookerPrefix(privateRequests);
});

it("delivers every Nit, with no cap per request", async () => {
  let reviews = 0;
  const { session } = await fixture({ interactive: true });
  globalThis.onlookerObserverTest = {
    stream(model, context, options) {
      if (!context.tools?.some((tool) => tool.name === "onlooker_report"))
        return response(model, reply("Done"), options);
      reviews++;
      const nit = (message: string) => ({ severity: "nit", message, evidence: { quote: "Done" } });
      return response(
        model,
        toolCall(
          "onlooker_report",
          {
            findings:
              reviews === 1
                ? ["A", "B", "C", "D"].map((name) => nit(`Nit ${name}.`))
                : [nit(`Nit ${reviews}.`)],
          },
          `report-${reviews}`,
        ),
        options,
      );
    },
  };
  const nits = () =>
    session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom_message" && entry.customType === "pi-onlooker"
          ? [entry.content]
          : [],
      );
  await session.prompt("First task");
  await session.prompt("Second task");
  await expect.poll(() => nits().length).toBe(5);
  expect(nits()).toEqual([
    "Onlooker nit: Nit A.",
    "Onlooker nit: Nit B.",
    "Onlooker nit: Nit C.",
    "Onlooker nit: Nit D.",
    "Onlooker nit: Nit 2.",
  ]);
});

it("accepts Tool-Call References supplied by a Consultation or a rebuilt Context Seed", async () => {
  const privateRequests: PrivateRequest[] = [];
  let consultationRefs: string[] = [];
  const reviewRefs: string[][] = [];
  const expectedRefs: string[][] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "Fix the parser": 1, "Check again": 0 },
    privateRequests,
    {
      ...ok,
      report: (review, request) => {
        const refs = refsIn(request);
        reviewRefs.push(refs);
        // The request-end Review receives only messages newer than the Consultation. After a
        // reseed, the Context Seed resupplies the earlier tool call.
        expectedRefs.push(review === 1 ? [] : consultationRefs);
        if (review === 1) {
          return {
            findings: [
              {
                severity: "concern",
                message: "The parser read was unchecked.",
                evidence: { refs: consultationRefs },
              },
            ],
          };
        }
        return {
          findings: [
            {
              severity: "blocker",
              message: "The parser read was unchecked.",
              evidence: { refs },
            },
          ],
        };
      },
    },
  );
  const { session, observer, settings } = await observe({ reviewEvery: "request" });
  let consulted = false;
  globalThis.onlookerObserverTest.turnEnd = async (event) => {
    // At the final answer's turn_end, the tool call's turn is captured but not yet reviewed.
    if (consulted || event.toolResults.length > 0) return;
    consulted = true;
    await observer.consult("Is the read correct?");
    consultationRefs = refsIn(privateRequests.at(-1));
  };
  await session.prompt("Fix the parser");
  expect(consultationRefs).toHaveLength(1);
  // A configuration change rebuilds the Onlooker Session from a new Context Seed.
  observer.configure({ ...settings, thinkingLevel: "low" });
  await session.prompt("Check again");
  expect(observer.status).toMatchObject({ lastError: null, droppedFindings: { unsupported: 0 } });
  expect(seedPayload(privateRequests.at(-1)).header).toContain("Current context seed.");
  expect(reviewRefs).toEqual(expectedRefs);
  expect(delivered(session)).toEqual([
    "Onlooker concern: The parser read was unchecked.",
    "Onlooker blocker: The parser read was unchecked.",
  ]);
});

it("drops findings that cite no evidence or a Tool-Call Reference the Onlooker was not given", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ "Fix the parser": 1 }, privateRequests, {
    ...ok,
    report: (review, request) => {
      if (review !== 1) return { findings: [] };
      const [ref] = refsIn(request);
      return {
        findings: [
          {
            severity: "concern",
            message: "Cited finding.",
            evidence: { refs: [`\`${ref ?? ""}\``] },
          },
          { severity: "nit", message: "Quoted finding.", evidence: { quote: "ok 0-0" } },
          { severity: "concern", message: "Invented reference.", evidence: { refs: ["ZZZZZZZZ"] } },
          { severity: "blocker", message: "Uncited finding.", evidence: {} },
        ],
      };
    },
  });
  const { session, observer } = await observe({});
  await session.prompt("Fix the parser");
  expect(observer.status).toMatchObject({
    lastError: null,
    droppedFindings: { unsupported: 2 },
  });
  expect(delivered(session)).toEqual([
    "Onlooker concern: Cited finding.",
    "Onlooker nit: Quoted finding.",
  ]);
  // The cited reference is journaled without its formatting.
  const cited = session.messages.find((message) => message.role === "custom");
  expect(cited?.role === "custom" && cited.details).toMatchObject({
    evidence: { refs: [refsIn(privateRequests[0])[0]] },
  });
  // The Onlooker learns which findings were dropped, in its own history.
  const report = privateRequests[1]?.messages.find((message) => message.role === "toolResult");
  expect(JSON.stringify(report)).toContain(
    'Dropped 2 findings citing no evidence or a Tool-Call Reference absent from the supplied evidence: \\"Invented reference.\\"; \\"Uncited finding.\\"',
  );
  expectStableOnlookerPrefix(privateRequests);
});

it("ends a Review without findings after two invalid onlooker_report calls instead of looping", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({}, privateRequests, {
    ...ok,
    // Every call omits the required evidence.
    report: () => ({ findings: [{ severity: "concern", message: "Unsupported." }] }),
  });
  const { session, observer } = await observe({});
  await session.prompt("Answer");
  expect(observer.status).toMatchObject({
    state: "armed",
    lastError: null,
    backlog: 0,
    droppedFindings: { invalidReviews: 1 },
  });
  expect(privateRequests).toHaveLength(2);
  // The first rejection explains the problem so the Onlooker can correct its report.
  expect(JSON.stringify(privateRequests[1]?.messages.at(-1))).toContain(
    "Call onlooker_report again with a valid report.",
  );
  expect(delivered(session)).toEqual([]);
});

it("accepts a corrected onlooker_report after one invalid call without pausing", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({}, privateRequests, {
    ...ok,
    report: (call) => ({
      findings: [
        call === 1
          ? { severity: "concern", message: "Corrected." }
          : { severity: "concern", message: "Corrected.", evidence: { quote: "Answer" } },
      ],
    }),
  });
  const { session, observer } = await observe({});
  await session.prompt("Answer");
  expect(observer.status).toMatchObject({
    lastError: null,
    droppedFindings: { invalidReviews: 0 },
  });
  // The second Onlooker call retried within the first Review, after the rejected report.
  expect(privateRequests[1]?.messages.at(-1)).toMatchObject({
    role: "toolResult",
    toolName: "onlooker_report",
    isError: true,
  });
  expect(delivered(session)).toEqual(["Onlooker concern: Corrected."]);
});

it("accepts null for an optional field of an onlooker_report finding's evidence like omitting it", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({}, privateRequests, {
    ...ok,
    // Models trained on `T | null` schemas send null for the evidence they do not cite; the
    // arguments are untyped JSON as the model emits them, not the schema's `Static` type.
    report: () => ({
      findings: [
        {
          severity: "concern",
          message: "Cited.",
          evidence: { quote: "Answer", refs: null },
        },
      ],
    }),
  });
  const { session, observer } = await observe({});
  await session.prompt("Answer");
  expect(observer.status).toMatchObject({
    lastError: null,
    droppedFindings: { invalidReviews: 0, unsupported: 0 },
  });
  // No report was rejected with a request to retry.
  expect(JSON.stringify(privateRequests)).not.toContain("Call onlooker_report again");
  expect(delivered(session)).toEqual(["Onlooker concern: Cited."]);
});

it("drops a legacy single-finding report, which cites no evidence", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({}, privateRequests, {
    ...ok,
    // The pre-evidence report shape, normalized by the tool before validation.
    report: () => ({ severity: "blocker", message: "Legacy finding." }),
  });
  const { session, observer } = await observe({});
  await session.prompt("Answer");
  expect(observer.status).toMatchObject({
    lastError: null,
    droppedFindings: { unsupported: 1 },
  });
  expect(delivered(session)).toEqual([]);
});

it("sends the default Onlooker Prompt as the private system prompt", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({}, privateRequests, ok);
  const { session } = await observe({});
  await session.prompt("Answer");
  expect(privateRequests[0]?.systemPrompt).toContain(onlookerPrompt);
});
