import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Native session identity only; callers validate the capabilities they require. */
export type DiscoverPiAgentSessionResult =
  | { readonly ok: true; readonly session: AgentSession }
  | { readonly ok: false; readonly warning: string };

/** Use the extension's host-resolved class: a compiled dependency's SDK import may be a different instance. */
export function discoverPiAgentSession(
  pi: Pick<ExtensionAPI, "getAllTools">,
  sessionClass: typeof AgentSession,
): DiscoverPiAgentSessionResult {
  const prototype = sessionClass.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "getAllTools");
  // This native SDK descriptor boundary requires only a callable data method; session identity is validated after delegation and callers own capability checks.
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    return { ok: false, warning: "AgentSession.getAllTools is not the tested data method" };
  }

  const originalGetAllTools = prototype.getAllTools;
  const receivers: AgentSession[] = [];
  Object.defineProperty(prototype, "getAllTools", {
    ...descriptor,
    value(this: AgentSession) {
      receivers.push(this);
      return originalGetAllTools.call(this);
    },
  });

  try {
    pi.getAllTools();
  } catch (cause) {
    return {
      ok: false,
      warning: `getAllTools capture failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  } finally {
    Object.defineProperty(prototype, "getAllTools", descriptor);
  }

  const [session] = receivers;
  if (!(session instanceof sessionClass)) {
    return { ok: false, warning: "getAllTools did not delegate to an AgentSession" };
  }
  return { ok: true, session };
}
