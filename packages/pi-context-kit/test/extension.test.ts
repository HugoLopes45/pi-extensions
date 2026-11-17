import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
  fauxToolCall,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createMenuTui, keys, menuDriver } from "pi-hl-utils/testing/menu-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

const sessions: { dispose(): void }[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Replaces the context-kit namespace of Pi's settings.json. */
function writeContextKitSettings(agentDir: string, options: unknown) {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "context-kit": options }));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function start(
  responses: FauxResponseStep[],
  contextWindow = 200_000,
  compactionEnabled = true,
  contextKit?: unknown,
  keepRecentTokens = 1_000,
  legacyContextKit?: unknown,
) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-context-kit-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-context-kit-cwd-"));
  writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n".repeat(200));
  writeFileSync(join(cwd, "b.ts"), "export const b = 2;\n".repeat(1_000));
  // The extension finds its settings file through Pi's agent directory.
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const agentSettings = {
    ...(contextKit === undefined ? {} : { "context-kit": contextKit }),
    // The 0.3 block, which the extension imports once.
    ...(legacyContextKit === undefined ? {} : { contextKit: legacyContextKit }),
  };
  if (Object.keys(agentSettings).length > 0)
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(agentSettings));
  const faux = fauxProvider({
    models: [{ id: "faux-1", contextWindow, maxTokens: 4_096, reasoning: true }],
  });
  faux.setResponses(responses);
  const settings = {
    retry: { enabled: false },
    compaction: {
      enabled: compactionEnabled,
      reserveTokens: 1_000,
      keepRecentTokens,
    },
  };
  const settingsManager = SettingsManager.inMemory(settings);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  // Pi 1.0 faux usage counts a session's first prompt as input and cache write; without the cache every version reports the same tokens.
  modelRuntime.registerNativeProvider({
    ...faux.provider,
    streamSimple: (model, context, options) =>
      faux.provider.streamSimple(model, context, {
        ...options,
        cacheRetention: "none",
      }),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../extensions/index.ts")],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: "high",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["read", "edit", "recall"],
  });
  sessions.push(session);
  return { session, faux, cwd, agentDir };
}

