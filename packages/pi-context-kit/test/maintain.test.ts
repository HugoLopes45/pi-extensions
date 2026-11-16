import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { contextTokens } from "../src/context.ts";
import { planMaintenance } from "../src/maintain.ts";
import { filler, Transcript } from "./fixtures.ts";

function staleSession() {
  const t = new Transcript();
  const old = t.tool("read", { path: "a.ts" }, filler(2_000));
  t.tool("read", { path: "a.ts" }, filler(2_000));
  return { t, old };
}

/** An older read of a.ts, far from the end, and more context than pruning can save. */
function staleSessionBeforeCompaction() {
  const t = new Transcript();
  const old = t.tool("read", { path: "a.ts" }, filler(2_000));
  t.tool("bash", { command: "a" }, filler(21_000));
  t.tool("read", { path: "a.ts" }, filler(2_000));
  t.tool("bash", { command: "b" }, filler(60_000));
  return { t, old };
}

describe("contextTokens", () => {
  it("counts additive system instructions", () => {
    const t = new Transcript();
    t.session.appendMessage({
      role: "system",
      content: filler(2_000),
      timestamp: 1,
    });
    t.session.appendMessage({
      role: "system",
      content: "Extra instructions",
      timestamp: 2,
    });
    expect(contextTokens(t.entries().flatMap((entry) => entry.messages))).toBe(
      estimateTokens({
        role: "system",
        content: `${filler(2_000)}\n\nExtra instructions`,
        timestamp: 1,
      }),
    );
  });

  it("replays section replacement and removal", () => {
    const t = new Transcript();
    t.session.appendMessage({
      role: "system",
      content: "Base",
      sections: {
        keep: filler(1_000),
        replace: filler(2_000),
        remove: filler(3_000),
      },
      timestamp: 1,
    });
    t.session.appendMessage({
      role: "system",
      content: "",
      sections: { replace: "New", remove: null },
      timestamp: 2,
    });
    expect(contextTokens(t.entries().flatMap((entry) => entry.messages))).toBe(
      estimateTokens({
        role: "system",
        content: "Base",
        sections: { keep: filler(1_000), replace: "New" },
        timestamp: 1,
      }),
    );
  });

  it("retains tools not removed by a later system update", () => {
    const t = new Transcript();
    const keep = {
      name: "keep",
      description: filler(1_000),
      parameters: { type: "object" },
    };
    const remove = {
      name: "remove",
      description: filler(2_000),
      parameters: { type: "object" },
    };
    const add = {
      name: "add",
      description: "New tool",
      parameters: { type: "object" },
    };
    t.session.appendMessage({
      role: "system",
      content: "Base",
      toolsAdded: [keep, remove],
      timestamp: 1,
    });
    t.session.appendMessage({
      role: "system",
      content: "",
      toolsAdded: [add],
      toolsRemoved: [{ name: "remove" }],
      timestamp: 2,
    });
    expect(contextTokens(t.entries().flatMap((entry) => entry.messages))).toBe(
      estimateTokens({
        role: "system",
        content: "Base",
        toolsAdded: [keep, add],
        timestamp: 1,
      }),
    );
  });
});

