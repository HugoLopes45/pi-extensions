import { initTheme } from "@earendil-works/pi-coding-agent";
import { SettingsMenu } from "pi-hl-utils/settings-menu";
import { createMenuTui, keys, menuDriver } from "pi-hl-utils/testing/menu-ui";
import { escapeTaggedTheme } from "pi-hl-utils/testing/ui-testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { claudeProMenuSpec, type ClaudeProMenuHost, type ClaudeProMenuView } from "../src/menu.ts";
import type { ClaudeProChange } from "../src/settings.ts";

const view: ClaudeProMenuView = {
  headline: ["pi-claude-pro is active: claude-test uses your Claude plan."],
  scopes: ["session", "global"],
  settings: {
    footer: true,
    warnAt: 80,
    extraUsageWarning: true,
    usageCacheSeconds: 30,
    footerWindows: ["5h", "7d", "Fable"],
  },
  sources: {},
  authored: {},
};

beforeAll(() => initTheme("dark"));

function setup() {
  const { tui } = createMenuTui();
  const apply = vi.fn<(scope: string, change: ClaudeProChange) => Promise<void>>(async () => {});
  const host: ClaudeProMenuHost = { view: () => view, apply };
  const done = vi.fn<() => void>();
  const menu = new SettingsMenu(claudeProMenuSpec(host), { tui, theme: escapeTaggedTheme }, done);
  return { menu, driver: menuDriver(() => menu), apply, done };
}

describe("ClaudeProSettingsMenu", () => {
  it("shows the usage headline, the scope and one row per option", () => {
    const { driver } = setup();
    const lines = driver.screen();
    expect(lines).toContain("claude-test uses your Claude plan");
    expect(lines).toContain("Scope");
    for (const key of ["footer", "warnAt", "extraUsageWarning", "claudeCodeVersion"]) {
      expect(lines).toContain(key);
    }
  });

  it("turns the footer on in the session scope when its row is chosen", async () => {
    const { menu, driver, apply } = setup();
    driver.press(keys.down, keys.enter);
    await menu.settled();
    expect(apply).toHaveBeenCalledWith("session", {
      action: "set",
      key: "footer",
      patch: { footer: true },
    });
  });

  it("writes to the scope chosen in the Scope row", async () => {
    const { menu, driver, apply } = setup();
    driver.press(keys.enter, keys.down, keys.enter);
    await menu.settled();
    expect(apply).toHaveBeenCalledWith("global", {
      action: "set",
      key: "footer",
      patch: { footer: true },
    });
  });

  it("sets a typed number and keeps the field open for an invalid one", async () => {
    const { menu, driver, apply } = setup();
    driver.press(keys.down, keys.down, keys.enter);
    driver.type("0");
    driver.press(keys.enter);
    await menu.settled();
    expect(apply).not.toHaveBeenCalled();

    driver.press(keys.backspace);
    driver.type("100");
    driver.press(keys.enter);
    await menu.settled();
    expect(apply).toHaveBeenLastCalledWith("session", {
      action: "set",
      key: "warnAt",
      patch: { warnAt: 100 },
    });
  });

  it.each([
    ["2.1", "2.1"],
    ['"2.1.400"', "2.1.400"],
  ])("sets the typed version %s", async (typed, version) => {
    const { menu, driver, apply } = setup();
    driver.press(keys.down, keys.down, keys.down, keys.down, keys.enter);
    driver.type(typed);
    driver.press(keys.enter);
    await menu.settled();
    expect(apply).toHaveBeenLastCalledWith("session", {
      action: "set",
      key: "claudeCodeVersion",
      patch: { claudeCodeVersion: version },
    });
  });
});
