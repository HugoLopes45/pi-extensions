import { describe, expect, it } from "vitest";

import { errorText, isMissingFileError } from "../src/errors.js";

describe("errorText", () => {
  it("returns an Error's message and stringifies anything else", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
  });
});

describe("isMissingFileError", () => {
  it("recognizes only an Error whose code is ENOENT", () => {
    expect(isMissingFileError(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true);
    expect(isMissingFileError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingFileError({ code: "ENOENT" })).toBe(false);
    expect(isMissingFileError("ENOENT")).toBe(false);
  });
});
