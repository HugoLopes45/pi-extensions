import type { TextContent } from "@earendil-works/pi-ai";
import type {
  ContextEditableContent,
  ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  type Edit,
  type EditableMessage,
  editableMessage,
  messageTokens,
  withContent,
} from "./context.ts";

export interface ShakeOptions {
  /** Newest context tokens that are never shaken. */
  protectTokens: number;
  /** Shake nothing unless the total savings reach this many tokens. */
  minSavings: number;
  /** Fenced or XML blocks smaller than this stay. */
  blockMinTokens: number;
}

/** A fenced code block, or an XML-like element with a matching closing tag. */
const BLOCK =
  /(?=(`{3,}|~{3,}))\1[^\n]*\n[\s\S]*?\n[ \t]*\1|<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\2>/y;
const BLOCK_START = /(?<!`)`{3,}|(?<!~)~{3,}|<[A-Za-z]/g;
const OPEN_TAG = /<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>/y;
const CLOSE_TAG = /<\/([A-Za-z][\w.:-]*)>/g;

/**
 * Elides large blocks and images from older messages. Tool calls and thinking stay intact,
 * so every tool call keeps its result. Signatures stay valid, but Anthropic drops every thinking
 * block after the first changed message.
 */
export function shake(entries: readonly ProjectedSessionEntry[], options: ShakeOptions): Edit[] {
  const edits: Edit[] = [];
  let seen = 0;
  let savings = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    const isProtected = seen < options.protectTokens;
    for (const message of entry.messages) {
      if (message.role !== "system") seen += messageTokens(message);
    }
    const edit = isProtected ? undefined : shakeEdit(entry, options);
    if (!edit) continue;
    savings += edit.saved;
    edits.push(edit.edit);
  }
  return savings >= options.minSavings && edits.length > 0 ? edits.toReversed() : [];
}

function shakeEdit(
  entry: ProjectedSessionEntry,
  options: ShakeOptions,
): { edit: Edit; saved: number } | undefined {
  const message = editableMessage(entry);
  if (!message || message.role === "user") return undefined;
  const targetId = entry.sourceEntry.id;
  const content = shakeContent(message, targetId, options);
  if (content === undefined) return undefined;
  const saved = messageTokens(message) - messageTokens(withContent(message, content));
  return saved > 0 ? { edit: { targetId, content }, saved } : undefined;
}

function shakeContent(
  message: EditableMessage,
  id: string,
  options: ShakeOptions,
): ContextEditableContent | undefined {
  const text = (value: string) => elideBlocks(value, id, options.blockMinTokens);

  if (typeof message.content === "string") {
    const next = text(message.content);
    return next === message.content ? undefined : next;
  }
  let changed = false;
  const next = message.content.map((block) => {
    if (block.type === "text") {
      const replaced = text(block.text);
      if (replaced === block.text) return block;
      changed = true;
      return { ...block, text: replaced };
    }
    if (block.type === "image") {
      changed = true;
      return imageNotice(id);
    }
    return block;
  });
  // Blocks keep their kind, and images only occur where text is also allowed.
  return changed ? next : undefined;
}

function elideBlocks(text: string, id: string, minTokens: number): string {
  const lastCloser = new Map(
    Array.from(text.matchAll(CLOSE_TAG), (match) => [match[1], match.index]),
  );
  const unclosedFences = new Set<string>();
  let result = "";
  let copied = 0;
  BLOCK_START.lastIndex = 0;
  for (let start = BLOCK_START.exec(text); start; start = BLOCK_START.exec(text)) {
    BLOCK.lastIndex = start.index;
    const block = cannotClose(text, start, unclosedFences, lastCloser) ? null : BLOCK.exec(text);
    if (!block) {
      if (!start[0].startsWith("<")) unclosedFences.add(start[0]);
      continue;
    }
    const tokens = Math.ceil(block[0].length / 4);
    const notice = `[Elided block: about ${tokens} tokens. Call recall with entryId "${id}" to read it.]`;
    result += text.slice(copied, start.index) + (tokens < minTokens ? block[0] : notice);
    copied = BLOCK_START.lastIndex = BLOCK.lastIndex;
  }
  return result + text.slice(copied);
}

/**
 * Rules out openers without a closer before scanning, so unclosed input does not rescan the
 * text to its end once per opener. A fence that fails to close leaves no closer for any later
 * fence of the same length.
 */
function cannotClose(
  text: string,
  start: RegExpExecArray,
  unclosedFences: ReadonlySet<string>,
  lastCloser: ReadonlyMap<string | undefined, number>,
): boolean {
  if (!start[0].startsWith("<")) return unclosedFences.has(start[0]);
  OPEN_TAG.lastIndex = start.index;
  const name = OPEN_TAG.exec(text)?.[1];
  return name !== undefined && (lastCloser.get(name) ?? -1) < OPEN_TAG.lastIndex;
}

function imageNotice(id: string): TextContent {
  return {
    type: "text",
    text: `[Image elided. Call recall with entryId "${id}" to see its metadata.]`,
  };
}
