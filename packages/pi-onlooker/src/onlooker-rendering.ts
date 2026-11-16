import {
  getMarkdownTheme,
  type MessageRenderOptions,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  onlookerFindingSchema,
  onlookerDroppedFindingsSchema,
  onlookerSpendSchema,
  onlookerStateSchema,
  type OnlookerSpend,
  type OnlookerWorkSpend,
  type OnlookerSeverity,
  type OnlookerState,
} from "./onlooker-contract.js";
import {
  onlookerAppliedChangeSchema,
  onlookerOptionKeys,
  onlookerOptionsSchema,
  onlookerSettingSourceSchema,
  type OnlookerOptions,
} from "./onlooker-settings.js";
import {
  callDurationFooter,
  COLLAPSED_LINES,
  appendDurationFooter,
  CollapsedPreview,
  customMessageBox,
  joinInline,
  previewBody,
  statusMark,
  summaryExpandHint,
  toolHeader,
  type DurationContext,
  type StatusKind,
} from "./utils/ui.js";

/** Theme operations used by Onlooker transcript and footer renderers. */
export type OnlookerRenderTheme = Pick<Theme, "fg" | "bg" | "bold">;

/** The registered name of the consultation tool. */
export const onlookerAskToolName = "onlooker_ask";

/** Severity Labels: a coloured word, never a Status Mark. */
const severityColor = {
  nit: "dim",
  concern: "warning",
  blocker: "error",
} as const satisfies Record<OnlookerSeverity, ThemeColor>;

const nullableString = Type.Union([Type.String(), Type.Null()]);
/** The minimum every historical status entry recorded. */
const minimalStatusSchema = Type.Object({
  state: onlookerStateSchema,
  error: Type.Optional(nullableString),
});
const statusSchema = Type.Object({
  state: onlookerStateSchema,
  changes: Type.Optional(Type.Array(onlookerAppliedChangeSchema)),
  settings: Type.Optional(onlookerOptionsSchema),
  sources: Type.Optional(Type.Record(Type.String(), onlookerSettingSourceSchema)),
  backlog: Type.Optional(Type.Number()),
  effectiveModel: Type.Optional(nullableString),
  effectiveThinkingLevel: Type.Optional(nullableString),
  usage: Type.Optional(Type.Union([Type.Object({ total: Type.Number() }), Type.Null()])),
  cost: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  spend: Type.Optional(Type.Union([onlookerSpendSchema, Type.Null()])),
  droppedFindings: Type.Optional(
    // Entries recorded before a reason existed omit its count.
    Type.Partial(onlookerDroppedFindingsSchema),
  ),
  error: Type.Optional(nullableString),
  lastError: Type.Optional(nullableString),
});
/** Data recorded in a `pi-onlooker-status` entry. */
export type OnlookerStatusEntry = Static<typeof statusSchema>;
const stateMarkKind = {
  disabled: "idle",
  private: "idle",
  armed: "active",
  reviewing: "active",
  consulting: "active",
  paused: "warning",
} as const satisfies Record<OnlookerState, StatusKind>;

/** Styles a plain piece of text; messages use `customMessageText`, menus leave it as is. */
type Paint = (text: string) => string;
const unpainted: Paint = (text) => text;
const messagePaint =
  (theme: Pick<Theme, "fg">): Paint =>
  (text) =>
    theme.fg("customMessageText", text);

/** Severity-labelled, attributed Intervention; invalid details fall back to Pi's renderer. */
export function renderOnlookerIntervention(
  // Journaled custom-message details are validated by the finding schema below.
  details: unknown,
  options: Pick<MessageRenderOptions, "expanded" | "outputPad">,
  theme: OnlookerRenderTheme,
): Component | undefined {
  if (!Value.Check(onlookerFindingSchema, details)) return undefined;
  const heading = theme.fg(severityColor[details.severity], details.severity);
  const body = new Markdown(details.message, 0, 0, getMarkdownTheme(), {
    color: messagePaint(theme),
  });
  return customMessageBox(
    theme,
    { outputPad: options.outputPad, source: details.name ?? "onlooker", heading },
    [
      details.severity === "nit"
        ? new CollapsedPreview(theme, body, {
            limit: COLLAPSED_LINES.fallback,
            expanded: options.expanded,
          })
        : body,
    ],
  );
}

/** Pi's entry renderers get no `outputPad`, so entries use Pi's default of one column. */
const entryOutputPad = 1;

/** `onlooker_ask` call: the question, first line only while collapsed. */
export function renderOnlookerAskCall(
  args: { message: string },
  expanded: boolean,
  theme: OnlookerRenderTheme,
  context: DurationContext,
): Component {
  const [first = "", ...rest] = args.message.split("\n");
  const hidden = rest.length > 0 && !expanded;
  const heading = toolHeader(theme, onlookerAskToolName, expanded ? undefined : first);
  const container = new Container();
  container.addChild(new Text(hidden ? `${heading}${summaryExpandHint(theme)}` : heading, 0, 0));
  if (expanded) container.addChild(new Text(theme.fg("muted", `message: ${args.message}`), 0, 0));
  container.addChild(callDurationFooter(theme, context));
  return container;
}

