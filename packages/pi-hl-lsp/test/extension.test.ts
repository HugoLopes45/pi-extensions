import { execFileSync } from "node:child_process";
import { chmod, mkdir, open, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { stringMatching } from "pi-hl-utils/testing/matchers";
import { createMenuTui, keys, menuDriver } from "pi-hl-utils/testing/menu-ui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it, onTestFinished, vi } from "vitest";

import { directory } from "./fixtures.js";

interface SessionOptions {
  allowProjectExecution?: boolean;
  formatOnWrite?: boolean;
  timeoutMs?: number;
  projectTrusted?: boolean;
  projectSettings?: (spawnLog: string) => unknown;
  // Runs the session from a symlink to the project, as on macOS where /tmp links to /private/tmp.
  linkedCwd?: boolean;
}

async function linkedDirectory() {
  const link = join(await directory(), "link");
  await symlink(await directory(), link);
  return link;
}

/** A protocol server that appends one line to `spawnLog` each time Pi launches it. */
function typescriptServer(mode: string, spawnLog: string) {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./protocol-server.ts", import.meta.url)), mode, spawnLog],
  };
}

async function session(enabled: boolean, mode = "normal", options: SessionOptions = {}) {
  const requests: string[][] = [];
  const errors: unknown[] = [];
  const onError = (error: unknown) => {
    errors.push(error);
  };
  expect(basename(homedir())).toMatch(/^pi-hl-lsp-tests-/u);
  const cwd = options.linkedCwd ? await linkedDirectory() : await directory();
  const agentDir = getAgentDir();
  const spawnLog = join(cwd, "spawns.log");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      "hl-lsp": {
        enabled,
        allowProjectExecution: options.allowProjectExecution ?? true,
        timeoutMs: options.timeoutMs ?? 5000,
        servers: { typescript: typescriptServer(mode, spawnLog) },
        ...(options.formatOnWrite === undefined ? {} : { formatOnWrite: options.formatOnWrite }),
      },
    }),
  );
  if (options.projectSettings) {
    await mkdir(join(cwd, ".pi"));
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify(options.projectSettings(spawnLog)),
    );
  }
  await writeFile(join(cwd, "tsconfig.json"), "{}");
  await writeFile(join(cwd, "index.ts"), "const value = 1;\n");
  const faux = fauxProvider({
    provider: "hl-lsp-offline",
    models: [{ id: "scripted" }],
  });
  const runtime = await createAgentSessionRuntime(
    async ({ sessionManager, sessionStartEvent }) => {
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        modelsStore: new InMemoryModelsStore(),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const settingsManager = SettingsManager.inMemory(
        {
          compaction: { enabled: false },
          retry: { enabled: false },
          cacheWarming: "off",
        },
        { projectTrusted: options.projectTrusted ?? true },
      );
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [
          fileURLToPath(new URL("../dist/index.js", import.meta.url)),
          fileURLToPath(new URL("./edit-tool.ts", import.meta.url)),
        ],
        // Undefined keeps Pi's default prompt, which lists tools that have a promptSnippet.
        systemPromptOverride: () => undefined,
      });
      await resourceLoader.reload();
      expect(resourceLoader.getExtensions().errors).toEqual([]);
      expect(resourceLoader.getExtensions().extensions).toHaveLength(2);
      const result = await createAgentSession({
        cwd,
        agentDir,
        sessionManager,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
        modelRuntime,
        settingsManager,
        resourceLoader,
        model: faux.getModel(),
        thinkingLevel: "off",
        noTools: "builtin",
      });
      result.session.agent.streamFunction = (model, context, options) => {
        requests.push(
          context.messages
            .filter((message) => message.role === "user")
            .flatMap((message) =>
              typeof message.content === "string"
                ? [message.content]
                : message.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text),
            ),
        );
        return faux.provider.streamSimple(model, context, options);
      };
      return {
        ...result,
        services: {
          cwd,
          agentDir,
          modelRuntime,
          settingsManager,
          resourceLoader,
          diagnostics: [],
        },
        diagnostics: [],
      };
    },
    { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
  );
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    await runtime.dispose();
    disposed = true;
  };
  onTestFinished(async () => {
    await dispose();
    expect(errors).toEqual([]);
  });
  runtime.setRebindSession((current) => current.bindExtensions({ mode: "print", onError }));
  await runtime.session.bindExtensions({ mode: "print", onError });
  return { runtime, faux, requests, spawnLog, agentDir, cwd, dispose };
}

async function tool(
  state: Awaited<ReturnType<typeof session>>,
  name: string,
  args: Parameters<typeof fauxToolCall>[1],
) {
  state.faux.setResponses([
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await state.runtime.session.sendCustomMessage(
    { customType: "test", content: "inspect", display: false },
    { triggerTurn: true },
  );
  return state.runtime.session.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === name,
  );
}

async function hover(state: Awaited<ReturnType<typeof session>>) {
  return tool(state, "hl_lsp_hover", {
    file: "index.ts",
    line: 1,
    column: 7,
  });
}

it.each(["reload", "newSession", "dispose"] as const)(
  "stops the real server process on %s",
  async (action) => {
    const state = await session(true);
    expect(await hover(state)).toMatchObject({
      details: { outcome: "completed" },
    });
    const pid = Number((await readFile(state.spawnLog, "utf8")).trim());
    expect(() => process.kill(pid, 0)).not.toThrow();
    if (action === "reload") await state.runtime.session.reload();
    else if (action === "dispose") await state.dispose();
    else await state.runtime.newSession();
    expect(() => process.kill(pid, 0)).toThrow("kill ESRCH");
  },
);

it("does not accumulate live servers across repeated native reloads", async () => {
  const state = await session(true);
  for (let cycle = 0; cycle < 2; cycle++) {
    expect(await hover(state)).toMatchObject({
      details: { outcome: "completed" },
    });
    const pids = (await readFile(state.spawnLog, "utf8")).trim().split("\n").map(Number);
    expect(pids).toHaveLength(cycle + 1);
    await state.runtime.session.reload();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow("kill ESRCH");
  }
});

it("stops the real server when a session is forked", async () => {
  const state = await session(true);
  const entryId = state.runtime.session.sessionManager.appendMessage({
    role: "user",
    content: "Fork origin",
    timestamp: Date.now(),
  });
  expect(await hover(state)).toMatchObject({
    details: { outcome: "completed" },
  });
  const pid = Number((await readFile(state.spawnLog, "utf8")).trim());
  await state.runtime.fork(entryId);
  expect(() => process.kill(pid, 0)).toThrow("kill ESRCH");
});

it("preserves global launch policy when enablement inherits", async () => {
  const state = await session(true);
  await state.runtime.session.prompt("/hl-lsp inherit enabled --global");
  const stored: unknown = JSON.parse(await readFile(join(state.agentDir, "settings.json"), "utf8"));
  expect(stored).toEqual({
    "hl-lsp": {
      allowProjectExecution: true,
      timeoutMs: 5000,
      servers: { typescript: typescriptServer("normal", state.spawnLog) },
    },
  });
  expect(await hover(state)).toMatchObject({ details: { outcome: "blocked" } });
});

it("reloads externally changed settings through the native SDK reload", async () => {
  const state = await session(false);
  expect(await hover(state)).toMatchObject({ details: { outcome: "blocked" } });
  await writeFile(
    join(state.agentDir, "settings.json"),
    JSON.stringify({
      "hl-lsp": {
        enabled: true,
        allowProjectExecution: true,
        servers: { typescript: typescriptServer("normal", state.spawnLog) },
      },
    }),
  );
  await state.runtime.session.reload();
  expect(await hover(state)).toMatchObject({
    details: { outcome: "completed" },
  });
});

it("shows launch policy only in the global menu scope", async () => {
  initTheme("dark");
  const { runtime } = await session(false);
  const screens: string[] = [];
  const ui = runtime.session.extensionRunner.getUIContext();
  await runtime.session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...ui,
      custom: (factory) =>
        new Promise((resolve) => {
          const { tui, keybindings } = createMenuTui();
          void Promise.resolve(factory(tui, ui.theme, keybindings, resolve)).then((component) => {
            const driver = menuDriver(() => component);
            screens.push(driver.screen());
            driver.press(keys.enter);
            screens.push(driver.screen());
            driver.press(keys.enter);
            screens.push(driver.screen());
            driver.press(keys.escape);
          });
        }),
    },
  });
  await runtime.session.prompt("/hl-lsp");
  expect(screens).toHaveLength(3);
  for (const screen of screens.slice(0, 2)) {
    expect(screen).toContain("enabled");
    expect(screen).toContain("name");
    expect(screen).not.toMatch(/timeoutMs|allowProjectExecution/);
  }
  expect(screens[2]).toContain("timeoutMs");
  expect(screens[2]).toContain("allowProjectExecution");
  for (const screen of screens) expect(screen).not.toContain("servers");
});

