import { stripVTControlCharacters } from "node:util";

import type { Context } from "@earendil-works/pi-ai";
import {
  initTheme,
  type ExtensionUIContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { createMenuTui, menuDriver } from "pi-hl-utils/testing/menu-ui";
import { expectClickToggles, keybindingHints } from "pi-hl-utils/testing/ui-testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

import onlooker from "../extensions/index.js";
import { fixture, response } from "./fixtures/onlooker-runtime.js";
import { createSdkHarness, reply, toolCall } from "./fixtures/sdk-harness.js";

beforeAll(() => initTheme("dark"));

function lastStatus(session: Awaited<ReturnType<typeof createSdkHarness>>["session"]) {
  return session.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");
}

describe("Onlooker status entries", () => {
  it("record the configuration change that produced them", async () => {
    const { session } = await createSdkHarness([onlooker]);
    await session.prompt("/onlooker on");
    expect(lastStatus(session)).toMatchObject({
      data: { changes: [{ scope: "session", key: "enabled", options: { enabled: true } }] },
    });
    await session.prompt('/onlooker set model "anthropic/claude-sonnet-4-5"');
    expect(lastStatus(session)).toMatchObject({
      data: {
        changes: [
          { scope: "session", key: "model", options: { model: "anthropic/claude-sonnet-4-5" } },
        ],
      },
    });
    await session.prompt("/onlooker inherit model");
    expect(lastStatus(session)).toMatchObject({
      data: { changes: [{ scope: "session", key: "model", options: {} }] },
    });
    await session.prompt("/onlooker status");
    expect(lastStatus(session)).not.toHaveProperty("data.changes");
    // A change that failed is not recorded.
    await session.prompt("/onlooker set catchUpThreshold 0");
    expect(lastStatus(session)).not.toHaveProperty("data.changes");
  });

  it("render through the registered entry renderer instead of JSON", async () => {
    const { session } = await createSdkHarness([onlooker]);
    await session.prompt("/onlooker on");
    const entry = lastStatus(session);
    if (entry?.type !== "custom") throw new Error("Expected an Onlooker status entry");
    const renderer = session.extensionRunner?.getEntryRenderer("pi-onlooker-status");
    const rendered = renderer?.(
      entry,
      { ...keybindingHints, expanded: false },
      themeFromRunner(session),
    );
    const text = stripVTControlCharacters(rendered?.render(120).join("\n") ?? "");
    expect(text).toContain("✓ enabled → true [session]");
    expect(text).toContain("[Onlooker] ● on");
    expect(text).not.toContain('"settings"');
    if (!renderer) throw new Error("Expected the Onlooker status renderer");
    expectClickToggles(
      renderer,
      entry,
      { ...keybindingHints, expanded: false },
      themeFromRunner(session),
    );
  });
});

function themeFromRunner(session: Awaited<ReturnType<typeof createSdkHarness>>["session"]): Theme {
  const ui = session.extensionRunner?.getUIContext();
  if (!ui) throw new Error("Expected an extension runner");
  return ui.theme;
}

function interventionText(
  session: Awaited<ReturnType<typeof createSdkHarness>>["session"],
): string {
  const entry = session.sessionManager
    .getBranch()
    .find((item) => item.type === "custom_message" && item.customType === "pi-onlooker");
  if (entry?.type !== "custom_message") throw new Error("Expected a delivered Intervention");
  const renderer = session.extensionRunner?.getMessageRenderer("pi-onlooker");
  const rendered = renderer?.(
    {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: true,
      details: entry.details,
      timestamp: 0,
    },
    { ...keybindingHints, expanded: false, outputPad: 0 },
    themeFromRunner(session),
  );
  return stripVTControlCharacters(rendered?.render(120).join("\n") ?? "");
}

describe("Onlooker footer", () => {
  it("tracks review activity while enabled and clears when disabled", async () => {
    const statuses: Array<string | undefined> = [];
    const releaseReview = Promise.withResolvers<void>();
    const reviewStarted = Promise.withResolvers<void>();
    const { session, cleanupGates } = await fixture({
      interactive: true,
      ui: {
        setStatus: (key, text) => {
          if (key === "onlooker")
            statuses.push(text === undefined ? undefined : stripVTControlCharacters(text));
        },
      },
    });
    cleanupGates.push(releaseReview.resolve);
    globalThis.onlookerObserverTest = {
      stream(model, context, options) {
        if (context.tools?.some((tool) => tool.name === "onlooker_report")) {
          reviewStarted.resolve();
          return response(
            model,
            toolCall("onlooker_report", { findings: [] }),
            options,
            releaseReview.promise,
          );
        }
        return response(model, reply("Done"), options);
      },
    };
    expect(statuses.at(-1)).toBe("○  Onlooker · model");
    await session.prompt('/onlooker set name "Inspector gadget"');
    expect(statuses.at(-1)).toBe("○  Inspector gadget · model");
    await session.prompt("Complete a task");
    await reviewStarted.promise;
    expect(statuses).toContain("●  Inspector gadget · model");
    releaseReview.resolve();
    await expect.poll(() => statuses.at(-1)).toBe("○  Inspector gadget · model");
    await session.prompt("/onlooker off");
    expect(statuses.at(-1)).toBeUndefined();
  });
});

describe("Interventions", () => {
  it("keep the observed request prefix stable while rendering through the Onlooker renderer", async () => {
    const mainRequests: Context[] = [];
    let reviews = 0;
    const { session } = await fixture({ interactive: true, onlooker: { correct: false } });
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
                        severity: "concern",
                        message: "Re-run the failing test",
                        evidence: { quote: "Done" },
                      },
                    ],
                  }
                : { findings: [] },
            ),
            options,
          );
        }
        mainRequests.push(structuredClone(context));
        return response(model, reply("Done"), options);
      },
    };
    await session.prompt("First task");
    await expect
      .poll(() =>
        session.sessionManager
          .getBranch()
          .some((entry) => entry.type === "custom_message" && entry.customType === "pi-onlooker"),
      )
      .toBe(true);
    await session.prompt("Second task");
    const [first, second] = mainRequests;
    if (!first || !second) throw new Error("Expected two observed requests");
    expect(mainRequests).toHaveLength(2);
    // Cache proof: the second request extends the first byte-for-byte.
    expect(second.systemPrompt).toEqual(first.systemPrompt);
    expect(second.tools).toEqual(first.tools);
    const ask = session.extensionRunner?.getToolDefinition("onlooker_ask");
    expect(ask?.renderCall).toBeTypeOf("function");
    expect(ask?.renderResult).toBeTypeOf("function");
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(
      second.messages.slice(first.messages.length).map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ).toMatchObject([
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Onlooker concern: Re-run the failing test\n[observed through turn 1; quote: "Done"]',
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Second task" }] },
    ]);
    const text = interventionText(session);
    expect(text).toContain("[Onlooker] concern");
    expect(text).not.toContain("▲");
    expect(text).toContain("Re-run the failing test");
  });
});

