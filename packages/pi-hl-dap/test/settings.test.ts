import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

import { readSettings } from "../src/settings.js";
import type { DapSettingsDocumentInput } from "../src/settings.js";

const temporaryDirectories: string[] = [];

type TestJsonObject = { readonly [key: string]: TestJsonValue };
type TestJsonValue = null | boolean | number | string | readonly TestJsonValue[] | TestJsonObject;

async function createSettingsReader(
  globalSettings: DapSettingsDocumentInput,
  projectSettings: DapSettingsDocumentInput,
  projectTrusted = true,
): Promise<SettingsManager> {
  const cwd = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-settings-project-"));
  const agentDirectory = await mkdtemp(resolve(tmpdir(), "pi-hl-dap-settings-agent-"));
  temporaryDirectories.push(cwd, agentDirectory);
  await mkdir(resolve(cwd, ".pi"), { recursive: true });
  await writeFile(resolve(agentDirectory, "settings.json"), JSON.stringify(globalSettings));
  await writeFile(resolve(cwd, ".pi/settings.json"), JSON.stringify(projectSettings));
  return SettingsManager.create(cwd, agentDirectory, { projectTrusted });
}

function stdioAdapter(command: string) {
  return { command, transport: "stdio" };
}

function tcpAdapter(command: string) {
  return { command, transport: { type: "tcp" } };
}

function launchProfile(adapter: string, argumentsValue: TestJsonObject = {}) {
  return { adapter, arguments: argumentsValue };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("readSettings", () => {
  test("excludes project settings through an untrusted SettingsManager", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: { global: stdioAdapter("global-adapter") },
            profiles: { global: launchProfile("global") },
          },
        },
        {
          hlDap: {
            adapters: { project: stdioAdapter("project-adapter") },
            profiles: { project: launchProfile("project") },
          },
        },
        false,
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["global"]);
    expect([...settings.profiles.keys()]).toEqual(["global"]);
  });

  test("merges timeout fields from global and trusted project settings", async () => {
    const settings = readSettings(
      await createSettingsReader(
        { hlDap: { timeouts: { requestMs: 100, startupMs: 200 } } },
        { hlDap: { timeouts: { executionMs: 300, requestMs: 400 } } },
      ),
    );

    expect(settings.timeouts).toEqual({
      executionMs: 300,
      requestMs: 400,
      shutdownMs: 5_000,
      startupMs: 200,
    });
  });

  test("replaces complete map entries and removes inherited adapters and profiles", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: {
              deleted: stdioAdapter("delete-me"),
              replaced: { ...stdioAdapter("global-adapter"), args: ["global"] },
            },
            profiles: {
              deleted: launchProfile("deleted"),
              replaced: launchProfile("replaced", { global: true }),
            },
          },
        },
        {
          hlDap: {
            adapters: {
              deleted: null,
              replaced: tcpAdapter("project-adapter"),
            },
            profiles: {
              deleted: null,
              replaced: launchProfile("replaced", { project: true }),
            },
          },
        },
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["replaced"]);
    expect(settings.adapters.get("replaced")).toMatchObject({
      args: [],
      command: "project-adapter",
      id: "replaced",
      transport: { host: "127.0.0.1", port: 0, type: "tcp" },
    });
    expect([...settings.profiles]).toEqual([
      [
        "replaced",
        {
          adapterId: "replaced",
          arguments: { project: true },
          id: "replaced",
        },
      ],
    ]);
  });

  test("quarantines an invalid project replacement instead of falling back to a global entry", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: {
              node: stdioAdapter("global-node"),
              valid: stdioAdapter("valid"),
            },
            profiles: {
              node: launchProfile("node"),
              valid: launchProfile("valid"),
            },
          },
        },
        {
          hlDap: {
            adapters: {
              node: { ...stdioAdapter("project-node"), unexpected: true },
            },
            profiles: {
              node: { ...launchProfile("valid"), unexpected: true },
            },
          },
        },
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["valid"]);
    expect([...settings.profiles.keys()]).toEqual(["valid"]);
    expect(settings.warnings).toEqual([
      expect.stringContaining("project hlDap.adapters.node.unexpected"),
      expect.stringContaining("project hlDap.profiles.node.unexpected"),
    ]);
  });

  test("quarantines invalid transports and rejects PORT substitution for stdio adapters", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: {
              badPort: {
                command: "adapter",
                transport: { type: "tcp", port: 65_536 },
              },
              missingCommand: { transport: "stdio" },
              stdioPort: {
                command: "adapter",
                args: ["--listen=$PORT"],
                transport: "stdio",
              },
              tcpPort: {
                command: "adapter",
                args: ["--listen=$PORT"],
                transport: { type: "tcp" },
              },
            },
            profiles: { tcp: launchProfile("tcpPort") },
          },
        },
        {},
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["tcpPort"]);
    expect(settings.adapters.get("tcpPort")?.args).toEqual(["--listen=$PORT"]);
    expect(settings.warnings).toEqual([
      expect.stringContaining("global hlDap.adapters.badPort.transport.port"),
      expect.stringContaining("global hlDap.adapters.missingCommand.command"),
      "global hlDap.adapters.stdioPort.args: $PORT requires TCP transport",
    ]);
  });

  test("quarantines profiles whose adapter is absent or invalid", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: {
              invalid: { command: "adapter", transport: { type: "udp" } },
              removed: stdioAdapter("adapter"),
              valid: stdioAdapter("valid-adapter"),
            },
            profiles: {
              invalid: launchProfile("invalid"),
              missing: launchProfile("missing"),
              removed: launchProfile("removed"),
              valid: launchProfile("valid"),
            },
          },
        },
        { hlDap: { adapters: { removed: null } } },
      ),
    );

    expect([...settings.profiles.keys()]).toEqual(["valid"]);
    expect(settings.warnings).toEqual([
      expect.stringContaining("global hlDap.adapters.invalid.transport"),
      'global hlDap.profiles.invalid.adapter: adapter "invalid" is not configured',
      'global hlDap.profiles.missing.adapter: adapter "missing" is not configured',
      'global hlDap.profiles.removed.adapter: adapter "removed" is not configured',
    ]);
  });

  test("reports strict path-qualified warnings while retaining unrelated valid entries", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: { valid: stdioAdapter("valid") },
            profiles: {
              invalidArguments: { adapter: "valid", arguments: [] },
              valid: launchProfile("valid", { nested: { enabled: true } }),
            },
            timeouts: { requestMs: -1, startupMs: 123, unknown: 1 },
            unknown: true,
          },
        },
        {},
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["valid"]);
    expect([...settings.profiles.keys()]).toEqual(["valid"]);
    expect(settings.timeouts.startupMs).toBe(123);
    expect(settings.timeouts.requestMs).toBe(10_000);
    expect(settings.warnings).toEqual([
      "global hlDap.unknown: unknown field",
      expect.stringContaining("global hlDap.profiles.invalidArguments.arguments"),
      expect.stringContaining("global hlDap.timeouts.requestMs"),
      "global hlDap.timeouts.unknown: unknown field",
    ]);
  });

  test("refuses a timeout Node timers would clamp to 1 ms", async () => {
    const settings = readSettings(
      await createSettingsReader(
        { hlDap: { timeouts: { executionMs: 2_147_483_648, shutdownMs: 2_147_483_647 } } },
        {},
      ),
    );

    expect(settings.timeouts.executionMs).toBe(30_000);
    expect(settings.timeouts.shutdownMs).toBe(2_147_483_647);
    expect(settings.warnings).toEqual([
      expect.stringContaining("global hlDap.timeouts.executionMs"),
    ]);
  });
});