it("never writes to the footer status", async () => {
  initTheme("dark");
  const { runtime } = await session(false);
  const ui = runtime.session.extensionRunner.getUIContext();
  const statuses: Parameters<typeof ui.setStatus>[] = [];
  await runtime.session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...ui,
      setStatus: (...args) => {
        statuses.push(args);
      },
      custom: (factory) =>
        new Promise((resolve) => {
          const { tui, keybindings } = createMenuTui();
          void Promise.resolve(factory(tui, ui.theme, keybindings, resolve)).then((component) =>
            menuDriver(() => component).press(keys.escape),
          );
        }),
    },
  });
  await runtime.session.prompt("/hl-lsp");
  expect(statuses).toEqual([]);
});

/** A Python project whose `.venv` holds a server script; `body` is the script after the shebang. */
async function pythonProject(cwd: string, body: string): Promise<string> {
  await writeFile(join(cwd, "pyproject.toml"), '[project]\nname = "demo"\n');
  const bin = join(cwd, ".venv", "bin");
  await mkdir(bin, { recursive: true });
  const server = join(bin, "basedpyright-langserver");
  await writeFile(server, `#!/bin/sh\n${body}\n`);
  await chmod(server, 0o755);
  return server;
}

function pythonProtocolServer(cwd: string): string {
  const script = fileURLToPath(new URL("./protocol-server.ts", import.meta.url));
  return `exec "${process.execPath}" "${script}" normal "${join(cwd, "python-spawns.log")}"`;
}

type Driver = ReturnType<typeof menuDriver>;

/** Rebind in TUI mode, which starts the session again; each opened dialog is driven by `drive`. */
async function startTui(
  runtime: Awaited<ReturnType<typeof session>>["runtime"],
  drive: (driver: Driver) => Promise<void>,
) {
  const ui = runtime.session.extensionRunner.getUIContext();
  const dialogs: Promise<void>[] = [];
  const notifications: Parameters<typeof ui.notify>[] = [];
  const bind = () =>
    runtime.session.bindExtensions({
      mode: "tui",
      uiContext: {
        ...ui,
        notify: (...args) => {
          notifications.push(args);
        },
        custom: (factory) =>
          new Promise((resolve) => {
            const { tui, keybindings } = createMenuTui();
            const component = Promise.resolve(factory(tui, ui.theme, keybindings, resolve));
            dialogs.push(component.then((shown) => drive(menuDriver(() => shown))));
          }),
      },
    });
  await bind();
  return { dialogs, notifications, bind };
}

async function globalLsp(agentDir: string): Promise<unknown> {
  const settings: unknown = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  return Value.Check(Type.Object({ "hl-lsp": Type.Unknown() }), settings)
    ? settings["hl-lsp"]
    : undefined;
}

it("offers a new language at startup and saves the server the user enables with consent", async () => {
  initTheme("dark");
  const { runtime, cwd, agentDir } = await session(false, "normal", {
    allowProjectExecution: false,
  });
  const server = await pythonProject(cwd, pythonProtocolServer(cwd));
  const screens: string[] = [];
  const { dialogs } = await startTui(runtime, async (driver) => {
    screens.push(driver.screen());
    driver.goTo("Allow project code");
    driver.press(keys.enter);
    driver.goTo("Enable");
    driver.press(keys.enter);
    await vi.waitFor(() => expect(driver.screen()).toContain("python: ready"), {
      timeout: 10_000,
    });
    driver.press(keys.escape);
  });
  expect(dialogs).toHaveLength(1);
  await Promise.all(dialogs);
  expect(screens[0]).toContain("Language servers for this project");
  expect(screens[0]?.replaceAll(/\s*\n\s*/gu, "")).toContain(`${server} for .py files`);
  await vi.waitFor(
    async () =>
      expect(await globalLsp(agentDir)).toMatchObject({
        enabled: true,
        allowProjectExecution: true,
        servers: {
          typescript: { command: process.execPath },
          python: { command: server, args: ["--stdio"] },
        },
      }),
    { timeout: 10_000 },
  );
});

it("remembers a dismissed language until /hl-lsp-setup reopens it", async () => {
  initTheme("dark");
  const { runtime, cwd, agentDir } = await session(false);
  await pythonProject(cwd, pythonProtocolServer(cwd));
  const { dialogs, bind } = await startTui(runtime, async (driver) => {
    driver.press(keys.escape);
  });
  expect(dialogs).toHaveLength(1);
  await Promise.all(dialogs);
  await vi.waitFor(async () =>
    expect(await globalLsp(agentDir)).toMatchObject({
      ignoredLanguages: ["python"],
    }),
  );
  await bind();
  expect(dialogs).toHaveLength(1);
  await runtime.session.prompt("/hl-lsp-setup");
  expect(dialogs).toHaveLength(2);
});

it("neither saves nor hides a server that fails its handshake", async () => {
  initTheme("dark");
  const { runtime, cwd, agentDir } = await session(false);
  await pythonProject(cwd, "exit 1");
  const { dialogs, bind } = await startTui(runtime, async (driver) => {
    driver.goTo("Enable");
    driver.press(keys.enter);
    await vi.waitFor(() => expect(driver.screen()).toContain("python: failed"), {
      timeout: 10_000,
    });
    driver.press(keys.escape);
  });
  await Promise.all(dialogs);
  const settings = await globalLsp(agentDir);
  expect(settings).not.toHaveProperty("ignoredLanguages");
  expect(settings).not.toHaveProperty("servers.python");
  await bind();
  expect(dialogs).toHaveLength(2);
});

it("drops the answers of a dialog whose session was replaced while it was open", async () => {
  initTheme("dark");
  const { runtime, cwd, agentDir } = await session(false);
  await pythonProject(cwd, pythonProtocolServer(cwd));
  const before = await readFile(join(agentDir, "settings.json"), "utf8");
  const drivers: Driver[] = [];
  const { dialogs, bind } = await startTui(runtime, async (driver) => {
    drivers.push(driver);
  });
  await bind();
  expect(dialogs).toHaveLength(2);
  await Promise.all(dialogs);
  drivers[0]?.press(keys.escape);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe(before);
  drivers[1]?.press(keys.escape);
  await vi.waitFor(async () =>
    expect(await globalLsp(agentDir)).toMatchObject({
      ignoredLanguages: ["python"],
    }),
  );
});

it("offers no setup in an untrusted project", async () => {
  initTheme("dark");
  const { runtime, cwd } = await session(false, "normal", {
    projectTrusted: false,
  });
  await pythonProject(cwd, pythonProtocolServer(cwd));
  const { dialogs, notifications } = await startTui(runtime, async (driver) => {
    driver.press(keys.escape);
  });
  await runtime.session.prompt("/hl-lsp-setup");
  expect(dialogs).toHaveLength(0);
  expect(notifications).toContainEqual([stringMatching(/^Trust /u), "warning"]);
});

it("shows status through Pi UI without adding model or session context", async () => {
  const { runtime } = await session(false);
  const ui = runtime.session.extensionRunner.getUIContext();
  const notifications: Parameters<typeof ui.notify>[] = [];
  await runtime.session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...ui,
      notify: (...args) => {
        notifications.push(args);
      },
    },
  });
  const messages = structuredClone(runtime.session.messages);
  const branch = runtime.session.sessionManager.getBranch();
  await runtime.session.prompt("/hl-lsp status");
  expect(runtime.session.messages).toEqual(messages);
  expect(runtime.session.sessionManager.getBranch()).toEqual(branch);
  expect(notifications).toEqual([[stringMatching(/"enabled": false/u), "info"]]);
});

