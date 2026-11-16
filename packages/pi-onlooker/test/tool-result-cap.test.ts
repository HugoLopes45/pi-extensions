import { readFileSync } from "node:fs";

import { onTestFinished, expect, it } from "vite-plus/test";

import { readOnlookerSettings } from "../src/onlooker-settings.js";
import type { EvidenceMessage } from "../src/utils/evidence.js";
import {
  activeFixture,
  expectPrefix,
  longSessionStream,
  seedPayload,
  type PrivateRequest,
  createObserver,
  type ObserverSettings,
} from "./fixtures/observer-harness.js";

/** A result whose head, middle, and tail are distinguishable. */
const big = (id: string, size = 30_000) =>
  `HEAD ${id} ${"a".repeat(size / 2)} MIDDLE ${"b".repeat(size / 2)} TAIL ${id}`;

async function observe(config: Partial<ObserverSettings>) {
  const session = await activeFixture();
  const observer = createObserver(
    session,
    { ...readOnlookerSettings(session).settings, enabled: true, catchUpThreshold: 1, ...config },
    "headless-root",
  );
  globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
  onTestFinished(() => observer.dispose());
  return { session, observer };
}

type ToolResultEvidence = Extract<EvidenceMessage, { role: "toolResult" }>;
const results = (messages: EvidenceMessage[]) =>
  messages.filter((m): m is ToolResultEvidence => m.role === "toolResult");
const refs = (messages: EvidenceMessage[]) =>
  messages.flatMap((m) =>
    m.role === "assistant"
      ? m.content.flatMap((block) => (block.type === "toolCall" ? [block.ref] : []))
      : [],
  );
const firstText = (result: ToolResultEvidence | undefined) => {
  const block = result?.content[0];
  return block?.type === "text" ? block.text : undefined;
};

it("caps an oversized tool result in a seed and an incremental update, keeping its Tool-Call Reference", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "First request": 1, "Second request": 1 },
    privateRequests,
    { result: (id) => big(id), isError: () => false },
  );
  const { session, observer } = await observe({ reviewEvery: "request" });
  const longPrompt = `First request: ${"u".repeat(12_000)}`;
  await session.prompt(longPrompt);
  await session.prompt("Second request: add tests.");
  expect(observer.status.lastError).toBeNull();
  const file = session.sessionManager.getSessionFile();
  expect(file).toBeTruthy();
  const stored = readFileSync(file ?? "", "utf8");

  const seed = seedPayload(privateRequests[0]);
  const update = seedPayload(privateRequests[1]);
  expect(seed.header).toContain("Current context seed.");
  expect(update.header).toContain("Incremental update.");
  for (const { evidence } of [seed, update]) {
    const { messages } = evidence;
    const [result] = results(messages);
    expect(result).toBeDefined();
    const text = firstText(result) ?? "";
    // Omitted text must not send the Onlooker to the unfiltered journal.
    expect(text).toMatch(/^HEAD \d+-\d+ a+/);
    expect(text).toMatch(/b+ TAIL \d+-\d+$/);
    expect(text).not.toContain("MIDDLE");
    expect(text).toMatch(
      /\n\[… \d+ characters omitted from this tool result; the full result is not available to this Onlooker\]\n/,
    );
    expect(text).not.toContain(file);
    expect(text.length).toBeLessThan(4_000 + 400);
    // The reference still links the call to its result, and the error status is kept.
    expect(result?.isError).toBe(false);
    expect(refs(messages)).toContain(result?.ref);
    // Privacy filtering must not alter the observed journal.
    expect(stored).toContain("MIDDLE");
  }
  // User text is never capped.
  expect(JSON.stringify(seed.evidence.messages)).toContain(longPrompt);
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it("honors maxToolResultChars", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ Request: 1 }, privateRequests, {
    result: (id) => big(id, 3_000),
    isError: () => false,
  });
  const { session } = await observe({ reviewEvery: "request", maxToolResultChars: 1_000 });
  await session.prompt("Request: refactor.");
  const [result] = results(seedPayload(privateRequests[0]).evidence.messages);
  expect(firstText(result)).toContain("characters omitted from this tool result");
  expect(firstText(result)?.length).toBeLessThan(1_000 + 400);
});

it("measures whether new evidence fits the seed budget on the capped evidence", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream(
    { "First request": 1, "Second request": 4 },
    privateRequests,
    { result: (id) => big(id, 120_000), isError: () => false, tokenRatio: 1 },
  );
  // Four 120k-character results are about 120k estimated tokens uncapped, far over this budget,
  // but about 5k tokens once capped, which fits.
  const { session, observer } = await observe({
    reviewEvery: "request",
    seedBudgetTokens: 12_000,
  });
  await session.prompt("First request: refactor.");
  await session.prompt("Second request: add tests.");
  expect(observer.status.lastError).toBeNull();
  const update = seedPayload(privateRequests[1]);
  expect(update.header).toContain("Incremental update.");
  expect(update.tokens).toBeLessThan(6_000);
  expect(results(update.evidence.messages)).toHaveLength(4);
  expectPrefix(privateRequests[1], privateRequests[0]);
});

it("spends the seed budget on capped evidence", async () => {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ Request: 40 }, privateRequests, {
    result: (id) => big(id, 20_000),
    isError: () => false,
  });
  const { session } = await observe({ reviewEvery: "request", seedBudgetTokens: 24_000 });
  await session.prompt("Request: refactor.");
  const seed = seedPayload(privateRequests[0]);
  // Uncapped, forty 20k-character results are ~200k tokens; capped, most turns fit 12k estimated.
  expect(seed.tokens).toBeLessThanOrEqual(12_000);
  const kept = results(seed.evidence.messages);
  expect(kept.length).toBeGreaterThan(8);
  // The fit may shorten the oldest kept turn to spend the remaining budget, which replaces its cap
  // marker with the Context Seed's; only the oldest result may carry either marker.
  const [oldest, ...newer] = kept;
  expect(firstText(oldest)).toMatch(/omitted from (?:this tool result|the Context Seed)/);
  for (const result of newer) expect(firstText(result)).toContain("this tool result");
});
