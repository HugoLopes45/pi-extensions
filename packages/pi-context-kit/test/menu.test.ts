import { initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsMenu } from "pi-hl-utils/settings-menu";
import { createMenuTui, keys, menuDriver } from "pi-hl-utils/testing/menu-ui";
import { escapeTaggedTheme } from "pi-hl-utils/testing/ui-testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { contextKitDefaults } from "../src/context-kit-settings.ts";
import {
  contextKitMenuSpec,
  menuChange,
  type ContextKitMenuHost,
  type ContextKitMenuView,
} from "../src/menu.ts";

beforeAll(() => initTheme("dark"));

describe("menuChange", () => {
  it("turns on and off into booleans for the scope", () => {
    expect(menuChange("enabled", "on", "global")).toEqual({
      action: "set",
      key: "enabled",
      patch: { enabled: true },
    });
    expect(menuChange("background", "off", "project")).toEqual({
      action: "set",
      key: "background",
      patch: { background: false },
    });
  });

  it("clears a key with inherit", () => {
    expect(menuChange("strategy", "inherit", "session")).toEqual({
      action: "inherit",
      key: "strategy",
    });
  });

  it("reads a whole number of tokens and keeps a percentage as text", () => {
    expect(menuChange("threshold", "120000", "global")).toMatchObject({
      patch: { threshold: 120_000 },
    });
    expect(menuChange("threshold", "72.5%", "global")).toMatchObject({
      patch: { threshold: "72.5%" },
    });
  });

  it("splits a method order by commas", () => {
    expect(menuChange("methodOrder", "shake, soft", "global")).toMatchObject({
      patch: { methodOrder: ["shake", "soft"] },
    });
  });

  it("rejects empty text and an out-of-range value before it is written", () => {
    expect(() => menuChange("progressRatio", "", "global")).toThrow(
      "Enter a value for progressRatio, or inherit",
    );
    expect(() => menuChange("progressRatio", "2", "global")).toThrow(
      /Invalid global context-kit settings\/progressRatio/,
    );
  });
});

describe("ContextKitSettingsMenu", () => {
  const view: ContextKitMenuView = {
    headline: ["Context cleanup on"],
    scopes: ["session", "project", "global"],
    settings: contextKitDefaults,
    sources: {},
    authored: {},
  };

  function setup() {
    const { tui } = createMenuTui();
    const host: ContextKitMenuHost = {
      view: () => view,
      apply: vi.fn<ContextKitMenuHost["apply"]>(async () => {}),
    };
    const menu = new SettingsMenu(
      contextKitMenuSpec(host),
      { tui, theme: escapeTaggedTheme },
      vi.fn<() => void>(),
    );
    return { menu, ...menuDriver(() => menu) };
  }

  it("keeps the selected row after a change", async () => {
    const { menu, goTo, press, screen } = setup();
    goTo("enabled");
    press(keys.enter);
    await menu.settled();
    expect(screen()).toMatch(/→ enabled/);
  });
});
