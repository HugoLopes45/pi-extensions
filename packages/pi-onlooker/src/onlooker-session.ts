import { join } from "node:path";

import type { Api, CacheRetention, Model } from "@earendil-works/pi-ai";
import * as piSdk from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  CreateAgentSessionFromServicesOptions,
  ExtensionFactory,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { onlookerGuidance } from "./onlooker-guidance.js";
import { onlookerPrompt, type OnlookerConfig } from "./onlooker-settings.js";
import { createProtectedReadTools } from "./protected-tools.js";

/** Fresh factories and native services; the observed session supplies data, never bound handlers. */
export interface OnlookerSessionOptions {
  config: OnlookerConfig;
  adviceTool: ToolDefinition;
  controlExtension?: ExtensionFactory;
  signal?: AbortSignal;
}

const roleSchema = Type.Object({
  role: Type.Literal("onlooker"),
  observedSessionId: Type.String({ minLength: 1 }),
});

/**
 * Prompt-cache retention the Onlooker asks for on its own requests. Pi's adapters map `long` to
 * what each API accepts: OpenAI `prompt_cache_retention: "24h"` (`prompt_cache_options` on
 * models with explicit cache modes), which costs nothing extra. Other providers keep Pi's
 * default, which follows `PI_CACHE_RETENTION`: Anthropic's 1h cache writes cost 2× instead of
 * 1.25×, the Codex adapter sends no retention field, and ChatGPT sign-in rejects the OpenAI one.
 */
export function onlookerCacheRetention(
  model: Pick<Model<Api>, "provider">,
): CacheRetention | undefined {
  return model.provider === "openai" ? "long" : undefined;
}

/** Private role is native journal state and is installed before session_start. */
export function isOnlookerSession(manager: Pick<SessionManager, "getBranch">): boolean {
  return manager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "pi-onlooker-role" &&
        Value.Check(roleSchema, entry.data),
    );
}

/** Abort owned work before emitting the native extension shutdown lifecycle. */
export async function disposeOnlookerSession(runtime: AgentSessionRuntime): Promise<void> {
  try {
    await runtime.session.abort();
  } finally {
    await runtime.dispose();
  }
}

