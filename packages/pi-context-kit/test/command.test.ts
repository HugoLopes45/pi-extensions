import { parseSettingsCommand } from "pi-hl-utils/settings-command";
import { type CommandSession, startCommandSession } from "pi-hl-utils/testing/command-session";
import { afterEach, describe, expect, it } from "vitest";

import contextKit from "../extensions/index.ts";
import { contextKitCommandSpec } from "../src/command.ts";

function parseContextKitCommand(input: string) {
  return parseSettingsCommand(input, contextKitCommandSpec);
}

describe("parseContextKitCommand", () => {
  it("opens the menu for a blank command and reports status for status", () => {
    expect(parseContextKitCommand("")).toEqual({ action: "menu" });
    expect(parseContextKitCommand(" status ")).toEqual({ action: "status" });
  });

  it("writes to the session by default and to the flagged scope", () => {
    expect(parseContextKitCommand("off")).toEqual({
      action: "set",
      scope: "session",
      key: "enabled",
      patch: { enabled: false },
    });
    expect(parseContextKitCommand("on --global")).toEqual({
      action: "set",
      scope: "global",
      key: "enabled",
      patch: { enabled: true },
    });
  });

  it("parses set with a JSON value and a project flag", () => {
    expect(parseContextKitCommand('set threshold "60%" --project')).toEqual({
      action: "set",
      scope: "project",
      key: "threshold",
      patch: { threshold: "60%" },
    });
  });

  it("clears a key at a scope with inherit", () => {
    expect(parseContextKitCommand("inherit strategy --global")).toEqual({
      action: "inherit",
      scope: "global",
      key: "strategy",
    });
  });

  it("rejects an unknown key", () => {
    expect(() => parseContextKitCommand("set maxTokens 1")).toThrow(
      "Unknown context-kit option: maxTokens",
    );
  });

  it("rejects an invalid value before it is written", () => {
    expect(() => parseContextKitCommand("set progressRatio 2")).toThrow(
      /Invalid session context-kit settings\/progressRatio/,
    );
  });

  it("rejects a scope flag on status and on the bare menu", () => {
    expect(() => parseContextKitCommand("status --global")).toThrow(/^Usage: \/context-kit/);
    expect(() => parseContextKitCommand("--global")).toThrow(/^Usage: \/context-kit/);
  });

  it("rejects a set value that is not JSON", () => {
    expect(() => parseContextKitCommand("set threshold 60%")).toThrow(
      "threshold value is not JSON",
    );
  });
});

describe("context-kit command completions", () => {
  const started: CommandSession[] = [];
  afterEach(() => {
    for (const item of started.splice(0)) item.cleanup();
  });
  async function values(prefix: string): Promise<string[]> {
    const command = await startCommandSession(contextKit, "print");
    started.push(command);
    const items = await command.session.extensionRunner
      .getCommand("context-kit")
      ?.getArgumentCompletions?.(prefix);
    return (items ?? []).map((item) => item.value);
  }

  it("offers the words and the option keys", async () => {
    expect(await values("")).toEqual(
      expect.arrayContaining(["on", "off", "status", "inherit", "set"]),
    );
    expect(await values("set th")).toEqual(["set threshold"]);
  });

  it("offers the scope flags once the command is complete", async () => {
    expect(await values("on ")).toEqual(["on --global", "on --project"]);
  });
});