/** What the stub TUI host is currently showing. */
interface ShownMenu {
  component: Component | undefined;
  opened: number;
  theme: Theme | undefined;
}

/** A TUI host whose `custom` shows the component to the test instead of a terminal. */
function menuUi() {
  const { tui, keybindings } = createMenuTui();
  const shown: ShownMenu = { component: undefined, opened: 0, theme: undefined };
  const ui: Partial<ExtensionUIContext> = {
    custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (result: T) => void,
      ) => Component | Promise<Component>,
    ): Promise<T> {
      shown.opened++;
      return new Promise<T>((resolve) => {
        const finish = (result: T) => {
          shown.component = undefined;
          resolve(result);
        };
        void Promise.resolve(factory(tui, themeOf(shown.theme), keybindings, finish)).then(
          (component) => {
            shown.component = component;
          },
        );
      });
    },
  };
  return { ui, shown, ...menuDriver(() => shown.component) };
}

/** The bound UI context's theme is Pi's initialized global theme. */
function themeOf(theme: Theme | undefined): Theme {
  if (!theme) throw new Error("Expected the bound UI theme");
  return theme;
}

describe("/onlooker settings menu", () => {
  it("opens instead of recording status in the TUI, and records one entry for its changes", async () => {
    const host = menuUi();
    const { session } = await fixture({ interactive: true, mode: "tui", ui: host.ui });
    host.shown.theme = session.extensionRunner?.getUIContext().theme;
    const before = session.sessionManager.getBranch().length;
    const command = session.prompt("/onlooker");
    await vi.waitFor(() => expect(host.shown.component).toBeDefined());
    expect(host.screen()).toContain("Onlooker settings");
    expect(host.screen()).toMatch(/enabled\s+inherit \(on · global\)/);
    host.goTo("thinkingLevel");
    host.press("\r");
    await vi.waitFor(() => expect(host.screen()).toMatch(/thinkingLevel\s+off$/m));
    host.goTo("reviewEvery");
    host.press("\r", "5", "\r");
    await vi.waitFor(() => expect(host.screen()).toMatch(/reviewEvery \[session\]\s+5/));
    host.press("\x1b");
    await command;
    const added = session.sessionManager.getBranch().slice(before);
    expect(
      added.filter((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toHaveLength(1);
    expect(lastStatus(session)).toMatchObject({
      data: {
        changes: [
          { scope: "session", key: "thinkingLevel", options: { thinkingLevel: "off" } },
          { scope: "session", key: "reviewEvery", options: { reviewEvery: 5 } },
        ],
        settings: { thinkingLevel: "off", reviewEvery: 5 },
      },
    });
  });

  it("records nothing when closed without changes", async () => {
    const host = menuUi();
    const { session } = await fixture({ interactive: true, mode: "tui", ui: host.ui });
    host.shown.theme = session.extensionRunner?.getUIContext().theme;
    const before = session.sessionManager.getBranch().length;
    const command = session.prompt("/onlooker");
    await vi.waitFor(() => expect(host.shown.component).toBeDefined());
    host.press("\x1b");
    await command;
    expect(session.sessionManager.getBranch().slice(before)).toEqual([]);
  });

  it("closes without a status entry when the branch changes", async () => {
    const host = menuUi();
    const { session } = await fixture({ interactive: true, mode: "tui", ui: host.ui });
    host.shown.theme = session.extensionRunner?.getUIContext().theme;
    globalThis.onlookerObserverTest = {
      stream: (model, _context, options) => response(model, reply("Done"), options),
    };
    await session.prompt("First task");
    const target = session.sessionManager.getLeafId();
    await session.prompt("Second task");
    const command = session.prompt("/onlooker");
    await vi.waitFor(() => expect(host.shown.component).toBeDefined());
    host.goTo("reviewEvery");
    host.press("\r", "5", "\r");
    await vi.waitFor(() => expect(host.screen()).toMatch(/reviewEvery \[session\]\s+5/));
    if (!target) throw new Error("Expected a branch target");
    await session.navigateTree(target, { summarize: false });
    await command;
    expect(host.shown.component).toBeUndefined();
    expect(
      session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toBe(false);
  });

  it("refreshes its headline when the Onlooker starts reviewing", async () => {
    const host = menuUi();
    const releaseReview = Promise.withResolvers<void>();
    const { session, cleanupGates } = await fixture({
      interactive: true,
      mode: "tui",
      ui: host.ui,
    });
    host.shown.theme = session.extensionRunner?.getUIContext().theme;
    cleanupGates.push(releaseReview.resolve);
    globalThis.onlookerObserverTest = {
      stream(model, context, options) {
        if (context.tools?.some((tool) => tool.name === "onlooker_report"))
          return response(
            model,
            toolCall("onlooker_report", { findings: [] }),
            options,
            releaseReview.promise,
          );
        return response(model, reply("Done"), options);
      },
    };
    const command = session.prompt("/onlooker");
    await vi.waitFor(() => expect(host.shown.component).toBeDefined());
    expect(host.screen()).toContain("Onlooker ● on");
    // The menu has focus in a real TUI; drive a turn directly to start a Review.
    await session.agent.prompt({ role: "user", content: "Task", timestamp: Date.now() });
    await vi.waitFor(() => expect(host.screen()).toContain("Onlooker ● reviewing"));
    releaseReview.resolve();
    await vi.waitFor(() => expect(host.screen()).toContain("Onlooker ● on"));
    host.press("\x1b");
    await command;
  });

  it("keeps /onlooker status as the transcript status in the TUI", async () => {
    const host = menuUi();
    const { session } = await fixture({ interactive: true, mode: "tui", ui: host.ui });
    await session.prompt("/onlooker status");
    expect(host.shown.opened).toBe(0);
    expect(lastStatus(session)).toMatchObject({ data: { state: "armed" } });
  });

  it("falls back to the transcript status without the TUI", async () => {
    const host = menuUi();
    const { session } = await fixture({ interactive: true, mode: "rpc", ui: host.ui });
    await session.prompt("/onlooker");
    expect(host.shown.opened).toBe(0);
    expect(lastStatus(session)).toMatchObject({ data: { state: "armed" } });
  });
});
