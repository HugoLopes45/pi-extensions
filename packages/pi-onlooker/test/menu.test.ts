import { initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsMenu } from "pi-hl-utils/settings-menu";
import { createMenuTui, keys, menuDriver } from "pi-hl-utils/testing/menu-ui";
import { expectLinesFitWidth } from "pi-hl-utils/testing/ui-testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  onlookerMenuSpec,
  type OnlookerMenuHost,
  type OnlookerMenuView,
  type OnlookerScopedOptions,
} from "../src/onlooker-menu.js";
import type { OnlookerRenderTheme } from "../src/onlooker-rendering.js";
import type {
  OnlookerChange,
  OnlookerOptions,
  OnlookerSettingScope,
  OnlookerSettingSource,
} from "../src/onlooker-settings.js";

const defaults = {
  enabled: false,
  name: "Onlooker",
  thinkingLevel: "high",
  reviewEvery: "turn",
} satisfies OnlookerOptions;

/** In-memory scoped settings with the same precedence as the extension. */
function createHost({ paused = false, failWith }: { paused?: boolean; failWith?: string } = {}) {
  const authored: OnlookerScopedOptions = {
    session: {},
    project: {},
    global: {},
  };
  const applied: Array<{ scope: OnlookerSettingScope; change: OnlookerChange }> = [];
  const state = { paused, resumed: 0 };
  const host: OnlookerMenuHost = {
    view(): OnlookerMenuView {
      const settings: OnlookerOptions = { ...defaults };
      const sources: Record<string, OnlookerSettingSource> = {};
      for (const scope of ["global", "project", "session"] as const) {
        Object.assign(settings, authored[scope]);
        for (const key of Object.keys(authored[scope])) sources[key] = scope;
      }
      return {
        headline: [state.paused ? "Onlooker paused: Deadline exceeded" : "Onlooker on"],
        paused: state.paused,
        scopes: ["session", "project", "global"],
        settings,
        sources,
        authored,
        models: ["anthropic/claude-sonnet", "openai/gpt"],
      };
    },
    async apply(scope, change) {
      if (failWith) throw new Error(failWith);
      applied.push({ scope, change });
      if (change.action === "inherit") delete authored[scope][change.key];
      else Object.assign(authored[scope], change.patch);
    },
    async resume() {
      state.resumed++;
      state.paused = false;
    },
  };
  return { host, applied, authored, state };
}

function createMenu(options: Parameters<typeof createHost>[0] = {}) {
  const fixture = createHost(options);
  const { tui } = createMenuTui();
  const done = vi.fn<() => void>();
  const menu = new SettingsMenu(onlookerMenuSpec(fixture.host), { tui, theme: plainTheme }, done);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { ...fixture, menu, done, settle, ...menuDriver(() => menu) };
}

const plainTheme: OnlookerRenderTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

beforeAll(() => initTheme("dark"));

