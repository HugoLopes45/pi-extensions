import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

declare global {
  var onlookerReviewRegression: {
    tree?: () => Promise<void>;
    compact?: () => Promise<void>;
    agentEnd?: () => Promise<void>;
  };
}

/** Earlier-loaded native lifecycle hooks held at the external fixture boundary. */
export default function reviewRegressionFixture(pi: ExtensionAPI): void {
  let privateRole = false;
  pi.on("session_start", (_event, ctx) => {
    privateRole = ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-role");
  });
  pi.on("agent_end", async () => {
    if (!privateRole) await globalThis.onlookerReviewRegression.agentEnd?.();
  });
  pi.on("session_tree", async () => {
    if (!privateRole) await globalThis.onlookerReviewRegression.tree?.();
  });
  pi.on("session_before_compact", async (event) => {
    if (privateRole || !globalThis.onlookerReviewRegression.compact) return;
    await globalThis.onlookerReviewRegression.compact();
    return {
      compaction: {
        summary: "Native fixture summary",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
}
