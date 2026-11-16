import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  contentText,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { onTestFinished, expect, it } from "vitest";

import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";
import "./fixtures/observer-extension.js";

it("returns enabled main-agent consultation as an ordinary tool result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "onlooker-consultation-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const privatePrompts: string[] = [];
  const privateToolNames: string[][] = [];
  const questions = ["What risk should I check first?"];
  let failConsultation = false;
  let failOnlookerTool = false;
  let consultationRequests = 0;
  globalThis.onlookerObserverTest = {
    stream(model, context) {
      const privateRole = context.tools?.some((tool) => tool.name === "onlooker_report") ?? false;
      const prompt = contentText(
        context.messages.findLast((message) => message.role === "user")?.content ?? "",
      );
      const message = {
        ...fauxAssistantMessage("Main task complete"),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      if (privateRole) {
        privatePrompts.push(prompt);
        privateToolNames.push((context.tools ?? []).map((tool) => tool.name));
        const failedRead = context.messages
          .slice(context.messages.findLastIndex((entry) => entry.role === "user"))
          .some(
            (entry) => entry.role === "toolResult" && entry.toolName === "read" && entry.isError,
          );
        if (failOnlookerTool && !failedRead) {
          message.content = [
            {
              type: "toolCall",
              id: "failed-read",
              name: "read",
              arguments: { path: join(directory, "missing-onlooker-file") },
            },
          ];
          message.stopReason = "toolUse";
        } else if (prompt.includes("Consultation request")) {
          consultationRequests++;
          if (failConsultation) {
            message.stopReason = "error";
            message.errorMessage = "Offline consultation failure";
          } else message.content = [{ type: "text", text: "Check the cancellation path first." }];
        } else {
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
      } else {
        const question = questions.shift();
        if (question) {
          message.content = [
            {
              type: "toolCall",
              id: `ask-${question}`,
              name: "onlooker_ask",
              arguments: { message: question },
            },
          ];
          message.stopReason = "toolUse";
        }
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (message.stopReason === "error")
          stream.push({ type: "error", reason: "error", error: message });
        else
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
      });
      return stream;
    },
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const settingsDocument = {
    onlooker: { enabled: true },
    compaction: { enabled: false },
    retry: { enabled: false },
  };
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(settingsDocument),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("./fixtures/observer-extension.ts", import.meta.url)),
        fileURLToPath(new URL("../extensions/index.ts", import.meta.url)),
      ],
    },
  });
  const model = modelRuntime.getModel("observer-fixture", "model");
  if (!model) throw new Error("Missing offline model");
  const created = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.create(directory, join(directory, "sessions")),
  });
  const runtime = new AgentSessionRuntime(created.session, services, async () => {
    throw new Error("No replacement");
  });
  await runtime.session.bindExtensions({ mode: "print" });
  onTestFinished(async () => {
    await runtime.session.abort();
    await runtime.dispose();
  });

  await runtime.session.prompt("Ask for a second opinion before finishing.");

  expect(
    runtime.session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "onlooker_ask",
    ),
  ).toMatchObject({
    isError: false,
    content: [{ type: "text", text: "Check the cancellation path first." }],
  });
  expect(privateToolNames.every((names) => !names.includes("onlooker_ask"))).toBe(true);
  expect(
    runtime.session.messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-onlooker",
    ),
  ).toEqual([]);
  expect(privatePrompts[0]).toContain("Consultation request");
  expect(privatePrompts[0]).toContain("What risk should I check first?");
  expect(privatePrompts.at(-1)).toContain("Review this observed-agent evidence");
  expect(
    privatePrompts.some(
      (prompt) =>
        prompt.includes("Review this observed-agent evidence") &&
        prompt.includes("onlooker_ask") &&
        prompt.includes("Check the cancellation path first."),
    ),
  ).toBe(true);

  // A failed Onlooker tool call is evidence for the Onlooker, not a failure of its work.
  failOnlookerTool = true;
  await runtime.session.prompt("Review after an investigative tool fails.");
  questions.push("Can you recover from a failed investigation?");
  await runtime.session.prompt("Ask after an investigative tool fails.");
  expect(
    runtime.session.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "onlooker_ask",
    ),
  ).toMatchObject({
    isError: false,
    content: [{ type: "text", text: "Check the cancellation path first." }],
  });
  await runtime.session.prompt("/onlooker status");
  expect(
    runtime.session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
  ).toMatchObject({ data: { state: "armed", lastError: null } });
  failOnlookerTool = false;
  await runtime.session.prompt("/onlooker on");
  failConsultation = true;
  questions.push("Can you verify another risk?");
  await runtime.session.prompt("Ask again after the first consultation.");
  expect(runtime.session.getActiveToolNames()).toContain("onlooker_ask");
  expect(
    runtime.session.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "onlooker_ask",
    ),
  ).toMatchObject({
    isError: true,
    content: [{ type: "text", text: `Offline consultation failure\n\n${TROUBLESHOOTING_HINT}` }],
  });

  const requestsBeforePausedCall = consultationRequests;
  questions.push("Can you answer while paused?");
  await runtime.session.prompt("Try the paused Onlooker.");
  const pausedResult = runtime.session.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "onlooker_ask",
  );
  expect(pausedResult).toMatchObject({ isError: true });
  expect(JSON.stringify(pausedResult)).toContain(
    "Onlooker is paused: Offline consultation failure",
  );
  expect(JSON.stringify(pausedResult)).toContain("/onlooker status");
  expect(JSON.stringify(pausedResult)).toContain("/onlooker on");
  expect(JSON.stringify(pausedResult)).toContain(TROUBLESHOOTING_HINT);
  expect(consultationRequests).toBe(requestsBeforePausedCall);
});