/** `onlooker_ask` result: a Markdown answer, previewed while collapsed, then Pi's duration footer. */
export function renderOnlookerAskResult(
  answer: string,
  options: { expanded: boolean; isPartial: boolean; isError: boolean },
  theme: OnlookerRenderTheme,
  context: DurationContext,
): Component {
  const container = new Container();
  if (answer) {
    container.addChild(new Spacer(1));
    if (options.isError) {
      const lines = previewBody(theme, answer.split("\n"), {
        limit: COLLAPSED_LINES.fallback,
        expanded: options.expanded,
        color: "error",
      });
      container.addChild(new Text(lines.join("\n"), 0, 0));
    } else {
      const body = new Markdown(answer, 0, 0, getMarkdownTheme(), {
        color: (text) => theme.fg("toolOutput", text),
      });
      container.addChild(
        new CollapsedPreview(theme, body, {
          limit: COLLAPSED_LINES.fallback,
          expanded: options.expanded,
        }),
      );
    }
  }
  appendDurationFooter(container, theme, context, { isPartial: options.isPartial });
  return container;
}

function formatTokens(total: number): string {
  if (total < 1_000) return String(total);
  if (total < 1_000_000) return `${(total / 1_000).toFixed(1)}k`;
  return `${(total / 1_000_000).toFixed(1)}M`;
}