it("persists a session display name through the shared set command", async () => {
  const { runtime, agentDir } = await session(false);
  const path = join(agentDir, "settings.json");
  async function readState() {
    const handle = await open(path, "r");
    try {
      return {
        content: await handle.readFile("utf8"),
        modified: (await handle.stat({ bigint: true })).mtimeNs,
      };
    } finally {
      await handle.close();
    }
  }
  const before = await readState();
  await runtime.session.prompt('/hl-lsp set name "Language tools"');
  const after = await readState();
  expect(after.content).toBe(before.content);
  expect(after.modified).toBe(before.modified);
  expect(runtime.session.sessionManager.getBranch().at(-1)).toMatchObject({
    type: "custom",
    customType: "hl-lsp-settings",
    data: { version: 1, overrides: { name: "Language tools" } },
  });
});

it("removes a session enable with inherit", async () => {
  const state = await session(false);
  await state.runtime.session.prompt("/hl-lsp on");
  expect(await hover(state)).toMatchObject({
    details: { outcome: "completed" },
  });
  await state.runtime.session.prompt("/hl-lsp inherit");
  expect(await hover(state)).toMatchObject({ details: { outcome: "blocked" } });
});

it("writes a global enable through the shared command", async () => {
  const state = await session(false);
  await state.runtime.session.prompt("/hl-lsp on --global");
  const stored: unknown = JSON.parse(await readFile(join(state.agentDir, "settings.json"), "utf8"));
  expect(stored).toMatchObject({ "hl-lsp": { enabled: true } });
  expect(await hover(state)).toMatchObject({
    details: { outcome: "completed" },
  });
});

it("rejects a relative server command before writing global settings", async () => {
  const state = await session(false);
  const path = join(state.agentDir, "settings.json");
  const before = await readFile(path, "utf8");
  await state.runtime.session.prompt(
    '/hl-lsp set servers {"typescript":{"command":"./server","args":[]}} --global',
  );
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await hover(state)).toMatchObject({ details: { outcome: "blocked" } });
});

it("keeps Pi usable after malformed global settings are reloaded", async () => {
  const state = await session(true);
  await writeFile(join(state.agentDir, "settings.json"), "{");
  await state.runtime.session.reload();
  expect(await hover(state)).toMatchObject({
    details: { outcome: "unavailable" },
  });
  expect(state.runtime.session.messages.at(-1)).toMatchObject({
    role: "assistant",
  });
  await expect(readFile(state.spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("loads the real extension through Pi and executes its registered tool offline", async () => {
  const { runtime, faux } = await session(true);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hl_lsp_hover", { file: "index.ts", line: 1, column: 7 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await runtime.session.sendCustomMessage(
    { customType: "test", content: "inspect", display: false },
    { triggerTurn: true },
  );
  const result = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "hl_lsp_hover",
  );
  expect(result).toMatchObject({
    details: {
      outcome: "completed",
      server: "typescript",
      source: "untrusted_lsp",
    },
  });
  expect(faux.state.callCount).toBe(2);
});

it("returns compact definition text with source lines, a duplicate and an outside location", async () => {
  const state = await session(true, "navigation");
  expect(
    await tool(state, "hl_lsp_definition", {
      file: "index.ts",
      line: 1,
      column: 7,
    }),
  ).toMatchObject({
    isError: false,
    content: [
      {
        type: "text",
        text: "hl-lsp definition index.ts: completed\nindex.ts:1:7  const value = 1;\n/outside/elsewhere.ts:3:1",
      },
    ],
    details: { outcome: "completed" },
  });
});

it("returns type definition and implementation locations as definition does", async () => {
  const state = await session(true, "type-navigation");
  expect(
    await tool(state, "hl_lsp_type_definition", {
      file: "index.ts",
      line: 1,
      column: 7,
    }),
  ).toMatchObject({
    isError: false,
    content: [
      {
        type: "text",
        text: "hl-lsp type_definition index.ts: completed\nindex.ts:1:7  const value = 1;",
      },
    ],
    details: { outcome: "completed" },
  });
  expect(
    await tool(state, "hl_lsp_implementation", {
      file: "index.ts",
      line: 1,
      column: 7,
    }),
  ).toMatchObject({
    isError: false,
    content: [
      {
        type: "text",
        text: "hl-lsp implementation index.ts: completed\nimpl.ts:3:1",
      },
    ],
    details: { outcome: "completed" },
  });
});

it("returns an error result for a malformed definition reply", async () => {
  const state = await session(true, "malformed-definition");
  expect(
    await tool(state, "hl_lsp_definition", {
      file: "index.ts",
      line: 1,
      column: 7,
    }),
  ).toMatchObject({
    isError: true,
    content: [
      {
        type: "text",
        text: "hl-lsp definition index.ts: failed\nUnexpected LSP definition response shape",
      },
    ],
  });
});

it("keeps a bounded leading part of an oversized single-line error reason", async () => {
  const { runtime, faux } = await session(true, "long-error");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hl_lsp_hover", { file: "index.ts", line: 1, column: 7 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await runtime.session.sendCustomMessage(
    { customType: "test", content: "inspect", display: false },
    { triggerTurn: true },
  );
  const result = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "hl_lsp_hover",
  );
  expect(result).toMatchObject({
    details: {
      outcome: "failed",
      truncated: true,
      reason: stringMatching(/^z{100}/u),
    },
  });
});

it("shows the header path relative to the session cwd when the file is inside it", async () => {
  const state = await session(true);
  expect(
    await tool(state, "hl_lsp_hover", {
      file: join(state.cwd, "index.ts"),
      line: 1,
      column: 7,
    }),
  ).toMatchObject({
    content: [
      {
        type: "text",
        text: stringMatching(/^hl-lsp hover index\.ts: completed\n/u),
      },
    ],
  });
});

it("shows the header path absolute when the file is outside the session cwd", async () => {
  const state = await session(true);
  const outside = join(state.cwd, "..", "outside.ts");
  expect(
    await tool(state, "hl_lsp_hover", {
      file: outside,
      line: 1,
      column: 7,
    }),
  ).toMatchObject({
    content: [
      {
        type: "text",
        text: `hl-lsp hover ${outside}: unavailable\nFile does not exist`,
      },
    ],
  });
});

it("finds a symbol by name through the workspace symbols tool", async () => {
  const state = await session(true, "workspace-symbols");
  expect(
    await tool(state, "hl_lsp_workspace_symbols", {
      file: "index.ts",
      query: "value",
    }),
  ).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
    content: [
      {
        type: "text",
        text: "hl-lsp workspace_symbols index.ts: completed\nvariable value  index.ts:1:7  const value = 1;",
      },
    ],
  });
});

it("reports a malformed workspace symbol response as an error", async () => {
  const state = await session(true, "workspace-symbols");
  expect(
    await tool(state, "hl_lsp_workspace_symbols", {
      file: "index.ts",
      query: "bogus",
    }),
  ).toMatchObject({ isError: true, details: { outcome: "failed" } });
});

