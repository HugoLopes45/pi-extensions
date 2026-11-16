import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
  type Context,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { onTestFinished, expect, it, vi } from "vitest";

import "./fixtures/observer-extension.js";
import { anyInstance, stringContaining } from "./fixtures/matchers.js";

/**
 * Pi 1.1 stamps each assistant message with the wall-clock `durationMs` of its call. Two runtimes
 * differ by a few milliseconds under load, so every transcript compared here zeroes it.
 */
const withStableDuration = <Message extends object>(message: Message): Message =>
  "durationMs" in message ? { ...message, durationMs: 0 } : message;

/** Pi 0.86+ records tool declarations on system messages; compare declarations, not callbacks. */
function sessionTranscript(runtime: AgentSessionRuntime) {
  return runtime.session.messages.map((message) => {
    if (message.role === "system" && message.toolsAdded) {
      return {
        ...message,
        toolsAdded: message.toolsAdded.map((tool) => {
          const { name, description, parameters } = toToolDeclaration(tool);
          return { name, description, parameters };
        }),
      };
    }
    return withStableDuration(message);
  });
}

const isSystem = (message: { role: string }): message is SystemMessage => message.role === "system";
const conversation = <T extends { role: string }>(messages: T[] = []) =>
  messages.filter((message) => !isSystem(message));

/** Current prompt, ordered tools, and conversation after replaying Pi's system deltas. */
function sessionState(runtime: AgentSessionRuntime) {
  const transcript = sessionTranscript(runtime);
  const system = transcript.filter(isSystem);
  return {
    systemPrompt: getCurrentSystemPrompt(system),
    tools: getCurrentTools(system),
    messages: conversation(transcript),
  };
}

/** An observed session with the Onlooker extension, optionally beside built-in codemode. */
async function observedRuntime(
  directory: string,
  codemodeMode: "none" | "on" | "only",
  enabled: boolean,
): Promise<AgentSessionRuntime> {
  const combined = codemodeMode !== "none";
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const document = {
    onlooker: {
      enabled,
    },
    defaultTools: [combined ? "+codemode" : "-codemode"],
    codemode: { mode: codemodeMode === "only" ? ("only" as const) : ("on" as const) },
    compaction: { enabled: false },
    retry: { enabled: false },
  };
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(document),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("./fixtures/observer-extension.ts", import.meta.url)),
        ...(combined ? ["builtin:codemode"] : []),
        fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      ],
      extensionFactories: combined
        ? [{ name: "codemode", factory: createCodemodeExtension(), builtin: true }]
        : [],
    },
  });
  const model = modelRuntime.getModel("observer-fixture", "model");
  if (!model) throw new Error("Missing offline model");
  const created = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.create(directory, join(directory, "sessions")),
  });
  return new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("No replacement");
  });
}

