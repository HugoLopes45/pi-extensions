import { Type, type Static } from "typebox";

import type { Observation } from "./diagnostics.js";
import { bounded } from "./text.js";

const position = Type.Object({
  line: Type.Integer({ minimum: 0 }),
  character: Type.Integer({ minimum: 0 }),
});
const command = Type.Object({
  title: Type.String(),
  command: Type.String(),
  arguments: Type.Optional(Type.Array(Type.Unknown())),
});
const codeAction = Type.Object({
  title: Type.String(),
  kind: Type.Optional(Type.String()),
  isPreferred: Type.Optional(Type.Boolean()),
  edit: Type.Optional(Type.Unknown()),
  command: Type.Optional(command),
  data: Type.Optional(Type.Unknown()),
});
// The edit is checked where it is applied, so only the shape of each action is validated here.
export const codeActionItem = Type.Union([command, codeAction]);
export const codeActionList = Type.Union([Type.Null(), Type.Array(codeActionItem)]);

export type CodeActionItem = Static<typeof codeActionItem>;
export type Range = {
  start: Static<typeof position>;
  end: Static<typeof position>;
};
export type ListedAction = {
  title: string;
  kind: string;
  preferred: boolean;
  state: "edit" | "resolvable" | "command-only";
};

// Server text is untrusted: one bounded line is shown, and an apply title must equal this same text.
export function displayText(text: string): string {
  return bounded(text, { maxBytes: 512, maxLines: 1 }).content;
}

export function editOf(action: CodeActionItem): unknown {
  return "edit" in action ? action.edit : undefined;
}

// An action without an edit is resolvable when the server resolves it and the action carries data.
export function isResolvable(action: CodeActionItem, resolves: boolean): boolean {
  return resolves && editOf(action) === undefined && "data" in action && action.data !== undefined;
}

export function listedAction(action: CodeActionItem, resolves: boolean): ListedAction {
  const state =
    editOf(action) !== undefined
      ? "edit"
      : isResolvable(action, resolves)
        ? "resolvable"
        : "command-only";
  return {
    title: displayText(action.title),
    kind: displayText("kind" in action ? (action.kind ?? "none") : "command"),
    preferred: "isPreferred" in action ? (action.isPreferred ?? false) : false,
    state,
  };
}

const stateText = {
  edit: "",
  resolvable: " (resolvable)",
  "command-only": " (command-only, not applied)",
} as const;

export function formatCodeActions(actions: ListedAction[]): string {
  if (actions.length === 0) return "No code actions at this position";
  return actions
    .map(
      (action, index) =>
        `${index + 1}. [${action.kind}] ${action.title}${action.preferred ? " (preferred)" : ""}${stateText[action.state]}`,
    )
    .join("\n");
}

function before(a: Static<typeof position>, b: Static<typeof position>): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

// A diagnostic that touches either end of the range counts as overlapping it.
function overlaps(a: Range, b: Range): boolean {
  return !before(a.end, b.start) && !before(b.end, a.start);
}

// The context carries only the diagnostics whose range overlaps the requested range.
export function contextDiagnostics(
  diagnostics: Observation["diagnostics"],
  range: Range,
): {
  range: Range;
  message: string;
  severity: number | undefined;
  code: string | number | undefined;
}[] {
  return diagnostics
    .filter((item) => overlaps(item.range, range))
    .map(({ range: itemRange, message, severity, code }) => ({
      range: itemRange,
      message,
      severity,
      code,
    }));
}
