import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  initTheme,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "pi-hl-utils/record";
import { createMenuTui, keys, menuDriver } from "pi-hl-utils/testing/menu-ui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BUNDLED_CLAUDE_CODE_VERSION } from "../src/claude-code.ts";

const TOKEN = "sk-ant-oat01-offline-test";

interface Sent {
  url: string;
  headers: Headers;
  body: {
    system: { type: string; text: string }[];
    messages?: unknown[];
    thread?: { type: string };
  };
}

function isSentBody(value: unknown): value is Sent["body"] {
  if (!isRecord(value) || !Array.isArray(value.system)) return false;
  const { system, messages, thread } = value;
  return (
    system.every(
      (block) =>
        isRecord(block) && typeof block.type === "string" && typeof block.text === "string",
    ) &&
    (messages === undefined || Array.isArray(messages)) &&
    (thread === undefined || (isRecord(thread) && typeof thread.type === "string"))
  );
}

async function sentBody(request: Request): Promise<Sent["body"]> {
  if (request.method !== "POST") return { system: [] };
  const body: unknown = await request.json();
  if (!isSentBody(body)) throw new Error(`Unexpected request body: ${JSON.stringify(body)}`);
  return body;
}

function sse(events: ({ type: string } & Record<string, unknown>)[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const REPLY = sse([
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "OK" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
]);

/** A bound UI: its `notify` messages, and the screen of each menu `custom` opens. */
interface BoundUi {
  notices: string[];
  menus: string[];
}

async function startPi(
  response: (url: string) => Response,
  extensionFactories: ((pi: ExtensionAPI) => void)[] = [],
  agentSettings: object = {},
  ui?: BoundUi,
): Promise<{ session: AgentSession; sent: Sent[] }> {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        url: request.url,
        headers: request.headers,
        body: await sentBody(request),
      });
      return response(request.url);
    }),
  );

  const agentDir = mkdtempSync(join(tmpdir(), "pi-claude-pro-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-claude-pro-cwd-"));
  // The extension reads its settings from PI_CODING_AGENT_DIR, so the real agent dir stays untouched.
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(agentSettings));
  // Pi retries at two levels: inside the provider request and after a failed
  // turn. Both stay on, with no delay, so the tests see every retry.
  const settingsManager = SettingsManager.inMemory({
    retry: {
      enabled: true,
      maxRetries: 2,
      baseDelayMs: 0,
      provider: { maxRetries: 2 },
    },
    // A manual compaction then has history to summarize after a single turn.
    compaction: { keepRecentTokens: 1 },
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  await modelRuntime.setRuntimeApiKey("anthropic", TOKEN);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories,
    additionalExtensionPaths: [resolve(import.meta.dirname, "../extensions/index.ts")],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: getBuiltinModel("anthropic", "claude-haiku-4-5"),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: [],
  });
  // Binding a UI also turns on Pi's retries, so only a test that reads notices or menus binds one.
  if (ui) {
    const uiContext = session.extensionRunner.getUIContext();
    await session.bindExtensions({
      mode: "tui",
      uiContext: {
        ...uiContext,
        notify: (message: string) => {
          ui.notices.push(message);
        },
        // The menu is shown, read and closed with Escape, so the command returns.
        custom: (factory) =>
          new Promise((resolve) => {
            const { tui, keybindings } = createMenuTui();
            void Promise.resolve(factory(tui, uiContext.theme, keybindings, resolve)).then(
              (component) => {
                ui.menus.push(menuDriver(() => component).screen());
                menuDriver(() => component).press(keys.escape);
              },
            );
          }),
      },
    });
  }
  return { session, sent };
}

async function runPrompt(
  response: (url: string) => Response,
  prompts = ["Reply with exactly: OK"],
  extensionFactories: ((pi: ExtensionAPI) => void)[] = [],
  agentSettings: object = {},
  ui?: BoundUi,
): Promise<{ sent: Sent[]; text: string }> {
  const { session, sent } = await startPi(response, extensionFactories, agentSettings, ui);
  try {
    for (const prompt of prompts) await session.prompt(prompt);
    const last = session.messages.at(-1);
    const text =
      last?.role === "assistant"
        ? (last.errorMessage ??
          last.content.map((block) => (block.type === "text" ? block.text : "")).join(""))
        : "";
    return { sent, text };
  } finally {
    session.dispose();
  }
}

