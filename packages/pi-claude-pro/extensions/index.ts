import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorText } from "pi-hl-utils/errors";
import {
  layeredMenuScopes,
  layeredSettingsSession,
  type LayeredSettingScope,
} from "pi-hl-utils/layered-settings";
import { registerSettingsCommand } from "pi-hl-utils/settings-command";
import { SettingsMenu } from "pi-hl-utils/settings-menu";

import { checkAccess, type Access } from "../src/access.ts";
import { BUNDLED_CLAUDE_CODE_VERSION, clientHeaders } from "../src/claude-code.ts";
import { claudeProCommandSpec } from "../src/claude-pro-command.ts";
import { parseLimitHeaders, parseUsageBody, type Limits } from "../src/limits.ts";
import { claudeProMenuSpec, type ClaudeProMenuHost, type ClaudeProMenuView } from "../src/menu.ts";
import { createProviderStream } from "../src/provider.ts";
import { createRateLimits } from "../src/rate-limit.ts";
import {
  claudeProDefaults,
  claudeProSettings,
  type ClaudeProChange,
  type ClaudeProConfig,
} from "../src/settings.ts";
import {
  accessFooter,
  footer,
  statusReport,
  type Footer,
  type FooterOptions,
  type Report,
  type StatusInput,
} from "../src/status.ts";
import { fetchUsage } from "../src/usage.ts";

const STATUS_KEY = "claude-pro";

function access(ctx: ExtensionContext): Promise<Access> {
  return checkAccess(ctx.modelRegistry, ctx.model);
}

function footerOptions(settings: ClaudeProConfig): FooterOptions {
  return { warnAt: settings.warnAt, windows: settings.footerWindows };
}

async function lookUpUsage(
  auth: Extract<Access, { kind: "subscription" }>,
  modelId: string,
  claudeCodeVersion: string | undefined,
): Promise<Pick<StatusInput, "limits" | "usageError">> {
  try {
    const body = await fetchUsage({
      accessToken: auth.accessToken,
      headers: clientHeaders(
        auth.headers,
        claudeCodeVersion ?? BUNDLED_CLAUDE_CODE_VERSION,
        undefined,
      ),
      signal: undefined,
      modelId,
      firstParty: auth.firstParty,
    });
    return { limits: parseUsageBody(body, modelId) };
  } catch (error) {
    return {
      usageError: errorText(error),
    };
  }
}

/** Header limits know the billing state; the usage endpoint fills missing windows. */
async function planUsage(
  auth: Extract<Access, { kind: "subscription" }>,
  modelId: string,
  last: Limits | undefined,
  claudeCodeVersion: string | undefined,
): Promise<Pick<StatusInput, "limits" | "usageError">> {
  if (last && last.windows.length > 0) return { limits: last };
  const usage = auth.firstParty
    ? await lookUpUsage(auth, modelId, claudeCodeVersion)
    : { usageError: "not available behind a proxy" };
  if (!last) return usage;
  return {
    limits: { ...last, windows: usage.limits?.windows ?? [] },
    ...(usage.usageError && { usageError: usage.usageError }),
  };
}

