import type {
  Context,
  Model,
  Api,
  SimpleStreamOptions,
  AssistantMessageEventStream,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { endpointContext } from "./endpoint-context.js";

declare global {
  var onlookerObserverTest: {
    stream: (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream;
    /** Sees every request exactly as the provider adapter would, before the scripted answer. */
    request?: (
      model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ) => void;
    beforeTask?: () => void;
    turnEnd?: (event: TurnEndEvent) => Promise<void>;
    /** Observed tool-result rewrite, such as display-only `details`. */
    toolResult?: (event: ToolResultEvent) => ToolResultEventResult | undefined;
    beforeSettle?: (event: AgentBeforeSettleEvent) => AgentBeforeSettleEventResult | undefined;
    settled?: (aborted: boolean) => Promise<void>;
  };
}

/** Offline provider and real awaited SDK hooks, controlled at the host boundary. */
export default function observerFixture(pi: ExtensionAPI): void {
  pi.registerProvider("observer-fixture", {
    api: "openai-completions",
    apiKey: "offline",
    baseUrl: "https://observer.invalid",
    models: ["model", "alternate", "priced", "wide"].map((id) => ({
      id,
      name: "Offline",
      reasoning: true,
      input: ["text", "image"],
      // `priced` declares prices, so its zero-usage responses cost a known $0.
      cost:
        id === "priced"
          ? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // `wide` declares a 1M window, where the absolute `auto` ceilings bind.
      contextWindow: id === "wide" ? 1_000_000 : 200000,
      maxTokens: 2048,
    })),
    streamSimple: (model, context, options) => {
      globalThis.onlookerObserverTest.request?.(model, context, options);
      return globalThis.onlookerObserverTest.stream(model, endpointContext(context), options);
    },
  });
  pi.on("before_agent_start", (event) => {
    // As the extension does: a custom message's run, such as a corrective continuation, is no new task.
    if (event.messageType !== "custom") globalThis.onlookerObserverTest.beforeTask?.();
  });
  pi.on("turn_end", (event) => globalThis.onlookerObserverTest.turnEnd?.(event));
  pi.on("tool_result", (event) => globalThis.onlookerObserverTest.toolResult?.(event));
  pi.on("agent_before_settle", (event) => globalThis.onlookerObserverTest.beforeSettle?.(event));
  pi.on("agent_settled", (event) => globalThis.onlookerObserverTest.settled?.(event.aborted));
}