/** Create a private native journal without starting model inference. */
export async function createOnlookerSession(
  observed: AgentSession,
  options: OnlookerSessionOptions,
): Promise<AgentSessionRuntime> {
  options.signal?.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () =>
    cancelled.reject(
      options.signal?.reason ?? new DOMException("Onlooker creation aborted", "AbortError"),
    );
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([buildOnlookerSession(observed, options), cancelled.promise]);
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

async function buildOnlookerSession(
  observed: AgentSession,
  options: OnlookerSessionOptions,
): Promise<AgentSessionRuntime> {
  const config = structuredClone(options.config);
  let selectedModel = observed.model;
  if (config.model) {
    const separator = config.model.indexOf("/");
    selectedModel = observed.modelRuntime.getModel(
      config.model.slice(0, separator),
      config.model.slice(separator + 1),
    );
  }
  if (!selectedModel)
    throw new Error(`Onlooker model is unavailable: ${config.model ?? "observed model"}`);
  const model = structuredClone(selectedModel);
  const cwd = observed.sessionManager.getCwd();
  const agentDir = piSdk.getAgentDir();
  const guidance = onlookerGuidance(cwd, agentDir);
  const readTools = createProtectedReadTools(cwd, () => observed.sessionManager.getSessionFile());
  const grants = readTools.map((tool) => tool.name);
  const global = JSON.stringify(observed.settingsManager.getGlobalSettings());
  const project = JSON.stringify(observed.settingsManager.getProjectSettings());
  const factory: CreateAgentSessionRuntimeFactory = async ({
    cwd: sessionCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    if (!isOnlookerSession(sessionManager))
      sessionManager.appendCustomEntry("pi-onlooker-role", {
        role: "onlooker",
        observedSessionId: observed.sessionId,
      });
    const scopes = new Map([
      ["global", global],
      ["project", project],
    ]);
    const settingsManager = piSdk.SettingsManager.fromStorage(
      {
        withLock(scope, update) {
          const next = update(scopes.get(scope));
          if (next !== undefined) scopes.set(scope, next);
        },
      },
      { projectTrusted: observed.settingsManager.isProjectTrusted() },
    );
    // The Onlooker loads no extension, so it registers no provider and can share the observed
    // catalog and credentials, including providers that observed extensions registered.
    const services = await piSdk.createAgentSessionServices({
      cwd: sessionCwd,
      agentDir,
      settingsManager,
      modelRuntime: observed.modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noContextFiles: true,
        // Neither Reviews nor Consultations use skills; the catalogue would only bloat and
        // destabilize the prompt.
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: options.controlExtension
          ? [{ name: "onlooker-control", factory: options.controlExtension }]
          : [],
        systemPromptOverride: () => [onlookerPrompt, ...guidance].join("\n\n"),
        appendSystemPromptOverride: () => [],
      },
    });
    const sessionOptions: CreateAgentSessionFromServicesOptions = {
      services,
      sessionManager,
      model,
      thinkingLevel: config.thinkingLevel,
      tools: [...grants, options.adviceTool.name],
      customTools: [...readTools, options.adviceTool],
    };
    if (sessionStartEvent) sessionOptions.sessionStartEvent = sessionStartEvent;
    const created = await piSdk.createAgentSessionFromServices(sessionOptions);
    // Retention is a per-request stream option on the Onlooker's own agent, never a process-wide
    // setting, so the observed agent's requests are untouched. Pi's native compaction of this
    // session reuses this stream function and sets `cacheRetention: "none"` on its summary
    // call on purpose, so a retention the caller chose is never overridden.
    const onlookerStream = created.session.agent.streamFunction;
    created.session.agent.streamFunction = (requestModel, context, streamOptions) => {
      const cacheRetention = streamOptions?.cacheRetention ?? onlookerCacheRetention(requestModel);
      return onlookerStream(
        requestModel,
        context,
        cacheRetention ? { ...streamOptions, cacheRetention } : streamOptions,
      );
    };
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await piSdk.createAgentSessionRuntime(factory, {
    cwd,
    agentDir,
    // An unsaved observed session has no session directory; its Onlooker Session stays unsaved too.
    sessionManager: observed.sessionManager.getSessionFile()
      ? piSdk.SessionManager.create(
          cwd,
          join(observed.sessionManager.getSessionDir(), "onlookers", observed.sessionId),
        )
      : piSdk.SessionManager.inMemory(cwd),
  });
  const bind = async (session: AgentSession) =>
    session.bindExtensions({
      mode: "print",
      onError: (error) => {
        runtime.services.diagnostics.push({
          type: "error",
          message: `Onlooker extension ${error.extensionPath}: ${error.error}`,
        });
      },
    });
  runtime.setRebindSession(bind);
  let bindingStarted = false;
  try {
    options.signal?.throwIfAborted();
    bindingStarted = true;
    await bind(runtime.session);
    if (!runtime.session.getActiveToolNames().includes(options.adviceTool.name))
      throw new Error(
        `Onlooker advice tool is inactive after extension binding: ${options.adviceTool.name}`,
      );
    // The native `tools` option is the Onlooker's tool ceiling; verify this runtime enforces it.
    const ceiling = new Set([...grants, options.adviceTool.name]);
    const escaped = runtime.session
      .getAllTools()
      .map(({ name }) => name)
      .filter((name) => !ceiling.has(name));
    if (escaped.length)
      throw new Error(
        `Unsupported Pi runtime: the Onlooker tool ceiling admitted ungranted tools (${escaped.join(", ")})`,
      );
    options.signal?.throwIfAborted();
    const failure = runtime.diagnostics.find((item) => item.type === "error");
    if (failure) throw new Error(failure.message);
    return runtime;
  } catch (cause) {
    if (bindingStarted) await disposeOnlookerSession(runtime);
    // No session_start ran, so no session-scoped resources exist to notify on this path.
    else runtime.session.dispose();
    throw cause;
  }
}