/** Records main and Review requests; each Review reports no finding. */
function recordingStream(
  mainRequests: Context[],
  reviewRequests: Context[],
): typeof globalThis.onlookerObserverTest {
  return {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      (privateRole ? reviewRequests : mainRequests).push(
        structuredClone({
          ...context,
          messages: context.messages.map(withStableDuration),
          tools: (context.tools ?? []).map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        }),
      );
      const message = {
        ...fauxAssistantMessage("Done"),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      if (privateRole) {
        message.content = [
          {
            type: "toolCall",
            id: "report",
            name: "onlooker_report",
            arguments: { severity: "none" },
          },
        ];
        message.stopReason = "toolUse";
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({ type: "done", reason: privateRole ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  };
}

const codemodeModes = ["none", "on", "only"] as const;
type CodemodeMode = (typeof codemodeModes)[number];

/** A disabled and an enabled observed session, each after one task and a status entry. */
async function observedPair(codemodeMode: CodemodeMode) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const directory = await mkdtemp(join(tmpdir(), "onlooker-extension-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const runtimes: AgentSessionRuntime[] = [];
  onTestFinished(async () => {
    for (const runtime of runtimes) {
      await runtime.session.abort();
      await runtime.dispose();
    }
  });
  const mainRequests: Context[] = [];
  const reviewRequests: Context[] = [];
  globalThis.onlookerObserverTest = recordingStream(mainRequests, reviewRequests);
  for (const enabled of [false, true]) {
    const runtime = await observedRuntime(directory, codemodeMode, enabled);
    runtimes.push(runtime);
    await runtime.session.bindExtensions({ mode: "print" });
    await runtime.session.prompt("Do this task.");
    await runtime.session.prompt("/onlooker status");
    expect(
      runtime.session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toMatchObject({
      data: {
        state: enabled ? "armed" : "disabled",
        backlog: 0,
      },
    });
  }
  const [disabled, enabled] = runtimes;
  if (!disabled || !enabled) throw new Error("Missing observed sessions");
  return { disabled, enabled, mainRequests, reviewRequests };
}

const codemodeDescription = (runtime: AgentSessionRuntime) =>
  runtime.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description;

it.each(codemodeModes)(
  "adds only onlooker_ask to the exact main inputs when enabled (built-in codemode: %s)",
  async (codemodeMode) => {
    const { disabled, enabled, mainRequests, reviewRequests } = await observedPair(codemodeMode);
    expect(reviewRequests).toHaveLength(1);
    expect(mainRequests).toHaveLength(2);
    const disabledRequest = mainRequests[0];
    if (!disabledRequest) throw new Error("Missing disabled request");
    const askTool = {
      name: "onlooker_ask",
      description:
        "Ask the Onlooker, a second model that reviews your work, for analysis or a second opinion. Waits for its answer. It reads files but cannot edit them or run commands.",
      parameters: {
        additionalProperties: false,
        properties: { message: { minLength: 1, type: "string" } },
        required: ["message"],
        type: "object",
      },
    };
    // Built-in codemode says how scripts call the tools they can reach.
    const askCall = `${askTool.description}\n\nCodemode: \`tools.onlooker_ask(args)\` resolves to a string.`;
    // `only` lists the full script declaration in the codemode description.
    const askSample = `${askTool.description}\n\ncodemode tool declaration:\n\`\`\`ts\ndeclare const tools: { onlooker_ask(args: {\n  // @minLength 1\n  message: string;\n}): Promise<string>; };\n\`\`\``;
    const declaredAsk = codemodeMode === "on" ? { ...askTool, description: askCall } : askTool;
    // `only` hides direct declarations and lists them in the codemode description instead.
    const scriptedAsk = stringContaining(`### \`onlooker_ask\`\n${askSample}`);
    const withScriptedAsk = (tools: NonNullable<Context["tools"]> = []) =>
      tools.map((tool) =>
        codemodeMode === "only" && tool.name === "codemode"
          ? { ...tool, description: scriptedAsk }
          : tool,
      );
    expect(mainRequests[1]).toEqual({
      ...disabledRequest,
      tools:
        codemodeMode === "only"
          ? withScriptedAsk(disabledRequest.tools)
          : [...(disabledRequest.tools ?? []), declaredAsk],
    });
    const disabledTranscript = sessionTranscript(disabled);
    const [disabledSystem] = disabledTranscript;
    if (disabledSystem?.role !== "system") throw new Error("Missing initial system message");
    expect(sessionTranscript(enabled)).toEqual([
      {
        ...disabledSystem,
        toolsAdded: [...withScriptedAsk(disabledSystem.toolsAdded), declaredAsk],
      },
      ...disabledTranscript.slice(1),
    ]);
    expect(codemodeDescription(enabled) === undefined).toBe(codemodeMode === "none");
    // Annotations are reported to permission extensions only; the exact provider-facing
    // declarations above are unchanged. onlooker_ask only consults; onlooker_report records findings.
    expect(
      enabled.session.getAllTools().find((tool) => tool.name === "onlooker_ask"),
    ).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
  },
  20_000,
);

it.each(codemodeModes)(
  "withdraws only onlooker_ask when disabled (built-in codemode: %s)",
  async (codemodeMode) => {
    const { disabled, enabled, mainRequests, reviewRequests } = await observedPair(codemodeMode);
    for (const runtime of [disabled, enabled]) await runtime.session.prompt("/onlooker off");
    // Disabling withdraws onlooker_ask from scripts too, leaving other listings unchanged.
    expect(codemodeDescription(enabled)).toEqual(codemodeDescription(disabled));
    for (const runtime of [disabled, enabled])
      await runtime.session.prompt("Continue with on-demand advice disabled.");
    expect(mainRequests).toHaveLength(4);
    // Pi 0.99 declares the removed tool with an appended delta instead of rewriting the prefix.
    const [disabledFollowUp, enabledFollowUp] = mainRequests.slice(2);
    // Under `only`, withdrawing onlooker_ask changes the codemode listing, so Pi redeclares codemode
    // after the other declared tools.
    const codemodeLast = (tools: NonNullable<Context["tools"]> = []) => [
      ...tools.filter((tool) => tool.name !== "codemode"),
      ...tools.filter((tool) => tool.name === "codemode"),
    ];
    expect({ ...enabledFollowUp, messages: conversation(enabledFollowUp?.messages) }).toEqual({
      ...disabledFollowUp,
      messages: conversation(disabledFollowUp?.messages),
      ...(codemodeMode === "only" && { tools: codemodeLast(disabledFollowUp?.tools) }),
    });
    const disabledState = sessionState(disabled);
    const disabledCodemode = disabledState.tools.find((tool) => tool.name === "codemode");
    // Under `only`, withdrawing onlooker_ask changes the codemode listing, so Pi redeclares codemode last.
    expect(sessionState(enabled)).toEqual(
      codemodeMode === "only"
        ? {
            ...disabledState,
            tools: [
              ...disabledState.tools.filter((tool) => tool !== disabledCodemode),
              disabledCodemode,
            ],
          }
        : disabledState,
    );
    expect(sessionTranscript(disabled).filter(isSystem)).toHaveLength(1);
    expect(sessionTranscript(enabled).filter(isSystem).slice(1)).toEqual([
      {
        role: "system",
        content: "",
        timestamp: anyInstance(Number),
        ...(codemodeMode === "only"
          ? {
              toolsAdded: [disabledCodemode],
              toolsRemoved: [{ name: "codemode" }, { name: "onlooker_ask" }],
            }
          : { toolsRemoved: [{ name: "onlooker_ask" }] }),
      },
    ]);
    await enabled.session.prompt("/onlooker on");
    await enabled.session.prompt("Recreate the private Onlooker session.");
    expect(reviewRequests).toHaveLength(2);
  },
  20_000,
);

it("pauses with a status error when its model is unavailable", async () => {
  const { enabled } = await observedPair("none");
  await enabled.session.prompt('/onlooker set model "missing/model"');
  await enabled.session.prompt("Continue even if Onlooker cannot resolve its model.");
  expect(
    enabled.session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
  ).toMatchObject({
    data: { state: "paused", error: stringContaining("model is unavailable") },
  });
}, 20_000);
