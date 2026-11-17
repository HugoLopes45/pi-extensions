import { execFileSync } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
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
import { expect, it, onTestFinished } from "vitest";

import { directory } from "./fixtures.js";

interface SessionOptions {
  allowProjectExecution?: boolean;
  projectTrusted?: boolean;
  projectSettings?: (spawnLog: string) => unknown;
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
  const cwd = await directory();
  const agentDir = getAgentDir();
  const spawnLog = join(cwd, "spawns.log");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      "hl-lsp": {
        enabled,
        allowProjectExecution: options.allowProjectExecution ?? true,
        timeoutMs: 5000,
        servers: { typescript: typescriptServer(mode, spawnLog) },
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
        additionalExtensionPaths: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
        // Undefined keeps Pi's default prompt, which lists tools that have a promptSnippet.
        systemPromptOverride: () => undefined,
      });
      await resourceLoader.reload();
      expect(resourceLoader.getExtensions().errors).toEqual([]);
      expect(resourceLoader.getExtensions().extensions).toHaveLength(1);
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

it("lists each hl_lsp tool with a one-line snippet in the system prompt", async () => {
  const { runtime } = await session(true);
  for (const name of [
    "hover",
    "definition",
    "references",
    "symbols",
    "workspace_symbols",
    "diagnostics",
  ])
    expect(runtime.session.systemPrompt).toMatch(new RegExp(`^- hl_lsp_${name}: .+$`, "mu"));
});

it("names each hl_lsp tool in its own prompt guideline", async () => {
  const { runtime } = await session(true);
  for (const name of [
    "hover",
    "definition",
    "references",
    "symbols",
    "workspace_symbols",
    "diagnostics",
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
      expect(text.length).toBeLessThan(4096);
    }
  }
  expect(
    runtime.session.messages.filter(
      (message) => message.role === "custom" && message.customType === "hl-lsp-diagnostics",
    ),
  ).toHaveLength(0);
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
  expect(files).toEqual(expect.arrayContaining(["dist/index.js", "THIRD_PARTY_NOTICES"]));
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
