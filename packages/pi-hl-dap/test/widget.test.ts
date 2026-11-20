import { stripVTControlCharacters } from "node:util";

import { initTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { createMenuTui } from "pi-hl-utils/testing/menu-ui";
import {
  escapeTaggedTheme,
  expectLinesFitWidth,
  liveTheme,
  readableTags,
} from "pi-hl-utils/testing/ui-testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import {
  DapWidget,
  renderDapWidgetLines,
  type DapWidgetTheme,
  type DapWidgetView,
} from "../src/widget.js";

const plainTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
} satisfies DapWidgetTheme;

function createContext(mode: "tui" | "rpc") {
  const { tui } = createMenuTui();
  let component: { render(width: number): readonly string[] } | undefined;
  const ui = {
    notify: vi.fn<Pick<ExtensionUIContext, "notify">["notify"]>(),
    theme: plainTheme,
    setWidget: vi.fn<
      (
        key: string,
        content:
          | string[]
          | ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
          | undefined,
      ) => void
    >((_key, content) => {
      if (content === undefined || Array.isArray(content)) {
        component = undefined;
        return;
      }
      component = content(tui, liveTheme());
    }),
  };
  return {
    component: () => component,
    context: { mode, cwd: "/workspace", ui },
    requestRender: tui.requestRender,
    ui,
  };
}

function widgetText(fixture: ReturnType<typeof createContext>, width = 80): string {
  return stripVTControlCharacters(fixture.component()?.render(width).join("\n") ?? "");
}

beforeAll(() => initTheme("dark"));
afterEach(() => vi.useRealTimers());

