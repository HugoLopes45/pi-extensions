import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect } from "vitest";

/** A started session; `cleanup` disposes it. Its agent dir stays in the OS temporary directory. */
export interface CommandSession {
  session: AgentSession;
  cleanup(): void;
}

/** Starts a real Pi session with one inline extension; commands run through `session.prompt("/name ...")`. */
export async function startCommandSession(
  extension: (pi: ExtensionAPI) => void,
  mode: "tui" | "print",
): Promise<CommandSession> {
  // Pi writes its auth and model files into the agent dir, so each session gets its own.
  const agentDir = mkdtempSync(join(tmpdir(), "pi-hl-utils-agent-"));
  const cwd = resolve(import.meta.dirname, "..");
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [extension],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: [],
  });
  if (mode === "tui") {
    await session.bindExtensions({
      mode: "tui",
      uiContext: session.extensionRunner.getUIContext(),
    });
  }
  return {
    session,
    cleanup() {
      session.dispose();
    },
  };
}
