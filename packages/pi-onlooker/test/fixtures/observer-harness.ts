import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  AgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { onTestFinished, expect } from "vite-plus/test";

import type { ObservedSetup } from "../../src/onlooker-evidence.js";
import {
  OnlookerObserver,
  type OnlookerLimits,
  type OnlookerMode,
  type OnlookerObserverOptions,
} from "../../src/onlooker-observer.js";
import type { OnlookerConfig } from "../../src/onlooker-settings.js";
import type { EvidenceBlock, EvidenceMessage } from "../../src/utils/evidence.js";
import "./observer-extension.js";

/** Onlooker settings plus the observer limits a test lowers to reach them quickly. */
export type ObserverSettings = OnlookerConfig & Partial<OnlookerLimits>;

/** An observer with `settings` split into the user's config and the observer's limits. */
export function createObserver(
  session: ConstructorParameters<typeof OnlookerObserver>[0],
  settings: ObserverSettings,
  mode: OnlookerMode,
  options: OnlookerObserverOptions = {},
): OnlookerObserver {
  const { enabled, name, model, thinkingLevel, reviewEvery, correct, ...limits } = settings;
  const config: OnlookerConfig = { enabled, name, thinkingLevel, reviewEvery, correct };
  if (model !== undefined) config.model = model;
  return new OnlookerObserver(session, config, mode, { ...options, limits });
}

/** Pi 0.86+ stores the system prompt as the leading session message. */
export const conversation = <T extends { role: string }>(messages: T[]) =>
  messages.filter((message) => message.role !== "system");

/**
 * An observed SDK session using the offline fixture provider; `settings` extend its defaults and
 * `extensions` are loaded after the fixture extension.
 */
export async function activeFixture(
  settings: NonNullable<Parameters<typeof SettingsManager.inMemory>[0]> = {},
  extensions: string[] = [],
  sessionManager?: SessionManager,
) {
  const dir = await mkdtemp(join(tmpdir(), "onlooker-observer-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...settings,
    }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("./observer-extension.ts", import.meta.url)),
        ...extensions,
      ],
    },
  });
  const model = modelRuntime.getModel("observer-fixture", "model");
  if (!model) throw new Error("Missing fixture model");
  const created = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: sessionManager ?? SessionManager.create(dir, join(dir, "sessions")),
  });
  const runtime = new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("No replacement");
  });
  await runtime.session.bindExtensions({ mode: "print" });
  onTestFinished(async () => {
    await runtime.session.abort();
    await runtime.dispose();
  });
  return runtime.session;
}

/** One private Onlooker request: its full context and the prompt text it ends with. */
export interface PrivateRequest {
  systemPrompt: Context["systemPrompt"];
  tools: { name: string; description: string; parameters: unknown }[];
  messages: Context["messages"];
  text: string;
  /** Private compaction summaries requested before this request. */
  summariesBefore: number;
}

/** One observed tool call of a batch. */
export interface ObservedCall {
  name: string;
  arguments: ToolCall["arguments"];
}

/** Fixture behavior beyond the observed tool batches. */
export interface LongSessionOptions {
  /** Observed tool-result text by batch ID. */
  result?: (id: string) => string;
  /**
   * Observed tool call of each batch, by batch ID; defaults to `read` of a missing file. Reads are
   * read-only, so a test that needs a Review per turn under `turn` calls a tool with effects.
   */
  call?: (id: string) => ObservedCall | ObservedCall[];
  /** Whether an observed tool result is an error; unset keeps the native (missing-file) error. */
  isError?: (id: string) => boolean;
  /**
   * Arguments of the `onlooker_report` call answering each Review request, in order, or a
   * legacy single-finding report.
   */
  report?: (review: number, request: PrivateRequest) => ToolCall["arguments"];
  /** Usage recorded on every private Onlooker response, such as a priced cost. */
  usage?: AssistantMessage["usage"];
  /** Report each private response's input as Pi's chars/4 estimate of its context. */
  reportContextTokens?: boolean;
  /**
   * Report each private response's input as its provider would: the cached system prompt and
   * tools at Pi's estimate, and the messages at this multiple of Pi's chars/4 estimate.
   */
  tokenRatio?: number;
  /** Private compaction summary requests, recorded in order. */
  summaries?: Context[];
  /** Milliseconds each Review response is held, by timer, before it completes. */
  reviewDelayMs?: number;
  /** Milliseconds each compaction summary is held, by timer, before it completes. */
  summaryDelayMs?: number;
  /** Hold every compaction summary until its request is aborted. */
  hangSummaries?: boolean;
  /** Error message for the first observed response, such as a retryable provider error. */
  firstError?: string;
  /** Reasoning prepended to every observed agent response. */
  thinking?: string;
  /** Delay the response to a Review request, such as until the observed agent moves on. */
  hold?: (review: number, request: PrivateRequest) => Promise<void> | undefined;
}

