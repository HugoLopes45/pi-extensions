import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { startCommandSession, type CommandSession } from "pi-hl-utils/testing/command-session";
import { afterEach } from "vitest";

const sessions: CommandSession[] = [];

afterEach(() => {
  for (const harness of sessions.splice(0)) harness.cleanup();
});

export async function createToolContext(cwd: string): Promise<ExtensionToolContext> {
  const harness = await startCommandSession(() => {}, "print");
  sessions.push(harness);
  return toToolContext({
    ...harness.session.extensionRunner.createContext(),
    cwd,
  });
}

/** Adds the nested-tool surface `ExtensionToolContext` requires; tests never call nested tools. */
export function toToolContext(context: ExtensionContext): ExtensionToolContext {
  return Object.assign(context, {
    tools: [],
    executeTool: () => Promise.reject(new Error("executeTool is unavailable in this test")),
  });
}
