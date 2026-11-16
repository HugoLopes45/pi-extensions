import { fileURLToPath } from "node:url";

import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as openaiStream } from "@earendil-works/pi-ai/api/openai-responses";
import { stringContaining } from "pi-hl-utils/testing/matchers";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { onTestFinished, expect, it, vi } from "vitest";

import { onlookerSettings } from "../src/onlooker-settings.js";
import {
  activeFixture,
  longSessionStream,
  createObserver,
  type ObserverSettings,
  type PrivateRequest,
} from "./fixtures/observer-harness.js";

/** A Codex access token only needs the account claim Pi's adapter reads. */
const codexToken = `x.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
).toString("base64")}.y`;

/** The request-body fields these tests read; the rest of Pi's payload stays opaque. */
const payloadSchema = Type.Object(
  {
    prompt_cache_key: Type.Optional(Type.String()),
    prompt_cache_retention: Type.Optional(Type.String()),
    input: Type.Optional(Type.Array(Type.Unknown())),
    tools: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true },
);
type Payload = Static<typeof payloadSchema>;

interface Request {
  onlooker: boolean;
  /** A native compaction summary of the Onlooker Session: a request without tools. */
  summary: boolean;
  /** The exact bytes the adapter would send, from `JSON.stringify`. */
  json: string;
  body: Payload;
  options: SimpleStreamOptions | undefined;
}

// The fixture provider registers each model under the API its adapter serves, so the adapter chosen by `model.api` matches the model's type; offline SDK tests exercise all three.
function adapterFor(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions) {
  if (servesApi(model, "openai-responses")) return openaiStream(model, context, options);
  if (servesApi(model, "anthropic-messages")) return anthropicStream(model, context, options);
  if (servesApi(model, "openai-codex-responses")) return codexStream(model, context, options);
  return undefined;
}

function servesApi<A extends Api>(model: Model<Api>, api: A): model is Model<A> {
  return model.api === api;
}

/**
 * Build each request's real provider payload with Pi's own adapter, after every
 * `before_provider_request` handler, and stop the adapter before it would use the network.
 */
function recordPayloads(requests: Request[]) {
  globalThis.onlookerObserverTest.request = (model, context, options) => {
    const tools = getCurrentTools(context.messages);
    const onlooker = tools.some((tool) => tool.name === "onlooker_report");
    const summary = tools.length === 0;
    const recorded: SimpleStreamOptions = {
      ...options,
      apiKey: model.api === "openai-codex-responses" ? codexToken : "offline",
      transport: "sse",
      // Pi's `onPayload` contract is an opaque provider body; it is serialized and schema-checked before any use.
      onPayload: async (body, payloadModel) => {
        const next: unknown = (await options?.onPayload?.(body, payloadModel)) ?? body;
        const json = JSON.stringify(next);
        requests.push({
          onlooker,
          summary,
          json,
          body: Value.Parse(payloadSchema, JSON.parse(json)),
          options,
        });
        throw new Error("payload recorded");
      },
    };
    const stream = adapterFor(model, context, recorded);
    if (stream) void stream.result();
    else requests.push({ onlooker, summary, json: "{}", body: {}, options });
  };
}

/** Run one observed request (two model calls) under a provider; the Onlooker is optional. */
async function run(
  provider: string,
  config?: Partial<ObserverSettings>,
  prompts = ["Request 1."],
  stream: Parameters<typeof longSessionStream>[2] = {
    result: (id) => `ok ${id}`,
    isError: () => false,
  },
) {
  const privateRequests: PrivateRequest[] = [];
  globalThis.onlookerObserverTest = longSessionStream({ Request: 1 }, privateRequests, stream);
  const requests: Request[] = [];
  recordPayloads(requests);
  const session = await activeFixture({ compaction: { enabled: false, keepRecentTokens: 1_000 } }, [
    fileURLToPath(new URL("./fixtures/provider-extension.ts", import.meta.url)),
  ]);
  const model = session.modelRuntime.getModel(provider, `offline-${provider}`);
  if (!model) throw new Error(`Missing ${provider} fixture model`);
  await session.setModel(model);
  if (config) {
    const observer = createObserver(
      session,
      {
        ...onlookerSettings.readSettings(session).settings,
        enabled: true,
        catchUpThreshold: 1,
        ...config,
      },
      "headless-root",
    );
    globalThis.onlookerObserverTest.settled = (aborted) => observer.settled(aborted);
    onTestFinished(() => observer.dispose());
  }
  for (const prompt of prompts) await session.prompt(prompt);
  return {
    session,
    onlooker: requests.filter((request) => request.onlooker),
    observed: requests.filter((request) => !request.onlooker && !request.summary),
    summaries: requests.filter((request) => request.summary),
  };
}

const cacheControls = (json: string) => json.match(/"cache_control":\{[^}]*\}/g) ?? [];
/** Observed bodies, as the exact bytes sent, with the per-run session id and directory named. */
const bytes = (
  session: { sessionId: string; sessionManager: { getCwd(): string } },
  requests: Request[],
) =>
  requests.map((request) =>
    request.json
      .replaceAll(session.sessionId, "<session>")
      .replaceAll(session.sessionManager.getCwd(), "<cwd>"),
  );