export default function claudePro(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let lastLimits: Limits | undefined;
  let warnedExtraUsage = false;
  let shownStatus: Footer | undefined;
  const reportedSettingsErrors = new Set<string>();

  /**
   * Pi can call the provider with no session context: before a turn when no UI is bound, or after
   * a reload drops this extension but keeps its provider. No session then means no layers to read.
   */
  function currentSettings(): ClaudeProConfig {
    return ctx ? effectiveSettings(ctx) : claudeProDefaults;
  }

  /**
   * Effective settings for a request or the footer. An invalid layer is ignored, and its error is
   * warned once per distinct message rather than on every read.
   */
  function effectiveSettings(current: ExtensionContext): ClaudeProConfig {
    const { settings, invalid } = claudeProSettings.readSettingsLeniently(
      layeredSettingsSession(current),
    );
    for (const error of invalid) {
      const message = errorText(error);
      if (!current.hasUI || reportedSettingsErrors.has(message)) continue;
      reportedSettingsErrors.add(message);
      current.ui.notify(
        `pi-claude-pro: ${message}. Using the other settings until it is fixed.`,
        "warning",
      );
    }
    return settings;
  }

  function show(status: Footer | undefined): void {
    shownStatus = status;
    if (!ctx?.hasUI) return;
    const shown = effectiveSettings(ctx).footer ? status : undefined;
    ctx.ui.setStatus(STATUS_KEY, shown && ctx.ui.theme.fg(shown.level, shown.text));
  }

  function showLimits(limits: Limits): void {
    lastLimits = limits;
    const settings = currentSettings();
    show(footer(limits, Date.now(), footerOptions(settings)));
    if (!limits.extraUsage || !settings.extraUsageWarning || warnedExtraUsage || !ctx?.hasUI)
      return;
    warnedExtraUsage = true;
    ctx.ui.notify(
      "Claude requests are billed as extra usage, per token. Run /claude-pro to see why.",
      "warning",
    );
  }

  /** Redraw the footer with the settings in effect now. */
  function refreshFooter(): void {
    if (lastLimits) showLimits(lastLimits);
    else show(shownStatus);
  }

  async function showReady(current: ExtensionContext): Promise<void> {
    ctx = current;
    lastLimits = undefined;
    show(accessFooter((await access(current)).kind));
  }

  async function report(current: ExtensionContext): Promise<Report> {
    ctx = current;
    const settings = effectiveSettings(current);
    const model = current.model;
    const auth = await access(current);
    const input: StatusInput = {
      model: model ? `${model.provider}/${model.id}` : "none",
      kind: auth.kind,
      ...(auth.kind === "auth-error" && { error: auth.error }),
      ...(auth.kind === "subscription" &&
        model &&
        (await planUsage(auth, model.id, lastLimits, settings.claudeCodeVersion))),
      warnAt: settings.warnAt,
    };
    return statusReport(input);
  }

  /** Persist one validated change at its scope; a session change becomes a session entry. */
  async function applyChange(
    current: ExtensionContext,
    scope: LayeredSettingScope,
    change: ClaudeProChange,
  ): Promise<void> {
    // Nothing else writes to this file while the command runs, so no write is stale.
    await claudeProSettings.writeChange(
      pi,
      layeredSettingsSession(current),
      scope,
      change,
      () => true,
    );
    refreshFooter();
  }

  async function notifyStatus(current: ExtensionContext): Promise<void> {
    const status = await report(current);
    current.ui.notify(status.text, status.level);
  }

  function menuHost(current: ExtensionContext, headline: readonly string[]): ClaudeProMenuHost {
    return {
      view(): ClaudeProMenuView {
        const session = layeredSettingsSession(current);
        const { settings, sources, authored } = claudeProSettings.readSettingsLeniently(session);
        return {
          headline,
          scopes: layeredMenuScopes(session.settingsManager),
          settings,
          sources,
          authored,
        };
      },
      apply: (scope, change) => applyChange(current, scope, change),
    };
  }

  async function openMenu(current: ExtensionContext, status: Report): Promise<void> {
    await current.ui.custom<void>((tui, theme, _keybindings, done) => {
      const color = status.level === "info" ? "muted" : status.level;
      const headline = [theme.fg(color, status.text)];
      return new SettingsMenu(claudeProMenuSpec(menuHost(current, headline)), { tui, theme }, () =>
        done(),
      );
    });
  }

  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: createProviderStream({
      stream: anthropicMessagesApi().streamSimple,
      contextWindows: new Map(
        getBuiltinModels("anthropic").map((model) => [model.id, model.contextWindow]),
      ),
      claudeCodeVersion: () => currentSettings().claudeCodeVersion,
      watchRequest: createRateLimits({
        fetchUsage,
        onLimits: showLimits,
        usageCacheMs: () => currentSettings().usageCacheSeconds * 1000,
      }),
    }),
  });

  registerSettingsCommand(pi, {
    name: "claude-pro",
    description: "Claude Pro usage status, settings menu, on, off, inherit, or set",
    optionKeys: claudeProSettings.optionKeys,
    parse: claudeProCommandSpec,
    start(current) {
      ctx = current;
      return {
        status: () => notifyStatus(current),
        async menu() {
          await openMenu(current, await report(current));
        },
        async change(command) {
          await applyChange(current, command.scope, command);
          await notifyStatus(current);
        },
        fail: (cause) => current.ui.notify(`pi-claude-pro: ${errorText(cause)}`, "error"),
      };
    },
  });

  pi.on("session_start", (_event, current) => {
    warnedExtraUsage = false;
    return showReady(current);
  });
  pi.on("model_select", (_event, current) => showReady(current));
  pi.on("before_agent_start", (_event, current) => {
    ctx = current;
  });

  pi.on("after_provider_response", async (event, current) => {
    ctx = current;
    const limits = parseLimitHeaders(event.headers, event.status);
    if (!limits || (await access(current)).kind !== "subscription") return;
    showLimits(limits);
  });

  pi.on("session_shutdown", (_event, current) => {
    ctx = current;
    show(undefined);
    ctx = undefined;
  });
}
