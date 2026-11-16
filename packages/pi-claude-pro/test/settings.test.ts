import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { claudeProSettings } from "../src/settings.ts";

/** A Pi settings directory with optional global and project documents. */
function pi(global?: unknown, project?: unknown) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-claude-pro-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-claude-pro-cwd-"));
  if (global !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
  if (project !== undefined) {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(project));
  }
  return {
    settingsManager: SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    }),
    sessionManager: SessionManager.inMemory(cwd),
  };
}

const defaults = {
  footer: true,
  warnAt: 80,
  extraUsageWarning: true,
  usageCacheSeconds: 30,
  footerWindows: ["5h", "7d", "Fable"],
};

describe("claude-pro settings", () => {
  it("uses the defaults when no layer authors an option", () => {
    const resolved = claudeProSettings.readSettings(pi());
    expect(resolved.settings).toEqual(defaults);
    expect(resolved.sources.warnAt).toBe("default");
  });

  it("reads the claude-pro namespace of the global settings", () => {
    const resolved = claudeProSettings.readSettings(
      pi({ "claude-pro": { footer: false, warnAt: 60 } }),
    );
    expect(resolved.settings).toMatchObject({ footer: false, warnAt: 60 });
    expect(resolved.sources.footer).toBe("global");
    expect(resolved.sources.extraUsageWarning).toBe("default");
  });

  it("lets the project override global, and the session override both", () => {
    const session = pi(
      { "claude-pro": { warnAt: 60, footer: false } },
      { "claude-pro": { warnAt: 70 } },
    );
    expect(claudeProSettings.readSettings(session).sources.warnAt).toBe("project");
    expect(claudeProSettings.readSettings(session).settings.warnAt).toBe(70);
    expect(claudeProSettings.readSettings(session).settings.footer).toBe(false);

    session.sessionManager.appendCustomEntry("pi-claude-pro-settings", {
      version: 1,
      overrides: { warnAt: 90 },
    });
    const resolved = claudeProSettings.readSettings(session);
    expect(resolved.settings.warnAt).toBe(90);
    expect(resolved.sources.warnAt).toBe("session");
  });

  it("ignores a project layer that is not trusted", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-claude-pro-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-claude-pro-cwd-"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "claude-pro": { footer: false } }),
    );
    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: false,
    });
    const resolved = claudeProSettings.readSettings({
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
    });
    expect(resolved.settings.footer).toBe(true);
  });

  it("replays the last session entry of the branch", () => {
    const session = pi();
    session.sessionManager.appendCustomEntry("pi-claude-pro-settings", {
      version: 1,
      overrides: { footer: false },
    });
    session.sessionManager.appendCustomEntry("pi-claude-pro-settings", {
      version: 1,
      overrides: { usageCacheSeconds: 0 },
    });
    expect(claudeProSettings.readSettings(session).settings).toMatchObject({
      footer: true,
      usageCacheSeconds: 0,
    });
  });

  it.each([
    ["a percentage of 0", { warnAt: 0 }],
    ["a percentage of 101", { warnAt: 101 }],
    ["a fractional percentage", { warnAt: 80.5 }],
    ["a boolean as footer", { footer: "no" }],
    ["a pin that is not a version", { claudeCodeVersion: "latest" }],
    ["an unknown window", { footerWindows: ["1h"] }],
    ["an empty window list", { footerWindows: [] }],
    ["a negative cache age", { usageCacheSeconds: -1 }],
    ["an unknown option", { warnat: 60 }],
  ])("rejects %s and names the scope", (_case, options) => {
    expect(() => claudeProSettings.parseOptions(options, "global")).toThrow(/global/);
  });

  it("accepts a pinned Claude Code version and zero usage cache", () => {
    expect(
      claudeProSettings.parseOptions(
        { claudeCodeVersion: "2.1.400", usageCacheSeconds: 0 },
        "session",
      ),
    ).toEqual({ claudeCodeVersion: "2.1.400", usageCacheSeconds: 0 });
  });

  it("ignores an invalid layer and reports it, keeping the other layers", () => {
    const session = pi(
      { "claude-pro": { warnAt: 60, footer: false } },
      { "claude-pro": { warnAt: 101 } },
    );
    const resolved = claudeProSettings.readSettingsLeniently(session);
    expect(resolved.settings).toMatchObject({ footer: false, warnAt: 60 });
    expect(resolved.invalid.map((error) => error.message)).toEqual([
      expect.stringMatching(/^Invalid project Claude Pro settings\/warnAt/),
    ]);
  });

  it("ignores an unreadable session entry and reports it", () => {
    const session = pi({ "claude-pro": { warnAt: 60 } });
    session.sessionManager.appendCustomEntry("pi-claude-pro-settings", {
      version: 2,
    });
    const resolved = claudeProSettings.readSettingsLeniently(session);
    expect(resolved.settings).toMatchObject({ footer: true, warnAt: 60 });
    expect(resolved.invalid).toHaveLength(1);
  });

  it("validates a key and its options before a change is applied", () => {
    expect(claudeProSettings.optionKey("footerWindows")).toBe("footerWindows");
    expect(() => claudeProSettings.optionKey("toString")).toThrow(/Unknown/);
    expect(claudeProSettings.parseOptions({ footerWindows: ["7d"] }, "session")).toEqual({
      footerWindows: ["7d"],
    });
    expect(() => claudeProSettings.parseOptions({ warnAt: 0 }, "session")).toThrow(/session/);
  });
});