it("rejects an empty workspace symbol query before any server launch", async () => {
  const state = await session(true, "workspace-symbols");
  const result = await tool(state, "hl_lsp_workspace_symbols", {
    file: "index.ts",
    query: "",
  });
  expect(result).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).toContain("query");
  await expect(readFile(state.spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("tells how to set up each detected language that has no server configured", async () => {
  vi.stubEnv("PATH", await directory());
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const state = await session(true);
  const server = await pythonProject(state.cwd, "exit 1");
  await writeFile(join(state.cwd, "Cargo.toml"), '[package]\nname = "demo"\n');
  const result = await tool(state, "hl_lsp_status", {});
  expect(result).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
  });
  const text = JSON.stringify(result);
  expect(text).toContain(
    JSON.stringify(
      `python: not configured; ${server} is installed: ask the user to run /hl-lsp-setup`,
    ).slice(1, -1),
  );
  expect(text).toContain(
    "rust: not configured; none is installed: install one (rustup component add rust-analyzer), then ask the user to run /hl-lsp-setup",
  );
  // Swift is not detected here, so its line carries no setup hint.
  expect(text).toContain('\\nswift: not configured"');
});

it("reports server state and supported tools, and starts no server for it", async () => {
  const state = await session(true);
  expect(await tool(state, "hl_lsp_status", {})).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
    content: [
      {
        type: "text",
        text: "hl-lsp status: completed\ntypescript: not started\npython: not configured\nrust: not configured\nswift: not configured",
      },
    ],
  });
  await expect(readFile(state.spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await hover(state)).toMatchObject({
    details: { outcome: "completed" },
  });
  expect(await tool(state, "hl_lsp_status", {})).toMatchObject({
    content: [
      {
        type: "text",
        text: stringMatching(
          /^hl-lsp status: completed\ntypescript: running root=.+ open=1 tools=hover diagnostics\npython: not configured\nrust: not configured\nswift: not configured$/u,
        ),
      },
    ],
  });
});

it("restarts one server key on reload so the next call starts a fresh process", async () => {
  const state = await session(true);
  expect(await hover(state)).toMatchObject({
    details: { outcome: "completed" },
  });
  const pid = Number((await readFile(state.spawnLog, "utf8")).trim());
  expect(await tool(state, "hl_lsp_reload", { server: "typescript" })).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
    content: [
      {
        type: "text",
        text: "hl-lsp reload typescript: completed\nstopped 1 server instance",
      },
    ],
  });
  expect(() => process.kill(pid, 0)).toThrow("kill ESRCH");
  expect(await hover(state)).toMatchObject({
    details: { outcome: "completed" },
  });
  expect((await readFile(state.spawnLog, "utf8")).trim().split("\n")).toHaveLength(2);
});

it("refuses an unknown server key on reload and lists the configured keys", async () => {
  const state = await session(true);
  expect(await tool(state, "hl_lsp_reload", { server: "rust" })).toMatchObject({
    isError: true,
    content: [
      {
        type: "text",
        text: 'hl-lsp reload rust: unavailable\nUnknown server "rust"; configured servers: typescript',
      },
    ],
  });
});

it("refuses status and reload through the gate while LSP is off", async () => {
  const state = await session(false);
  expect(await tool(state, "hl_lsp_status", {})).toMatchObject({
    isError: true,
    details: { outcome: "blocked" },
  });
  expect(await tool(state, "hl_lsp_reload", { server: "typescript" })).toMatchObject({
    isError: true,
    details: { outcome: "blocked" },
  });
});

it("reports a server that exited as failed, with its reason, in status", async () => {
  const state = await session(true, "exit-after-init");
  expect(await hover(state)).toMatchObject({ details: { outcome: "failed" } });
  expect(await tool(state, "hl_lsp_status", {})).toMatchObject({
    content: [
      {
        type: "text",
        text: stringMatching(
          /^hl-lsp status: completed\ntypescript: failed \((?:LSP connection closed|LSP process exited \(3\)[^\n]*)\) root=.+ open=1 tools=hover diagnostics\npython: not configured\nrust: not configured\nswift: not configured$/u,
        ),
      },
    ],
  });
});

// Two files hold the symbol: index.ts defines it and other.ts imports it.
async function renameSession(mode: string) {
  const state = await session(true, mode);
  await writeFile(join(state.cwd, "other.ts"), 'import { value } from "./index";\n');
  return state;
}

function rename(state: Awaited<ReturnType<typeof session>>) {
  return tool(state, "hl_lsp_rename", {
    file: "index.ts",
    line: 1,
    symbol: "value",
    new_name: "renamed",
  });
}

it.each(["rename-changes", "rename-versioned"])(
  "renames the symbol in every file of the workspace edit (%s)",
  async (mode) => {
    const state = await renameSession(mode);
    expect(await rename(state)).toMatchObject({
      isError: false,
      details: { outcome: "completed" },
      content: [
        {
          type: "text",
          text: "hl-lsp rename index.ts: completed\nindex.ts: 1 edits\nother.ts: 1 edits\ntotal: 2 edits in 2 files",
        },
      ],
    });
    expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("const renamed = 1;\n");
    expect(await readFile(join(state.cwd, "other.ts"), "utf8")).toBe(
      'import { renamed } from "./index";\n',
    );
  },
);

it("names renamed files relative to a symlinked session cwd", async () => {
  const state = await session(true, "rename-changes", { linkedCwd: true });
  await writeFile(join(state.cwd, "other.ts"), 'import { value } from "./index";\n');
  expect(await rename(state)).toMatchObject({
    content: [
      {
        type: "text",
        text: "hl-lsp rename index.ts: completed\nindex.ts: 1 edits\nother.ts: 1 edits\ntotal: 2 edits in 2 files",
      },
    ],
  });
});

it("checks every file a rename changed for errors", async () => {
  const state = await renameSession("rename-errors");
  const note = (file: string) =>
    `hl-lsp: 1 error in ${file}; no check ran before this edit, so it may be older\n1:1 error 2322 Untrusted diagnostic prose`;
  expect(
    await tool(state, "hl_lsp_rename", {
      file: "index.ts",
      line: 1,
      symbol: "value",
      new_name: "ERROR",
    }),
  ).toMatchObject({
    content: [
      {
        type: "text",
        text: "hl-lsp rename index.ts: completed\nindex.ts: 1 edits\nother.ts: 1 edits\ntotal: 2 edits in 2 files",
      },
      { type: "text", text: note("index.ts") },
      { type: "text", text: note("other.ts") },
    ],
  });
});

it("reports a written rename as completed when the server cannot be updated", async () => {
  const state = await renameSession("rename-huge");
  expect(await rename(state)).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
    content: [
      {
        type: "text",
        text: "hl-lsp rename index.ts: completed\nindex.ts: 1 edits\ntotal: 1 edits in 1 files\nthe server was not updated: File exceeds the 1 MiB snapshot limit",
      },
      {
        type: "text",
        text: "hl-lsp: index.ts was not checked for errors: File exceeds the 1 MiB snapshot limit",
      },
    ],
  });
});

it("checks at most ten changed files and counts the rest", async () => {
  const state = await renameSession("rename-many");
  for (let index = 0; index < 11; index += 1)
    await writeFile(join(state.cwd, `other${index}.ts`), 'import { value } from "./index";\n');
  const result = await rename(state);
  expect(result).toMatchObject({ details: { outcome: "completed" } });
  expect(JSON.stringify(result)).toContain(
    "hl-lsp: 2 more changed files were not checked for errors",
  );
});

it.each([
  ["rename-prepare-null", "Rename is not available at this position"],
  ["rename-stale", "is stale"],
  ["rename-overlap", "overlap"],
  ["rename-resource", "resource operation"],
])("refuses a rename without writing any file (%s)", async (mode, reason) => {
  const state = await renameSession(mode);
  const result = await rename(state);
  expect(result).toMatchObject({
    isError: true,
    details: { outcome: "refused" },
  });
  expect(JSON.stringify(result)).toContain(reason);
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("const value = 1;\n");
  expect(await readFile(join(state.cwd, "other.ts"), "utf8")).toBe(
    'import { value } from "./index";\n',
  );
});

it("refuses a rename that targets a file outside the project and writes no file", async () => {
  const state = await renameSession("rename-outside");
  const outside = join(dirname(state.cwd), `outside-${basename(state.cwd)}.ts`);
  await writeFile(outside, "keep\n");
  const result = await rename(state);
  expect(result).toMatchObject({
    isError: true,
    details: { outcome: "refused" },
  });
  expect(JSON.stringify(result)).toContain("outside the project");
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("const value = 1;\n");
  expect(await readFile(outside, "utf8")).toBe("keep\n");
});

