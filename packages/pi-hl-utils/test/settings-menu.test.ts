import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  cycleDisplay,
  effectiveWithSource,
  ModelPicker,
  nextCycleValue,
  SettingsMenu,
  ValueInput,
  type SettingsMenuSpec,
  type SettingsMenuTheme,
  type SettingsMenuView,
} from "../src/settings-menu.js";
import { createMenuTui, menuDriver } from "../testing/menu-ui.js";
import { escapeTaggedTheme, expectLinesFitWidth, readableTags } from "../testing/ui-testing.js";

const enter = "\r";
const down = "\x1b[B";
const taggedTheme: SettingsMenuTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<b>${text}</b>`,
};

beforeAll(() => initTheme("dark"));

function screen(component: Component): string[] {
  return component.render(60).map((line) => stripVTControlCharacters(line).trimEnd());
}

function type(component: Component, text: string): void {
  for (const character of text) component.handleInput?.(character);
}

describe("nextCycleValue", () => {
  it("advances and wraps", () => {
    const values = ["inherit", "on", "off"] as const;
    expect(nextCycleValue(values, "inherit")).toBe("on");
    expect(nextCycleValue(values, "on")).toBe("off");
    expect(nextCycleValue(values, "off")).toBe("inherit");
  });
});

describe("ValueInput", () => {
  function createInput(submit: (text: string) => void = () => {}) {
    const input = new ValueInput("limit", "a number, or inherit", taggedTheme, submit, () => {});
    return { input };
  }

  it("submits the typed text", () => {
    const submit = vi.fn<(text: string) => void>();
    const { input } = createInput(submit);
    type(input, "12");
    input.handleInput(enter);
    expect(submit).toHaveBeenCalledWith("12");
  });

  it("shows a thrown message until the next keystroke", () => {
    const { input } = createInput(() => {
      throw new Error("Not a number");
    });
    type(input, "x");
    input.handleInput(enter);
    expect(input.render(60).at(-1)).toBe("<error>✗</error> <error>Not a number</error>");
    type(input, "y");
    expect(input.render(60).at(-1)).toBe("<dim>a number, or inherit</dim>");
  });
});

describe("ModelPicker", () => {
  const models = ["anthropic/claude-sonnet", "openai/gpt", "openai/o-mini"];

  function createPicker() {
    const choose = vi.fn<(value: string) => void>();
    return { picker: new ModelPicker(models, choose, () => {}), choose };
  }

  it("chooses the highlighted entry", () => {
    const { picker, choose } = createPicker();
    picker.handleInput(enter);
    expect(choose).toHaveBeenLastCalledWith("inherit");
    picker.handleInput(down);
    picker.handleInput(enter);
    expect(choose).toHaveBeenLastCalledWith("anthropic/claude-sonnet");
  });

  it("fuzzy-filters the list as the user types", () => {
    const { picker, choose } = createPicker();
    type(picker, "omini");
    const text = screen(picker).join("\n");
    expect(text).toContain("openai/o-mini");
    expect(text).not.toContain("anthropic/claude-sonnet");
    picker.handleInput(enter);
    expect(choose).toHaveBeenCalledWith("openai/o-mini");
  });
});

describe("cycleDisplay", () => {
  const inEffect = effectiveWithSource("on", "project");

  it("shows what an unset option inherits", () => {
    expect(cycleDisplay({ own: undefined, inEffect, source: "project", scope: "session" })).toBe(
      "inherit (on · project)",
    );
  });

  it("shows the scope's own value, noting an override from another scope", () => {
    expect(cycleDisplay({ own: "off", inEffect, source: "session", scope: "session" })).toBe("off");
    expect(cycleDisplay({ own: "off", inEffect, source: "project", scope: "session" })).toBe(
      "off (overridden: on · project)",
    );
  });
});

const headline = `Test ${escapeTaggedTheme.fg("accent", "ready")} with a long status line that has to wrap at narrow widths`;

/** A two-row menu: the Scope row, then one cycled `footer` row whose changes reach `apply`. */
function createMenu(apply: (scope: string, value: string) => Promise<void> = async () => {}) {
  const { tui } = createMenuTui();
  const spec: SettingsMenuSpec<SettingsMenuView, string> = {
    title: "Test settings",
    read: () => ({ headline: [headline], scopes: ["session", "global"] }),
    rows: () => [
      { kind: "scope" },
      {
        kind: "cycle",
        id: "footer",
        label: "footer",
        description: "Shows the footer",
        values: ["inherit", "on", "off"],
        own: undefined,
        inEffect: "on · default",
        source: "default",
        change: (value) => value,
      },
    ],
    apply,
  };
  const menu = new SettingsMenu(spec, { tui, theme: escapeTaggedTheme }, () => {});
  return { menu, ...menuDriver(() => menu) };
}

describe("SettingsMenu", () => {
  const tags = (line: string | undefined) => readableTags(line ?? "").trimEnd();

  it("frames an accent title, the headline, and Pi's settings list between borders", () => {
    const { menu } = createMenu();
    const lines = menu.render(80);
    expect(tags(lines[1])).toBe(" <accent><b>Test settings</b></accent>");
    expect(tags(lines[2])).toContain("Test <accent>ready</accent>");
    expect(tags(lines.at(0))).toMatch(/^<border>─+<\/border>$/);
    expect(tags(lines.at(-1))).toMatch(/^<border>─+<\/border>$/);
    expect(lines.map((line) => stripTerminalSequences(line)).join("\n")).toMatch(
      /→ Scope\s+session/,
    );
  });

  it("writes a cycled row's next value to the selected scope", async () => {
    const apply = vi.fn<(scope: string, value: string) => Promise<void>>(async () => {});
    const { menu, goTo, press } = createMenu(apply);
    goTo("footer");
    press(enter);
    await menu.settled();
    expect(apply).toHaveBeenCalledWith("session", "on");
  });

  it("keeps the selected row after an edit", async () => {
    const { menu, goTo, press, screen } = createMenu();
    goTo("footer");
    press(enter);
    await menu.settled();
    expect(screen()).toMatch(/→ footer/);
  });

  it("writes to the scope chosen in the Scope row", async () => {
    const apply = vi.fn<(scope: string, value: string) => Promise<void>>(async () => {});
    const { menu, goTo, press } = createMenu(apply);
    goTo("Scope");
    press(enter);
    goTo("footer");
    press(enter);
    await menu.settled();
    expect(apply).toHaveBeenCalledWith("global", "on");
  });

  it("shows a failed edit with a failure mark, then clears it on the next edit", async () => {
    const apply = vi
      .fn<(scope: string, value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Settings are read-only"))
      .mockResolvedValue(undefined);
    const { menu, goTo, press } = createMenu(apply);
    goTo("footer");
    press(enter);
    await menu.settled();
    const lines = menu.render(120);
    expect(lines.map(tags)).toContain(" <error>✗</error> <error>Settings are read-only</error>");
    for (const width of [40, 120])
      expectLinesFitWidth(menu.render(width), width, { piThemedBody: true });
    press(enter);
    await menu.settled();
    expect(menu.render(120).map(tags).join("\n")).not.toContain("read-only");
  });
});
