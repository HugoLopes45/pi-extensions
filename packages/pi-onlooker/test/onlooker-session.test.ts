import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  DefaultResourceLoader,
  createAgentSessionFromServices,
  AgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createCodemodeExtension,
  defineTool,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { onTestFinished, describe, expect, it } from "vitest";

import { onlookerGuidance } from "../src/onlooker-guidance.js";
import { createOnlookerSession, disposeOnlookerSession } from "../src/onlooker-session.js";
import { onlookerPrompt, onlookerSettings } from "../src/onlooker-settings.js";

const fixture = fileURLToPath(new URL("./fixtures/session-extension.ts", import.meta.url));
const adviceTool = defineTool({
  name: "onlooker_report",
  label: "Advice",
  description: "Finish review",
  parameters: Type.Object({}),
  async execute() {
    return {
      content: [{ type: "text", text: "Done" }],
      details: {},
      terminate: true,
    };
  },
});

async function observedFixture(
  paths = [fixture],
  suppliedSettings?: SettingsManager,
  ownedLoader = false,
  suppliedRuntime?: ModelRuntime,
  extensionFactories: InlineExtension[] = [],
) {
  const dir = await mkdtemp(join(tmpdir(), "onlooker-sdk-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const settings =
    suppliedSettings ??
    SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
  const modelRuntime =
    suppliedRuntime ??
    (await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    }));
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    modelRuntime,
    resourceLoaderOptions: {
      noExtensions: false,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
      additionalExtensionPaths: paths,
      extensionFactories,
    },
  });
  if (ownedLoader) {
    class FileSelectionLoader extends DefaultResourceLoader {}
    services.resourceLoader = new FileSelectionLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      additionalExtensionPaths: paths,
      extensionsOverride: (loaded) => ({
        ...loaded,
        extensions: loaded.extensions.filter(
          (extension) => !extension.path.endsWith("coordinator.ts"),
        ),
      }),
    });
    await services.resourceLoader.reload();
  }
  const model = modelRuntime.getModel("onlooker-fixture", "reviewer");
  if (!model) throw new Error("Fixture provider did not load");
  services.resourceLoader.getExtensions().runtime.flagValues.set("fixture-enabled", false);
  const created = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")),
  });
  const runtime = new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("Fixture does not replace sessions");
  });
  await runtime.session.bindExtensions({ mode: "print" });
  onTestFinished(async () => {
    await runtime.session.abort();
    await runtime.dispose();
  });
  return { observed: runtime.session, dir };
}

function entry(session: AgentSessionRuntime["session"], customType: string) {
  return session.sessionManager
    .getBranch()
    .findLast((item) => item.type === "custom" && item.customType === customType);
}