it("refuses a rename of a read-only file before writing any file", async () => {
  const state = await renameSession("rename-changes");
  await chmod(join(state.cwd, "other.ts"), 0o444);
  const result = await rename(state);
  expect(result).toMatchObject({
    isError: true,
    details: { outcome: "refused" },
  });
  expect(JSON.stringify(result)).toContain("other.ts is read-only");
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("const value = 1;\n");
  expect(await readFile(join(state.cwd, "other.ts"), "utf8")).toBe(
    'import { value } from "./index";\n',
  );
});

it("returns call hierarchy items as the location tools do", async () => {
  const state = await session(true, "call-hierarchy");
  expect(
    await tool(state, "hl_lsp_incoming_calls", {
      file: "index.ts",
      line: 1,
      column: 7,
    }),
  ).toMatchObject({
    isError: false,
    content: [
      {
        type: "text",
        text: "hl-lsp incoming_calls index.ts: completed\ncaller.ts:3:5 caller of value",
      },
    ],
    details: { outcome: "completed" },
  });
});

// lib.ts defines value; index.ts imports it from "./lib".
async function renameFileSession(mode: string) {
  const state = await session(true, mode);
  await writeFile(join(state.cwd, "lib.ts"), "export const value = 1;\n");
  await writeFile(join(state.cwd, "index.ts"), 'import { value } from "./lib";\n');
  return state;
}

function renameFile(state: Awaited<ReturnType<typeof session>>, oldPath: string, newPath: string) {
  return tool(state, "hl_lsp_rename_file", {
    old_path: oldPath,
    new_path: newPath,
  });
}

it("moves the file and updates the imports that name it", async () => {
  const state = await renameFileSession("rename-file");
  expect(await renameFile(state, "lib.ts", "util.ts")).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
    content: [
      {
        type: "text",
        text: "hl-lsp rename_file lib.ts -> util.ts: completed\nindex.ts: 1 edits\nmoved lib.ts -> util.ts\ntotal: 1 edits in 1 files",
      },
    ],
  });
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe(
    'import { value } from "./util";\n',
  );
  expect(await readFile(join(state.cwd, "util.ts"), "utf8")).toBe("export const value = 1;\n");
  await expect(readFile(join(state.cwd, "lib.ts"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("checks the moved file for errors", async () => {
  const state = await renameFileSession("rename-file-errors");
  await writeFile(join(state.cwd, "lib.ts"), "export const ERROR = 1;\n");
  expect(await renameFile(state, "lib.ts", "util.ts")).toMatchObject({
    content: [
      {
        type: "text",
        text: stringMatching(/^hl-lsp rename_file lib\.ts -> util\.ts: completed\n/u),
      },
      {
        type: "text",
        text: "hl-lsp: 1 error in util.ts; no check ran before this edit, so it may be older\n1:1 error 2322 Untrusted diagnostic prose",
      },
    ],
  });
});

it("moves the file without edits when willRenameFiles answers null", async () => {
  const state = await renameFileSession("rename-file-null");
  expect(await renameFile(state, "lib.ts", "util.ts")).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
    content: [
      {
        type: "text",
        text: "hl-lsp rename_file lib.ts -> util.ts: completed\nmoved lib.ts -> util.ts\ntotal: 0 edits in 0 files",
      },
    ],
  });
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe(
    'import { value } from "./lib";\n',
  );
  expect(await readFile(join(state.cwd, "util.ts"), "utf8")).toBe("export const value = 1;\n");
});

it("refuses a file move when the server does not advertise willRename", async () => {
  const state = await renameFileSession("normal");
  const result = await renameFile(state, "lib.ts", "util.ts");
  expect(result).toMatchObject({
    isError: true,
    details: { outcome: "unsupported" },
  });
  expect(JSON.stringify(result)).toContain("workspace.fileOperations.willRename");
  expect(await readFile(join(state.cwd, "lib.ts"), "utf8")).toBe("export const value = 1;\n");
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe(
    'import { value } from "./lib";\n',
  );
});

it.each([
  ["missing.ts", "util.ts", "unavailable", "File does not exist"],
  ["lib.ts", "index.ts", "refused", "already exists"],
  ["lib.ts", "../outside.ts", "refused", "outside the project"],
])(
  "refuses a file move without moving or editing (%s to %s)",
  async (oldPath, newPath, outcome, reason) => {
    const state = await renameFileSession("rename-file");
    const result = await renameFile(state, oldPath, newPath);
    expect(result).toMatchObject({
      isError: true,
      details: { outcome },
    });
    expect(JSON.stringify(result)).toContain(reason);
    expect(await readFile(join(state.cwd, "lib.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe(
      'import { value } from "./lib";\n',
    );
  },
);

it("reports the journal when the file cannot be moved", async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", await directory());
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const state = await renameFileSession("rename-file");
  await writeFile(join(state.cwd, "blocked"), "not a directory\n");
  const result = await renameFile(state, "lib.ts", "blocked/util.ts");
  expect(result).toMatchObject({
    isError: true,
    details: { outcome: "failed" },
  });
  expect(JSON.stringify(result)).toContain("Inspect files for partial edits: index.ts.");
  expect(JSON.stringify(result)).toContain("Review the edit journal:");
  expect(await readFile(join(state.cwd, "lib.ts"), "utf8")).toBe("export const value = 1;\n");
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe(
    'import { value } from "./util";\n',
  );
});

function listCodeActions(state: Awaited<ReturnType<typeof session>>, line = 1) {
  return tool(state, "hl_lsp_code_actions", { file: "index.ts", line });
}

function applyCodeAction(state: Awaited<ReturnType<typeof session>>, index: number, title: string) {
  return tool(state, "hl_lsp_apply_code_action", {
    file: "index.ts",
    line: 1,
    index,
    title,
  });
}

it("lists code actions with their kind, preferred marker and whether an edit is applied", async () => {
  const state = await session(true, "code-actions");
  expect(await listCodeActions(state)).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
    content: [
      {
        type: "text",
        text: "hl-lsp code_actions index.ts: completed\n1. [quickfix] Fix 0 diagnostics (preferred)\n2. [source] Run tool (command-only, not applied)\n3. [refactor] Resolve me (resolvable)",
      },
    ],
  });
});

it("lists code actions when the server never publishes diagnostics", async () => {
  const state = await session(true, "code-actions-silent");
  expect(await listCodeActions(state)).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
    content: [{ text: stringMatching(/1\. \[quickfix\] Fix 0 diagnostics/u) }],
  });
});

it("sends the cached diagnostics that overlap the requested line", async () => {
  const state = await session(true, "code-actions");
  await writeFile(join(state.cwd, "index.ts"), "const value = ERROR;\n");
  expect(await listCodeActions(state, 1)).toMatchObject({
    content: [{ text: stringMatching(/1\. \[quickfix\] Fix 1 diagnostics/u) }],
  });
  expect(await listCodeActions(state, 2)).toMatchObject({
    content: [{ text: stringMatching(/1\. \[quickfix\] Fix 0 diagnostics/u) }],
  });
});

it("applies the edit of the listed action when its title matches", async () => {
  const state = await session(true, "code-actions");
  expect(await applyCodeAction(state, 1, "Fix 0 diagnostics")).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
    content: [
      {
        type: "text",
        text: "hl-lsp apply_code_action index.ts: completed\nindex.ts: 1 edits\ntotal: 1 edits in 1 files",
      },
    ],
  });
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("let value = 1;\n");
});

it("checks the files a code action edited for errors", async () => {
  const state = await session(true, "code-actions");
  await writeFile(join(state.cwd, "index.ts"), "const value = 1; // ERROR\n");
  expect(await applyCodeAction(state, 1, "Fix 1 diagnostics")).toMatchObject({
    content: [
      {
        type: "text",
        text: stringMatching(/^hl-lsp apply_code_action index\.ts: completed\n/u),
      },
      {
        type: "text",
        text: "hl-lsp: 1 error in index.ts; no check ran before this edit, so it may be older\n1:1 error 2322 Untrusted diagnostic prose",
      },
    ],
  });
});

it("refuses a stale index whose listed title differs and writes no file", async () => {
  const state = await session(true, "code-actions");
  const result = await applyCodeAction(state, 1, "Fix 1 diagnostics");
  expect(result).toMatchObject({
    isError: true,
    details: { outcome: "refused" },
  });
  expect(JSON.stringify(result)).toContain("list the code actions again");
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("const value = 1;\n");
});

