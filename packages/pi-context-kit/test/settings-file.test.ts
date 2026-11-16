import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isRecord } from "pi-hl-utils/record";
import { describe, expect, it } from "vitest";

import { mergeSettings, readSettingsFile, settingsPaths } from "../src/settings-file.ts";

function dirs() {
  const agentDir = mkdtempSync(join(tmpdir(), "context-kit-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "context-kit-cwd-"));
  mkdirSync(join(cwd, ".pi"));
  return { agentDir, cwd };
}

describe("settingsPaths", () => {
  it("reads the project file only in a trusted project", () => {
    const { agentDir, cwd } = dirs();
    expect(settingsPaths(agentDir, cwd, true)).toEqual({
      global: join(agentDir, "context-kit.json"),
      project: join(cwd, ".pi", "context-kit.json"),
    });
    expect(settingsPaths(agentDir, cwd, false)).toEqual({
      global: join(agentDir, "context-kit.json"),
      project: undefined,
    });
  });
});

describe("readSettingsFile", () => {
  it("returns an empty object when the file does not exist", () => {
    const { agentDir } = dirs();
    expect(readSettingsFile(join(agentDir, "context-kit.json"))).toEqual({});
  });

  it("reports a file that is not valid JSON", () => {
    const { agentDir } = dirs();
    const path = join(agentDir, "context-kit.json");
    writeFileSync(path, "{ threshold: 1 ");
    expect(() => readSettingsFile(path)).toThrow(
      new RegExp(`^${path} is not valid JSON \\(.+\\)$`),
    );
  });

  it("reports a file whose content is not a JSON object", () => {
    const { agentDir } = dirs();
    const path = join(agentDir, "context-kit.json");
    writeFileSync(path, "[1, 2]");
    expect(() => readSettingsFile(path)).toThrow(`${path} must contain a JSON object`);
  });
});

describe("mergeSettings", () => {
  it("merges objects key by key and replaces other values", () => {
    expect(
      mergeSettings(
        {
          threshold: "60%",
          advanced: { prune: { protectTokens: 1, minTokens: 2 } },
        },
        {
          strategy: "frugal",
          advanced: { prune: { minTokens: 3 }, methodOrder: ["soft"] },
        },
      ),
    ).toEqual({
      threshold: "60%",
      strategy: "frugal",
      advanced: {
        prune: { protectTokens: 1, minTokens: 3 },
        methodOrder: ["soft"],
      },
    });
  });

  it("keeps a __proto__ key as a setting, so the checks report it", () => {
    const over: unknown = JSON.parse('{"__proto__": {"enabled": false}}');
    if (!isRecord(over)) throw new Error("fixture is not a JSON object");
    const merged = mergeSettings({}, over);
    expect(Object.keys(merged)).toEqual(["__proto__"]);
    expect(Reflect.get(merged, "enabled")).toBeUndefined();
  });
});