describe("Onlooker settings menu", () => {
  it("shows the live headline, the scope, and every setting with its effective value", () => {
    const { screen, menu } = createMenu();
    const text = screen();
    expect(text).toContain("Onlooker on");
    expect(text).toMatch(/Scope\s+session/);
    expect(text).toMatch(/enabled\s+inherit \(off · default\)/);
    expect(text).toMatch(/thinkingLevel\s+inherit \(high · default\)/);
    expect(text).toMatch(/model\s+inherit/);
    expect(text).toMatch(/reviewEvery\s+turn/);
    expect(text).not.toContain("Resume");
    for (const width of [40, 120])
      expectLinesFitWidth(menu.render(width), width, { piThemedBody: true });
  });

  it("cycles the selected scope's own value through inherit, on, and off", async () => {
    const { goTo, press, applied, screen, menu } = createMenu();
    const row = () =>
      screen()
        .split("\n")
        .find((line) => line.includes("enabled"))
        ?.trim()
        .replace(/\s+/g, " ");
    goTo("enabled");
    const seen = [row()];
    for (let step = 0; step < 4; step++) {
      press(keys.enter);
      await menu.settled();
      seen.push(row());
    }
    expect(seen).toEqual([
      "→ enabled inherit (off · default)",
      "→ enabled on",
      "→ enabled off",
      "→ enabled inherit (off · default)",
      "→ enabled on",
    ]);
    expect(applied).toEqual([
      { scope: "session", change: { action: "set", key: "enabled", patch: { enabled: true } } },
      { scope: "session", change: { action: "set", key: "enabled", patch: { enabled: false } } },
      { scope: "session", change: { action: "inherit", key: "enabled" } },
      { scope: "session", change: { action: "set", key: "enabled", patch: { enabled: true } } },
    ]);
  });

  it("never shows a bare inherit while a cycled edit is still being written", async () => {
    const release = Promise.withResolvers<void>();
    const { goTo, press, authored, host, screen, menu } = createMenu();
    authored.project.enabled = true;
    menu.refresh();
    const apply = host.apply.bind(host);
    host.apply = async (scope, change) => {
      await release.promise;
      await apply(scope, change);
    };
    const row = () =>
      screen()
        .split("\n")
        .find((line) => line.includes("enabled"))
        ?.trim()
        .replace(/\s+/g, " ");
    goTo("enabled");
    press(keys.enter);
    expect(row()).toBe("→ enabled inherit (on · project)");
    release.resolve();
    await menu.settled();
    expect(row()).toBe("→ enabled on");
  });

  it("shows when a higher-precedence scope overrides the edited value", async () => {
    const { goTo, press, authored, screen, menu } = createMenu();
    authored.global.enabled = true;
    authored.session.enabled = false;
    menu.refresh();
    goTo("Scope");
    press(keys.enter, keys.enter);
    expect(screen()).toMatch(/enabled\s+on \(overridden: off · session\)/);
  });

  it.each([" Marcel", "Marcel "])("rejects surrounding whitespace in a name %j", async (name) => {
    const { goTo, press, type, applied, screen, menu } = createMenu();
    goTo("name");
    press(keys.enter);
    type(name);
    press(keys.enter);
    await menu.settled();
    expect(applied).toEqual([]);
    expect(screen()).toMatch(/✗ .*name/);
  });

  it("edits a display name with spaces and restores inheritance", async () => {
    const { goTo, press, type, applied, screen, menu } = createMenu();
    goTo("name");
    press(keys.enter);
    type("Inspector gadget");
    press(keys.enter);
    await menu.settled();
    expect(screen()).toMatch(/name \[session\]\s+Inspector gadget/);
    expect(applied.at(-1)).toEqual({
      scope: "session",
      change: { action: "set", key: "name", patch: { name: "Inspector gadget" } },
    });
    goTo("name");
    press(keys.enter);
    type("inherit");
    press(keys.enter);
    await menu.settled();
    expect(screen()).toMatch(/name\s+Onlooker/);
    expect(applied.at(-1)).toEqual({
      scope: "session",
      change: { action: "inherit", key: "name" },
    });
  });

  it("cycles thinking level from inherit through its levels", async () => {
    const { goTo, press, applied, menu } = createMenu();
    goTo("thinkingLevel");
    for (let step = 0; step < 2; step++) {
      press(keys.enter);
      await menu.settled();
    }
    expect(applied.map(({ change }) => change)).toEqual(
      ["off", "minimal"].map((thinkingLevel) => ({
        action: "set",
        key: "thinkingLevel",
        patch: { thinkingLevel },
      })),
    );
  });

  it("writes edits to the scope chosen in the Scope row", async () => {
    const { goTo, press, applied, settle } = createMenu();
    goTo("Scope");
    press(keys.enter, keys.enter);
    goTo("enabled");
    press(keys.enter);
    await settle();
    expect(applied).toEqual([
      { scope: "global", change: { action: "set", key: "enabled", patch: { enabled: true } } },
    ]);
  });

  it("validates a Review cadence inline, then accepts it or inherit", async () => {
    const { goTo, press, type, applied, screen, settle } = createMenu();
    goTo("reviewEvery");
    press(keys.enter);
    type("0");
    press(keys.enter);
    await settle();
    expect(applied).toEqual([]);
    expect(screen()).toMatch(/✗ .*reviewEvery/);
    press(keys.backspace);
    type("inherit");
    press(keys.enter);
    await settle();
    for (const value of ["request", "4", "turn"]) {
      goTo("reviewEvery");
      press(keys.enter);
      type(value);
      press(keys.enter);
      await settle();
    }
    expect(applied.map(({ change }) => change)).toEqual([
      { action: "inherit", key: "reviewEvery" },
      { action: "set", key: "reviewEvery", patch: { reviewEvery: "request" } },
      { action: "set", key: "reviewEvery", patch: { reviewEvery: 4 } },
      { action: "set", key: "reviewEvery", patch: { reviewEvery: "turn" } },
    ]);
  });

  it("picks a model from a searchable list", async () => {
    const { goTo, press, type, applied, settle } = createMenu();
    goTo("model");
    press(keys.enter);
    type("gpt");
    press(keys.enter);
    await settle();
    expect(applied.map(({ change }) => change)).toEqual([
      { action: "set", key: "model", patch: { model: "openai/gpt" } },
    ]);
  });

  it("offers Resume only while paused", async () => {
    const { goTo, press, state, screen, settle } = createMenu({ paused: true });
    expect(screen()).toContain("Onlooker paused: Deadline exceeded");
    goTo("Resume");
    press(keys.enter);
    await settle();
    expect(state.resumed).toBe(1);
    expect(screen()).not.toContain("Resume");
  });

  it("shows a failed edit inline and keeps the menu open", async () => {
    const { goTo, press, done, screen, settle } = createMenu({
      failWith: "Onlooker project settings require a trusted project",
    });
    goTo("enabled");
    press(keys.enter);
    await settle();
    expect(screen()).toContain("Onlooker project settings require a trusted project");
    expect(done).not.toHaveBeenCalled();
  });

  it("keeps an open submenu when the Onlooker pauses, then offers Resume", async () => {
    const { goTo, press, type, applied, state, menu, screen, settle } = createMenu();
    goTo("reviewEvery");
    press(keys.enter);
    state.paused = true;
    menu.refresh();
    expect(screen()).toContain("a number of turns, or inherit");
    type("5");
    press(keys.enter);
    await settle();
    expect(applied.map(({ change }) => change)).toEqual([
      { action: "set", key: "reviewEvery", patch: { reviewEvery: 5 } },
    ]);
    expect(screen()).toContain("Resume");
  });
});