/**
 * A long observed session: each request runs its listed number of tool batches, whose results
 * `result` writes. Private requests are recorded in order.
 */
export function longSessionStream(
  batches: Record<string, number>,
  privateRequests: PrivateRequest[],
  options: LongSessionOptions = {},
) {
  const {
    result = (id: string) => `result ${id} ${"x".repeat(8_000)}`,
    call = (id: string) => ({ name: "read", arguments: { path: `/missing-onlooker-${id}` } }),
    isError,
    report = () => ({ findings: [] }),
    usage,
    reportContextTokens,
    tokenRatio,
    summaries,
    reviewDelayMs,
    summaryDelayMs,
    hangSummaries,
    hold,
    thinking,
  } = options;
  let { firstError } = options;
  let reviews = 0;
  let summaryCount = 0;
  type Message = ReturnType<typeof fauxAssistantMessage>;
  function answerReview(context: Context, message: Message): Promise<void> | undefined {
    const request = context.messages.at(-1);
    const text =
      request?.role === "user" && Array.isArray(request.content)
        ? request.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
    const recorded: PrivateRequest = {
      systemPrompt: context.systemPrompt,
      tools: (context.tools ?? []).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
      messages: structuredClone(context.messages),
      text,
      summariesBefore: summaryCount,
    };
    privateRequests.push(structuredClone(recorded));
    if (usage) message.usage = structuredClone(usage);
    if (reportContextTokens) {
      const input = Math.ceil(JSON.stringify(context).length / 4);
      message.usage = { ...message.usage, input, totalTokens: input + message.usage.output };
    }
    if (tokenRatio) {
      const setup = Math.ceil(JSON.stringify([context.systemPrompt, context.tools]).length / 4);
      const input =
        setup + Math.ceil(Math.ceil(JSON.stringify(context.messages).length / 4) * tokenRatio);
      message.usage = { ...message.usage, input, totalTokens: input + message.usage.output };
    }
    if (!text.startsWith("Consultation request")) {
      message.content = [
        {
          type: "toolCall",
          id: `report-${++reviews}`,
          name: "onlooker_report",
          arguments: report(reviews, recorded),
        },
      ];
      message.stopReason = "toolUse";
      return hold?.(reviews, recorded);
    }
    return undefined;
  }
  function planTurn(context: Context, message: Message): void {
    const start = context.messages.findLastIndex((entry) => entry.role === "user");
    const request = context.messages[start];
    const text = request?.role === "user" ? JSON.stringify(request.content) : "";
    const done = context.messages.slice(start).filter((entry) => entry.role === "toolResult");
    const planned = Object.entries(batches).find(([prompt]) => text.includes(prompt))?.[1];
    if (done.length < (planned ?? 0)) {
      const id = `${start}-${done.length}`;
      message.content = [call(id)].flat().map((entry, index) => ({
        type: "toolCall" as const,
        id: index ? `${id}#${index}` : id,
        ...entry,
      }));
      message.stopReason = "toolUse";
    }
  }
  return {
    stream(model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report");
      const stream = createAssistantMessageEventStream();
      let held: Promise<void> | undefined;
      const message = {
        ...fauxAssistantMessage("Done"),
        model: model.id,
        provider: model.provider,
        api: model.api,
      };
      if (privateRole) held = answerReview(context, message);
      else if (!context.tools?.length) {
        summaryCount++;
        summaries?.push(structuredClone(context));
        if (hangSummaries) {
          streamOptions?.signal?.addEventListener(
            "abort",
            () =>
              stream.push({
                type: "error",
                reason: "aborted",
                error: { ...message, stopReason: "aborted" },
              }),
            { once: true },
          );
          return stream;
        }
        if (usage) message.usage = structuredClone(usage);
        message.content = [
          { type: "text", text: "Summary: the user asked to refactor the parser." },
        ];
      } else if (firstError) {
        const errorMessage = firstError;
        firstError = undefined;
        queueMicrotask(() =>
          stream.push({
            type: "error",
            reason: "error",
            error: { ...message, stopReason: "error", errorMessage },
          }),
        );
        return stream;
      } else {
        planTurn(context, message);
        if (thinking) message.content = [{ type: "thinking", thinking }, ...message.content];
      }
      const done = () =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      const delay = privateRole ? reviewDelayMs : context.tools?.length ? 0 : summaryDelayMs;
      if (held) void held.then(done);
      else if (delay) setTimeout(done, delay);
      else queueMicrotask(done);
      return stream;
    },
    toolResult: (event: ToolResultEvent): ToolResultEventResult => {
      const rewritten: ToolResultEventResult = {
        content: [{ type: "text", text: result(event.toolCallId) }],
      };
      if (isError) rewritten.isError = isError(event.toolCallId);
      return rewritten;
    },
  };
}