describe("readSettings adapter presets", () => {
  test("resolves a preset's data into the Adapter Definition", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: { node: { ...tcpAdapter("node"), preset: "vscode-js-debug" } },
            profiles: { node: launchProfile("node") },
          },
        },
        {},
      ),
    );

    expect(settings.adapters.get("node")).toMatchObject({
      adapterID: "pwa-node",
      channels: {
        sessions: "promoted",
        firstSessionIsPrimary: true,
        targetIdKey: "__pendingTargetId",
      },
      outputExitReport: {
        category: "stderr",
        cleanExitCode: 0,
        onlyWhenArgument: {
          absentOrIn: { console: ["internalConsole"] },
          notIn: { outputCapture: ["std"] },
        },
      },
    });
  });

  test.each([
    [
      "debugpy",
      { adapterID: "python", channels: { sessions: "promoted", firstSessionIsPrimary: false } },
    ],
    ["lldb-dap", { adapterID: "lldb-dap" }],
  ])("resolves the %s preset only from data", async (preset, expected) => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: { adapter: { ...stdioAdapter("adapter"), preset } },
            profiles: { adapter: launchProfile("adapter") },
          },
        },
        {},
      ),
    );

    expect(settings.adapters.get("adapter")).toMatchObject(expected);
    expect(settings.adapters.get("adapter")?.outputExitReport).toBeUndefined();
  });

  test("merges the Adapter Definition's channel fields over the preset's", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: {
              node: {
                ...tcpAdapter("node"),
                channels: { sessions: "root", firstSessionIsPrimary: false },
                preset: "vscode-js-debug",
              },
            },
            profiles: { node: launchProfile("node") },
          },
        },
        {},
      ),
    );

    expect(settings.adapters.get("node")?.channels).toEqual({
      sessions: "root",
      firstSessionIsPrimary: false,
      targetIdKey: "__pendingTargetId",
    });
  });

  test("quarantines an Adapter Definition that names an unknown preset", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: {
              valid: stdioAdapter("valid"),
              unknown: { ...stdioAdapter("unknown"), preset: "not-packaged" },
            },
            profiles: { valid: launchProfile("valid") },
          },
        },
        {},
      ),
    );

    expect([...settings.adapters.keys()]).toEqual(["valid"]);
    expect(settings.warnings).toEqual([
      'global hlDap.adapters.unknown.preset: unknown adapter preset "not-packaged"',
    ]);
  });

  test("quarantines an Adapter Definition whose channels are invalid", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: {
              invalid: { ...stdioAdapter("invalid"), channels: { sessions: "children" } },
            },
          },
        },
        {},
      ),
    );

    expect(settings.adapters.size).toBe(0);
    expect(settings.warnings).toEqual([
      expect.stringContaining("global hlDap.adapters.invalid.channels.sessions"),
    ]);
  });

  test("keeps a valid Launch Profile adapterID and quarantines an empty one", async () => {
    const settings = readSettings(
      await createSettingsReader(
        {
          hlDap: {
            adapters: { node: stdioAdapter("node") },
            profiles: {
              empty: { ...launchProfile("node"), adapterID: "" },
              node: { ...launchProfile("node"), adapterID: "custom-adapter" },
            },
          },
        },
        {},
      ),
    );

    expect([...settings.profiles.keys()]).toEqual(["node"]);
    expect(settings.profiles.get("node")?.adapterID).toBe("custom-adapter");
    expect(settings.warnings).toEqual([
      expect.stringContaining("global hlDap.profiles.empty.adapterID"),
    ]);
  });
});