describe("inside Pi", () => {
  beforeAll(() => initTheme("dark"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends a subscription request as Claude Code", async () => {
    const { sent, text } = await runPrompt(
      () =>
        new Response(REPLY, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    expect(text).toBe("OK");
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.get("user-agent")).toBe(
      `claude-cli/${BUNDLED_CLAUDE_CODE_VERSION} (external, pi)`,
    );
    expect(request?.headers.get("x-app")).toBe("cli");
    expect(request?.headers.get("x-claude-code-session-id")).toBeTruthy();
    const system = request?.body.system.map((block) => block.text) ?? [];
    expect(system[0]).toMatch(
      /^x-anthropic-billing-header: cc_version=[\d.]+\.[0-9a-f]{3}; cc_entrypoint=pi; cch=00000;$/,
    );
    expect(system).not.toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(system.join("\n")).not.toContain("Pi documentation");
    expect(system.slice(1).join("\n")).toContain("inside pi, a coding agent harness");
  });

  it("sends the Claude Code version pinned in settings.json", async () => {
    const { sent } = await runPrompt(
      () =>
        new Response(REPLY, {
          headers: { "content-type": "text/event-stream" },
        }),
      ["Reply with exactly: OK"],
      [],
      { "claude-pro": { claudeCodeVersion: "2.1.400" } },
    );
    expect(sent[0]?.headers.get("user-agent")).toBe("claude-cli/2.1.400 (external, pi)");
  });

  it("serves a request outside an agent turn after a reload", async () => {
    const { session, sent } = await startPi(
      () =>
        new Response(REPLY, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    try {
      await session.prompt("Reply with exactly: OK");
      await session.reload();
      const { summary } = await session.compact();
      expect(summary).toContain("OK");
      expect(sent.at(-1)?.headers.get("user-agent")).toBe(
        `claude-cli/${BUNDLED_CLAUDE_CODE_VERSION} (external, pi)`,
      );
    } finally {
      session.dispose();
    }
  });

  it("applies a session /claude-pro change to the next request", async () => {
    const { sent } = await runPrompt(
      () =>
        new Response(REPLY, {
          headers: { "content-type": "text/event-stream" },
        }),
      ['/claude-pro set claudeCodeVersion "2.1.400"', "Reply with exactly: OK"],
    );
    const requests = messageRequests(sent);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("user-agent")).toBe("claude-cli/2.1.400 (external, pi)");
  });

  const rateLimited = (headers: Record<string, string>) => () =>
    Response.json(
      { type: "error", error: { type: "rate_limit_error", message: "Error" } },
      { status: 429, headers: { "retry-after": "0", ...headers } },
    );
  const messageRequests = (sent: Sent[]) =>
    sent.filter((request) => request.url.includes("/v1/messages"));

  it("answers and warns once when a stored settings layer is invalid", async () => {
    const ok = () => new Response(REPLY, { headers: { "content-type": "text/event-stream" } });
    const ui: BoundUi = { notices: [], menus: [] };
    const { sent, text } = await runPrompt(
      ok,
      ["Reply with exactly: OK", "Reply again"],
      [],
      { "claude-pro": { warnAt: 101 } },
      ui,
    );
    expect(text).toBe("OK");
    expect(messageRequests(sent)).toHaveLength(2);
    expect(ui.notices).toEqual([
      expect.stringMatching(/^pi-claude-pro: Invalid global Claude Pro settings\/warnAt/),
    ]);
  });

  it("opens the settings menu while a stored settings layer is invalid", async () => {
    const ui: BoundUi = { notices: [], menus: [] };
    await runPrompt(
      () =>
        new Response(REPLY, {
          headers: { "content-type": "text/event-stream" },
        }),
      ["/claude-pro"],
      [],
      { "claude-pro": { warnAt: 101 } },
      ui,
    );
    expect(ui.menus).toHaveLength(1);
    expect(ui.menus[0]).toContain("footer");
  });

  it("explains exhausted extra usage from HTTP 400 without retries or usage lookup", async () => {
    const { sent, text } = await runPrompt(() =>
      Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
          },
        },
        { status: 400 },
      ),
    );
    expect(text).toBe("Claude extra usage limit reached");
    expect(sent).toHaveLength(1);
  });

  it("lets Pi retry a transient 429", async () => {
    const { sent } = await runPrompt((url) =>
      url.endsWith("/api/oauth/usage")
        ? Response.json({ five_hour: { utilization: 10 } })
        : rateLimited({})(),
    );
    // 3 provider attempts in each of 3 turns.
    expect(messageRequests(sent)).toHaveLength(9);
  });

  it("explains an exhausted subscription instead of retrying", async () => {
    const { sent, text } = await runPrompt(
      rateLimited({
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      }),
    );
    expect(text).toBe("Claude 5-hour limit reached");
    expect(messageRequests(sent)).toHaveLength(1);
  });

  it("asks the usage endpoint when a 429 does not say which limit is spent", async () => {
    const { sent, text } = await runPrompt((url) =>
      url.endsWith("/api/oauth/usage")
        ? Response.json({
            five_hour: { utilization: 100, resets_at: null },
            seven_day: { utilization: 40, resets_at: null },
          })
        : rateLimited({})(),
    );
    expect(text).toBe("Claude 5-hour limit reached");
    const usage = sent.filter((request) => request.url.endsWith("/api/oauth/usage"));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(usage[0]?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(messageRequests(sent)).toHaveLength(1);
  });

  it("preserves a replacement prompt while moving only Pi documentation", async () => {
    const custom = "<docs>Project documentation</docs>\nKeep custom instructions.";
    const { sent } = await runPrompt(
      () =>
        new Response(REPLY, {
          headers: { "content-type": "text/event-stream" },
        }),
      ["hello", "next"],
      [
        (pi) => {
          pi.on("before_agent_start", (event) => ({
            systemPrompt: `${event.systemPrompt}\n${custom}`,
          }));
        },
      ],
    );
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      // Pi 1.5+ continues a message thread: the server keeps the prompt and the
      // earlier messages, so the request sends only billing and new messages.
      const continued = request.body.thread?.type === "continue";
      const system = request.body.system.map((block) => block.text).join("\n");
      expect(system).not.toContain("Pi documentation");
      const expected = continued
        ? [/^x-anthropic-billing-header: [^\n]*$/]
        : [custom, "inside pi, a coding agent harness"];
      for (const part of expected) expect(system).toMatch(part);
      expect(
        JSON.stringify(request.body.messages).split("Pi documentation (read only"),
      ).toHaveLength(continued ? 1 : 2);
    }
  });

  it("moves Pi's docs into the first user message of every request", async () => {
    const ok = () => new Response(REPLY, { headers: { "content-type": "text/event-stream" } });
    const { sent } = await runPrompt(ok, [
      "Comment créer une extension pour cet agent ?",
      "Et un thème ?",
    ]);
    const docsCount = (request: Sent | undefined) =>
      JSON.stringify(request?.body.messages).split("Pi documentation (read only").length - 1;
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0]?.body.messages?.[0])).toContain("Pi documentation (read only");
    for (const request of sent) {
      // A thread continuation does not resend the first user message.
      expect(docsCount(request)).toBe(request.body.thread?.type === "continue" ? 0 : 1);
      expect(request.body.system.map((block) => block.text).join("\n")).not.toContain(
        "Pi documentation",
      );
    }
  });
});

describe("/claude-pro arguments inside Pi", () => {
  beforeAll(() => initTheme("dark"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** The completions of the `claude-pro` command that the extension registers. */
  async function completions(prefix: string): Promise<string[]> {
    const { session } = await startPi(() => new Response(REPLY));
    try {
      const items = await session.extensionRunner
        .getCommand("claude-pro")
        ?.getArgumentCompletions?.(prefix);
      return (items ?? []).map((item) => item.value);
    } finally {
      session.dispose();
    }
  }

  it("completes the top-level words", async () => {
    expect(await completions("s")).toEqual(["status", "set"]);
  });

  it("completes option keys after set and inherit", async () => {
    expect(await completions("set f")).toEqual(["set footer", "set footerWindows"]);
    expect(await completions("inherit w")).toEqual(["inherit warnAt"]);
  });

  it("offers the scope flags once the command is complete", async () => {
    expect(await completions("set footer false ")).toEqual([
      "set footer false --global",
      "set footer false --project",
    ]);
    expect(await completions("set footer false --g")).toEqual(["set footer false --global"]);
  });

  it("offers no scope for a command that is not yet valid", async () => {
    expect(await completions("set warnAt ")).toEqual([]);
  });
});
