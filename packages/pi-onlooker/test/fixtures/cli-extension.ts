import {
  contentText,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentTools,
  type JsonObject,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverPiAgentSession } from "pi-hl-utils/pi-agent-session-discovery";

/** Offline CLI boundary: real loading, commands, and reviews without network requests. */
export default function cliFixture(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const found = discoverPiAgentSession(pi, AgentSession);
    if (!found.ok) throw new Error(found.warning);
    console.log(
      `ONLOOKER_CLI_RESOURCES=${JSON.stringify({
        privateRole: ctx.sessionManager
          .getBranch()
          .some((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-role"),
        extensions: found.session.resourceLoader
          .getExtensions()
          .extensions.map(({ path, resolvedPath, sourceInfo, hidden }) => ({
            path,
            resolvedPath,
            sourceInfo,
            hidden,
          })),
      })}`,
    );
  });
  pi.registerProvider("onlooker-cli-fixture", {
    api: "openai-completions",
    apiKey: "offline",
    oauth: {
      name: "Offline CLI OAuth",
      async login() {
        throw new Error("CLI tests must not start login");
      },
      async refreshToken(credentials) {
        if (credentials.refresh !== "offline-refresh")
          throw new Error("Unexpected fixture credential");
        console.log("ONLOOKER_CLI_REFRESH");
        return { ...credentials, access: "refreshed-offline-access", expires: 4102444800000 };
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
    baseUrl: "https://onlooker.invalid",
    models: [
      {
        id: "model",
        name: "Offline CLI",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context, options) {
      if (options?.apiKey !== "offline" && options?.apiKey !== "refreshed-offline-access")
        throw new Error("Unexpected CLI fixture authentication");
      console.log(`ONLOOKER_CLI_AUTH=${options.apiKey === "offline" ? "api-key" : "oauth"}`);
      const tools = getCurrentTools(context.messages);
      const declared = (name: string) => tools.some((tool) => tool.name === name);
      // Built-in `codemode.mode: "only"` leaves callable direct tools undeclared but listed by codemode.
      const scripted = (name: string) =>
        tools.some((tool) => tool.name === "codemode" && tool.description.includes(name));
      const call = (name: string, args: JsonObject): ToolCall =>
        declared(name)
          ? { type: "toolCall", id: name, name, arguments: args }
          : {
              type: "toolCall",
              id: name,
              name: "codemode",
              arguments: { code: `return await tools.${name}(${JSON.stringify(args)});` },
            };
      const reviewing = declared("onlooker_report") || scripted("onlooker_report");
      const lastUser = contentText(
        context.messages.findLast((message) => message.role === "user")?.content ?? "",
      );
      const consultation = reviewing && lastUser.includes("Consultation request");
      console.log(
        `ONLOOKER_CLI_INFERENCE=${consultation ? "consultation" : reviewing ? "review" : "observed"}`,
      );
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("Offline task complete"),
        provider: model.provider,
        model: model.id,
        api: model.api,
      };
      if (consultation) {
        message.content = [{ type: "text", text: "Inspect the native path." }];
        console.log("ONLOOKER_CLI_CONSULTATION=Inspect the native path.");
      } else if (reviewing) {
        // A scripted report does not terminate the turn; answer its script result with text.
        if (context.messages.at(-1)?.role !== "toolResult") {
          message.content = [call("onlooker_report", { severity: "none" })];
          message.stopReason = "toolUse";
        }
      } else if (
        lastUser.includes("Ask Onlooker which path to inspect") &&
        !context.messages.some(
          (item) =>
            item.role === "toolResult" &&
            (item.toolCallId === "onlooker_ask" || item.toolName === "onlooker_ask"),
        )
      ) {
        message.content = [call("onlooker_ask", { message: "Which path should I inspect?" })];
        message.stopReason = "toolUse";
      }
      queueMicrotask(() =>
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        }),
      );
      return stream;
    },
  });
  pi.registerCommand("onlooker-cli-reload", {
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  pi.registerCommand("onlooker-cli-probe", {
    handler: async (_args, ctx) => {
      const status = ctx.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");
      console.log(
        `ONLOOKER_CLI_PROBE=${JSON.stringify({ status: status?.type === "custom" ? status.data : null, activeTools: pi.getActiveTools() })}`,
      );
    },
  });
}
