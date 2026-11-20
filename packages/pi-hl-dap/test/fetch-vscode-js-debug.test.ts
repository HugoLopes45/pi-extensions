import filesystem, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

import { objectContaining, stringContaining } from "pi-hl-utils/testing/matchers";
import { afterEach, describe, expect, test, vi } from "vitest";

import setup, {
  defaultFixtureDirectory,
  extractDirectoryName,
  integrityMarkerName,
} from "../scripts/fetch-vscode-js-debug.mjs";

const temporaryDirectories: string[] = [];

function temporaryFixturePath(path: string, directory: string): string {
  return path.startsWith(`${defaultFixtureDirectory}${sep}`)
    ? resolve(directory, path.slice(defaultFixtureDirectory.length + 1))
    : path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("vscode-js-debug offline global setup", () => {
  const preparationError = objectContaining({
    message: stringContaining("node scripts/fetch-vscode-js-debug.mjs"),
  });
  test.each([
    { state: "missing", expected: preparationError },
    { state: "mismatched integrity", expected: preparationError },
    { state: "missing entry point", expected: preparationError },
    { state: "ready", expected: undefined },
  ])("validates a $state fixture offline without fetching", async ({ state, expected }) => {
    const directory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-offline-fixture-"));
    temporaryDirectories.push(directory);
    const fixture = {
      version: "1.117.0",
      url: "https://fixture.invalid/js-debug.tar.gz",
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    };
    await writeFile(resolve(directory, "fixture.json"), JSON.stringify(fixture));
    if (state !== "missing") {
      const extract = resolve(directory, extractDirectoryName);
      await mkdir(resolve(extract, "src"), { recursive: true });
      await writeFile(
        resolve(extract, "package.json"),
        JSON.stringify({
          name: "vscode-js-debug",
          version: fixture.version,
          private: true,
        }),
      );
      if (state !== "missing entry point") {
        await writeFile(resolve(extract, "src/dapDebugServer.js"), "process.exitCode = 0;\n");
      }
      await writeFile(
        resolve(extract, integrityMarkerName),
        state === "mismatched integrity" ? "invalid integrity" : fixture.integrity,
      );
    }

    const readFile = filesystem.readFile;
    vi.spyOn(filesystem, "readFile").mockImplementation((path, options) =>
      readFile(typeof path === "string" ? temporaryFixturePath(path, directory) : path, options),
    );
    const access = filesystem.access;
    vi.spyOn(filesystem, "access").mockImplementation((path, mode) =>
      access(typeof path === "string" ? temporaryFixturePath(path, directory) : path, mode),
    );
    const stat = filesystem.stat;
    vi.spyOn(filesystem, "stat").mockImplementation((path, options) =>
      stat(typeof path === "string" ? temporaryFixturePath(path, directory) : path, options),
    );
    syncBuiltinESMExports();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Offline fetch forbidden"));
    const result: unknown = await setup().then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect.soft(fetch).not.toHaveBeenCalled();
    expect(result).toEqual(expected);
  });
});