it("refuses to apply a command-only action and writes no file", async () => {
  const state = await session(true, "code-actions");
  const result = await applyCodeAction(state, 2, "Run tool");
  expect(result).toMatchObject({
    isError: true,
    details: { outcome: "refused" },
  });
  expect(JSON.stringify(result)).toContain("has no edit");
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("const value = 1;\n");
});

it("resolves an action without an edit before applying its edit", async () => {
  const state = await session(true, "code-actions");
  expect(await applyCodeAction(state, 3, "Resolve me")).toMatchObject({
    isError: false,
    details: { outcome: "completed" },
  });
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("var value = 1;\n");
});

it("refuses a code action edit that targets a file outside the project and writes no file", async () => {
  const state = await session(true, "code-actions-outside");
  const outside = join(dirname(state.cwd), `outside-${basename(state.cwd)}.ts`);
  await writeFile(outside, "keep\n");
  const result = await applyCodeAction(state, 1, "Fix 0 diagnostics");
  expect(result).toMatchObject({
    isError: true,
    details: { outcome: "refused" },
  });
  expect(JSON.stringify(result)).toContain("outside the project");
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("const value = 1;\n");
  expect(await readFile(outside, "utf8")).toBe("keep\n");
});

it("lists each hl_lsp tool with a one-line snippet in the system prompt", async () => {
  const { runtime } = await session(true);
  for (const name of [
    "hover",
    "definition",
    "type_definition",
    "implementation",
    "references",
    "incoming_calls",
    "outgoing_calls",
    "symbols",
    "workspace_symbols",
    "diagnostics",
    "status",
    "reload",
  ])
    expect(runtime.session.systemPrompt).toMatch(new RegExp(`^- hl_lsp_${name}: .+$`, "mu"));
});

it("names each hl_lsp tool in its own prompt guideline", async () => {
  const { runtime } = await session(true);
  for (const name of [
    "hover",
    "definition",
    "type_definition",
    "implementation",
    "references",
    "incoming_calls",
    "outgoing_calls",
    "symbols",
    "workspace_symbols",
    "diagnostics",
    "status",
    "reload",
  ])
    expect(runtime.session.systemPrompt).toMatch(new RegExp(`^- Use hl_lsp_${name} `, "mu"));
});

it("keeps fifty edited revisions out of persistent diagnostic context", async () => {
  const state = await session(true, "versioned");
  for (let revision = 1; revision <= 50; revision++) {
    await writeFile(join(state.cwd, "index.ts"), `const value = ${revision};\n`);
    expect(await hover(state)).toMatchObject({
      details: { outcome: "completed" },
    });
  }
  const summaries = state.requests.map((request) =>
    request.filter((text) => text.includes('"source":"hl-lsp"')),
  );
  expect(summaries.map((items) => items.length)).toEqual(
    Array.from({ length: 50 }, () => [0, 1]).flat(),
  );
  for (const text of summaries.flat()) {
    expect(text.length).toBeLessThan(4096);
    expect(text).not.toContain("Untrusted diagnostic prose");
  }
  expect(
    state.runtime.session.messages.filter(
      (message) => message.role === "custom" && message.customType === "hl-lsp-diagnostics",
    ),
  ).toHaveLength(0);
});

it("sends no summary to the model while the open file has no diagnostics", async () => {
  const state = await session(true, "error-lines");
  await writeFile(join(state.cwd, "index.ts"), "const value = 1;\n");
  expect(await hover(state)).toMatchObject({
    details: { outcome: "completed" },
  });
  await writeFile(join(state.cwd, "index.ts"), "const ERROR = 1;\n");
  expect(await hover(state)).toMatchObject({
    details: { outcome: "completed" },
  });
  expect(
    state.requests.map(
      (request) => request.filter((text) => text.includes('"source":"hl-lsp"')).length,
    ),
  ).toEqual([0, 0, 0, 1]);
});

it("adds one bounded transient summary per natural request without raw diagnostic prose", async () => {
  const { runtime, faux, requests } = await session(true, "versioned");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hl_lsp_diagnostics", { file: "index.ts" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await runtime.session.sendCustomMessage(
    { customType: "test", content: "inspect", display: false },
    { triggerTurn: true },
  );
  const result = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "hl_lsp_diagnostics",
  );
  expect(result).toMatchObject({
    content: [
      {
        type: "text",
        text: "hl-lsp diagnostics index.ts: completed\n1:1 error 2322 Untrusted diagnostic prose",
      },
    ],
    details: { diagnostics: [{ message: "Untrusted diagnostic prose" }] },
  });
  faux.setResponses([fauxAssistantMessage("next")]);
  await runtime.session.sendCustomMessage(
    { customType: "test", content: "continue", display: false },
    { triggerTurn: true },
  );
  expect(requests).toHaveLength(3);
  expect(
    requests.map((request) => request.filter((text) => text.includes('"source":"hl-lsp"')).length),
  ).toEqual([0, 1, 1]);
  for (const request of requests.slice(1)) {
    const summaries = request.filter((text) => text.includes('"source":"hl-lsp"'));
    expect(summaries).toHaveLength(1);
    for (const text of summaries) {
      const summary: unknown = JSON.parse(text);
      expect(summary).toMatchObject({
        reportedCount: 1,
        projectComplete: false,
      });
      expect(text).not.toContain("Untrusted diagnostic prose");
      expect(text).not.toMatch(/generation|documentVersion|receivedAt|checkedAt/u);
      expect(text.length).toBeLessThan(4096);
    }
  }
  expect(
    runtime.session.messages.filter(
      (message) => message.role === "custom" && message.customType === "hl-lsp-diagnostics",
    ),
  ).toHaveLength(0);
});

it("checks several files in one call and collapses the clean ones into one line", async () => {
  const state = await session(true, "error-lines");
  await writeFile(join(state.cwd, "index.ts"), "ERROR\n");
  await writeFile(join(state.cwd, "a.ts"), "const a = 1;\n");
  await writeFile(join(state.cwd, "b.ts"), "const b = 1;\n");
  expect(
    await tool(state, "hl_lsp_diagnostics", {
      paths: ["index.ts", "a.ts", "b.ts"],
    }),
  ).toMatchObject({
    isError: false,
    content: [
      {
        type: "text",
        text: "hl-lsp diagnostics: 3 files, 1 with diagnostics, 2 clean, 0 not settled, 0 not checked\nhl-lsp diagnostics index.ts: completed\n1:1 error 2322 Untrusted diagnostic prose\nclean: a.ts, b.ts",
      },
    ],
    details: { outcome: "completed" },
  });
});

it("shows a file whose type has no server as one refusal line and checks the rest", async () => {
  const state = await session(true, "error-lines");
  await writeFile(join(state.cwd, "index.ts"), "ERROR\n");
  await writeFile(join(state.cwd, "notes.txt"), "plain\n");
  const result = await tool(state, "hl_lsp_diagnostics", {
    paths: ["notes.txt", "index.ts"],
  });
  expect(result).toMatchObject({
    isError: false,
    content: [
      {
        type: "text",
        text: stringMatching(
          /^hl-lsp diagnostics: 2 files, 1 with diagnostics, 0 clean, 0 not settled, 1 not checked\nnotes\.txt: unsupported: .+\nhl-lsp diagnostics index\.ts: completed\n1:1 error 2322 Untrusted diagnostic prose$/u,
        ),
      },
    ],
  });
});

it.each([
  ["both file and paths", { file: "index.ts", paths: ["index.ts"] }],
  ["neither", {}],
])("refuses diagnostics given %s before any server launch", async (_label, args) => {
  const state = await session(true, "error-lines");
  expect(await tool(state, "hl_lsp_diagnostics", args)).toMatchObject({
    isError: true,
    content: [
      {
        type: "text",
        text: "hl-lsp diagnostics: give exactly one of file or paths",
      },
    ],
  });
  await expect(readFile(state.spawnLog, "utf8")).rejects.toThrow("ENOENT");
});

