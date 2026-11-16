import { parseSettingsCommand } from "pi-hl-utils/settings-command";
import { describe, expect, it } from "vitest";

import { claudeProCommandSpec } from "../src/claude-pro-command.ts";

function parseClaudeProCommand(input: string) {
  return parseSettingsCommand(input, claudeProCommandSpec);
}

describe("parseClaudeProCommand", () => {
  it("opens the menu when given no arguments and reports status on status", () => {
    expect(parseClaudeProCommand("")).toEqual({ action: "menu" });
    expect(parseClaudeProCommand("status")).toEqual({ action: "status" });
  });

  it("rejects a scope flag on the menu or status", () => {
    expect(() => parseClaudeProCommand("status --global")).toThrow(/Usage: \/claude-pro/);
  });

  it("toggles the footer in the session by default", () => {
    expect(parseClaudeProCommand("on")).toEqual({
      action: "set",
      scope: "session",
      key: "footer",
      patch: { footer: true },
    });
    expect(parseClaudeProCommand("off --global")).toEqual({
      action: "set",
      scope: "global",
      key: "footer",
      patch: { footer: false },
    });
  });

  it("clears the footer with a bare inherit and any key with inherit key", () => {
    expect(parseClaudeProCommand("inherit")).toEqual({
      action: "inherit",
      scope: "session",
      key: "footer",
    });
    expect(parseClaudeProCommand("inherit warnAt --project")).toEqual({
      action: "inherit",
      scope: "project",
      key: "warnAt",
    });
  });

  it("sets a JSON value at the chosen scope", () => {
    expect(parseClaudeProCommand("set warnAt 60 --global")).toEqual({
      action: "set",
      scope: "global",
      key: "warnAt",
      patch: { warnAt: 60 },
    });
    expect(parseClaudeProCommand('set footerWindows ["7d"]')).toEqual({
      action: "set",
      scope: "session",
      key: "footerWindows",
      patch: { footerWindows: ["7d"] },
    });
    expect(parseClaudeProCommand('set claudeCodeVersion "2.1.400"')).toMatchObject({
      patch: { claudeCodeVersion: "2.1.400" },
    });
  });

  it.each([
    ["an unknown key", "set nope 1", /^Unknown Claude Pro option: nope$/],
    ["a value out of range", "set warnAt 0", /^Invalid session Claude Pro settings/],
    ["a value that is not JSON", "set warnAt sixty", /^warnAt value is not JSON/],
    [
      "a pin that is not a version",
      'set claudeCodeVersion "latest"',
      /^Invalid session Claude Pro settings/,
    ],
    [
      "an empty window list",
      "set footerWindows []",
      /^Invalid session Claude Pro settings\/footerWindows: must not have fewer than 1 items$/,
    ],
  ])("rejects %s", (_case, input, message) => {
    expect(() => parseClaudeProCommand(input)).toThrow(message);
  });
});
