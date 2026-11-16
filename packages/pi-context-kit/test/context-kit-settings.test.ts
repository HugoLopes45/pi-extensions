import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { contextKitConfig, contextKitSettings } from "../src/context-kit-settings.ts";
import { DEFAULT_CONFIG } from "./fixtures.ts";

/** A Pi settings backend holding the given documents; `projectTrusted` gates the project layer. */
function settingsWith(documents: {
  global?: unknown;
  project?: unknown;
  projectTrusted?: boolean;
}) {
  const stored = {
    global: JSON.stringify(documents.global ?? {}),
    project: JSON.stringify(documents.project ?? {}),
  };
  return SettingsManager.fromStorage(
    {
      withLock(scope, update) {
        const next = update(stored[scope]);
        if (next !== undefined) stored[scope] = next;
      },
    },
    { projectTrusted: documents.projectTrusted ?? true },
  );
}

/** A session whose branch holds the given session overrides, oldest first. */
function sessionWith(...overrides: unknown[]) {
  const sessionManager = SessionManager.inMemory("/work");
  for (const value of overrides)
    sessionManager.appendCustomEntry("pi-context-kit-settings", {
      version: 1,
      overrides: value,
    });
  return sessionManager;
}

/** The effective config for stored documents, as the extension reads it. */
function effective(
  options: { global?: object; project?: object; projectTrusted?: boolean } = {},
  ...overrides: unknown[]
) {
  const namespaced = (value: object | undefined) =>
    value === undefined ? undefined : { "context-kit": value };
  return contextKitConfig(
    contextKitSettings.readSettings({
      settingsManager: settingsWith({
        global: namespaced(options.global),
        project: namespaced(options.project),
        projectTrusted: options.projectTrusted ?? true,
      }),
      sessionManager: sessionWith(...overrides),
    }),
  );
}

describe("contextKitConfig", () => {
  it("resolves no settings to the runtime defaults with no problems", () => {
    const { config, problems } = effective();
    expect(config).toMatchObject({
      enabled: true,
      strategy: "balanced",
      threshold: { percent: 75 },
      progressRatio: 0.8,
    });
    expect(problems).toEqual([]);
  });

  it("takes the method order and background from the strategy", () => {
    expect(effective({ global: { strategy: "frugal" } }).config).toMatchObject({
      strategy: "frugal",
      methodOrder: ["shake", "handoff", "soft"],
      background: false,
      customOrder: false,
    });
  });

  it("lets a later layer replace an earlier one key by key", () => {
    const result = effective({
      global: { strategy: "frugal", threshold: "60%" },
      project: { threshold: 90_000 },
    });
    expect(result.config).toMatchObject({
      strategy: "frugal",
      threshold: { tokens: 90_000 },
    });
  });

  it("gives the session layer the last word", () => {
    expect(
      effective({ global: { threshold: "60%" } }, { threshold: "90%" }).config.threshold,
    ).toEqual({ percent: 90 });
  });

  it("reads a percentage with a fraction as that percentage", () => {
    expect(effective({ global: { threshold: "72.5%" } }).config.threshold).toEqual({
      percent: 72.5,
    });
  });

  it("ignores the project layer of an untrusted project", () => {
    expect(
      effective({ project: { threshold: 5_000 }, projectTrusted: false }).config.threshold,
    ).toEqual(DEFAULT_CONFIG.threshold);
  });

  it("maps the flat prune and shake keys to their settings", () => {
    expect(
      effective({ global: { pruneEnabled: false, shakeBlockMinTokens: 500 } }).config,
    ).toMatchObject({
      prune: {
        enabled: false,
        protectTokens: 40_000,
        minSavings: 20_000,
        minTokens: 50,
      },
      shake: { protectTokens: 16_000, minSavings: 4_000, blockMinTokens: 500 },
    });
  });

  it("reports a strategy that a method order replaces", () => {
    const result = effective({
      global: { strategy: "frugal" },
      project: { methodOrder: ["soft", "soft"] },
    });
    expect(result.config).toMatchObject({
      methodOrder: ["soft"],
      customOrder: true,
    });
    expect(result.problems).toEqual([
      'strategy "frugal" does not set the method order, because methodOrder replaces it',
    ]);
  });

  it("reports a background that the method order cannot write", () => {
    expect(effective({}, { methodOrder: ["shake", "soft"], background: true }).problems).toEqual([
      'background has no effect, because "handoff" is not before "soft" in the method order',
    ]);
  });

  it("accepts a background that the chosen strategy does not use", () => {
    expect(effective({ global: { strategy: "frugal" } }, { background: true })).toEqual({
      config: {
        ...DEFAULT_CONFIG,
        strategy: "frugal",
        methodOrder: ["shake", "handoff", "soft"],
        background: true,
      },
      problems: [],
    });
  });
});

describe("contextKitSettings.parseOptions", () => {
  it.each([
    ["threshold", 120_000],
    ["threshold", "72.5%"],
    ["threshold", "100%"],
    ["threshold", "pi"],
    ["progressRatio", 1],
    ["methodOrder", ["shake", "handoff", "soft"]],
    ["strategy", "pi-summary"],
    ["pruneMinTokens", 0],
  ])("accepts %s set to %j", (key, value) => {
    expect(contextKitSettings.parseOptions({ [key]: value }, "global")).toEqual({ [key]: value });
  });

  it.each([
    ["threshold", 0],
    ["threshold", 1.5],
    ["threshold", "150000"],
    ["threshold", "0%"],
    ["threshold", "101%"],
    ["threshold", "75 %"],
    ["threshold", true],
    ["progressRatio", 0],
    ["progressRatio", 1.5],
    ["methodOrder", ["handoff", "remote"]],
    ["strategy", "remote"],
    ["pruneProtectTokens", -1],
    ["shakeBlockMinTokens", 1.5],
    ["enabled", "yes"],
    ["maxTokens", 1],
  ])("rejects %s set to %j", (key, value) => {
    expect(() => contextKitSettings.parseOptions({ [key]: value }, "global")).toThrow(
      /Invalid global context-kit settings/,
    );
  });

  it("reports a namespace that is not an object as a failed layer", () => {
    expect(
      contextKitSettings.readLayers(settingsWith({ global: { "context-kit": 5 } })).global,
    ).toBeInstanceOf(Error);
  });

  it("reads only the context-kit namespace of Pi's settings", () => {
    expect(
      contextKitSettings.readLayers(
        settingsWith({
          global: {
            contextKit: { thresholdTokens: 5 },
            "context-kit": { enabled: false },
          },
        }),
      ).global,
    ).toEqual({ enabled: false });
  });

  it("replays only the last session override of the branch", () => {
    const result = contextKitSettings.readSettings({
      settingsManager: settingsWith({}),
      sessionManager: sessionWith({ enabled: false }, { enabled: true }),
    });
    expect(result.settings.enabled).toBe(true);
    expect(result.sources.enabled).toBe("session");
  });
});