describe("HL DAP Observer UI", () => {
  const stopped: DapWidgetView = {
    state: "stopped",
    adapterId: "node",
    profileId: "node",
    stopReason: "breakpoint",
    path: "a.ts:4",
    elapsedMs: 18_000,
  };

  test("lays out a bold title with muted counts, then a Status Mark row", () => {
    const rendered = renderDapWidgetLines(stopped, 120, escapeTaggedTheme);
    expectLinesFitWidth(rendered, 120);
    expect(rendered.map(readableTags)).toEqual([
      "<toolTitle><b>DAP</b></toolTitle> <muted>node/node · 18s</muted>",
      "<muted>■</muted> stopped<dim> · </dim><dim>breakpoint</dim><dim> · </dim><muted>a.ts:4</muted>",
    ]);
  });

  test("renders adapter strings without terminal sequences or extra rows", () => {
    const rendered = renderDapWidgetLines(
      {
        state: "stopped",
        adapterId: "node\u001b[2J",
        profileId: "p\u001b]0;title\u0007",
        stopReason: "\u001b[31mevil\nDebuggee output:",
        path: "a\rb.ts:4",
      },
      200,
      plainTheme,
    );
    expect(rendered).toHaveLength(2);
    for (const control of ["\u001b", "\u0007", "\r", "\n"]) {
      expect(rendered.join("")).not.toContain(control);
    }
    expect(rendered[1]).toContain("evil Debuggee output:");
  });

  test("degrades right-to-left within terminal width", () => {
    const widths = [30, 18, 12];
    const rendered = widths.map((width) => renderDapWidgetLines(stopped, width, plainTheme));
    const text = rendered.map((lines) => lines.join("\n"));
    // The path goes first, while the header still fits.
    expect(text[0]).toContain("18s");
    expect(text[0]).not.toContain("a.ts:4");
    expect(text[0]).toContain("breakpoint");
    // Then the duration and the reason.
    expect(text[1]).not.toContain("18s");
    expect(text[1]).toContain("node/node");
    expect(text[1]).not.toContain("breakpoint");
    expect(text[1]).toContain("stopped");
    // Then the profile.
    expect(text[2]).not.toContain("node/node");
    expect(text[2]).toContain("DAP");
    expect(
      rendered.every((lines, index) =>
        lines.every((line) => visibleWidth(line) <= (widths[index] ?? 0)),
      ),
    ).toBe(true);
  });

  test("mounts on launch, updates in place, clears stopped location on resume, and refreshes duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);

    controller.onToolStart({
      operation: "launch",
      profile: "node",
      program: "src/app.ts",
    });
    expect(fixture.ui.setWidget).toHaveBeenCalledOnce();
    expect(fixture.ui.setWidget.mock.calls[0]?.[0]).toBe("pi-hl-dap");
    expect(widgetText(fixture)).toContain("launching");

    controller.onSessionSnapshot({
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "breakpoint",
      threadId: 1,
    });
    controller.onToolSuccess(
      { operation: "stack" },
      {
        snapshot: {
          state: "stopped",
          adapterId: "node",
          profileId: "node",
          stopReason: "breakpoint",
          threadId: 1,
        },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        stackFrames: [
          {
            id: 1,
            name: "main",
            line: 42,
            column: 1,
            source: { path: "/workspace/src/app.ts" },
          },
        ],
      },
    );
    expect(widgetText(fixture)).toContain("src/app.ts:42");
    expect(fixture.ui.setWidget).toHaveBeenCalledOnce();

    controller.onSessionSnapshot({
      state: "running",
      adapterId: "node",
      profileId: "node",
    });
    expect(widgetText(fixture)).toContain("src/app.ts");
    expect(widgetText(fixture)).not.toContain(":42");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixture.requestRender).toHaveBeenCalled();
    controller.dispose();
  });

  test("shows the stopped source location from a stop result's top Stack Frame", () => {
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);
    controller.onToolStart({ operation: "continue" });
    const snapshot = {
      state: "stopped",
      adapterId: "node",
      profileId: "node",
      stopReason: "breakpoint",
      threadId: 1,
    } as const;
    controller.onSessionSnapshot(snapshot);

    controller.onToolSuccess(
      { operation: "continue" },
      {
        snapshot,
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
        stop: {
          topFrame: {
            id: 1,
            name: "add",
            line: 3,
            column: 5,
            source: { path: "/workspace/src/app.ts" },
          },
        },
      },
    );

    expect(widgetText(fixture)).toContain("src/app.ts:3");
    controller.dispose();
  });

  test("keeps termination for ten seconds and a new launch cancels the old cooldown", async () => {
    vi.useFakeTimers();
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);
    controller.onToolStart({ operation: "launch", program: "app.ts" });
    controller.onSessionSnapshot({
      state: "terminated",
      adapterId: "node",
      profileId: "node",
      exitCode: 0,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fixture.component()).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.component()).toBeUndefined();
    controller.onToolSuccess(
      { operation: "status" },
      {
        snapshot: { state: "terminated", adapterId: "node", profileId: "node" },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
      },
    );
    expect(fixture.component()).toBeUndefined();

    controller.onToolStart({ operation: "launch", program: "app.ts" });
    controller.onSessionSnapshot({
      state: "terminated",
      adapterId: "node",
      profileId: "node",
      exitCode: 0,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    controller.onToolStart({ operation: "launch", program: "next.ts" });
    await vi.advanceTimersByTimeAsync(1);
    expect(widgetText(fixture)).toContain("next.ts");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.component()).toBeDefined();
    controller.dispose();
    controller.dispose();
    expect(fixture.ui.setWidget).toHaveBeenLastCalledWith("pi-hl-dap", undefined);
  });

  test("notifies a failure that arrived during a tool call that then succeeded", () => {
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);
    controller.onToolStart({ operation: "stop" });
    controller.onUnexpectedFailure(new Error("HL DAP: cleanup failed"));
    expect(fixture.ui.notify).not.toHaveBeenCalled();
    controller.onToolSuccess(
      { operation: "stop" },
      {
        snapshot: { state: "idle" },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
      },
    );
    expect(fixture.ui.notify).toHaveBeenCalledExactlyOnceWith("DAP: cleanup failed", "error");
    controller.dispose();
  });

  test("notifies a held failure that an unrelated tool failure does not represent", () => {
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);
    controller.onToolStart({ operation: "stack" });
    controller.onUnexpectedFailure(new Error("HL DAP: adapter crashed"));
    controller.onToolFailure({ operation: "stack" }, new Error("HL DAP: stack requires a stopped"));
    expect(fixture.ui.notify).toHaveBeenCalledExactlyOnceWith("DAP: adapter crashed", "error");
    controller.dispose();
  });

  test("notifies an adapter failure without its terminal control sequences", () => {
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);
    controller.onUnexpectedFailure(new Error("HL DAP: adapter\x1b]0;pwned\x07\x1b[2J crashed\x07"));
    expect(fixture.ui.notify).toHaveBeenCalledExactlyOnceWith("DAP: adapter crashed", "error");
    controller.dispose();
  });

  test("notifies a held failure whose text an unrelated tool failure quotes", () => {
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);
    controller.onToolStart({ operation: "evaluate", expression: "x" });
    controller.onUnexpectedFailure(new Error("connection closed"));
    controller.onToolFailure(
      { operation: "evaluate", expression: "x" },
      new Error("HL DAP: Cannot evaluate expression: connection closed"),
    );
    expect(fixture.ui.notify).toHaveBeenCalledExactlyOnceWith("DAP: connection closed", "error");
    controller.dispose();
  });

  test("does not notify a held failure that a failed tool call carries as its cause", () => {
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);
    const failure = new Error("HL DAP: Debug Session cleanup failed");
    controller.onToolStart({ operation: "launch" });
    controller.onUnexpectedFailure(failure);
    controller.onToolFailure(
      { operation: "launch" },
      new Error("HL DAP: previous cleanup failed", {
        cause: new Error("wrapped", {
          cause: new AggregateError([new Error("kill EPERM"), failure], "cleanup failures"),
        }),
      }),
    );
    expect(fixture.ui.notify).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("does not notify a held failure that a concurrent failed tool call represents", () => {
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);
    controller.onToolStart({ operation: "status" });
    controller.onToolStart({ operation: "continue" });
    const failure = new Error("adapter failed");
    controller.onUnexpectedFailure(failure);
    controller.onToolFailure({ operation: "continue" }, failure);
    controller.onToolSuccess(
      { operation: "status" },
      {
        snapshot: { state: "idle" },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
      },
    );
    expect(fixture.ui.notify).not.toHaveBeenCalled();
    controller.dispose();
  });

  test("keeps an active Debug Session's widget when a second launch is refused", () => {
    const fixture = createContext("tui");
    const controller = new DapWidget(fixture.context);
    controller.onToolStart({ operation: "launch", program: "app.ts" });
    controller.onSessionSnapshot({
      state: "running",
      adapterId: "node",
      profileId: "node",
    });
    controller.onToolSuccess(
      { operation: "launch" },
      {
        snapshot: { state: "running", adapterId: "node", profileId: "node" },
        output: "",
        discardedOutputBytes: 0,
        desiredBreakpoints: [],
      },
    );

    controller.onToolStart({ operation: "launch", program: "other.ts" });
    controller.onToolFailure({ operation: "launch" }, new Error("launch requires no active"));

    expect(widgetText(fixture)).toContain("running");
    expect(widgetText(fixture)).toContain("app.ts");
    controller.dispose();
  });

  test("is inert outside TUI and notifies only unrepresented asynchronous failures", () => {
    const rpc = createContext("rpc");
    const rpcController = new DapWidget(rpc.context);
    rpcController.onToolStart({ operation: "launch" });
    rpcController.onUnexpectedFailure(new Error("adapter failed"));
    rpcController.dispose();
    expect(rpc.ui.setWidget).not.toHaveBeenCalled();

    const tui = createContext("tui");
    const controller = new DapWidget(tui.context);
    controller.onToolStart({ operation: "continue" });
    const represented = new Error("represented");
    controller.onUnexpectedFailure(represented);
    expect(tui.ui.notify).not.toHaveBeenCalled();
    controller.onToolFailure({ operation: "continue" }, represented);
    controller.onUnexpectedFailure(new Error("asynchronous"));
    expect(tui.ui.notify).toHaveBeenCalledWith("DAP: asynchronous", "error");
    controller.onUnexpectedFailure(new Error("HL DAP: prefixed"));
    expect(tui.ui.notify).toHaveBeenLastCalledWith("DAP: prefixed", "error");
  });
});
