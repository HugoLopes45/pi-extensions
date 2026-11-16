import { resolveLayeredOptions, type LayeredSettingScope } from "pi-hl-utils/layered-settings";
import { describe, expect, it } from "vitest";

import { type ContextKitConfig, writesHandoff } from "../src/config.ts";
import {
  contextKitConfig,
  contextKitDefaults,
  contextKitSettings,
} from "../src/context-kit-settings.ts";
import {
  flattenSettings,
  migrateLegacy,
  migrateProject,
  planSettingsImports,
} from "../src/migrate.ts";
import { mergeSettings } from "../src/settings-file.ts";

/** The effective config of nested 0.4 settings, lowest precedence first. */
function effectiveOf(...layers: [LayeredSettingScope, Record<string, unknown>][]) {
  return contextKitConfig(
    resolveLayeredOptions({
      defaults: contextKitDefaults,
      optionKeys: contextKitSettings.optionKeys,
      layers: layers.map(([scope, nested]) => [
        scope,
        contextKitSettings.parseOptions(flattenSettings(nested), scope),
      ]),
    }),
  );
}

describe("flattenSettings", () => {
  it("moves the advanced keys to their flat names", () => {
    expect(
      flattenSettings({
        enabled: false,
        threshold: "60%",
        advanced: {
          methodOrder: ["soft"],
          background: false,
          supersedeReads: false,
          progressRatio: 0.5,
          prune: {
            enabled: false,
            protectTokens: 1,
            minSavings: 2,
            minTokens: 3,
          },
          shake: { protectTokens: 4, minSavings: 5, blockMinTokens: 6 },
        },
      }),
    ).toEqual({
      enabled: false,
      threshold: "60%",
      methodOrder: ["soft"],
      background: false,
      supersedeReads: false,
      progressRatio: 0.5,
      pruneEnabled: false,
      pruneProtectTokens: 1,
      pruneMinSavings: 2,
      pruneMinTokens: 3,
      shakeProtectTokens: 4,
      shakeMinSavings: 5,
      shakeBlockMinTokens: 6,
    });
  });

  it("drops the editor's schema key", () => {
    expect(flattenSettings({ $schema: "context-kit.schema.json", enabled: true })).toEqual({
      enabled: true,
    });
  });

  it("keeps an unknown nested key, so the option schema rejects it", () => {
    expect(() =>
      contextKitSettings.parseOptions(
        flattenSettings({ advanced: { prune: { foo: 1 } } }),
        "global",
      ),
    ).toThrow(/Invalid global context-kit settings/);
  });
});

describe("migrateLegacy", () => {
  it("keeps Pi's limit when 0.3 had no threshold", () => {
    expect(migrateLegacy({})).toEqual({ threshold: "pi" });
  });

  it.each([
    [{ thresholdTokens: 150_000 }, 150_000],
    [{ thresholdPercent: 75 }, "75%"],
    [{ thresholdTokens: -1, thresholdPercent: 62.5 }, "62.5%"],
    [{ thresholdTokens: 120_000, thresholdPercent: 60 }, 120_000],
    [{ thresholdTokens: "lots" }, "pi"],
  ])("converts the threshold of %j", (legacy, threshold) => {
    expect(migrateLegacy(legacy)).toEqual({ threshold });
  });

  it.each([
    [{ methodOrder: ["handoff", "shake", "soft"] }, {}],
    [
      { methodOrder: ["shake", "handoff", "soft"] },
      { strategy: "frugal", advanced: { background: true } },
    ],
    [{ methodOrder: ["shake", "handoff", "soft"], asyncEnabled: false }, { strategy: "frugal" }],
    [{ methodOrder: ["soft"] }, { strategy: "pi-summary" }],
    [{ asyncEnabled: false }, { advanced: { background: false } }],
    [
      { methodOrder: ["remote", "handoff", "snapcompact", "soft"] },
      { advanced: { methodOrder: ["handoff", "soft"] } },
    ],
    [
      { methodOrder: ["shake", "soft"], asyncEnabled: false },
      { advanced: { methodOrder: ["shake", "soft"] } },
    ],
    [{ methodOrder: "handoff" }, {}],
    [{ methodOrder: ["handoff", "magic"] }, {}],
    [{ methodOrder: ["shake", "remote", "shake"] }, { advanced: { methodOrder: ["shake"] } }],
  ])("converts the methods of %j", (legacy, expected) => {
    const migrated = migrateLegacy(legacy);
    expect(migrated).toEqual({ threshold: "pi", ...expected });
    expect(effectiveOf(["global", migrated]).problems).toEqual([]);
  });

  it("keeps the other settings, the advanced ones under advanced", () => {
    const prune = { enabled: false, protectTokens: 10_000 };
    const shake = { minSavings: 1_000 };
    expect(
      migrateLegacy({
        enabled: false,
        supersedeReads: false,
        progressRatio: 0.5,
        prune,
        shake,
      }),
    ).toEqual({
      enabled: false,
      threshold: "pi",
      advanced: { supersedeReads: false, progressRatio: 0.5, prune, shake },
    });
  });
});

