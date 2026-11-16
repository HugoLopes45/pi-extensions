import { describe, expect, test } from "vitest";

import { isRecord } from "../src/record.js";

describe("isRecord", () => {
  test("accepts plain objects, including empty ones", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ type: "text" })).toBe(true);
  });

  test("rejects null, arrays and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ type: "text" }])).toBe(false);
    expect(isRecord("object")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