/** A private prompt's header line and its JSON payload, exactly as sent. */
export function seedPayload(request: Pick<PrivateRequest, "text"> | undefined) {
  const text = request?.text ?? "";
  const newline = text.indexOf("\n");
  const json = text.slice(newline + 1);
  return {
    header: text.slice(0, newline),
    /** Pi's chars/4 estimate of the payload the Onlooker received. */
    tokens: Math.ceil(json.length / 4),
    /** The parsed payload, checked on access so tests can read the header of any request. */
    get evidence(): SeedEvidence {
      const parsed: unknown = JSON.parse(json);
      if (!isSeedEvidence(parsed))
        throw new Error(`Not an evidence payload: ${json.slice(0, 200)}`);
      return parsed;
    },
  };
}

/** The evidence JSON of a Review prompt: a Context Seed or an Incremental update. */
interface SeedEvidence {
  messages: EvidenceMessage[];
  observedSetup?: ObservedSetup;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvidenceBlock(value: unknown): value is EvidenceBlock {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "thinking":
      return typeof value.thinking === "string" || value.redacted === true;
    case "image":
      return typeof value.attachment === "number";
    case "toolCall":
      return (
        typeof value.ref === "string" && typeof value.name === "string" && isRecord(value.arguments)
      );
    default:
      return false;
  }
}

function isBlocks(value: unknown): value is EvidenceBlock[] {
  return Array.isArray(value) && value.every(isEvidenceBlock);
}

const stopReasons = new Set<unknown>([undefined, "error", "aborted", "length"]);

function isEvidenceMessage(value: unknown): value is EvidenceMessage {
  if (!isRecord(value)) return false;
  switch (value.role) {
    case "user":
      return typeof value.content === "string" || isBlocks(value.content);
    case "assistant":
      return (
        isBlocks(value.content) &&
        stopReasons.has(value.stopReason) &&
        (value.errorMessage === undefined || typeof value.errorMessage === "string")
      );
    case "toolResult":
      return (
        typeof value.ref === "string" &&
        typeof value.toolName === "string" &&
        typeof value.isError === "boolean" &&
        isBlocks(value.content)
      );
    default:
      return false;
  }
}

function isObservedSetup(value: unknown): value is ObservedSetup {
  return (
    isRecord(value) &&
    (value.systemPrompt === undefined || typeof value.systemPrompt === "string") &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (tool) => isRecord(tool) && typeof tool.name === "string" && typeof tool.summary === "string",
    )
  );
}

function isSeedEvidence(value: unknown): value is SeedEvidence {
  return (
    isRecord(value) &&
    Array.isArray(value.messages) &&
    value.messages.every(isEvidenceMessage) &&
    (value.observedSetup === undefined || isObservedSetup(value.observedSetup))
  );
}

/** Onlooker prompt-cache proof: a later request extends the earlier context unchanged. */
export function expectPrefix(
  later: PrivateRequest | undefined,
  earlier: PrivateRequest | undefined,
) {
  expect(earlier?.messages.length).toBeGreaterThan(0);
  expect(later?.messages.slice(0, earlier?.messages.length)).toEqual(earlier?.messages);
}

/** A batch call with effects, so each turn starts a Review under `reviewEvery: "turn"`. */
export const effectful: NonNullable<LongSessionOptions["call"]> = () => ({
  name: "bash",
  arguments: { command: "true" },
});
