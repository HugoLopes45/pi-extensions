import * as piSdk from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { completeOnlookerCommandArguments, parseOnlookerCommand } from "../src/onlooker-command.js";
import {
  OnlookerSettingsMenu,
  type OnlookerMenuHost,
  type OnlookerScopedOptions,
} from "../src/onlooker-menu.js";
import { OnlookerObserver } from "../src/onlooker-observer.js";
import {
  onlookerAskToolName as askToolName,
  onlookerFooterText,
  onlookerStatusHeadline,
  renderOnlookerAskCall,
  renderOnlookerAskResult,
  renderOnlookerIntervention,
  renderOnlookerStatus,
  type OnlookerActivity,
  type OnlookerRenderTheme,
  type OnlookerStatusEntry,
} from "../src/onlooker-rendering.js";
import { isOnlookerSession } from "../src/onlooker-session.js";
import {
  readOnlookerLayers,
  readOnlookerOverrides,
  readOnlookerSettings,
  writeOnlookerSettings,
  type OnlookerLayers,
  type OnlookerChange,
  type OnlookerAppliedChange,
  type OnlookerSettingScope,
} from "../src/onlooker-settings.js";
import { TROUBLESHOOTING_HINT } from "../src/troubleshooting-skill.js";
import { expandEntryOnClick, expandMessageOnClick } from "../src/utils/expand-on-click.js";
import { acceptNullForOptionalArguments } from "../src/utils/null-optional-arguments.js";
import { discoverPiAgentSession } from "../src/utils/pi-agent-session-discovery.js";
import { noticeText } from "../src/utils/ui.js";