describe("pi-context-kit inside Pi", () => {
  it.each([
    ["enabled", true],
    ["disabled", false],
  ])("keeps an older read below the threshold with compaction %s", async (_, enabled) => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      enabled,
    );
    await session.prompt("Read a.ts twice");
    expect(
      session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit"),
    ).toEqual([]);
  });

  it("tells the user about freed tokens and shows the threshold in the status", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      { threshold: 8_000, methodOrder: [] },
    );
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify,
        setStatus,
      },
    });
    await session.prompt("Read b.ts twice");
    expect(notify.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^pi-context-kit freed \d+% of the context \(\d+k? tokens\)\. The agent can still look up what was removed\.$/,
        ),
        "info",
      ],
    ]);
    expect(setStatus).toHaveBeenLastCalledWith(
      "context-kit",
      expect.stringMatching(/^Context [0-3]% · cleanup at 4%$/),
    );
  });

  it("states the settings with /context-kit outside the TUI", async () => {
    const { session } = await start([], 200_000, true, { strategy: "frugal" });
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await session.prompt("/context-kit");
    expect(notify.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^pi-context-kit: automatic cleanup at 75%, with frugal\. Settings: \/context-kit$/,
        ),
        "info",
      ],
    ]);
  });

  it("imports context-kit.json into the global namespace and renames the file", async () => {
    const { session, agentDir } = await start([fauxAssistantMessage("done")]);
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, JSON.stringify({ threshold: 8_000, advanced: { background: false } }));
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [
        `pi-context-kit moved its settings into Pi's settings.json under "context-kit". The 0.3 "contextKit" entry is no longer read. ${file} was renamed to ${file}.migrated.`,
        "info",
      ],
    ]);
    expect(existsSync(file)).toBe(false);
    expect(readJson(join(agentDir, "settings.json"))).toEqual({
      "context-kit": { threshold: 8_000, background: false },
    });
  });

  it("imports the 0.3 contextKit block when no context-kit.json exists", async () => {
    const { session, agentDir } = await start(
      [fauxAssistantMessage("done")],
      200_000,
      true,
      undefined,
      1_000,
      { thresholdTokens: 8_000, asyncEnabled: false },
    );
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify,
        setStatus,
      },
    });
    // 8,000 of 200,000 tokens.
    expect(setStatus).toHaveBeenLastCalledWith(
      "context-kit",
      expect.stringMatching(/ · cleanup at 4%$/),
    );
    expect(notify.mock.calls).toEqual([
      [
        `pi-context-kit moved its settings into Pi's settings.json under "context-kit". The 0.3 "contextKit" entry is no longer read.`,
        "info",
      ],
    ]);
    expect(readJson(join(agentDir, "settings.json"))).toEqual({
      contextKit: { thresholdTokens: 8_000, asyncEnabled: false },
      "context-kit": { threshold: 8_000, background: false },
    });
  });

  it("does not import the 0.3 block again after the user inherits every imported setting", async () => {
    const { session, agentDir } = await start(
      [fauxAssistantMessage("done")],
      200_000,
      true,
      undefined,
      1_000,
      { thresholdTokens: 8_000, asyncEnabled: false },
    );
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: vi.fn<() => void>(),
      },
    });
    await session.prompt("/context-kit inherit threshold --global");
    await session.prompt("/context-kit inherit background --global");
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(readJson(join(agentDir, "settings.json"))).toEqual({
      contextKit: { thresholdTokens: 8_000, asyncEnabled: false },
      "context-kit": {},
    });
  });

  it("imports an empty project 0.3 block once", async () => {
    const { session, cwd } = await start([fauxAssistantMessage("done")]);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ contextKit: {} }));
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: vi.fn<() => void>(),
      },
    });
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(readJson(join(cwd, ".pi", "settings.json"))).toEqual({
      contextKit: {},
      "context-kit": {},
    });
  });

  it("keeps an existing context-kit namespace and leaves context-kit.json in place", async () => {
    const { session, agentDir } = await start([fauxAssistantMessage("done")], 200_000, true, {
      threshold: 9_000,
    });
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, JSON.stringify({ threshold: 8_000 }));
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(readJson(file)).toEqual({ threshold: 8_000 });
    expect(readJson(join(agentDir, "settings.json"))).toEqual({
      "context-kit": { threshold: 9_000 },
    });
  });

  it("imports a trusted project's context-kit.json into the project namespace", async () => {
    const { session, cwd } = await start([fauxAssistantMessage("done")]);
    mkdirSync(join(cwd, ".pi"));
    const file = join(cwd, ".pi", "context-kit.json");
    writeFileSync(file, JSON.stringify({ strategy: "frugal" }));
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [expect.stringContaining(`${file} was renamed to ${file}.migrated.`), "info"],
    ]);
    expect(readJson(join(cwd, ".pi", "settings.json"))).toEqual({
      "context-kit": { strategy: "frugal" },
    });
    expect(existsSync(`${file}.migrated`)).toBe(true);
  });

  it("ignores the context-kit.json of a project that Pi does not trust", async () => {
    const { session, cwd } = await start([fauxAssistantMessage("done")]);
    mkdirSync(join(cwd, ".pi"));
    const file = join(cwd, ".pi", "context-kit.json");
    writeFileSync(file, JSON.stringify({ strategy: "frugal" }));
    session.settingsManager.setProjectTrusted(false);
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.migrated`)).toBe(false);
  });

  it("writes an imported scope in one settings write", async () => {
    const { session, agentDir } = await start([fauxAssistantMessage("done")]);
    writeFileSync(
      join(agentDir, "context-kit.json"),
      JSON.stringify({ threshold: 8_000, strategy: "frugal" }),
    );
    const flush = vi.spyOn(SettingsManager.prototype, "flush");
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: vi.fn<() => void>(),
      },
    });
    // Each settings write flushes once before it locks the file.
    expect(flush).toHaveBeenCalledTimes(1);
    expect(readJson(join(agentDir, "settings.json"))).toEqual({
      "context-kit": { threshold: 8_000, strategy: "frugal" },
    });
  });

  it("moves the 0.3 block of a trusted project into the project namespace", async () => {
    const { session, cwd } = await start([fauxAssistantMessage("done")]);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ contextKit: { methodOrder: ["soft"] } }),
    );
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [expect.stringContaining("moved its settings into Pi's settings.json"), "info"],
    ]);
    expect(readJson(join(cwd, ".pi", "settings.json"))).toEqual({
      contextKit: { methodOrder: ["soft"] },
      "context-kit": { strategy: "pi-summary" },
    });
  });

  it("keeps the global 0.3 threshold for a project that did not set one", async () => {
    const { session, cwd } = await start(
      [fauxAssistantMessage("done")],
      200_000,
      true,
      undefined,
      1_000,
      { thresholdPercent: 70 },
    );
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ contextKit: { prune: { enabled: false } } }),
    );
    const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), setStatus },
    });
    expect(readJson(join(cwd, ".pi", "settings.json"))).toEqual({
      contextKit: { prune: { enabled: false } },
      "context-kit": { pruneEnabled: false },
    });
    expect(setStatus).toHaveBeenLastCalledWith(
      "context-kit",
      expect.stringMatching(/ · cleanup at 70%$/),
    );
  });

  it("moves the settings at the next start after a failed write", async () => {
    const { session, agentDir } = await start([fauxAssistantMessage("done")]);
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, JSON.stringify({ threshold: 8_000 }));
    const settingsFile = join(agentDir, "settings.json");
    writeFileSync(settingsFile, "{}");
    chmodSync(settingsFile, 0o444);
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: vi.fn<() => void>(),
      },
    });
    chmodSync(settingsFile, 0o644);
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [expect.stringContaining(`${file} was renamed to ${file}.migrated.`), "info"],
    ]);
    expect(readJson(settingsFile)).toEqual({
      "context-kit": { threshold: 8_000 },
    });
  });

  it("leaves no namespace after a failed write, and imports at the next start", async () => {
    const { session, agentDir } = await start([fauxAssistantMessage("done")]);
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, JSON.stringify({ threshold: 8_000 }));
    const settingsFile = join(agentDir, "settings.json");
    writeFileSync(settingsFile, "{}");
    chmodSync(settingsFile, 0o444);
    const failed = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify: failed },
    });
    expect(failed.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^pi-context-kit: moving settings failed \(.+\)\. Defaults apply until it works\.$/,
        ),
        "warning",
      ],
    ]);
    expect(readJson(settingsFile)).toEqual({});
    expect(readJson(file)).toEqual({ threshold: 8_000 });
    chmodSync(settingsFile, 0o644);
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [expect.stringContaining(`${file} was renamed to ${file}.migrated.`), "info"],
    ]);
    expect(readJson(settingsFile)).toEqual({
      "context-kit": { threshold: 8_000 },
    });
    expect(existsSync(file)).toBe(false);
  });

  it("warns and imports nothing when a project context-kit.json is not valid JSON", async () => {
    const { session, cwd } = await start([fauxAssistantMessage("done")]);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "context-kit.json"), "{ broken");
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^pi-context-kit: moving settings failed \(.+ is not valid JSON \(.+\)\)\. Defaults apply until it works\.$/,
        ),
        "warning",
      ],
    ]);
    expect(existsSync(join(cwd, ".pi", "settings.json"))).toBe(false);
  });

  it("imports nothing when one option is invalid, and keeps the file", async () => {
    const { session, agentDir } = await start([fauxAssistantMessage("done")]);
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, JSON.stringify({ threshold: 8_000, strategy: "nope" }));
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^pi-context-kit: moving settings failed \(.+\)\. Defaults apply until it works\.$/,
        ),
        "warning",
      ],
    ]);
    expect(notify.mock.calls[0]?.[0]).toContain(`${file} is invalid (`);
    expect(readJson(file)).toEqual({ threshold: 8_000, strategy: "nope" });
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
  });

  it("keeps context-kit.json when the settings write fails", async () => {
    const { session, agentDir } = await start([fauxAssistantMessage("done")]);
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, JSON.stringify({ threshold: 8_000 }));
    // A read-only settings.json makes the write fail.
    const settingsFile = join(agentDir, "settings.json");
    writeFileSync(settingsFile, "{}");
    chmodSync(settingsFile, 0o444);
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^pi-context-kit: moving settings failed \(.+\)\. Defaults apply until it works\.$/,
        ),
        "warning",
      ],
    ]);
    expect(readJson(file)).toEqual({ threshold: 8_000 });
    expect(existsSync(`${file}.migrated`)).toBe(false);
  });

  it("keeps the imported options when the rename fails, and does not import again", async () => {
    const { session, agentDir } = await start([fauxAssistantMessage("done")]);
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, JSON.stringify({ threshold: 8_000, advanced: { background: false } }));
    // A directory at the rename target makes the rename fail after the write.
    mkdirSync(`${file}.migrated`);
    const failed = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify: failed },
    });
    expect(failed.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^pi-context-kit: settings were imported, but renaming .+ failed \(.+\)\. The file stays in place and is not imported again\.$/,
        ),
        "warning",
      ],
    ]);
    const settingsFile = join(agentDir, "settings.json");
    expect(readJson(settingsFile)).toEqual({
      "context-kit": { threshold: 8_000, background: false },
    });
    expect(readJson(file)).toEqual({
      threshold: 8_000,
      advanced: { background: false },
    });
    const flush = vi.spyOn(SettingsManager.prototype, "flush");
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(readJson(settingsFile)).toEqual({
      "context-kit": { threshold: 8_000, background: false },
    });
  });

  it("waits to import while Pi's settings.json cannot be read", async () => {
    const { session, agentDir } = await start([]);
    const settingsFile = join(agentDir, "settings.json");
    writeFileSync(settingsFile, "{ broken");
    const file = join(agentDir, "context-kit.json");
    writeFileSync(file, JSON.stringify({ threshold: 8_000 }));
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: vi.fn<() => void>(),
      },
    });
    expect(readFileSync(settingsFile, "utf8")).toBe("{ broken");
    expect(existsSync(file)).toBe(true);
    writeFileSync(settingsFile, "{}");
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [expect.stringContaining(`${file} was renamed to ${file}.migrated.`), "info"],
    ]);
  });

  it("turns cleanup off in the global settings with /context-kit off --global", async () => {
    const { session, agentDir } = await start([]);
    const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), setStatus },
    });
    await session.prompt("/context-kit off --global");
    expect(readJson(join(agentDir, "settings.json"))).toEqual({
      "context-kit": { enabled: false },
    });
    expect(setStatus).toHaveBeenLastCalledWith("context-kit", "Context cleanup off");
  });

  it("shows the strategy's effective method order and background in the /context-kit menu", async () => {
    initTheme("dark");
    const { session } = await start([], 200_000, true, { strategy: "frugal" });
    const screens: string[] = [];
    const uiContext = session.extensionRunner.getUIContext();
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        ...uiContext,
        // The menu is read and closed with Escape, so the command returns.
        custom: (factory) =>
          new Promise((resolve) => {
            const { tui, keybindings } = createMenuTui();
            void Promise.resolve(factory(tui, uiContext.theme, keybindings, resolve)).then(
              (component) => {
                screens.push(menuDriver(() => component).screen());
                menuDriver(() => component).press(keys.escape);
              },
            );
          }),
      },
    });
    await session.prompt("/context-kit");
    expect(screens).toHaveLength(1);
    // The global strategy supplies both values, so both name that scope.
    expect(screens[0]).toMatch(/methodOrder \[global\].*shake, handoff, soft/);
    expect(screens[0]).toMatch(/background \[global\].*off/);
  });

  it("reports a failed /context-kit change as an error notice", async () => {
    const { session, agentDir } = await start([]);
    const settingsFile = join(agentDir, "settings.json");
    writeFileSync(settingsFile, "{}");
    // A read-only settings.json makes the write fail.
    chmodSync(settingsFile, 0o444);
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await session.prompt("/context-kit off --global");
    expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/^pi-context-kit: .+/), "error");
  });

  it("applies a session override to the status without writing settings", async () => {
    const { session, agentDir } = await start([]);
    const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), setStatus },
    });
    await session.prompt("/context-kit set threshold 8000");
    // 8,000 of 200,000 tokens.
    expect(setStatus).toHaveBeenLastCalledWith(
      "context-kit",
      expect.stringMatching(/ · cleanup at 4%$/),
    );
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
  });

  it("reports an invalid context-kit setting at start and again on /context-kit", async () => {
    const { session } = await start([], 200_000, true, { maxTokens: 8_000 });
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await session.prompt("/context-kit");
    const warning = [
      expect.stringMatching(
        /^pi-context-kit settings need attention: .+\. Type \/context-kit to see them\.$/,
      ),
      "warning",
    ];
    expect(notify.mock.calls).toEqual([
      warning,
      warning,
      [
        expect.stringMatching(
          /^pi-context-kit: automatic cleanup at 75%, with balanced\. Settings: \/context-kit$/,
        ),
        "info",
      ],
    ]);
  });

  it("shows a settings problem without terminal control sequences", async () => {
    const { session } = await start([], 200_000, true, {
      "a\x1b]52;c;ZQ==\x07b\x9b": 1,
    });
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    expect(notify.mock.calls).toEqual([
      [
        "pi-context-kit settings need attention: Invalid global context-kit settings: unknown option ab. Type /context-kit to see them.",
        "warning",
      ],
    ]);
  });

  it("reports an unreadable session override and keeps the other settings", async () => {
    const { session } = await start([], 200_000, true, { strategy: "frugal" });
    session.sessionManager.appendCustomEntry("pi-context-kit-settings", {
      version: 2,
    });
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await session.prompt("/context-kit");
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(
        /^pi-context-kit settings need attention: Invalid context-kit session settings\. /,
      ),
      "warning",
    );
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringMatching(/^pi-context-kit: automatic cleanup at .+, with frugal\./),
      "info",
    );
  });

  it("updates the status after a compaction at turn end", async () => {
    // The last reply passes the threshold, so no later turn refreshes the status.
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done ".repeat(5_000)),
    ];
    const reply: FauxResponseStep = (context) =>
      JSON.stringify(context.messages.at(-1)).includes("handoff note")
        ? fauxAssistantMessage("## Goal\nNote")
        : (main.shift() ?? fauxAssistantMessage("extra"));
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      200_000,
      true,
      {
        threshold: 10_000,
        background: false,
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    const compacted = () =>
      session.sessionManager.getBranch().some((entry) => entry.type === "compaction");
    const statuses: [string, boolean][] = [];
    const setStatus = (key: string, text: string | undefined) => {
      if (key === "context-kit") statuses.push([text ?? "", compacted()]);
    };
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), setStatus },
    });
    await session.prompt("Read b.ts and answer");
    expect(
      session.sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    expect(main).toHaveLength(0);
    expect(statuses.at(-1)).toEqual([expect.stringMatching(/^Context \d% · cleanup at 5%$/), true]);
  });

  it("replaces an older read when that brings the context below the threshold", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      { threshold: 8_000, methodOrder: [] },
    );
    await session.prompt("Read b.ts twice");
    const edits = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "context_edit");
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(session.sessionManager.buildSessionProjection().messages)).toContain(
      "[Superseded by a newer read of this file]",
    );
  });

  it.each([
    [4, 1],
    [10, 0],
  ])("takes threshold %i%% as a share of the context window", async (percent, edits) => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      { threshold: `${percent}%`, methodOrder: [] },
    );
    await session.prompt("Read b.ts twice");
    expect(
      session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit"),
    ).toHaveLength(edits);
  });

  // An edit without compaction costs the provider cache again at each turn above the threshold.
  it("keeps an older read above the threshold when nothing compacts", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      { threshold: 1_000, methodOrder: [] },
    );
    await session.prompt("Read a.ts twice");
    expect(
      session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit"),
    ).toEqual([]);
  });

  it("compacts with a handoff note from the live context and Pi's file sections", async () => {
    let turnOptions: SimpleStreamOptions | undefined;
    let handoffOptions: SimpleStreamOptions | undefined;
    let handoffMessages = 0;
    const { session } = await start([
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("first done"),
      (_context, options) => {
        turnOptions = options;
        return fauxAssistantMessage("second done");
      },
      (context, options) => {
        handoffOptions = options;
        handoffMessages = context.messages.length;
        return fauxAssistantMessage("## Goal\nKeep going");
      },
    ]);
    await session.prompt("Read a.ts");
    await session.prompt("Continue");
    const live = session.sessionManager.buildSessionProjection().messages.length;
    const result = await session.compact("the next step");

    // Anthropic drops the cached message prefix when thinking or tool_choice differ.
    expect(turnOptions?.reasoning).toBe("high");
    expect(handoffOptions?.reasoning).toBe(turnOptions?.reasoning);
    expect(handoffOptions?.toolChoice).toBe(turnOptions?.toolChoice);
    expect(handoffOptions?.maxTokens).toBe(4_096);
    expect(handoffMessages).toBe(live + 1);
    expect(result.summary).toBe("## Goal\nKeep going\n\n<read-files>\na.ts\n</read-files>");
    expect(result.details).toEqual({ readFiles: ["a.ts"], modifiedFiles: [] });
  });

  it("includes all active system instructions in the retained handoff budget", async () => {
    let notes = 0;
    const { session } = await start(
      [
        fauxAssistantMessage("first done"),
        fauxAssistantMessage("second done"),
        (context) => {
          if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) notes++;
          return fauxAssistantMessage("## Goal\nSummary");
        },
        fauxAssistantMessage("## Current turn\nContinue"),
      ],
      200_000,
      true,
      { threshold: 13_000, background: false },
    );
    await session.prompt(`Remember ${"history ".repeat(1_500)}`);
    await session.prompt("Continue");
    session.sessionManager.appendMessage({
      role: "system",
      content: "x".repeat(48_000),
      timestamp: Date.now(),
    });
    session.sessionManager.appendMessage({
      role: "system",
      content: "Additional instructions",
      timestamp: Date.now(),
    });
    await session.compact();
    expect(notes).toBe(0);
  });

  it("falls back to Pi's summary when the handoff request fails", async () => {
    let summaryIsHandoff: boolean | undefined;
    const { session } = await start([
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("hello"),
      fauxAssistantMessage("again"),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "no tool choice",
      }),
      (context) => {
        summaryIsHandoff = JSON.stringify(context).includes("handoff note");
        return fauxAssistantMessage("## Goal\nPi summary");
      },
    ]);
    await session.prompt("Hi");
    await session.prompt("Again");
    const result = await session.compact();
    expect(summaryIsHandoff).toBe(false);
    expect(result.summary).toContain("Pi summary");
    expect(result.details).toBeDefined();
  });

  it("shows a failed handoff's error text without terminal control sequences", async () => {
    const { session } = await start([
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("hello"),
      fauxAssistantMessage("again"),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage:
          "no tool\x1b]8;;https://evil.example\x07link\x1b]8;;\x07 \x1b]52;c;ZXZpbA==\x07ok\x9b\rnext\x1b[2J\tend\x1b",
      }),
      fauxAssistantMessage("## Goal\nPi summary"),
    ]);
    const notify = vi.fn<ExtensionUIContext["notify"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await session.prompt("Hi");
    await session.prompt("Again");
    await session.compact();
    expect(notify.mock.calls).toEqual([
      [
        "pi-context-kit: handoff note failed (no toollink ok\nnext\tend). Pi's summary is used instead.",
        "warning",
      ],
    ]);
  });

  it("reuses a ready early note at manual compaction near the threshold", async () => {
    const noteMessages: number[] = [];
    const notes: string[] = [];
    const main = [
      ...Array.from({ length: 3 }, () =>
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      ),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("second done"),
    ];
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        noteMessages.push(context.messages.length);
        const note = notes.length === 0 ? "Background note" : "Fresh note";
        notes.push(note);
        return fauxAssistantMessage(`## Goal\n${note}`);
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      19_000,
      true,
      {
        threshold: "pi",
        background: true,
        supersedeReads: false,
        pruneEnabled: false,
        progressRatio: 1,
      },
    );
    await session.prompt("Read the file");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notes).toHaveLength(1);
    expect(
      session.sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(0);
    await session.prompt("Continue");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notes).toHaveLength(1);
    const live = session.sessionManager.buildSessionProjection().messages.length;
    const result = await session.compact();

    expect(notes).toEqual(["Background note"]);
    expect(noteMessages[0]).toBeLessThan(live + 1);
    expect(result.summary).toMatch(/^## Goal\nBackground note/);
  });

  it.each(["tree", "reload", "disable", "abort"])(
    "cancels an unfinished background note on %s",
    async (action) => {
      const main = [
        ...Array.from({ length: 3 }, () =>
          fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        ),
        fauxAssistantMessage("done"),
        fauxAssistantMessage("", {
          stopReason: action === "abort" ? "aborted" : "stop",
        }),
      ];
      let noteSignal: AbortSignal | undefined;
      const reply: FauxResponseStep = (context, options) => {
        if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
          const signal = options?.signal;
          if (!signal) throw new Error("missing note cancellation signal");
          noteSignal = signal;
          return new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
              { once: true },
            );
          });
        }
        const next = main.shift();
        if (!next) throw new Error("unexpected request");
        return next;
      };
      const { session, agentDir } = await start(
        Array.from({ length: 8 }, () => reply),
        19_000,
        true,
        {
          threshold: "pi",
          supersedeReads: false,
          pruneEnabled: false,
          progressRatio: 1,
        },
      );
      await session.prompt("Read b.ts three times");
      expect(noteSignal?.aborted).toBe(false);
      try {
        if (action === "reload") await session.reload();
        else if (action === "disable" || action === "abort") {
          if (action === "disable") writeContextKitSettings(agentDir, { enabled: false });
          await session.prompt("Continue");
        } else {
          const target = session.sessionManager
            .getBranch()
            .find((entry) => entry.type === "message" && entry.message.role === "assistant");
          if (!target) throw new Error("missing tree navigation target");
          if ((await session.navigateTree(target.id)).cancelled)
            throw new Error("tree navigation cancelled");
        }
        expect(noteSignal?.aborted).toBe(true);
      } finally {
        await session.reload();
      }
    },
  );

  it.each(["pi", 16_000])(
    "tries shake at Pi's threshold instead of waiting with threshold %s",
    async (threshold) => {
      const main = [
        ...Array.from({ length: 4 }, () =>
          fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        ),
        fauxAssistantMessage("done"),
      ];
      let noteSignal: AbortSignal | undefined;
      let notes = 0;
      const reply: FauxResponseStep = (context, options) => {
        const last = JSON.stringify(context.messages.at(-1));
        if (last.includes("handoff note")) {
          notes++;
          const signal = options?.signal;
          if (!signal) throw new Error("missing note cancellation signal");
          noteSignal = signal;
          return new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
              },
              { once: true },
            );
          });
        }
        if (last.includes("summary")) return fauxAssistantMessage("## Goal\nPi summary");
        const next = main.shift();
        if (!next) throw new Error("unexpected request");
        return next;
      };
      const { session, cwd } = await start(
        Array.from({ length: 12 }, () => reply),
        17_500,
        true,
        {
          threshold,
          supersedeReads: false,
          pruneEnabled: false,
          shakeProtectTokens: 0,
          shakeMinSavings: 1,
          shakeBlockMinTokens: 10,
        },
      );
      writeFileSync(join(cwd, "b.ts"), `<log>${"b".repeat(19_000)}</log>`);
      await session.prompt("Read b.ts four times");
      expect(notes).toBe(1);
      expect(noteSignal?.aborted).toBe(true);
      const branch = session.sessionManager.getBranch();
      expect(branch.some((entry) => entry.type === "context_edit")).toBe(true);
      expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(0);
      expect(JSON.stringify(session.messages.at(-1))).toContain("done");
    },
  );

  it("does not start a background note after an aborted response", async () => {
    let notes = 0;
    const { session, agentDir } = await start(
      [
        fauxAssistantMessage("ready"),
        fauxAssistantMessage("t".repeat(4_000)),
        fauxAssistantMessage("", { stopReason: "aborted" }),
        () => {
          notes++;
          return fauxAssistantMessage("## Goal\nBackground note");
        },
      ],
      200_000,
      true,
      { threshold: 20_000, background: false },
    );
    await session.prompt("Start");
    const tokens = session.getContextUsage()?.tokens;
    if (tokens == null) throw new Error("missing context usage");
    await session.prompt("x".repeat((18_000 - tokens) * 4));
    writeContextKitSettings(agentDir, { threshold: 20_000 });
    await session.prompt("Continue");
    expect(notes).toBe(0);
  });

  it("leaves overflow recovery to Pi when a background note is ready", async () => {
    const main = [
      fauxAssistantMessage("ready"),
      fauxAssistantMessage("background work may start ".repeat(200)),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "prompt is too long: 300000 tokens > 200000 maximum",
      }),
      fauxAssistantMessage("recovered turn"),
    ];
    let notes = 0;
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("## Goal\nBackground note");
      }
      if (last.includes("<conversation>")) return fauxAssistantMessage("## Goal\nPi summary");
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 10 }, () => reply),
      200_000,
      true,
      {
        threshold: 20_000,
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt("Start");
    const tokens = session.getContextUsage()?.tokens;
    if (tokens == null) throw new Error("missing context usage");
    await session.prompt("x".repeat((18_000 - tokens) * 4));
    await new Promise((resolve) => setImmediate(resolve));
    expect(notes).toBe(1);
    await session.prompt(`Continue ${"y".repeat(24_000)}`);
    expect(JSON.stringify(session.messages.at(-1))).toContain("recovered turn");
    expect(main).toHaveLength(0);
  });

  it("uses a fresh note at manual compaction when no early note is ready", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("second done"),
    ];
    let notes = 0;
    let noteMessages = 0;
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        notes++;
        noteMessages = context.messages.length;
        return fauxAssistantMessage("## Goal\nBackground note");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    // An 8,000-token threshold has a 1,000-token lead, not an 8,192-token floor.
    const { session } = await start(
      Array.from({ length: 6 }, () => reply),
      9_000,
      true,
      {
        threshold: "pi",
      },
    );
    await session.prompt("Read a.ts");
    await session.prompt("Continue");
    const live = session.sessionManager.buildSessionProjection().messages.length;
    const result = await session.compact();

    expect(notes).toBe(1);
    // The manual compaction writes from the current live context.
    expect(noteMessages).toBe(live + 1);
    expect(result.summary).toMatch(/^## Goal\nBackground note\n\n<read-files>/);
    const kept = session.sessionManager.getEntry(result.firstKeptEntryId);
    expect(kept?.type === "message" && kept.message.role).toBe("assistant");
  });

  it("does nothing when context-kit enabled is false", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      { enabled: false },
    );
    const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
    await session.bindExtensions({
      uiContext: { ...session.extensionRunner.getUIContext(), setStatus },
    });
    await session.prompt("Read a.ts twice");
    expect(setStatus).toHaveBeenLastCalledWith("context-kit", "Context cleanup off");
    expect(
      session.sessionManager.getBranch().filter((entry) => entry.type === "context_edit"),
    ).toEqual([]);
  });

  it("uses Pi's summary when methodOrder puts soft first", async () => {
    let handoffRequested = false;
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage("hello"),
        fauxAssistantMessage("again"),
        (context) => {
          handoffRequested = JSON.stringify(context).includes("handoff note");
          return fauxAssistantMessage("## Goal\nPi summary");
        },
      ],
      200_000,
      true,
      { methodOrder: ["soft", "handoff"] },
    );
    await session.prompt("Hi");
    await session.prompt("Again");
    const result = await session.compact();
    expect(handoffRequested).toBe(false);
    expect(result.summary).toContain("Pi summary");
  });

  it("compacts at an early threshold and continues with the latest tool result", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    const requests: string[] = [];
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note"))
        return fauxAssistantMessage("## Goal\nContinue the inspection");
      requests.push(JSON.stringify(context.messages));
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      200_000,
      true,
      {
        threshold: 13_000,
        background: false,
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt(`Read b.ts then a.ts. ${"history ".repeat(5_000)}`);
    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.fromHook).toBe(true);
    expect(requests.at(-1)).toContain("Continue the inspection");
    expect(requests.at(-1)).toContain("export const a = 1;");
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("compacts with Pi's summary at an early threshold when the note fails", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note"))
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "note failed",
        });
      if (last.includes("<conversation>")) return fauxAssistantMessage("## Goal\nPi summary");
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      200_000,
      true,
      {
        threshold: 13_000,
        background: false,
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt(`Read b.ts then a.ts. ${"history ".repeat(5_000)}`);
    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.summary).toContain("Pi summary");
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("does not retry a failed note when Pi compacts at its own threshold", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "note failed",
        });
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      15_000,
      true,
      {
        threshold: "pi",
        background: false,
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt(`Read b.ts. ${"history ".repeat(4_500)}`);
    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(notes).toBe(1);
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.fromHook).toBe(false);
  });

  it("compacts in the turn that passes an early threshold without a note in progress", async () => {
    const main = [
      ...Array.from({ length: 3 }, () =>
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      ),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    const requests: string[] = [];
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("## Goal\nContinue the inspection");
      }
      requests.push(JSON.stringify(context.messages));
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      200_000,
      true,
      {
        threshold: 13_000,
        background: true,
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt("Read b.ts three times");
    expect(notes).toBe(1);
    expect(
      session.sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(1);
    expect(requests.at(-1)).toContain("Continue the inspection");
  });

  it("cancels an unfinished note when /compact asks for a focus", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    let noteSignal: AbortSignal | undefined;
    let abortedBeforeFocus: boolean | undefined;
    const reply: FauxResponseStep = (context, options) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        notes++;
        if (notes > 1) {
          abortedBeforeFocus = noteSignal?.aborted;
          return fauxAssistantMessage("## Goal\nFocused note");
        }
        const signal = options?.signal;
        if (!signal) throw new Error("missing note cancellation signal");
        noteSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
        });
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 12 }, () => reply),
      200_000,
      true,
      {
        threshold: 12_000,
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt("Read b.ts twice, then a.ts");
    expect(noteSignal?.aborted).toBe(false);
    const result = await session.compact("the next step");
    expect(abortedBeforeFocus).toBe(true);
    expect(notes).toBe(2);
    expect(result.summary).toContain("Focused note");
  });

  it("waits for an unfinished note at an early threshold instead of compacting", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    let summaries = 0;
    let noteSignal: AbortSignal | undefined;
    const reply: FauxResponseStep = (context, options) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        const signal = options?.signal;
        if (!signal) throw new Error("missing note cancellation signal");
        noteSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
        });
      }
      if (last.includes("<conversation>")) {
        summaries++;
        return fauxAssistantMessage("## Goal\nPi summary");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 12 }, () => reply),
      200_000,
      true,
      {
        threshold: 12_000,
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    try {
      await session.prompt("Read b.ts twice, then a.ts");
      expect(notes).toBe(1);
      expect(noteSignal?.aborted).toBe(false);
      expect(summaries).toBe(0);
      expect(
        session.sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(JSON.stringify(session.messages.at(-1))).toContain("done");
    } finally {
      await session.reload();
    }
  });

  it.each([
    ["soft is not in methodOrder", 200_000, ["handoff", "shake"]],
    ["the threshold equals Pi's", 14_000, ["soft"]],
  ])("writes no early summary when %s", async (_, contextWindow, order) => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note"))
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "note failed",
        });
      if (last.includes("<conversation>")) return fauxAssistantMessage("## Goal\nPi summary");
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      contextWindow,
      true,
      {
        threshold: 13_000,
        methodOrder: order,
        background: false,
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt(`Read b.ts then a.ts. ${"history ".repeat(5_000)}`);
    expect(
      session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "compaction" && entry.fromHook),
    ).toEqual([]);
  });

  it("writes no early summary when only the previous summary precedes the retained context", async () => {
    let summaries = 0;
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("<conversation>")) {
        summaries++;
        return fauxAssistantMessage("## Goal\nPi summary");
      }
      return fauxAssistantMessage("done");
    };
    const { session } = await start(
      Array.from({ length: 4 }, () => reply),
      200_000,
      true,
      { threshold: 13_000, methodOrder: ["soft"] },
      50_000,
    );
    await session.prompt("Hi");
    const first = session.sessionManager.getBranch().find((entry) => entry.type === "message");
    session.sessionManager.appendCompaction(
      `## Goal\n${"old ".repeat(12_000)}`,
      first?.id ?? null,
      0,
    );
    await session.prompt("Again");
    expect(summaries).toBe(0);
  });

  it("updates the previous summary in an early summary", async () => {
    const main = [
      fauxAssistantMessage("hello"),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done"),
    ];
    let request = "";
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("<conversation>")) {
        request = last;
        return fauxAssistantMessage("## Goal\nPi summary");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 6 }, () => reply),
      200_000,
      true,
      {
        threshold: 13_000,
        methodOrder: ["soft"],
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt("Hi");
    const first = session.sessionManager.getBranch().find((entry) => entry.type === "message");
    session.sessionManager.appendCompaction("## Goal\nOld goal", first?.id ?? null, 0);
    await session.prompt(`Read b.ts. ${"history ".repeat(5_000)}`);
    expect(request).toContain("<previous-summary>");
    expect(request).toContain("Old goal");
  });

  it("bounds an early summary's output by the room the retained context leaves", async () => {
    const main = [
      fauxAssistantMessage("hello"),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done"),
    ];
    let summaryOptions: SimpleStreamOptions | undefined;
    const reply: FauxResponseStep = (context, options) => {
      if (JSON.stringify(context.messages.at(-1)).includes("<conversation>")) {
        summaryOptions = options;
        return fauxAssistantMessage("## Goal\nPi summary");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 6 }, () => reply),
      200_000,
      true,
      {
        threshold: 12_000,
        methodOrder: ["soft"],
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt("Hi");
    await session.prompt(`Read b.ts. ${"history ".repeat(5_000)}`);
    // The room under 12,000 * progressRatio 0.8 = 9,600 tokens, after the retained system prompt
    // and recent turns, is below the model's 4,096-token maximum.
    expect(summaryOptions?.maxTokens).toBeGreaterThan(0);
    expect(summaryOptions?.maxTokens).toBeLessThan(4_096);
  });

  it("does not retry a failed early summary every turn", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    let summaries = 0;
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("<conversation>")) {
        summaries++;
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "summary failed",
        });
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      200_000,
      true,
      {
        threshold: 13_000,
        methodOrder: ["soft"],
        supersedeReads: false,
        pruneEnabled: false,
      },
    );
    await session.prompt(`Read b.ts then a.ts. ${"history ".repeat(5_000)}`);
    expect(summaries).toBe(1);
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("falls back to Pi when a fresh note exceeds the retained-context budget", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage("first done"),
        fauxAssistantMessage("second done ".repeat(500)),
        fauxAssistantMessage("oversized ".repeat(20_000)),
        fauxAssistantMessage("## Goal\nPi summary"),
        fauxAssistantMessage("## Current turn\nContinue"),
      ],
      40_000,
      true,
      { background: false },
    );
    await session.prompt(`Remember ${"history ".repeat(1_500)}`);
    await session.prompt("Continue");
    const result = await session.compact();
    expect(result.summary).toContain("Pi summary");
    expect(result.summary).not.toContain("oversized");
  });

  it("skips an automatic handoff when retained context cannot fit its target", async () => {
    let noteRequested = false;
    const { session } = await start(
      [
        fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        (context) => {
          noteRequested = JSON.stringify(context.messages).includes("handoff note");
          return fauxAssistantMessage("done");
        },
      ],
      200_000,
      true,
      { threshold: 4_000, background: false, progressRatio: 1 },
    );
    await session.prompt("Read a.ts then b.ts");

    expect(noteRequested).toBe(false);
    expect(session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(
      false,
    );
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("does not retry notes that cannot fit the retained context", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    const reply: FauxResponseStep = (context) => {
      if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "note failed",
        });
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 5 }, () => reply),
      200_000,
      true,
      {
        threshold: 4_000,
        background: false,
        progressRatio: 1,
      },
    );
    await session.prompt("Read b.ts then a.ts");

    expect(notes).toBe(0);
    expect(session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(
      false,
    );
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it.each([19_000, 200_000])(
    "shakes after a failed handoff with a %i-token context window",
    async (contextWindow) => {
      const main = [
        fauxAssistantMessage(["```ts", "x".repeat(56_000), "```"].join("\n")),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("done"),
      ];
      let notes = 0;
      const reply: FauxResponseStep = (context) => {
        if (JSON.stringify(context.messages.at(-1)).includes("handoff note")) {
          notes++;
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "handoff unavailable",
          });
        }
        const next = main.shift();
        if (!next) throw new Error("unexpected request");
        return next;
      };
      const { session } = await start(
        Array.from({ length: 8 }, () => reply),
        contextWindow,
        true,
        {
          threshold: 18_000,
          background: false,
          pruneEnabled: false,
          shakeProtectTokens: 0,
          shakeMinSavings: 1,
          shakeBlockMinTokens: 10,
        },
      );
      await session.prompt("Generate the source");
      await session.prompt("Read b.ts");
      const branch = session.sessionManager.getBranch();
      expect(notes).toBe(1);
      expect(branch.filter((entry) => entry.type === "context_edit")).toHaveLength(1);
      expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(0);
      expect(JSON.stringify(session.messages.at(-1))).toContain("done");
    },
  );

  it("shakes before soft when methodOrder puts shake first", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage([
          {
            type: "text",
            text: ["```ts", "x".repeat(40_000), "```"].join("\n"),
          },
          fauxToolCall("read", { path: "a.ts" }),
        ]),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      {
        threshold: 8_000,
        methodOrder: ["shake", "soft", "handoff"],
        background: false,
        pruneEnabled: false,
        shakeProtectTokens: 0,
        shakeMinSavings: 1,
        shakeBlockMinTokens: 10,
      },
    );
    await session.prompt("Inspect the file");
    expect(session.sessionManager.getBranch().some((entry) => entry.type === "context_edit")).toBe(
      true,
    );
  });

  it("does not shake when pruning alone brings the context under the threshold", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage([
          {
            type: "text",
            text: ["```ts", "x = 1;".repeat(2_800), "```"].join("\n"),
          },
          fauxToolCall("read", { path: "b.ts" }),
        ]),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      {
        threshold: 8_000,
        background: false,
        pruneProtectTokens: 0,
        pruneMinSavings: 1,
        pruneMinTokens: 50,
        shakeProtectTokens: 0,
        shakeMinSavings: 1,
        shakeBlockMinTokens: 10,
      },
    );
    await session.prompt("Read b.ts");
    const replacements = session.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "context_edit" ? [JSON.stringify(entry.replacement)] : [],
      );
    expect(replacements.some((text) => text.includes("Output pruned"))).toBe(true);
    expect(replacements.some((text) => text.includes("Elided block"))).toBe(false);
  });

  it("does not shake when replacing old reads alone brings the context under the threshold", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage([
          {
            type: "text",
            text: ["```ts", "x = 1;".repeat(2_800), "```"].join("\n"),
          },
          fauxToolCall("read", { path: "b.ts" }),
        ]),
        fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      {
        threshold: 11_000,
        background: false,
        pruneEnabled: false,
        shakeProtectTokens: 0,
        shakeMinSavings: 1,
        shakeBlockMinTokens: 10,
      },
    );
    await session.prompt("Read b.ts twice");
    const branch = session.sessionManager.getBranch();
    const replacements = branch.flatMap((entry) =>
      entry.type === "context_edit" ? [JSON.stringify(entry.replacement)] : [],
    );
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toContain("Superseded by a newer read");
    expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(0);
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("does not shake before soft when methodOrder puts soft first", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage([
          {
            type: "text",
            text: ["```ts", "x".repeat(40_000), "```"].join("\n"),
          },
          fauxToolCall("read", { path: "a.ts" }),
        ]),
        fauxAssistantMessage("done"),
      ],
      200_000,
      true,
      {
        threshold: 8_000,
        methodOrder: ["soft", "shake", "handoff"],
        background: false,
        pruneEnabled: false,
        shakeProtectTokens: 0,
        shakeMinSavings: 1,
        shakeBlockMinTokens: 10,
      },
    );
    await session.prompt("Inspect the file");
    expect(session.sessionManager.getBranch().some((entry) => entry.type === "context_edit")).toBe(
      false,
    );
  });

  it.each([
    ["handoff", "shake", "soft"],
    ["handoff", "soft", "shake"],
    ["shake", "handoff", "soft"],
    ["shake", "soft", "handoff"],
    ["soft", "handoff", "shake"],
    ["soft", "shake", "handoff"],
  ])("honors automatic priority %s, %s, %s", async (first, second, third) => {
    const main = [
      fauxAssistantMessage(["```ts", "x".repeat(56_000), "```"].join("\n")),
      fauxAssistantMessage(fauxToolCall("read", { path: "b.ts" })),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    let summaries = 0;
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("## Goal\nContinue the inspection");
      }
      if (last.includes("<conversation>")) {
        summaries++;
        return fauxAssistantMessage("## Goal\nPi summary");
      }
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      200_000,
      true,
      {
        threshold: 18_000,
        methodOrder: [first, second, third],
        background: false,
        pruneEnabled: false,
        shakeProtectTokens: 0,
        shakeMinSavings: 1,
        shakeBlockMinTokens: 10,
      },
    );
    await session.prompt("Generate the source");
    await session.prompt("Read b.ts");
    const branch = session.sessionManager.getBranch();
    expect(notes).toBe(first === "handoff" ? 1 : 0);
    expect(summaries).toBe(first === "soft" ? 1 : 0);
    expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(
      first === "shake" ? 0 : 1,
    );
    expect(branch.filter((entry) => entry.type === "context_edit")).toHaveLength(
      first === "shake" ? 1 : 0,
    );
    expect(JSON.stringify(session.messages.at(-1))).toContain("done");
  });

  it("preserves ranges beyond Pi's truncated full read", async () => {
    const { session, cwd } = await start([
      fauxAssistantMessage(fauxToolCall("read", { path: "long.txt", offset: 2_501, limit: 10 })),
      fauxAssistantMessage(fauxToolCall("read", { path: "long.txt" })),
      fauxAssistantMessage("done"),
    ]);
    writeFileSync(
      join(cwd, "long.txt"),
      `${Array.from({ length: 2_500 }, (_, i) => `line ${i + 1}`).join("\n")}\nTAIL-UNIQUE`,
    );
    await session.prompt("Read the end and the beginning");
    const branch = session.sessionManager.getBranch();
    expect(JSON.stringify(branch)).toContain("TAIL-UNIQUE");
    expect(
      branch.some(
        (entry) =>
          entry.type === "context_edit" &&
          JSON.stringify(entry).includes("Superseded by a newer read"),
      ),
    ).toBe(false);
  });

  it("uses the projected retained tail after compaction edits", async () => {
    const { session } = await start(
      [
        fauxAssistantMessage(`continued one ${"c".repeat(16_000)}`),
        fauxAssistantMessage(`continued two ${"d".repeat(12_000)}`),
        (context) => {
          if (JSON.stringify(context.messages).includes("handoff note"))
            return fauxAssistantMessage("## Goal\nSecond note");
          throw new Error("unexpected non-handoff request");
        },
      ],
      200_000,
      true,
      {
        threshold: 13_000,
        background: false,
        progressRatio: 1,
        pruneEnabled: false,
      },
      8_000,
    );
    const manager = session.sessionManager;
    const retainedIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      manager.appendMessage({
        role: "user",
        content: `history prompt ${i}`,
        timestamp: Date.now(),
      });
      const id = manager.appendMessage(fauxAssistantMessage(`history-${i} ${"h".repeat(8_000)}`));
      if (i >= 3) retainedIds.push(id);
    }
    const firstRetainedId = retainedIds.at(0);
    if (!firstRetainedId) throw new Error("expected retained history");
    manager.appendCompaction("## Goal\nPrevious summary", firstRetainedId, 30_000);
    manager.appendContextEdit(firstRetainedId, {
      content: [{ type: "text", text: "edited retained history" }],
    });
    manager.appendMessage({
      role: "user",
      content: "Continue from the retained history",
      timestamp: Date.now(),
    });

    await session.prompt("Continue once");
    await session.prompt("Continue again");
    const compactions = manager.getBranch().filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(2);
    const latest = compactions.at(-1);
    expect(latest?.type).toBe("compaction");
    expect(retainedIds).toContain(
      latest?.type === "compaction" ? latest.firstKeptEntryId : undefined,
    );
  });

  it("lets the model recall raw text removed by a context edit", async () => {
    const { session } = await start([
      fauxAssistantMessage("stored"),
      fauxAssistantMessage(fauxToolCall("recall", { query: "RECALL-MARKER" })),
      fauxAssistantMessage("found"),
    ]);
    await session.prompt("Remember RECALL-MARKER");
    const entry = session.sessionManager
      .getBranch()
      .find((candidate) => candidate.type === "message" && candidate.message.role === "user");
    if (!entry) throw new Error("missing user message");
    session.sessionManager.appendContextEdit(entry.id, { content: "[elided]" });
    expect(JSON.stringify(session.sessionManager.buildSessionProjection().messages)).not.toContain(
      "RECALL-MARKER",
    );
    await session.prompt("Find the original message");
    const result = session.messages.find((message) => message.role === "toolResult");
    expect(result?.role === "toolResult" && result.isError).toBe(false);
    expect(JSON.stringify(result)).toContain(`${entry.id} user: Remember RECALL-MARKER`);
  });

  it("leaves an overflow without a ready note to Pi's summary", async () => {
    const main = [
      fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" })),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "prompt is too long: 300000 tokens > 200000 maximum",
      }),
      fauxAssistantMessage("done"),
    ];
    let notes = 0;
    const reply: FauxResponseStep = (context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("handoff note")) {
        notes++;
        return fauxAssistantMessage("## Goal\nNote");
      }
      if (last.includes("<conversation>")) return fauxAssistantMessage("## Goal\nPi summary");
      const next = main.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    };
    const { session } = await start(
      Array.from({ length: 8 }, () => reply),
      200_000,
      true,
      {
        background: false,
      },
    );
    await session.prompt("Read a.ts");
    const compactions = session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(notes).toBe(0);
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.fromHook).toBe(false);
  });

  it("returns an error to the model when recall gets no query or entryId", async () => {
    const { session } = await start([
      fauxAssistantMessage(fauxToolCall("recall", {})),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Recall something");
    const result = session.messages.find((message) => message.role === "toolResult");
    expect(result?.role === "toolResult" && result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Pass query or entryId.");
  });
});