function formatMoney(cost: number): string {
  return `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "cost unknown";
  return `cost ${formatMoney(cost)}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function formatWork(work: OnlookerWorkSpend, one: string, many: string): string | undefined {
  if (!work.count) return;
  return [
    plural(work.count, one, many),
    plural(work.calls, "call", "calls"),
    `in ${formatTokens(work.input)}`,
    `cache read ${formatTokens(work.cacheRead)}`,
    `cache write ${formatTokens(work.cacheWrite)}`,
    `out ${formatTokens(work.output)}`,
    work.cost === null ? "cost unknown" : formatMoney(work.cost),
    `${(work.ms / 1000).toFixed(1)}s`,
  ].join(" · ");
}

/** One line per kind of Onlooker work done, then the evidence it did not see in full. */
function spendLines({ reviews, consultations, compactions, evidence }: OnlookerSpend): string[] {
  const lost = joinDefined(
    [
      evidence.seeds ? plural(evidence.seeds, "Context Seed", "Context Seeds") : undefined,
      evidence.omittedMessages ? `${evidence.omittedMessages} omitted` : undefined,
      evidence.shortenedMessages ? `${evidence.shortenedMessages} shortened` : undefined,
      evidence.cappedResults ? `${evidence.cappedResults} capped` : undefined,
    ],
    " · ",
  );
  return [
    formatWork(reviews, "Review", "Reviews"),
    formatWork(consultations, "consultation", "consultations"),
    formatWork(compactions, "compaction", "compactions"),
    lost ? `evidence: ${lost}` : undefined,
  ].filter((line): line is string => line !== undefined);
}

/** Findings dropped, when there are any. */
function findingCounts(entry: OnlookerStatusEntry): string[] {
  const dropped = entry.droppedFindings;
  return [
    dropped?.unsupported
      ? `${plural(dropped.unsupported, "finding", "findings")} without valid evidence dropped`
      : "",
    dropped?.invalidReviews
      ? `${plural(dropped.invalidReviews, "Review", "Reviews")} ended by invalid reports`
      : "",
  ].filter(Boolean);
}

/** Human-readable option value; an absent value inherits. */
export function formatOnlookerOption(options: OnlookerOptions, key: keyof OnlookerOptions): string {
  const value = options[key];
  return value === undefined ? "inherit" : String(value);
}

/** The word shown for a state: an armed Onlooker reads `on` to the user. */
function stateWord(state: OnlookerState): string {
  return state === "armed" ? "on" : state;
}

function badge(state: OnlookerState, theme: OnlookerRenderTheme, paint: Paint): string {
  return `${statusMark(theme, stateMarkKind[state])} ${paint(stateWord(state))}`;
}

function joinDefined(parts: ReadonlyArray<string | undefined>, separator: string): string {
  return parts.filter((part) => part !== undefined).join(separator);
}

function stateLine(
  entry: OnlookerStatusEntry,
  theme: OnlookerRenderTheme,
  label: string | undefined,
  paint: Paint,
): string {
  const inherited = entry.settings && entry.settings.model === undefined;
  const state = badge(entry.state, theme, paint);
  return joinInline(theme, [
    label ? `${label} ${state}` : state,
    entry.effectiveModel
      ? `${paint(entry.effectiveModel)}${inherited ? theme.fg("dim", " (inherited)") : ""}`
      : undefined,
    entry.effectiveThinkingLevel ? paint(entry.effectiveThinkingLevel) : undefined,
    entry.backlog ? paint(`backlog ${entry.backlog}`) : undefined,
  ]);
}

function errorLine(theme: OnlookerRenderTheme, error: string): string {
  return `${statusMark(theme, "failed")} ${theme.fg("error", error)}`;
}

/** Live state line plus any error, as shown at the top of the settings menu. */
export function onlookerStatusHeadline(
  entry: OnlookerStatusEntry,
  theme: OnlookerRenderTheme,
): string[] {
  const error = entry.error ?? entry.lastError;
  return [
    stateLine(entry, theme, theme.bold(entry.settings?.name ?? "Onlooker"), unpainted),
    ...(error ? [errorLine(theme, error)] : []),
  ];
}

/** The status entry's body below its `[onlooker] ● on · model` label line. */
function summaryLines(entry: OnlookerStatusEntry, theme: OnlookerRenderTheme): string[] {
  const paint = messagePaint(theme);
  const lines: string[] = [];
  for (const { scope, key, options } of entry.changes ?? []) {
    lines.push(
      `${statusMark(theme, "done")} ${paint(`${key} → ${formatOnlookerOption(options, key)}`)} ${theme.fg("dim", `[${scope}]`)}`,
    );
  }
  const activity = joinDefined(
    [
      entry.usage ? `tokens ${formatTokens(entry.usage.total)}` : undefined,
      entry.usage ? formatCost(entry.cost) : undefined,
    ],
    " · ",
  );
  if (activity)
    lines.push(theme.fg("muted", `${entry.settings?.name ?? "Onlooker"} Session: ${activity}`));
  for (const line of entry.spend ? spendLines(entry.spend) : [])
    lines.push(theme.fg("muted", line));
  const counts = findingCounts(entry);
  if (counts.length) lines.push(theme.fg("muted", counts.join(" · ")));
  const error = entry.error ?? entry.lastError;
  if (error) lines.push(errorLine(theme, error));
  return lines;
}

function detailLines(entry: OnlookerStatusEntry, theme: OnlookerRenderTheme): string[] {
  const paint = messagePaint(theme);
  const lines: string[] = [];
  if (entry.settings) {
    const settings = entry.settings;
    const width = Math.max(...onlookerOptionKeys.map((key) => key.length));
    lines.push("");
    for (const key of onlookerOptionKeys) {
      const source = entry.sources?.[key] ?? "default";
      lines.push(
        `  ${paint(key.padEnd(width))}  ${paint(formatOnlookerOption(settings, key))}  ${theme.fg(source === "default" ? "dim" : "accent", `[${source}]`)}`,
      );
    }
  }
  return lines;
}

/** Drop top-level fields that no longer match, so older entries keep what they can show. */
function salvageStatus(data: Static<typeof minimalStatusSchema>): OnlookerStatusEntry {
  // Runtime copy keeps every recorded field; only mismatching ones are removed below.
  const candidate = structuredClone(data);
  for (const issue of Value.Errors(statusSchema, candidate)) {
    const field = issue.instancePath.split("/")[1];
    if (field && field !== "state") Reflect.deleteProperty(candidate, field);
  }
  return Value.Check(statusSchema, candidate)
    ? candidate
    : { state: data.state, error: data.error ?? null };
}

/**
 * Status snapshot in Pi's custom-message look: a ten-line summary, with every setting when
 * expanded.
 */
export function renderOnlookerStatus(
  // Journaled entry data is validated below; older shapes keep their state and error, anything else renders raw.
  data: unknown,
  expanded: boolean,
  theme: OnlookerRenderTheme,
  outputPad = entryOutputPad,
): Component {
  if (!Value.Check(minimalStatusSchema, data))
    return customMessageBox(theme, { outputPad, source: "onlooker" }, [
      new Text(JSON.stringify(data, null, 2), 0, 0),
    ]);
  const entry = salvageStatus(data);
  const summary = summaryLines(entry, theme);
  const details = detailLines(entry, theme);
  const heading = stateLine(entry, theme, undefined, messagePaint(theme));
  const rows = [...summary, ...details];
  const body = new Text(rows.join("\n"), 0, 0);
  return customMessageBox(
    theme,
    { outputPad, source: entry.settings?.name ?? "onlooker", heading },
    rows.length > 0
      ? [new CollapsedPreview(theme, body, { limit: COLLAPSED_LINES.fallback, expanded })]
      : [],
  );
}

/** The live fields the footer summarizes for one watched agent. */
export interface OnlookerActivity {
  name?: string;
  state: OnlookerState;
  /** `provider/id`; the footer shows only the id. */
  effectiveModel?: string | null;
}

/** Footer status entry; `undefined` clears it. Pause reasons stay in `/onlooker status`. */
export function onlookerFooterText(
  root: OnlookerActivity | undefined,
  theme: Pick<Theme, "fg">,
): string | undefined {
  if (!root || root.state === "disabled" || root.state === "private") return undefined;
  const paused = root.state === "paused";
  const busy = root.state === "reviewing" || root.state === "consulting";
  const mark = paused ? "warning" : busy ? "active" : "idle";
  return `${statusMark(theme, mark)}  ${joinInline(theme, [
    theme.fg("dim", root.name ?? "onlooker"),
    root.effectiveModel?.slice(root.effectiveModel.indexOf("/") + 1),
  ])}`;
}
