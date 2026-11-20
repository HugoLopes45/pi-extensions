import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { acceptNullForOptionalArguments } from "pi-hl-utils/null-optional-arguments";
import { registerSteering } from "pi-hl-utils/steering";
import { noticeText } from "pi-hl-utils/ui";

import { createDapArtifacts, type DapArtifacts } from "../src/artifacts.js";
import { DapController } from "../src/controller.js";
import { sanitizeDapObserverText } from "../src/rendering.js";
import { readSettings } from "../src/settings.js";
import { createDapTools, type DapToolRuntime } from "../src/tools.js";
import { DapWidget } from "../src/widget.js";

interface DapRuntime extends DapToolRuntime {
  readonly observer: DapWidget;
  readonly controller: DapController;
  readonly artifacts: DapArtifacts;
}

/** Compose Pi lifecycle, settings, tools, and passive UI without starting an adapter at load time. */
export function createDapExtension(getAgentDirectory: () => string = getAgentDir) {
  return (pi: ExtensionAPI) => {
    let active: DapRuntime | undefined;
    let generation = 0;
    let disposePromise: Promise<void> | undefined;
    let disposeFailureDelivered = false;
    const pendingAllocationFailures: unknown[] = [];

    async function disposeRuntime(): Promise<void> {
      if (active === undefined && pendingAllocationFailures.length === 0) {
        await disposePromise;
        return;
      }
      const runtime = active;
      active = undefined;
      const errors = pendingAllocationFailures.splice(0);
      const previousDisposal = disposePromise;
      const disposing = Promise.resolve().then(async () => {
        try {
          await previousDisposal;
        } catch (cause) {
          errors.push(cause);
        }
        if (runtime !== undefined) {
          try {
            runtime.observer.dispose();
          } catch (cause) {
            errors.push(cause);
          }
          try {
            await runtime.controller.dispose();
          } catch (cause) {
            errors.push(cause);
          }
          try {
            await runtime.artifacts.dispose();
          } catch (cause) {
            errors.push(cause);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, "Debug Session shutdown and artifact cleanup failed");
      });
      disposePromise = disposing;
      disposeFailureDelivered = false;
      try {
        await disposing;
      } catch (cause) {
        if (disposePromise === disposing) disposeFailureDelivered = true;
        throw cause;
      }
    }

    async function startRuntime(context: ExtensionContext): Promise<void> {
      const startingGeneration = ++generation;
      if (active === undefined && disposeFailureDelivered) {
        disposePromise = undefined;
        disposeFailureDelivered = false;
      }
      await disposeRuntime();
      if (generation !== startingGeneration) return;
      const manager = SettingsManager.create(context.cwd, getAgentDirectory(), {
        projectTrusted: context.isProjectTrusted(),
      });
      const settings = readSettings(manager);
      const warnings = [
        ...manager.drainErrors().map(({ scope, error }) => `${scope} settings: ${error.message}`),
        ...settings.warnings,
      ];
      if (warnings.length > 0)
        context.ui.notify(
          noticeText("DAP", sanitizeDapObserverText(`settings:\n- ${warnings.join("\n- ")}`)),
          "warning",
        );
      const artifacts = await createDapArtifacts(context.sessionManager.getSessionDir());
      if (generation !== startingGeneration) {
        try {
          await artifacts.dispose();
        } catch (cause) {
          pendingAllocationFailures.push(cause);
          throw cause;
        }
        return;
      }
      const observer = new DapWidget(context);
      active = {
        observer,
        controller: new DapController({
          cwd: context.cwd,
          settings,
          artifacts,
          onSnapshotChange: (snapshot) => observer.onSessionSnapshot(snapshot),
          onUnexpectedFailure: (error) => observer.onUnexpectedFailure(error),
        }),
        artifacts,
      };
    }

    registerSteering(pi);
    for (const tool of createDapTools(() => active))
      pi.registerTool(acceptNullForOptionalArguments(tool));
    pi.on("session_start", (_event, context) => startRuntime(context));
    pi.on("session_shutdown", () => {
      generation++;
      return disposeRuntime();
    });
  };
}

export default createDapExtension();
