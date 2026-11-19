import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  readableTags,
} from "pi-hl-utils/testing/ui-testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  renderCall,
  renderResult as renderToolResult,
  sanitizeDapObserverText,
  type DapCallRenderContext,
  type DapResultRenderContext,
} from "../src/rendering.js";
import type { DapOperation, DapToolRenderDetails } from "../src/schemas.js";

beforeAll(() => {
  setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
});

afterEach(() => vi.useRealTimers());

function callContext(overrides: Partial<DapCallRenderContext> = {}): DapCallRenderContext {
  return {
    state: {},
    executionStarted: false,
    isPartial: true,
    durationMs: undefined,
    invalidate: () => {},
    expanded: false,
    cwd: "/workspace",
    ...overrides,
  };
}

function resultContext(overrides: Partial<DapResultRenderContext> = {}): DapResultRenderContext {
  return {
    state: {},
    executionStarted: true,
    isPartial: false,
    durationMs: 2500,
    invalidate: () => {},
    isError: false,
    ...overrides,
  };
}

function lines(component: { render(width: number): string[] }, width = 120): string[] {
  const rendered = component.render(width);
  expectLinesFitWidth(rendered, width);
  return rendered.map((line) => readableTags(line).trimEnd());
}

function result(
  text: string,
  details?: DapToolRenderDetails,
): AgentToolResult<DapToolRenderDetails | undefined> {
  return { content: [{ type: "text", text }], details };
}

function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `  row ${index + 1}`).join("\n");
}

function renderResult(
  operation: DapOperation,
  text: string,
  options: { expanded: boolean; isPartial?: boolean },
  context = resultContext(),
  details?: DapToolRenderDetails,
) {
  return renderToolResult(
    operation,
    result(text, details),
    { expanded: options.expanded, isPartial: options.isPartial ?? false },
    escapeTaggedTheme,
    context,
  );
}

describe("dap tool call", () => {
  test("leads with the registered tool name, an accent target, and muted arguments", () => {
    expect(
      lines(
        renderCall(
          {
            operation: "launch",
            profile: "node",
            program: "/workspace/src/app.ts",
          },
          escapeTaggedTheme,
          callContext(),
        ),
      )[0],
    ).toBe(
      "<toolTitle><b>hl_dap_launch</b></toolTitle> <accent>src/app.ts</accent> <muted>node</muted>",
    );
    expect(
      lines(
        renderCall(
          {
            operation: "set_breakpoints",
            file_path: "/workspace/app.ts",
            breakpoints: [{ line: 3 }, { line: 8 }],
          },
          escapeTaggedTheme,
          callContext(),
        ),
      )[0],
    ).toBe(
      "<toolTitle><b>hl_dap_set_breakpoints</b></toolTitle> <accent>app.ts</accent> <muted>2 breakpoints</muted>",
    );
    expect(
      lines(renderCall({ operation: "stack", thread_id: 2 }, escapeTaggedTheme, callContext()))[0],
    ).toBe("<toolTitle><b>hl_dap_stack</b></toolTitle> <muted>thread #2</muted>");
    expect(
      lines(
        renderCall(
          { operation: "evaluate", expression: "a  +\nb" },
          escapeTaggedTheme,
          callContext(),
        ),
      )[0],
    ).toBe("<toolTitle><b>hl_dap_evaluate</b></toolTitle> <accent>a + b</accent>");
  });

  test("lists launch arguments in the expanded call, bounded to one line", () => {
    const rendered = lines(
      renderCall(
        {
          operation: "launch",
          launch_arguments: { autoAttachChildProcesses: false, note: "x".repeat(400) },
        },
        escapeTaggedTheme,
        callContext({ expanded: true }),
      ),
      400,
    );
    expect(rendered[1]).toMatch(
      /^<muted>launch_arguments: \{"autoAttachChildProcesses":false,"note":"x+\.\.\.<\/muted>$/u,
    );
    expect(rendered[1]?.length).toBe("<muted>launch_arguments: ".length + 160 + "</muted>".length);
  });

  test("renders call arguments without terminal sequences or extra rows", () => {
    for (const expanded of [false, true]) {
      const rendered = lines(
        renderCall(
          {
            operation: "launch",
            program: "/tmp/a\u001b[2J\nb.js",
            profile: "node\u001b]0;title\u0007",
            cwd: "/tmp/c\rd",
          },
          escapeTaggedTheme,
          callContext({ expanded }),
        ),
      ).join("\n");
      for (const control of ["\u001b", "\u0007", "\r"]) expect(rendered).not.toContain(control);
      expect(rendered).toContain("a b.js");
    }
  });

  test("renders provider arguments before required operation fields arrive", () => {
    for (const operation of ["set_breakpoints", "variables", "evaluate"] as const) {
      for (const expanded of [false, true]) {
        const rendered = lines(
          renderCall({ operation }, escapeTaggedTheme, callContext({ expanded })),
        ).join("\n");
        expect(rendered).toContain(`hl_dap_${operation}`);
        expect(rendered).not.toContain("undefined");
      }
    }
  });
});

describe("dap tool result", () => {
  test("previews stack and variables to ls's 20 lines with Pi's expand hint", () => {
    for (const operation of ["stack", "variables"] as const) {
      const rendered = lines(renderResult(operation, numbered(25), { expanded: false }));
      expect(rendered).toContain("<toolOutput>  row 20</toolOutput>".trimEnd());
      expect(rendered).not.toContain("<toolOutput>  row 21</toolOutput>");
      expect(rendered).toContain(
        "<muted>... (5 more lines,</muted> <dim>ctrl+o</dim><muted> to expand</muted><muted>)</muted>",
      );
      expect(rendered.at(-1)).toBe("<muted>Took 2.5s</muted>");
    }
  });

  test("sanitizes terminal sequences and controls out of Debuggee output", () => {
    const unsafe = "ok\u001b[31m red\u001b[0m\u001b]0;title\u0007\u0000\u0085\r\nnext";
    const rendered = lines(
      renderResult("status", `idle\n\nDebuggee output:\n${unsafe}`, {
        expanded: true,
      }),
    ).join("\n");
    expect(rendered).toContain("ok red");
    expect(rendered).toContain("next");
    expect(sanitizeDapObserverText(unsafe)).not.toContain("\u001b");
  });

  test("shows only the Elapsed footer while an execution wait reports progress", () => {
    vi.useFakeTimers({ now: 0 });
    const context = resultContext({ isPartial: true, durationMs: undefined });
    const progress = {
      kind: "progress",
      operation: "continue",
      elapsed_ms: 0,
    } as const;
    renderResult(
      "continue",
      "continue waiting",
      { expanded: false, isPartial: true },
      context,
      progress,
    );
    vi.advanceTimersByTime(7000);
    const rendered = lines(
      renderResult(
        "continue",
        "continue waiting",
        { expanded: false, isPartial: true },
        context,
        progress,
      ),
    );
    expect(rendered.join("\n")).not.toContain("waiting");
    expect(rendered.join("\n")).not.toContain("Continuing");
    expect(rendered.at(-1)).toBe("<muted>Elapsed 7.0s</muted>");
  });
});
