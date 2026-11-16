import { readFileSync } from "node:fs";

import { isRecord } from "pi-hl-utils/record";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { ownThreshold, speculationLead } from "../src/config.ts";
import {
  contextKitDefaults,
  contextKitOptionsSchema,
  contextKitSettings,
} from "../src/context-kit-settings.ts";
import { DEFAULT_CONFIG } from "./fixtures.ts";

describe("ownThreshold", () => {
  it("takes a percentage of the context window by default", () => {
    expect(ownThreshold(DEFAULT_CONFIG, 200_000)).toBe(150_000);
  });

  it("caps a percentage below the whole window", () => {
    expect(ownThreshold({ ...DEFAULT_CONFIG, threshold: { percent: 100 } }, 200_000)).toBe(198_000);
  });

  it("caps tokens below the whole window", () => {
    const at = (tokens: number) =>
      ownThreshold({ ...DEFAULT_CONFIG, threshold: { tokens } }, 200_000);
    expect(at(100_000)).toBe(100_000);
    expect(at(500_000)).toBe(199_999);
  });

  it("leaves only Pi's threshold for pi", () => {
    expect(ownThreshold({ ...DEFAULT_CONFIG, threshold: "pi" }, 200_000)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("speculationLead", () => {
  it("scales to small thresholds without exceeding them", () => {
    expect(speculationLead(8)).toBe(1);
    expect(speculationLead(80_000)).toBe(10_000);
    expect(speculationLead(1_000_000)).toBe(32_000);
    expect(speculationLead(0)).toBe(0);
    expect(speculationLead(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("context-kit.schema.json", () => {
  const schema = (): unknown =>
    JSON.parse(readFileSync(new URL("../context-kit.schema.json", import.meta.url), "utf8"));

  it("declares every setting with the defaults of the settings schema", () => {
    const defaults = (node: unknown): unknown => {
      if (!isRecord(node)) return undefined;
      if (isRecord(node.properties))
        return Object.fromEntries(
          Object.entries(node.properties)
            .map(([key, child]) => [key, defaults(child)])
            .filter(([, value]) => value !== undefined),
        );
      return node.default;
    };
    expect(defaults(schema())).toEqual(contextKitDefaults);
  });

  it("lists the same options as the settings schema", () => {
    const root = schema();
    const properties = isRecord(root) && isRecord(root.properties) ? root.properties : {};
    expect(Object.keys(properties).toSorted()).toEqual(
      [...contextKitSettings.optionKeys].toSorted(),
    );
  });

  it.each([
    "75%",
    "72.5%",
    "100%",
    "100.0%",
    "0.5%",
    "007%",
    "0100%",
    "0%",
    "0.0%",
    "100.5%",
    "101%",
    ".5%",
    "75 %",
    "%",
  ])("matches the settings schema for the threshold %s", (threshold) => {
    const text = readFileSync(new URL("../context-kit.schema.json", import.meta.url), "utf8");
    const pattern = /"pattern": "(.+)"/.exec(text)?.[1];
    expect(pattern).toBeDefined();
    const source: unknown = JSON.parse(`"${pattern}"`);
    if (typeof source !== "string") throw new Error("schema pattern is not a JSON string");
    expect(new RegExp(source).test(threshold)).toBe(
      Value.Check(contextKitOptionsSchema, { threshold }),
    );
  });
});