it("refuses more than twenty paths in one call", async () => {
  const state = await session(true, "error-lines");
  const paths = Array.from({ length: 21 }, (_item, index) => `file${index}.ts`);
  expect(await tool(state, "hl_lsp_diagnostics", { paths })).toMatchObject({
    isError: true,
    content: [
      {
        type: "text",
        text: stringMatching(
          /^Validation failed for tool "hl_lsp_diagnostics":\n\s+- paths: expected at most 20 items/u,
        ),
      },
    ],
  });
});

it("gives each file of a batch its own deadline when the batch takes longer than the timeout", async () => {
  const state = await session(true, "slow-error-lines", { timeoutMs: 3000 });
  await writeFile(join(state.cwd, "a.ts"), "ERROR\n");
  await writeFile(join(state.cwd, "b.ts"), "const b = 1;\n");
  await writeFile(join(state.cwd, "c.ts"), "ERROR\n");
  await writeFile(join(state.cwd, "d.ts"), "const d = 1;\n");
  expect(
    await tool(state, "hl_lsp_diagnostics", {
      paths: ["a.ts", "b.ts", "c.ts", "d.ts"],
    }),
  ).toMatchObject({
    isError: false,
    content: [
      {
        type: "text",
        text: "hl-lsp diagnostics: 4 files, 2 with diagnostics, 2 clean, 0 not settled, 0 not checked\nhl-lsp diagnostics a.ts: completed\n1:1 error 2322 Untrusted diagnostic prose\nhl-lsp diagnostics c.ts: completed\n1:1 error 2322 Untrusted diagnostic prose\nclean: b.ts, d.ts",
      },
    ],
    details: { outcome: "completed" },
  });
});

it("does not count files published as empty without a version as clean", async () => {
  const state = await session(true);
  await writeFile(join(state.cwd, "a.ts"), "const a = 1;\n");
  await writeFile(join(state.cwd, "b.ts"), "const b = 1;\n");
  expect(await tool(state, "hl_lsp_diagnostics", { paths: ["a.ts", "b.ts"] })).toMatchObject({
    isError: false,
    content: [
      {
        type: "text",
        text: "hl-lsp diagnostics: 2 files, 0 with diagnostics, 0 clean, 2 not settled, 0 not checked\nno errors seen (not settled): a.ts, b.ts",
      },
    ],
  });
});

it("does not call a file clean from an empty list without a version in single-file mode", async () => {
  const state = await session(true);
  await writeFile(join(state.cwd, "a.ts"), "const a = 1;\n");
  expect(await tool(state, "hl_lsp_diagnostics", { file: "a.ts" })).toMatchObject({
    isError: false,
    content: [
      {
        type: "text",
        text: "hl-lsp diagnostics a.ts: partial\nno errors seen yet: the server published an empty list without a version, so errors may still arrive",
      },
    ],
  });
});

it("keeps the real SDK tool blocked when the extension is disabled", async () => {
  const { runtime, faux } = await session(false);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hl_lsp_hover", { file: "index.ts", line: 1, column: 7 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await runtime.session.sendCustomMessage(
    { customType: "test", content: "inspect", display: false },
    { triggerTurn: true },
  );
  const result = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "hl_lsp_hover",
  );
  expect(result).toMatchObject({
    isError: true,
    content: [
      {
        type: "text",
        text: "hl-lsp hover index.ts: blocked\nLSP is off; run /hl-lsp on",
      },
    ],
    details: { outcome: "blocked" },
  });
});

