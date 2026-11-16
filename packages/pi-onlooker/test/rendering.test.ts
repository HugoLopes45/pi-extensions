import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
  taggedTheme,
} from "pi-hl-utils/testing/ui-testing";
import type { DurationContext } from "pi-hl-utils/ui";
import { beforeAll, describe, expect, it } from "vitest";

import {
  onlookerFooterText,
  onlookerStatusHeadline,
  renderOnlookerAskCall,
  renderOnlookerAskResult,
  renderOnlookerIntervention,
  renderOnlookerStatus,
  type OnlookerStatusEntry,
} from "../src/onlooker-rendering.js";

// Line breaks and truncation match a real theme under the escape-encoded theme (its styles are not
// re-opened after a wrap); the text-tagged theme is for exact strings from functions that never wrap.
const theme = escapeTaggedTheme;
const tagged = taggedTheme;

beforeAll(() => {
  initTheme("dark");
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

/**
 * Render at 40 and 120 columns, proving both fit (Markdown bodies follow Pi's global theme), and
 * return the 120-column lines as readable tags.
 */
function lines(component: { render(width: number): string[] } | undefined): string[] {
  if (!component) throw new Error("Expected a component");
  for (const width of [40, 120])
    expectLinesFitWidth(component.render(width), width, { piThemedBody: true });
  // Decode all lines together: pi-tui does not re-open the encoded styles on later lines.
  const rendered = component.render(120);
  if (rendered.length === 0) return [];
  return readableTags(rendered.join("\n"))
    .split("\n")
    .map((line) => line.trimEnd());
}

const withoutTags = (text: string) => text.replace(/<\/?[A-Za-z:]+>/g, "");
const plainText = (rendered: string[]) => withoutTags(rendered.join("\n")).trim();

const label = "<customMessageLabel><b>[onlooker]</b></customMessageLabel>";
const hintPattern =
  /<muted>\.\.\. \((\d+) more lines,<\/muted> <dim>ctrl\+o<\/dim><muted> to expand<\/muted><muted>\)<\/muted>/;

function durationContext(overrides: Partial<DurationContext> = {}): DurationContext {
  return {
    state: {},
    executionStarted: false,
    isPartial: false,
    durationMs: undefined,
    invalidate: () => {},
    ...overrides,
  };
}

const collapsed = { expanded: false, outputPad: 1 };
const longMessage = Array.from({ length: 14 }, (_, index) => `Line ${index + 1}`).join("\n\n");

describe("Onlooker Interventions", () => {
  it("renders the recorded display name without changing legacy labels", () => {
    const text = plainText(
      lines(
        renderOnlookerIntervention(
          { severity: "concern", message: "Run tests", name: "Inspector gadget" },
          collapsed,
          theme,
        ),
      ),
    );
    expect(text).toContain("[Inspector gadget]");
  });

  it("uses the configured name in the footer and status", () => {
    expect(onlookerFooterText({ state: "armed", name: "Marcel" }, tagged)).toContain("Marcel");
    expect(
      plainText(
        statusLines({ ...snapshot, settings: { ...settings, name: "Inspector gadget" } }, true),
      ),
    ).toContain("[Inspector gadget]");
    expect(
      onlookerStatusHeadline({ state: "armed", settings: { name: "Marcel" } }, tagged).join("\n"),
    ).toContain("Marcel");
  });
  it("labels each severity with a coloured word, never a glyph", () => {
    const colors = { nit: "dim", concern: "warning", blocker: "error" } as const;
    for (const severity of ["nit", "concern", "blocker"] as const) {
      const rendered = lines(
        renderOnlookerIntervention({ severity, message: "Run the tests" }, collapsed, theme),
      ).join("\n");
      expect(rendered).toContain(`${label} <${colors[severity]}>${severity}</${colors[severity]}>`);
      expect(rendered).toContain("Run the tests");
      expect(rendered).not.toMatch(/[▲✖]/);
    }
  });

  it("always shows Concerns and Blockers in full but collapses long Nits to ten lines", () => {
    for (const severity of ["concern", "blocker"] as const) {
      const text = lines(
        renderOnlookerIntervention({ severity, message: longMessage }, collapsed, theme),
      ).join("\n");
      expect(text).toContain("Line 14");
      expect(text).not.toContain("to expand");
    }
    const nit = lines(
      renderOnlookerIntervention({ severity: "nit", message: longMessage }, collapsed, theme),
    );
    const nitText = nit.join("\n");
    expect(nitText).toContain("Line 1");
    expect(nitText).not.toContain("Line 14");
    const hidden = Number(hintPattern.exec(nitText)?.[1]);
    const expanded = lines(
      renderOnlookerIntervention(
        { severity: "nit", message: longMessage },
        { expanded: true, outputPad: 1 },
        theme,
      ),
    );
    expect(expanded.join("\n")).toContain("Line 14");
    expect(expanded.join("\n")).not.toContain("to expand");
    // Header, spacer, ten body lines, and the hint, inside one row of padding top and bottom.
    expect(nit).toHaveLength(2 + 1 + 1 + 10 + 1);
    expect(expanded).toHaveLength(nit.length - 1 + hidden);
  });

  it("leaves unrecognised details to Pi's default rendering", () => {
    expect(
      renderOnlookerIntervention({ severity: "veto", message: "x" }, collapsed, theme),
    ).toBeUndefined();
    expect(renderOnlookerIntervention(undefined, collapsed, theme)).toBeUndefined();
  });
});

const settings = {
  enabled: true,
  reviewEvery: "turn",
};
const snapshot = {
  state: "reviewing",
  settings,
  sources: {
    enabled: "session",
    model: "default",
    thinkingLevel: "default",
    reviewEvery: "default",
  },
  backlog: 2,
  effectiveModel: "anthropic/claude-sonnet",
  effectiveThinkingLevel: "high",
  usage: { input: 40_000, output: 1_200, cacheRead: 0, cacheWrite: 0, total: 41_200 },
  cost: 0.18,
  lastError: null,
  error: null,
};
type StatusData = Parameters<typeof renderOnlookerStatus>[0];
const statusLines = (data: StatusData, expanded = false) =>
  lines(renderOnlookerStatus(data, expanded, theme));
const status = (data: StatusData, expanded = false) => plainText(statusLines(data, expanded));

describe("Onlooker status", () => {
  it("summarizes state, model, backlog, usage, and problems when collapsed", () => {
    const text = status({ ...snapshot, error: "Model unavailable" });
    expect(text).toContain("[onlooker] ● reviewing");
    expect(text).toContain("anthropic/claude-sonnet (inherited) · high");
    expect(text).toContain("backlog 2");
    expect(text).toContain("Onlooker Session: tokens 41.2k · cost $0.18");
    expect(text).toContain("✗ Model unavailable");
    expect(statusLines({ ...snapshot, error: "Model unavailable" }).join("\n")).toContain(
      "<error>✗</error> <error>Model unavailable</error>",
    );
  });

  it("hints at what the Collapsed View hides, and the Expanded View shows it without a hint", () => {
    const changes = (["enabled", "model", "thinkingLevel", "reviewEvery"] as const).map((key) => ({
      scope: "session",
      key,
      options: {},
    }));
    const long = { ...snapshot, changes, error: "Model unavailable" };
    const collapsedLines = statusLines(long);
    const expandedLines = statusLines(long, true);
    const hidden = Number(hintPattern.exec(collapsedLines.join("\n"))?.[1]);
    expect(hidden).toBeGreaterThan(0);
    expect(expandedLines).toHaveLength(collapsedLines.length - 1 + hidden);
    expect(expandedLines.join("\n")).not.toContain("to expand");
  });

  it("shows each kind of Onlooker work and the evidence it did not see in full", () => {
    const work = {
      count: 2,
      calls: 3,
      input: 40_000,
      output: 1_200,
      cacheRead: 30_000,
      cacheWrite: 2_000,
      cost: 0.0123,
      ms: 12_340,
    };
    const idle = { ...work, count: 0 };
    const evidence = { seeds: 2, omittedMessages: 14, shortenedMessages: 0, cappedResults: 3 };
    const spend = { reviews: work, consultations: idle, compactions: idle, evidence };
    const text = status({ ...snapshot, spend });
    expect(text).toContain(
      "2 Reviews · 3 calls · in 40.0k · cache read 30.0k · cache write 2.0k · out 1.2k · $0.01 · 12.3s",
    );
    expect(text).not.toContain("consultation");
    expect(text).toContain("evidence: 2 Context Seeds · 14 omitted · 3 capped");
    const unknown = { ...spend, compactions: { ...work, count: 1, cost: null } };
    expect(status({ ...snapshot, spend: unknown })).toContain("1 compaction · 3 calls");
    expect(status({ ...snapshot, spend: unknown })).toMatch(/1 compaction .*cost unknown/);
  });

  it("counts findings dropped, only when there are any", () => {
    const text = status({
      ...snapshot,
      droppedFindings: { unsupported: 3, invalidReviews: 1 },
    });
    for (const count of [
      "3 findings without valid evidence dropped",
      "1 Review ended by invalid reports",
    ])
      expect(text.replace(/\s+/g, " ")).toContain(count);
    const quiet = status({
      ...snapshot,
      droppedFindings: { unsupported: 0 },
    });
    expect(quiet).not.toContain("dropped");
  });

  it("never presents unknown cost as zero and omits empty problem lines", () => {
    const text = status({
      ...snapshot,
      cost: null,
      settings: { ...settings, model: "openai/gpt" },
    });
    expect(text).toContain("Onlooker Session: tokens 41.2k · cost unknown");
    expect(text).not.toContain("$0");
    expect(text).toContain("anthropic/claude-sonnet · high");
    expect(text).not.toContain("(inherited)");
    expect(text).not.toContain("!");
    expect(text).not.toContain("✗");
  });

  it("lists every setting with its source when expanded", () => {
    const text = status(snapshot, true);
    expect(text).toMatch(/enabled\s+true\s+\[session\]/);
    expect(text).toMatch(/model\s+inherit\s+\[default\]/);
    expect(text).toMatch(/reviewEvery\s+turn\s+\[default\]/);
  });

  it("leads with the state, then the configuration changes that produced it", () => {
    expect(
      status({
        ...snapshot,
        changes: [
          { scope: "session", key: "model", options: { model: "openai/gpt" } },
          { scope: "project", key: "enabled", options: {} },
        ],
      }),
    ).toMatch(
      /^\[onlooker\] ● reviewing.*\n\s*\n\s*✓ model → openai\/gpt \[session\]\s*\n\s*✓ enabled → inherit \[project\]\s*\n/,
    );
  });

  it("keeps every recognisable field when one field no longer matches", () => {
    const text = status(
      {
        ...snapshot,
        settings: { ...settings, retiredOption: true },
      },
      true,
    );
    expect(text).toContain("[onlooker] ● reviewing");
    expect(text).toContain("anthropic/claude-sonnet");
    expect(text).toContain("Onlooker Session: tokens 41.2k · cost $0.18");
    expect(text).toContain("backlog 2");
    expect(text).not.toContain("retiredOption");
  });

  it("falls back to the raw record when even the state is missing", () => {
    expect(status({ unexpected: 1 })).toContain('"unexpected": 1');
  });

  it("heads the settings menu with a bold name, the state mark, and the error", () => {
    expect(onlookerStatusHeadline({ state: "paused", error: "Deadline exceeded" }, tagged)).toEqual(
      [
        "<b>Onlooker</b> <warning>!</warning> paused",
        "<error>✗</error> <error>Deadline exceeded</error>",
      ],
    );
  });
});

describe("onlooker_ask rendering", () => {
  const question = "Is this migration safe?\nConsider the rollback path.";
  const answer = Array.from({ length: 12 }, (_, index) => `- Point ${index + 1}`).join("\n");
  const header = "<toolTitle><b>onlooker_ask</b></toolTitle>";
  const resultOptions = { expanded: false, isPartial: false, isError: false };

  it("heads the call with the lowercase tool name and the question's first line", () => {
    expect(
      lines(renderOnlookerAskCall({ message: question }, false, theme, durationContext())),
    ).toEqual([`${header} <accent>Is this migration safe?</accent><dim> (ctrl+o to expand)</dim>`]);
    expect(
      lines(renderOnlookerAskCall({ message: "Is this safe?" }, false, theme, durationContext())),
    ).toEqual([`${header} <accent>Is this safe?</accent>`]);
  });

  it("lists the whole question as an argument when expanded, without a hint", () => {
    const rendered = lines(
      renderOnlookerAskCall({ message: question }, true, theme, durationContext()),
    );
    expect(rendered).toEqual([
      header,
      "<muted>message: Is this migration safe?",
      "Consider the rollback path.</muted>",
    ]);
  });

  it("previews the answer to ten lines with Pi's Expand Hint, then shows it all when expanded", () => {
    const preview = lines(
      renderOnlookerAskResult(answer, resultOptions, theme, durationContext({ durationMs: 1234 })),
    );
    const previewText = preview.join("\n");
    expect(previewText).toContain("Point 1");
    expect(previewText).toContain("Point 10");
    expect(previewText).not.toContain("Point 11");
    expect(previewText).toContain(
      "<muted>... (2 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
    );
    const full = lines(
      renderOnlookerAskResult(
        answer,
        { ...resultOptions, expanded: true },
        theme,
        durationContext({ durationMs: 1234 }),
      ),
    ).join("\n");
    expect(full).toContain("Point 12");
    expect(full).not.toContain("to expand");
  });

  it("shows no placeholder while there is nothing to show", () => {
    expect(
      lines(
        renderOnlookerAskResult(
          "",
          { expanded: false, isPartial: true, isError: false },
          theme,
          durationContext(),
        ),
      ),
    ).toEqual([]);
  });

  it("shows errors as error text, ten lines when collapsed", () => {
    const failure = Array.from({ length: 12 }, (_, index) => `Failure ${index + 1}`).join("\n");
    const context = () => durationContext({ durationMs: 50 });
    const brief = lines(
      renderOnlookerAskResult(
        "Onlooker is disabled",
        { ...resultOptions, isError: true },
        theme,
        context(),
      ),
    );
    expect(brief).toContain("<error>Onlooker is disabled</error>");
    const long = lines(
      renderOnlookerAskResult(failure, { ...resultOptions, isError: true }, theme, context()),
    ).join("\n");
    expect(long).toContain("<error>Failure 10</error>");
    expect(long).not.toContain("Failure 11");
    expect(long).toContain("<muted>... (2 more lines,</muted>");
    const expanded = lines(
      renderOnlookerAskResult(
        failure,
        { ...resultOptions, isError: true, expanded: true },
        theme,
        context(),
      ),
    ).join("\n");
    expect(expanded).toContain("<error>Failure 12</error>");
    expect(expanded).not.toContain("to expand");
  });
});

describe("untrusted text", () => {
  // A title change, a screen clear, a C1 CSI, and a lone bell and escape.
  const hostile = "ok\x1b]0;pwned\x07\x1b[2J\x9b2J\x07\x1b done\r\nnext";
  // Style sequences are the renderer's own; anything else reached the text from outside.
  const controls = (rendered: readonly string[]) => {
    const text = rendered.join("\n");
    const found: string[] = [];
    for (let index = 0; index < text.length; index++) {
      if (text.startsWith("\x1b[", index)) {
        let end = index + 2;
        while (end < text.length && "0123456789;".includes(text.charAt(end))) end++;
        if (text.charAt(end) === "m") {
          index = end;
          continue;
        }
      }
      const code = text.charCodeAt(index);
      if (code !== 0x0a && code !== 0x09 && (code < 0x20 || (code >= 0x7f && code <= 0x9f)))
        found.push(text.charAt(index));
    }
    return found;
  };
  const render = (component: { render(width: number): string[] }) => component.render(120);

  it("keeps terminal controls in model text out of Interventions and onlooker_ask rows", () => {
    const finding = { severity: "concern", message: hostile } as const;
    const intervention = renderOnlookerIntervention(finding, collapsed, theme);
    if (!intervention) throw new Error("Expected a component");
    expect(controls(render(intervention))).toEqual([]);
    for (const expanded of [false, true])
      expect(
        controls(
          render(renderOnlookerAskCall({ message: hostile }, expanded, theme, durationContext())),
        ),
      ).toEqual([]);
    for (const isError of [false, true])
      expect(
        controls(
          render(
            renderOnlookerAskResult(
              hostile,
              { expanded: true, isPartial: false, isError },
              theme,
              durationContext(),
            ),
          ),
        ),
      ).toEqual([]);
  });

  it("keeps terminal controls in errors and models out of status rows", () => {
    const entry: OnlookerStatusEntry = {
      state: "paused",
      settings: { enabled: true, model: hostile },
      effectiveModel: hostile,
      error: hostile,
    };
    expect(controls(render(renderOnlookerStatus(entry, true, theme)))).toEqual([]);
    expect(controls(onlookerStatusHeadline(entry, theme))).toEqual([]);
    expect(
      controls([onlookerFooterText({ state: "armed", effectiveModel: hostile }, theme) ?? ""]),
    ).toEqual([]);
  });

  it("removes C1 controls and OSC 8 links but keeps the link text", () => {
    const linked = "a\u009b2Jb \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ c\x1b]8;;x\x07d";
    const [, line] = onlookerStatusHeadline({ state: "paused", error: linked }, tagged);
    expect(line).toBe("<error>✗</error> <error>a2Jb link cd</error>");
  });

  it("keeps a line break in an Intervention", () => {
    const intervention = renderOnlookerIntervention(
      { severity: "concern", message: "first\r\n\r\nsecond" },
      { expanded: true, outputPad: 1 },
      tagged,
    );
    const rows = withoutTags(lines(intervention).join("\n")).split("\n");
    const first = rows.findIndex((row) => row.includes("first"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(rows.findIndex((row) => row.includes("second"))).toBeGreaterThan(first);
    expect(controls(rows)).toEqual([]);
  });

  it("keeps the visible text and line breaks", () => {
    expect(onlookerStatusHeadline({ state: "paused", error: "a\x1b[2Jb\r\nc\td" }, tagged)[1]).toBe(
      "<error>✗</error> <error>ab\nc\td</error>",
    );
  });
});

describe("Onlooker footer", () => {
  const watching = "<accent>●</accent>  <dim>onlooker</dim>";
  const waiting = "<dim>○</dim>  <dim>onlooker</dim>";

  it.each(["reviewing", "consulting"] as const)(
    "shows the shared activity mark without a backlog while %s",
    (state) => {
      const activity = { state, backlog: 2 };
      expect(onlookerFooterText(activity, tagged)).toBe(watching);
    },
  );

  it("names the Onlooker model without its provider", () => {
    const effectiveModel = "anthropic/claude-haiku-4-5";
    expect(onlookerFooterText({ state: "armed", effectiveModel }, tagged)).toBe(
      `${waiting}<dim> · </dim>claude-haiku-4-5`,
    );
    expect(onlookerFooterText({ state: "reviewing", effectiveModel }, tagged)).toBe(
      `${watching}<dim> · </dim>claude-haiku-4-5`,
    );
  });

  it("shows a pause icon without its reason and retains the model", () => {
    expect(
      onlookerFooterText({ state: "paused", effectiveModel: "anthropic/claude-haiku-4-5" }, tagged),
    ).toBe("<warning>!</warning>  <dim>onlooker</dim><dim> · </dim>claude-haiku-4-5");
  });
});