describe("migrateProject", () => {
  // 0.3 read the project block merged over the global block. The global block becomes the global file.
  it.each([
    [
      { thresholdPercent: 70 },
      { prune: { enabled: false } },
      { advanced: { prune: { enabled: false } } },
    ],
    [{ thresholdTokens: 100_000 }, { thresholdPercent: 60 }, { threshold: 100_000 }],
    [{}, { enabled: false, thresholdPercent: 60 }, { enabled: false, threshold: "60%" }],
    [
      { asyncEnabled: false },
      { methodOrder: ["shake", "handoff", "soft"] },
      { strategy: "frugal", advanced: { background: false } },
    ],
    [
      { methodOrder: ["soft"] },
      { methodOrder: ["handoff", "shake", "soft"] },
      { strategy: "balanced", advanced: { background: true } },
    ],
    [
      { methodOrder: ["shake", "soft"] },
      { methodOrder: ["soft"] },
      { advanced: { methodOrder: ["soft"] } },
    ],
    [
      { methodOrder: ["shake", "handoff", "soft"] },
      { methodOrder: ["soft"] },
      { strategy: "pi-summary", advanced: { background: false } },
    ],
    [
      { asyncEnabled: false },
      { asyncEnabled: true },
      { strategy: "balanced", advanced: { background: true } },
    ],
  ])("converts global %j with project %j", (global, project, expected) => {
    const globalFile = migrateLegacy(global);
    const migrated = migrateProject(global, project, globalFile);
    expect(migrated).toEqual(expected);
    const effective = effectiveOf(["global", globalFile], ["project", migrated]);
    expect(effective.problems).toEqual([]);
    expect(behavior(effective.config)).toEqual(
      behavior(effectiveOf(["global", migrateLegacy(mergeSettings(global, project))]).config),
    );
  });
});

/** What decides the work done: `strategy` and `customOrder` only say where the method order comes from, and background needs a handoff. */
function behavior({
  strategy: _strategy,
  customOrder: _customOrder,
  background,
  ...rest
}: ContextKitConfig) {
  return { ...rest, background: writesHandoff(rest.methodOrder) && background };
}

describe("planSettingsImports", () => {
  it("imports a scope's context-kit.json and names the file to rename", () => {
    expect(
      planSettingsImports(
        { stored: false, file: { path: "/agent/context-kit.json", content: { threshold: 8_000 } } },
        undefined,
      ),
    ).toEqual([
      { scope: "global", options: { threshold: 8_000 }, file: "/agent/context-kit.json" },
    ]);
  });

  it("imports the 0.3 block of a scope that has no context-kit.json", () => {
    expect(
      planSettingsImports({ stored: false, legacy: { thresholdTokens: 8_000 } }, undefined),
    ).toEqual([{ scope: "global", options: { threshold: 8_000 } }]);
  });

  it("skips a scope whose namespace is already stored", () => {
    expect(
      planSettingsImports(
        {
          stored: true,
          file: { path: "/agent/context-kit.json", content: { threshold: 8_000 } },
          legacy: { thresholdTokens: 9_000 },
        },
        undefined,
      ),
    ).toEqual([]);
  });

  it("converts the project's 0.3 block over the global settings as 0.3 merged them", () => {
    expect(
      planSettingsImports(
        { stored: false, legacy: { thresholdTokens: 8_000 } },
        { stored: false, legacy: { methodOrder: ["soft"] } },
      ),
    ).toEqual([
      { scope: "global", options: { threshold: 8_000 } },
      { scope: "project", options: { strategy: "pi-summary" } },
    ]);
  });

  it("returns nothing when neither scope has settings to import", () => {
    expect(planSettingsImports({ stored: false }, { stored: false })).toEqual([]);
  });
});