it("reports an invalid session LSP override as the unavailable reason, and launches nothing", async () => {
  const { runtime, faux, spawnLog } = await session(true);
  runtime.session.sessionManager.appendCustomEntry("hl-lsp-settings", {
    version: 1,
    overrides: { enabled: true, allowProjectExecution: true },
  });
  await runtime.session.reload();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hl_lsp_hover", { file: "index.ts", line: 1, column: 7 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await runtime.session.sendCustomMessage(
    { customType: "test", content: "inspect", display: false },
    { triggerTurn: true },
  );
  const result = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "hl_lsp_hover",
  );
  expect(result).toMatchObject({
    details: {
      outcome: "unavailable",
      reason:
        "Invalid session HL LSP settings: allowProjectExecution is global-only; set it in global settings",
    },
  });
  await expect(readFile(spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("launches nothing for an untrusted project whose hl-lsp servers are set", async () => {
  const { runtime, faux, spawnLog } = await session(true, "normal", {
    projectTrusted: false,
    projectSettings: (log) => ({
      "hl-lsp": {
        enabled: true,
        servers: { typescript: typescriptServer("normal", log) },
      },
    }),
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hl_lsp_hover", { file: "index.ts", line: 1, column: 7 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await runtime.session.sendCustomMessage(
    { customType: "test", content: "inspect", display: false },
    { triggerTurn: true },
  );
  const result = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "hl_lsp_hover",
  );
  expect(result).toMatchObject({
    details: {
      outcome: "blocked",
      reason: stringMatching(/project is not trusted; run \/trust/u),
    },
  });
  await expect(readFile(spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("fails closed when a trusted project's hl-lsp servers try to replace the global server", async () => {
  const { runtime, faux, spawnLog } = await session(true, "normal", {
    projectSettings: (log) => ({
      "hl-lsp": { servers: { typescript: typescriptServer("normal", log) } },
    }),
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hl_lsp_hover", { file: "index.ts", line: 1, column: 7 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await runtime.session.sendCustomMessage(
    { customType: "test", content: "inspect", display: false },
    { triggerTurn: true },
  );
  const result = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "hl_lsp_hover",
  );
  expect(result).toMatchObject({
    details: {
      outcome: "unavailable",
      reason: "Invalid project HL LSP settings: servers is global-only; set it in global settings",
    },
  });
  await expect(readFile(spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps a valid session enable blocked without global project-execution consent", async () => {
  const { runtime, faux, spawnLog } = await session(false, "normal", {
    allowProjectExecution: false,
  });
  await runtime.session.prompt("/hl-lsp on");
  const settings = runtime.session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "hl-lsp-settings");
  expect(settings.at(-1)).toMatchObject({
    data: { version: 1, overrides: { enabled: true } },
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hl_lsp_hover", { file: "index.ts", line: 1, column: 7 }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await runtime.session.sendCustomMessage(
    { customType: "test", content: "inspect", display: false },
    { triggerTurn: true },
  );
  const result = runtime.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "hl_lsp_hover",
  );
  expect(result).toMatchObject({
    details: {
      outcome: "blocked",
      reason: stringMatching(
        /project execution is not allowed; run \/hl-lsp set allowProjectExecution true --global/u,
      ),
    },
  });
  await expect(readFile(spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("appends an error that an edit introduces", async () => {
  const state = await session(true, "error-lines");
  await tool(state, "hl_lsp_diagnostics", { paths: ["index.ts"] });
  expect(await tool(state, "edit", { path: "index.ts", text: "ERROR\n" })).toMatchObject({
    isError: false,
    content: [
      { type: "text", text: "Wrote index.ts" },
      {
        type: "text",
        text: "hl-lsp: 1 new error in index.ts\n1:1 error 2322 Untrusted diagnostic prose",
      },
    ],
  });
});

it("does not call errors new when no check ran before the edit", async () => {
  const state = await session(true, "error-lines");
  expect(await tool(state, "edit", { path: "index.ts", text: "ERROR\nERROR\n" })).toMatchObject({
    content: [
      { type: "text", text: "Wrote index.ts" },
      {
        type: "text",
        text: "hl-lsp: 2 errors in index.ts; no check ran before this edit, so some may be older\n1:1 error 2322 Untrusted diagnostic prose\n1:1 error 2322 Untrusted diagnostic prose",
      },
    ],
  });
});

it("says an edit was not checked while the server is still busy", async () => {
  const state = await session(true, "pull-progress-forever", {
    timeoutMs: 1500,
  });
  expect(await tool(state, "edit", { path: "index.ts", text: "ERROR\n" })).toMatchObject({
    content: [
      { type: "text", text: "Wrote index.ts" },
      {
        type: "text",
        text: stringMatching(/^hl-lsp: index\.ts was not checked for errors: .*busy/u),
      },
    ],
  });
});

it("says an edit was not checked when the server stays silent after it", async () => {
  const state = await session(true, "dedupe-empty");
  await tool(state, "hl_lsp_diagnostics", { paths: ["index.ts"] });
  expect(await tool(state, "edit", { path: "index.ts", text: "const value = 2;\n" })).toMatchObject(
    {
      content: [
        { type: "text", text: "Wrote index.ts" },
        {
          type: "text",
          text: "hl-lsp: index.ts was not checked for errors: the server reported nothing after the edit",
        },
      ],
    },
  );
});

it("appends nothing for a later edit that keeps the same error", async () => {
  const state = await session(true, "error-lines");
  await tool(state, "edit", { path: "index.ts", text: "ERROR\n" });
  expect(await tool(state, "edit", { path: "index.ts", text: "ERROR\nkeep\n" })).toMatchObject({
    content: [{ type: "text", text: "Wrote index.ts" }],
  });
});

it("appends one error when an edit adds a second identical error", async () => {
  const state = await session(true, "error-lines");
  await tool(state, "edit", { path: "index.ts", text: "ERROR\n" });
  expect(await tool(state, "edit", { path: "index.ts", text: "ERROR\nERROR\n" })).toMatchObject({
    content: [
      { type: "text", text: "Wrote index.ts" },
      {
        type: "text",
        text: "hl-lsp: 1 new error in index.ts\n1:1 error 2322 Untrusted diagnostic prose",
      },
    ],
  });
});

it("leaves a clean edit's result unchanged", async () => {
  const state = await session(true, "error-lines");
  expect(await tool(state, "edit", { path: "index.ts", text: "const value = 2;\n" })).toMatchObject(
    {
      content: [{ type: "text", text: "Wrote index.ts" }],
    },
  );
});

it("appends nothing for a warning-only edit", async () => {
  const state = await session(true, "error-lines");
  expect(await tool(state, "edit", { path: "index.ts", text: "WARN\n" })).toMatchObject({
    content: [{ type: "text", text: "Wrote index.ts" }],
  });
});

it("ignores a failed edit", async () => {
  const state = await session(true, "error-lines");
  expect(await tool(state, "edit", { path: "index.ts", text: "fail" })).toMatchObject({
    isError: true,
    content: [{ type: "text", text: "Could not find the text" }],
  });
});

it("ignores an edit to a file type without a configured server", async () => {
  const state = await session(true, "error-lines");
  expect(await tool(state, "edit", { path: "notes.md", text: "ERROR\n" })).toMatchObject({
    content: [{ type: "text", text: "Wrote notes.md" }],
  });
});

it("leaves an edit's result unchanged while project execution is blocked", async () => {
  const state = await session(true, "error-lines", {
    allowProjectExecution: false,
  });
  expect(await tool(state, "edit", { path: "index.ts", text: "ERROR\n" })).toMatchObject({
    content: [{ type: "text", text: "Wrote index.ts" }],
  });
  await expect(readFile(state.spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("says an edit was not checked when the server never answers, within the post-edit deadline", async () => {
  const state = await session(true, "silent");
  const started = performance.now();
  expect(await tool(state, "edit", { path: "index.ts", text: "ERROR\n" })).toMatchObject({
    content: [
      { type: "text", text: "Wrote index.ts" },
      {
        type: "text",
        text: stringMatching(/^hl-lsp: index\.ts was not checked for errors: \S/u),
      },
    ],
  });
  expect(performance.now() - started).toBeLessThan(3500);
});

it("appends new errors after a write too", async () => {
  const state = await session(true, "error-lines");
  expect(await tool(state, "write", { path: "index.ts", text: "ERROR\n" })).toMatchObject({
    content: [
      { type: "text", text: "Wrote index.ts" },
      {
        type: "text",
        text: "hl-lsp: 1 error in index.ts; no check ran before this edit, so it may be older\n1:1 error 2322 Untrusted diagnostic prose",
      },
    ],
  });
});

it("leaves an edit unformatted unless formatOnWrite is set", async () => {
  const state = await session(true, "format");
  expect(
    await tool(state, "edit", {
      path: "index.ts",
      text: "  const value = 2;\n",
    }),
  ).toMatchObject({
    content: [{ type: "text", text: "Wrote index.ts" }],
  });
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("  const value = 2;\n");
  expect(await readFile(state.spawnLog, "utf8")).not.toContain("format");
});

it("formats an edited file and appends the formatted line", async () => {
  const state = await session(true, "format", { formatOnWrite: true });
  expect(
    await tool(state, "edit", {
      path: "index.ts",
      text: "  const value = 2;\n",
    }),
  ).toMatchObject({
    isError: false,
    content: [
      { type: "text", text: "Wrote index.ts" },
      { type: "text", text: "hl-lsp: formatted index.ts (1 edits)" },
    ],
  });
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("const value = 2;\n");
});

it("formats a written file too", async () => {
  const state = await session(true, "format", { formatOnWrite: true });
  expect(
    await tool(state, "write", {
      path: "index.ts",
      text: "  const value = 2;\n",
    }),
  ).toMatchObject({
    content: [
      { type: "text", text: "Wrote index.ts" },
      { type: "text", text: "hl-lsp: formatted index.ts (1 edits)" },
    ],
  });
});

it("skips formatting when the file changed after the server read it", async () => {
  const state = await session(true, "format-race", { formatOnWrite: true });
  expect(
    await tool(state, "edit", {
      path: "index.ts",
      text: "  const value = 2;\n",
    }),
  ).toMatchObject({
    content: [
      { type: "text", text: "Wrote index.ts" },
      {
        type: "text",
        text: "hl-lsp: format skipped: index.ts changed after the server read it",
      },
    ],
  });
  expect(await readFile(join(state.cwd, "index.ts"), "utf8")).toBe("    const other = 3;\n");
});

it("appends nothing for a server without a formatting provider", async () => {
  const state = await session(true, "error-lines", { formatOnWrite: true });
  expect(
    await tool(state, "edit", {
      path: "index.ts",
      text: "  const value = 2;\n",
    }),
  ).toMatchObject({
    content: [{ type: "text", text: "Wrote index.ts" }],
  });
});

it("reports the format line before new errors", async () => {
  const state = await session(true, "format-errors", { formatOnWrite: true });
  expect(await tool(state, "edit", { path: "index.ts", text: "  ERROR\n" })).toMatchObject({
    content: [
      { type: "text", text: "Wrote index.ts" },
      { type: "text", text: "hl-lsp: formatted index.ts (1 edits)" },
      {
        type: "text",
        text: "hl-lsp: 1 error in index.ts; no check ran before this edit, so it may be older\n1:1 error 2322 Untrusted diagnostic prose",
      },
    ],
  });
});

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const packResult = Type.Array(
  Type.Object({ files: Type.Array(Type.Object({ path: Type.String() })) }),
);

it("packs the compiled entry, its chunks and the notices without sources", () => {
  const output: unknown = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: packageDirectory,
      encoding: "utf8",
    }),
  );
  if (!Value.Check(packResult, output)) throw new Error("Unexpected npm pack output");
  const files = output.flatMap((pack) => pack.files.map((file) => file.path));
  expect(files).toEqual(
    expect.arrayContaining([
      "dist/index.js",
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES",
    ]),
  );
  expect(files.filter((path) => path.startsWith("dist/")).length).toBeGreaterThan(1);
  expect(files.filter((path) => path.startsWith("src/"))).toEqual([]);
});

it("ships the full license and notices of the bundled vscode-jsonrpc", async () => {
  const jsonrpc = join(
    dirname(createRequire(import.meta.url).resolve("vscode-jsonrpc/node")),
    "..",
    "..",
  );
  const notices = await readFile(join(packageDirectory, "THIRD_PARTY_NOTICES"), "utf8");
  for (const name of ["License.txt", "thirdpartynotices.txt"])
    expect(notices).toContain((await readFile(join(jsonrpc, name), "utf8")).trim());
});