describe("private Onlooker native sessions", () => {
  it("omits the skills catalogue so skill changes keep the Onlooker system prompt stable", async () => {
    const discoverFixture = fileURLToPath(
      new URL("./fixtures/skill-discover-extension.ts", import.meta.url),
    );
    const prompts: string[] = [];
    // Skills arrive both from the agent dir and from an inherited extension's `resources_discover`.
    for (const skills of [[], ["alpha"], ["beta"]]) {
      const { observed, dir } = await observedFixture([fixture, discoverFixture]);
      for (const skill of skills) {
        for (const root of ["skills", "extension-skills"]) {
          await mkdir(join(dir, root, skill), { recursive: true });
          await writeFile(
            join(dir, root, skill, "SKILL.md"),
            `---\nname: ${skill}\ndescription: Observed ${skill} skill\n---\nBody\n`,
          );
        }
      }
      // Without the fix these resources would be loaded into the Onlooker Session.
      const plain = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager: SettingsManager.inMemory(),
      });
      await plain.reload();
      const fixtureSkills = plain
        .getSkills()
        .skills.map((item) => item.name)
        .filter((name) => name === "alpha" || name === "beta");
      expect(fixtureSkills).toEqual(skills);
      const runtime = await createOnlookerSession(observed, {
        config: onlookerSettings.readSettings(observed).settings,
        adviceTool,
      });
      onTestFinished(() => disposeOnlookerSession(runtime));
      expect(runtime.session.getActiveToolNames()).toContain("read");
      expect(runtime.session.resourceLoader.getSkills().skills).toEqual([]);
      const created = runtime.session.systemPrompt.replaceAll(dir, "<dir>");
      await runtime.session.reload();
      expect(runtime.session.resourceLoader.getSkills().skills).toEqual([]);
      expect(runtime.session.systemPrompt.replaceAll(dir, "<dir>")).toBe(created);
      prompts.push(created);
    }
    expect(prompts[1]).toBe(prompts[0]);
    expect(prompts[2]).toBe(prompts[0]);
  });

  it("loads no observed extension and exposes only the protected read tools and the advice tool", async () => {
    const exposures = fileURLToPath(new URL("./fixtures/exposure-extension.ts", import.meta.url));
    const { observed } = await observedFixture(
      [fixture, exposures],
      SettingsManager.inMemory({
        codemode: { mode: "on" },
        compaction: { enabled: false },
      }),
      false,
      undefined,
      [{ name: "codemode", factory: createCodemodeExtension(), builtin: true }],
    );
    const settings = onlookerSettings.readSettings(observed).settings;
    const config = {
      ...settings,
    };
    const runtime = await createOnlookerSession(observed, {
      config,
      adviceTool,
    });
    onTestFinished(() => disposeOnlookerSession(runtime));
    const names = runtime.session.getAllTools().map((tool) => tool.name);
    expect(names.toSorted()).toEqual(["find", "grep", "ls", "onlooker_report", "read"]);
    expect(runtime.session.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(entry(runtime.session, "fixture-start")).toBeUndefined();
  });

  it("appends user then project ONLOOKER.md guidance to the Onlooker Prompt", async () => {
    const { observed, dir } = await observedFixture();
    const agentDir = join(dir, "agent");
    await mkdir(agentDir);
    await mkdir(join(dir, ".pi"));
    await writeFile(join(agentDir, "ONLOOKER.md"), "User rule\n");
    await writeFile(join(dir, "ONLOOKER.md"), "Project rule\n");
    await writeFile(join(dir, ".pi", "ONLOOKER.md"), "Pi dir rule\n");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    onTestFinished(() => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const config = onlookerSettings.readSettings(observed).settings;
    const runtime = await createOnlookerSession(observed, {
      config,
      adviceTool,
    });
    onTestFinished(() => disposeOnlookerSession(runtime));
    const block = (text: string) =>
      `Especially pay attention to:\n<attention>\n${text}\n</attention>`;
    expect(runtime.session.systemPrompt).toContain(
      [onlookerPrompt, block("User rule"), block("Project rule"), block("Pi dir rule")].join(
        "\n\n",
      ),
    );
  });

  it("refuses project guidance symlinks before creating a model session", async () => {
    const { observed, dir } = await observedFixture();
    await writeFile(join(dir, ".env"), "SYNTHETIC-GUIDANCE-SECRET");
    await symlink(".env", join(dir, "ONLOOKER.md"));
    const outcome = await createOnlookerSession(observed, {
      config: onlookerSettings.readSettings(observed).settings,
      adviceTool,
    }).then(
      (runtime) => {
        onTestFinished(() => disposeOnlookerSession(runtime));
        return "created";
      },
      (error: unknown) => String(error),
    );
    expect(outcome).toMatch(/guidance.*symlink/i);
  });

  it("refuses guidance through a symlinked project .pi directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "onlooker-guidance-link-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "ONLOOKER.md"), "SYNTHETIC-PRIVATE-TEXT");
    await symlink("elsewhere", join(root, ".pi"));
    expect(() => onlookerGuidance(root, join(root, "no-agent"))).toThrow(/guidance.*symlink/i);
  });

  it("reads ONLOOKER.md from the git root down to the working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "onlooker-guidance-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const sub = join(root, "repo", "sub");
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    await mkdir(sub);
    await writeFile(join(root, "ONLOOKER.md"), "Outside repo");
    await writeFile(join(root, "repo", "ONLOOKER.md"), "Repo");
    await writeFile(join(sub, "ONLOOKER.md"), "Sub");
    expect(
      onlookerGuidance(sub, join(root, "no-agent")).map((text) => text.split("\n")[2]),
    ).toEqual(["Repo", "Sub"]);
  });

  it("refuses to read secret files of the observed project", async () => {
    const { observed, dir } = await observedFixture();
    await writeFile(join(dir, ".env"), "TOKEN=SECRET-VALUE\n");
    const runtime = await createOnlookerSession(observed, {
      config: onlookerSettings.readSettings(observed).settings,
      adviceTool,
    });
    onTestFinished(() => disposeOnlookerSession(runtime));
    globalThis.onlookerSessionResponses = [{ name: "read", arguments: { path: ".env" } }];
    onTestFinished(() => {
      globalThis.onlookerSessionResponses = undefined;
    });
    await runtime.session.prompt("Review");
    const result = runtime.session.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ role: "toolResult", isError: true });
    expect(JSON.stringify(runtime.session.messages)).not.toContain("SECRET-VALUE");
  });

  it("bounds cancelled creation and shuts down late startup without retaining its signal", async () => {
    const { observed } = await observedFixture();
    const config = onlookerSettings.readSettings(observed).settings;
    await expect(
      createOnlookerSession(observed, {
        config,
        adviceTool,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/abort/i);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    const creating = createOnlookerSession(observed, {
      config,
      adviceTool,
      signal: cancellation.signal,
      controlExtension(pi) {
        pi.on("session_start", async () => {
          started.resolve();
          await release.promise;
        });
        pi.on("session_shutdown", () => {
          stopped.resolve();
        });
      },
    });
    await started.promise;
    cancellation.abort();
    await expect(creating).rejects.toThrow(/abort/i);
    release.resolve();
    await stopped.promise;

    const creationOnly = new AbortController();
    const runtime = await createOnlookerSession(observed, {
      config,
      adviceTool,
      signal: creationOnly.signal,
    });
    onTestFinished(async () => {
      await runtime.session.abort();
      await runtime.dispose();
    });
    creationOnly.abort();
    await runtime.session.prompt("Review");
    expect(runtime.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
  });

  it("honors explicit model and thinking level through the observed model runtime", async () => {
    const { observed } = await observedFixture();
    await observed.modelRuntime.setRuntimeApiKey("onlooker-fixture", "runtime-only-key");
    const config = {
      ...onlookerSettings.readSettings(observed).settings,
      model: "onlooker-fixture/alternate",
      thinkingLevel: "high" as const,
    };
    const runtime = await createOnlookerSession(observed, {
      config,
      adviceTool,
    });
    onTestFinished(async () => {
      await runtime.session.abort();
      await runtime.dispose();
    });
    expect(runtime.session.model?.id).toBe("alternate");
    expect(runtime.session.thinkingLevel).toBe("high");
    expect((await runtime.session.modelRuntime.getAuth("onlooker-fixture"))?.auth.apiKey).toBe(
      "runtime-only-key",
    );
    expect(runtime.session.modelRuntime).toBe(observed.modelRuntime);
    await expect(
      createOnlookerSession(observed, {
        config: { ...config, model: "missing/provider" },
        adviceTool,
      }),
    ).rejects.toThrow(/model.*unavailable/i);
  });
});
