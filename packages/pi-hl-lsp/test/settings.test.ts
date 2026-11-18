import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

import { lspSettings, readSettings as readLayeredSettings } from "../src/settings.js";
import { directory } from "./fixtures.js";

function readSettings(global: unknown, project: unknown, trusted: boolean) {
  const settingsManager = SettingsManager.fromStorage(
    {
      withLock(scope, update) {
        update(JSON.stringify({ "hl-lsp": scope === "global" ? global : project }));
      },
    },
    { projectTrusted: trusted },
  );
  return readLayeredSettings({
    settingsManager,
    sessionManager: { getBranch: () => [] },
  }).settings;
}

function readFromDisk(cwd: string, agentDir: string) {
  return readLayeredSettings({
    settingsManager: SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    }),
    sessionManager: { getBranch: () => [] },
  }).settings;
}

function thrownMessage(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("expected settings read to throw");
}

it("names the unreadable settings file and its parse error", async () => {
  const agentDir = await directory();
  const cwd = await directory();
  await writeFile(join(agentDir, "settings.json"), "x");
  const message = thrownMessage(() => readFromDisk(cwd, agentDir));
  expect(message).toContain(join(agentDir, "settings.json"));
  expect(message).toContain("Unexpected token");
  expect(message).not.toContain("more)");
});

it("shows control characters in a settings parse error escaped", async () => {
  const agentDir = await directory();
  const cwd = await directory();
  await writeFile(join(agentDir, "settings.json"), "\u001b");
  const message = thrownMessage(() => readFromDisk(cwd, agentDir));
  expect(message).toContain("\\u001b");
  expect(message).not.toContain("\u001b");
});

it("counts the unreadable settings files after the first", async () => {
  const agentDir = await directory();
  const cwd = await directory();
  await writeFile(join(agentDir, "settings.json"), "x");
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "settings.json"), "x");
  expect(thrownMessage(() => readFromDisk(cwd, agentDir))).toContain("(+1 more)");
});

it("bounds a settings error with a long path to 512 bytes", async () => {
  const agentDir = join(await directory(), "a".repeat(200), "b".repeat(200), "c".repeat(200));
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "x");
  expect(Buffer.byteLength(join(agentDir, "settings.json"))).toBeGreaterThan(512);
  const cwd = await directory();
  const message = thrownMessage(() => readFromDisk(cwd, agentDir));
  expect(message).toContain("Pi settings could not be read: /");
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(512);
});

it.each(["node", "./x"])("rejects command %s through direct shared writes", async (command) => {
  const manager = SettingsManager.inMemory({});
  await expect(
    lspSettings.writeSettings(
      manager,
      "global",
      {
        action: "set",
        key: "servers",
        patch: { servers: { typescript: { command, args: [] } } },
      },
      () => true,
    ),
  ).rejects.toThrow(/absolute/);
  expect(manager.getGlobalSettings()).toEqual({});
});

it("validates a display name before appending a session override", async () => {
  const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>();
  await expect(
    lspSettings.writeChange(
      { appendEntry },
      {
        settingsManager: SettingsManager.inMemory({}),
        sessionManager: { getBranch: () => [] },
      },
      "session",
      { action: "set", key: "name", patch: { name: " bad" } },
      () => true,
    ),
  ).rejects.toThrow(/whitespace/);
  expect(appendEntry).not.toHaveBeenCalled();
});

it("starts disabled without executable approval", () => {
  expect(readSettings(undefined, undefined, false)).toEqual({
    enabled: false,
    name: "HL LSP",
    allowProjectExecution: false,
    timeoutMs: 5000,
    formatOnWrite: false,
    servers: {},
  });
});

it("accepts explicit global launch policy and trusted presentation overrides", () => {
  const servers = {
    typescript: {
      command: "/usr/local/bin/typescript-language-server",
      args: ["--stdio"],
    },
  };
  expect(
    readSettings(
      {
        enabled: true,
        servers,
        allowProjectExecution: true,
        formatOnWrite: true,
      },
      { name: "Language tools" },
      true,
    ),
  ).toEqual({
    enabled: true,
    name: "Language tools",
    allowProjectExecution: true,
    timeoutMs: 5000,
    formatOnWrite: true,
    servers,
  });
});

it("does not let project settings authorize executable launch", () => {
  expect(() => readSettings({}, { servers: {} }, true)).toThrow(/project/);
  expect(() => readSettings({}, { allowProjectExecution: true }, true)).toThrow(/project/);
  expect(() => readSettings({}, { formatOnWrite: true }, true)).toThrow(/project/);
});

it("ignores untrusted project settings entirely", () => {
  expect(readSettings({}, { enabled: true, servers: { arbitrary: "bad" } }, false).enabled).toBe(
    false,
  );
});

it("rejects malformed global settings and excessive budgets", () => {
  for (const value of [
    null,
    [],
    { enabled: "yes" },
    { timeoutMs: 0 },
    { timeoutMs: 60001 },
    { formatOnWrite: "yes" },
    { unknown: true },
  ]) {
    expect(() => readSettings(value, undefined, false)).toThrow(/global/);
  }
});

it("accepts a custom server with its file types and root markers", () => {
  const server = {
    command: "/usr/local/bin/mylsp",
    args: ["--stdio"],
    fileTypes: [".foo"],
    rootMarkers: ["project.foo-root", "*.foo-project"],
  };
  expect(readSettings({ servers: { mylsp: server } }, undefined, false).servers).toEqual({
    mylsp: server,
  });
});

it("accepts dependency directory names and refuses paths or patterns", () => {
  const server = {
    command: "/usr/local/bin/vue-ls",
    args: [],
    fileTypes: [".vue"],
    rootMarkers: ["package.json"],
    dependencyDirs: ["node_modules"],
  };
  expect(readSettings({ servers: { vue: server } }, undefined, false).servers).toEqual({
    vue: server,
  });
  for (const name of ["a/b", "*.deps", ""])
    expect(() =>
      readSettings({ servers: { vue: { ...server, dependencyDirs: [name] } } }, undefined, false),
    ).toThrow(/global/);
});

it("refuses a custom server that omits its file types or root markers", () => {
  const command = "/usr/local/bin/mylsp";
  expect(() =>
    readSettings({ servers: { mylsp: { command, args: [] } } }, undefined, false),
  ).toThrow('Custom server "mylsp" needs fileTypes and rootMarkers');
});

it("refuses two servers that claim one file type and names both", () => {
  expect(() =>
    readSettings(
      {
        servers: {
          typescript: { command: "/usr/bin/ts-ls", args: [] },
          mylsp: {
            command: "/usr/bin/mylsp",
            args: [],
            fileTypes: [".ts"],
            rootMarkers: ["tsconfig.json"],
          },
        },
      },
      undefined,
      false,
    ),
  ).toThrow('Servers "typescript" and "mylsp" both claim ".ts"');
});

it("refuses server names outside the lowercase name pattern and more than 32 servers", () => {
  const custom = {
    command: "/usr/bin/mylsp",
    args: [],
    fileTypes: [".foo"],
    rootMarkers: ["a"],
  };
  expect(() => readSettings({ servers: { Bad_Name: custom } }, undefined, false)).toThrow(/global/);
  const many = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`server-${index}`, custom]),
  );
  expect(() => readSettings({ servers: many }, undefined, false)).toThrow(/global/);
});

it("rejects relative executables and control characters in names", () => {
  expect(() =>
    readSettings({ servers: { python: { command: "./server", args: [] } } }, undefined, false),
  ).toThrow(/absolute/);
  expect(() => readSettings({ name: "Bad\nname" }, undefined, false)).toThrow(/global/);
});