it("asks OpenAI for 24h prompt cache retention on Onlooker requests only", async () => {
  const baseline = await run("openai");
  const withOnlooker = await run("openai", {});
  expect(withOnlooker.onlooker.length).toBeGreaterThan(0);
  for (const request of withOnlooker.onlooker) {
    expect(request.options?.cacheRetention).toBe("long");
    expect(request.body.prompt_cache_retention).toBe("24h");
    expect(request.body.prompt_cache_key).toEqual(expect.any(String));
  }
  // The observed agent's requests stay byte-identical to a run without the Onlooker.
  expect(baseline.observed).toHaveLength(2);
  expect(bytes(withOnlooker.session, withOnlooker.observed)).toEqual(
    bytes(baseline.session, baseline.observed),
  );
  for (const request of withOnlooker.observed) {
    expect(request.options?.cacheRetention).toBeUndefined();
    expect(request.body).not.toHaveProperty("prompt_cache_retention");
  }
});

it("keeps Anthropic on the default cache lifetime unless the Onlooker opts in", async () => {
  const baseline = await run("anthropic");
  const standard = await run("anthropic", {});
  expect(standard.onlooker.length).toBeGreaterThan(0);
  for (const request of standard.onlooker) {
    expect(request.options?.cacheRetention).toBeUndefined();
    expect(cacheControls(request.json).length).toBeGreaterThan(0);
    expect(cacheControls(request.json).join()).not.toContain("ttl");
  }
  expect(bytes(standard.session, standard.observed)).toEqual(
    bytes(baseline.session, baseline.observed),
  );

  // Pi's PI_CACHE_RETENTION applies because the Onlooker sets no retention for Anthropic.
  vi.stubEnv("PI_CACHE_RETENTION", "long");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const extended = await run("anthropic", {});
  for (const request of extended.onlooker) {
    const controls = cacheControls(request.json);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toContain('"ttl":"1h"');
  }
});

it("sends no retention field to Codex, whose backend takes none", async () => {
  const { onlooker } = await run("openai-codex", {});
  expect(onlooker.length).toBeGreaterThan(0);
  for (const request of onlooker) {
    expect(request.options?.cacheRetention).toBeUndefined();
    expect(request.body).not.toHaveProperty("prompt_cache_retention");
    expect(request.body).not.toHaveProperty("prompt_cache_options");
  }
});

it("sends the first and second Review of a new Onlooker Session with the same request settings", async () => {
  // Cache proof for the Codex second-Review miss: everything but `input` is identical, and the
  // second request's input extends the first's.
  const { onlooker } = await run("openai-codex", { reviewEvery: "turn" }, [
    "Request 1.",
    "Request 2.",
  ]);
  expect(onlooker.length).toBeGreaterThanOrEqual(2);
  const settings = (body: Payload) => {
    const { input: _input, ...rest } = body;
    return JSON.stringify(rest);
  };
  const inputs = onlooker.map((request) => request.body.input ?? []);
  for (const [index, request] of onlooker.entries()) {
    if (index === 0) continue;
    expect(settings(request.body)).toBe(settings(onlooker[0]?.body ?? {}));
    const previous = inputs[index - 1] ?? [];
    expect(JSON.stringify(inputs[index]?.slice(0, previous.length))).toBe(JSON.stringify(previous));
  }
  expect(onlooker[0]?.body.tools).toBeDefined();
  expect(onlooker[0]?.body.prompt_cache_key).toBe(onlooker[1]?.body.prompt_cache_key);
});

it.each([
  {
    provider: "openai",
    retention: (request: Request): unknown => request.body.prompt_cache_retention,
    expected: "24h",
  },
  {
    provider: "anthropic",
    retention: (request: Request): unknown => cacheControls(request.json).join(),
    expected: stringContaining('"ttl":"1h"'),
  },
])(
  "keeps native compaction summaries of the Onlooker Session uncached on $provider",
  async ({ provider, retention, expected }) => {
    // Anthropic Reviews get long retention only through Pi's PI_CACHE_RETENTION.
    vi.stubEnv("PI_CACHE_RETENTION", "long");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const prompts = Array.from({ length: 6 }, (_, index) => `Request ${index + 1}.`);
    const { onlooker, summaries } = await run(
      provider,
      { reviewEvery: "request", maxSessionTokens: 4_000 },
      prompts,
      {
        result: (id) => `result ${id} ${"x".repeat(8_000)}`,
        isError: () => false,
        reportContextTokens: true,
      },
    );
    expect(summaries.length).toBeGreaterThan(0);
    for (const request of summaries) {
      expect(request.options?.cacheRetention).toBe("none");
      expect(request.json).not.toContain("cache_control");
      expect(request.body).not.toHaveProperty("prompt_cache_retention");
      expect(request.body).not.toHaveProperty("prompt_cache_key");
    }
    expect(onlooker.length).toBeGreaterThan(0);
    for (const request of onlooker) expect(retention(request)).toEqual(expected);
  },
);