describe("planMaintenance", () => {
  it("rejects pruning that still leaves the merged system context over budget", () => {
    const t = new Transcript();
    t.session.appendMessage({
      role: "system",
      content: filler(20_000),
      timestamp: 1,
    });
    t.tool("bash", { command: "old" }, filler(5_000));
    t.session.appendMessage({
      role: "system",
      content: "Extra instructions",
      timestamp: 2,
    });
    t.user("Continue");
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: {
        ...DEFAULT_CONFIG,
        prune: { enabled: true, protectTokens: 0, minSavings: 1, minTokens: 1 },
        shake: undefined,
      },
      tokens: 26_000,
      threshold: 10_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 26_000 });
  });

  // Any edit changes the prompt prefix: the provider cache and the later thinking blocks are lost.
  it("applies no edits below the threshold", () => {
    const { t } = staleSession();
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: DEFAULT_CONFIG,
      tokens: 4_100,
      threshold: 10_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 4_100 });
  });

  it("supersedes older reads anywhere in the context before compaction", () => {
    const { t, old } = staleSessionBeforeCompaction();
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: DEFAULT_CONFIG,
      tokens: 85_100,
      threshold: 70_000,
    });
    expect(plan.edits.map((edit) => edit.targetId)).toEqual([old]);
    expect(plan.tokens).toBeLessThan(84_000);
  });

  it("supersedes older reads together with pruning", () => {
    const t = new Transcript();
    const old = t.tool("read", { path: "a.ts" }, filler(2_000));
    const output = t.tool("bash", { command: "a" }, filler(30_000));
    t.tool("read", { path: "a.ts" }, filler(2_000));
    t.tool("bash", { command: "b" }, filler(41_000));
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: DEFAULT_CONFIG,
      tokens: 75_100,
      threshold: 70_000,
    });
    expect(plan.edits.map((edit) => edit.targetId)).toEqual(expect.arrayContaining([old, output]));
  });

  it("prunes over the threshold when that gets well below it", () => {
    const t = new Transcript();
    const old = t.tool("bash", { command: "a" }, filler(30_000));
    t.tool("bash", { command: "b" }, filler(41_000));
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: DEFAULT_CONFIG,
      tokens: 71_100,
      threshold: 70_000,
    });
    expect(plan.edits.map((edit) => edit.targetId)).toEqual([old]);
    expect(plan.tokens).toBeLessThan(56_000);
  });

  it("keeps Pi's token count when no maintenance edit is persisted", () => {
    const t = new Transcript();
    t.user("small context");
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: {
        ...DEFAULT_CONFIG,
        supersedeReads: false,
        prune: { ...DEFAULT_CONFIG.prune, enabled: false },
        shake: undefined,
      },
      tokens: 100_000,
      threshold: 70_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 100_000 });
  });

  it("leaves reduction to compaction when pruning is not enough", () => {
    const t = new Transcript();
    t.tool("bash", { command: "a" }, filler(21_000));
    t.tool("bash", { command: "b" }, filler(60_000));
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: DEFAULT_CONFIG,
      tokens: 81_100,
      threshold: 70_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 81_100 });
  });

  it("keeps older reads when supersedeReads is off", () => {
    const { t } = staleSessionBeforeCompaction();
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: { ...DEFAULT_CONFIG, supersedeReads: false },
      tokens: 85_100,
      threshold: 70_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 85_100 });
  });

  it("does not prune when pruning is off", () => {
    const t = new Transcript();
    t.tool("bash", { command: "a" }, filler(30_000));
    t.tool("bash", { command: "b" }, filler(41_000));
    const plan = planMaintenance({
      entries: t.entries(),
      edited: new Set(),
      options: {
        ...DEFAULT_CONFIG,
        prune: { ...DEFAULT_CONFIG.prune, enabled: false },
      },
      tokens: 71_100,
      threshold: 70_000,
    });
    expect(plan).toEqual({ edits: [], tokens: 71_100 });
  });

  it("shakes only when shake options are given", () => {
    const t = new Transcript();
    t.assistant(`<log>\n${filler(30_000)}\n</log>`);
    t.assistant("ok");
    t.assistant(filler(41_000));
    const input = {
      entries: t.entries(),
      edited: new Set<string>(),
      tokens: 71_100,
      threshold: 70_000,
    };
    expect(planMaintenance({ ...input, options: DEFAULT_CONFIG }).edits).toHaveLength(1);
    expect(
      planMaintenance({
        ...input,
        options: { ...DEFAULT_CONFIG, shake: undefined },
      }),
    ).toEqual({ edits: [], tokens: 71_100 });
  });
});