const askToolParameters = Type.Object(
  { message: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
/** Live status fields while no Onlooker Session observes. */
function idleStatus(enabled: boolean) {
  return {
    state: enabled ? ("armed" as const) : ("disabled" as const),
    backlog: 0,
    effectiveModel: null,
    effectiveThinkingLevel: null,
    usage: null,
    cost: null,
    spend: null,
    droppedFindings: { unsupported: 0, invalidReviews: 0 },
    lastError: null,
  };
}

/** Review an observed session without changing its tools or standing instructions. */
export default function onlooker(pi: ExtensionAPI): void {
  let warn: (message: string) => void = () => {};
  let footer: ExtensionUIContext | undefined;
  /** The open settings menu, refreshed on state changes and closed on session changes. */
  let activeMenu: { refresh: () => void; close: () => void } | undefined;
  let observed: AgentSession | undefined;
  let error: string | undefined;
  let displayName = "Onlooker";
  let layers: OnlookerLayers = { global: {}, project: {} };
  let generation = 0;
  let privateSession = false;
  let observer: OnlookerObserver | undefined;
  let askToolRegistered = false;
  pi.registerEntryRenderer(
    "pi-onlooker-status",
    expandEntryOnClick((entry, { expanded }, theme) =>
      renderOnlookerStatus(entry.data, expanded, theme),
    ),
  );
  pi.registerMessageRenderer(
    "pi-onlooker",
    expandMessageOnClick((message, options, theme) =>
      renderOnlookerIntervention(message.details, options, theme),
    ),
  );

  /** Show the current Onlooker state in the open settings menu and the footer. */
  function publishState(): void {
    activeMenu?.refresh();
    if (!footer) return;
    const root: OnlookerActivity | undefined =
      observer?.status ?? (observed && error ? { state: "paused", name: displayName } : undefined);
    try {
      footer.setStatus("onlooker", onlookerFooterText(root, footer.theme));
    } catch {
      // A replaced session's UI is stale; status entries remain authoritative.
    }
  }

  function setAskToolAvailable(available: boolean): void {
    if (available && !askToolRegistered) {
      const askTool = piSdk.defineTool({
        name: askToolName,
        label: "Ask Onlooker",
        description:
          "Ask the Onlooker, a second model that reviews your work, for analysis or a second opinion. Waits for its answer. It reads files but cannot edit them or run commands.",
        parameters: askToolParameters,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        executionMode: "sequential",
        renderCall: (args, theme, context) =>
          renderOnlookerAskCall(args, context.expanded, theme, context),
        renderResult: (result, options, theme, context) =>
          renderOnlookerAskResult(
            result.content.map((item) => (item.type === "text" ? item.text : "")).join(""),
            { expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
            theme,
            context,
          ),
        execute: async (_id, { message }, signal) => {
          try {
            const current = observer;
            if (!current)
              throw new Error(
                `${error ?? "Onlooker consultation is unavailable"}. Inspect /onlooker status, then run /onlooker on or correct its configuration.`,
              );
            const answer = await current.consult(message, signal);
            return { content: [{ type: "text", text: answer }], details: {} };
          } catch (cause) {
            // Caller cancellation is not a malfunction the Skill diagnoses.
            if (signal?.aborted) throw cause;
            const text = cause instanceof Error ? cause.message : String(cause);
            throw new Error(`${text}\n\n${TROUBLESHOOTING_HINT}`, { cause });
          }
        },
      });
      pi.registerTool(acceptNullForOptionalArguments(askTool));
      askToolRegistered = true;
      return;
    }
    if (!askToolRegistered) return;
    const active = pi.getActiveTools();
    if (available === active.includes(askToolName)) return;
    pi.setActiveTools(
      available ? [...active, askToolName] : active.filter((name) => name !== askToolName),
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    activeMenu?.close();
    const stamp = ++generation;
    const previous = observer;
    observer = undefined;
    await previous?.dispose();
    if (stamp !== generation) return;
    observed = undefined;
    error = undefined;
    privateSession = isOnlookerSession(ctx.sessionManager);
    displayName = "Onlooker";
    if (privateSession) {
      setAskToolAvailable(false);
      return;
    }
    const { ui } = ctx;
    footer = ctx.hasUI ? ui : undefined;
    warn = (message) => {
      try {
        ui.notify(message, "warning");
      } catch {
        // A replaced session's UI is stale; the native status entry remains the durable record.
      }
    };
    const found = discoverPiAgentSession(pi, piSdk.AgentSession);
    if (found.ok) {
      observed = found.session;
      layers = readOnlookerLayers(observed.settingsManager);
      await refresh(ctx);
    } else {
      error = found.warning;
      setAskToolAvailable(true);
    }
  });
  pi.on("session_tree", async (_event, ctx) => {
    activeMenu?.close();
    generation++;
    observer?.reset();
    await refresh(ctx);
  });
  pi.on("model_select", () => observer?.modelChanged());
  // Since Pi 1.2 a custom message's run, such as a corrective continuation, fires this too.
  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "custom") observer?.beforeTask();
  });
  pi.on("agent_before_settle", (event) => observer?.beforeSettle(event));
  pi.on("agent_settled", (event) => observer?.settled(event.aborted));
  pi.on("session_shutdown", async () => {
    activeMenu?.close();
    generation++;
    observed = undefined;
    await observer?.dispose();
    observer = undefined;
    publishState();
    footer = undefined;
  });

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (!observed || privateSession) return;
    try {
      const { settings } = readOnlookerSettings(observed, layers);
      displayName = settings.name;
      if (observer) observer.configure(settings);
      else
        observer = new OnlookerObserver(
          observed,
          settings,
          ctx.hasUI ? "interactive" : "headless-root",
          {
            onError: (message) => {
              pi.appendEntry("pi-onlooker-status", {
                state: "paused",
                error: message,
                settings: { name: displayName },
              });
              warn(noticeText(displayName, `paused: ${message}`));
            },
            onStateChange: publishState,
          },
        );
      setAskToolAvailable(settings.enabled);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      setAskToolAvailable(true);
      await observer?.dispose();
      observer = undefined;
    }
    publishState();
  }

  /** Current effective settings and live Onlooker state, as recorded in status entries. */
  function statusData(subject: AgentSession): OnlookerStatusEntry {
    const resolved = readOnlookerSettings(subject, layers);
    const live = observer?.status ?? idleStatus(resolved.settings.enabled);
    return { ...resolved, ...live, error: error ?? live.lastError };
  }

  function status(ctx: ExtensionContext, changes: readonly OnlookerAppliedChange[] = []): void {
    try {
      if (!observed) throw new Error(error ?? "Onlooker session is unavailable");
      const entry = statusData(observed);
      if (changes.length) entry.changes = [...changes];
      pi.appendEntry("pi-onlooker-status", entry);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      pi.appendEntry("pi-onlooker-status", { state: "paused", error, usage: null, cost: null });
    }
    if (error) ctx.ui.notify(noticeText(displayName, error), "error");
  }

  /** Persist one validated change at its scope and reconfigure; undefined if superseded. */
  async function applyChange(
    ctx: ExtensionContext,
    subject: AgentSession,
    scope: OnlookerSettingScope,
    change: OnlookerChange,
    isCurrent: () => boolean,
  ): Promise<OnlookerAppliedChange | undefined> {
    if (scope === "session") {
      const overrides = readOnlookerOverrides(subject.sessionManager);
      if (change.action === "inherit") delete overrides[change.key];
      else Object.assign(overrides, change.patch);
      pi.appendEntry("pi-onlooker-settings", { version: 1, overrides });
    } else {
      const updated = await writeOnlookerSettings(
        subject.settingsManager,
        scope,
        change,
        isCurrent,
      );
      if (!isCurrent() || !updated) return undefined;
      layers[scope] = updated;
    }
    error = undefined;
    await refresh(ctx);
    return { scope, key: change.key, options: change.action === "inherit" ? {} : change.patch };
  }

  /** The settings menu's view of this extension's settings authority. */
  function menuHost(
    ctx: ExtensionContext,
    subject: AgentSession,
    theme: OnlookerRenderTheme,
    applied: OnlookerAppliedChange[],
  ): OnlookerMenuHost {
    return {
      view() {
        const data = statusData(subject);
        const authored: Partial<OnlookerScopedOptions> = {
          session: readOnlookerOverrides(subject.sessionManager),
        };
        if (!(layers.project instanceof Error)) authored.project = layers.project;
        if (!(layers.global instanceof Error)) authored.global = layers.global;
        return {
          headline: onlookerStatusHeadline(data, theme),
          paused: data.state === "paused",
          scopes: subject.settingsManager.isProjectTrusted()
            ? ["session", "project", "global"]
            : ["session", "global"],
          settings: data.settings ?? {},
          sources: data.sources ?? {},
          authored,
          models: ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`),
        };
      },
      async apply(scope, change) {
        const stamp = ++generation;
        const result = await applyChange(
          ctx,
          subject,
          scope,
          change,
          () => generation === stamp && observed === subject,
        );
        if (result) applied.push(result);
      },
      async resume() {
        error = undefined;
        await refresh(ctx);
      },
    };
  }

  /** Native settings list in the editor area, as `/settings` does; one status entry on close. */
  async function openMenu(ctx: ExtensionContext, subject: AgentSession): Promise<void> {
    const applied: OnlookerAppliedChange[] = [];
    let discarded = false;
    let menu: OnlookerSettingsMenu | undefined;
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const opened = new OnlookerSettingsMenu(
        menuHost(ctx, subject, theme, applied),
        {
          tui,
          theme,
        },
        () => done(),
      );
      menu = opened;
      activeMenu = {
        refresh: () => {
          opened.refresh();
          tui.requestRender();
        },
        close: () => {
          discarded = true;
          activeMenu = undefined;
          done();
        },
      };
      return opened;
    });
    activeMenu = undefined;
    // Edits started before closing are still recorded once they settle.
    await menu?.settled();
    if (!discarded && observed === subject && applied.length) status(ctx, applied);
  }

  pi.registerCommand("onlooker", {
    description: "Onlooker settings menu, or on, off, inherit, set, and status",
    getArgumentCompletions: completeOnlookerCommandArguments,
    async handler(args, ctx) {
      if (privateSession) {
        pi.appendEntry("pi-onlooker-status", {
          state: "private",
          error: "Private Onlooker Sessions cannot create another Onlooker",
        });
        return;
      }
      const subject = observed;
      let stamp = generation;
      const isCurrent = () => generation === stamp && observed === subject;
      let applied: OnlookerAppliedChange | undefined;
      try {
        if (!subject) throw new Error(error ?? "Onlooker session is unavailable");
        const command = parseOnlookerCommand(args);
        if (command.action === "menu" && ctx.mode === "tui") {
          // Opening fails closed to the status entry when settings cannot be read.
          statusData(subject);
          await openMenu(ctx, subject);
          return;
        }
        if (command.action !== "status" && command.action !== "menu") {
          stamp = ++generation;
          applied = await applyChange(ctx, subject, command.scope, command, isCurrent);
        }
      } catch (cause) {
        if (!isCurrent()) return;
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (isCurrent()) status(ctx, applied ? [applied] : []);
    },
  });
}
