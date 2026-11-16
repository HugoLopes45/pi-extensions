import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  type ContextEditableContent,
  type ContextEditEntryDraft,
  estimateTokens,
  type ProjectedSessionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type AgentMessage = ProjectedSessionEntry["messages"][number];
export type EditableMessage = Extract<
  AgentMessage,
  { role: "user" | "assistant" | "toolResult" | "custom" }
>;

/** A replacement of one entry's model-visible content. */
export interface Edit {
  targetId: string;
  content: ContextEditableContent;
}

function isEditable(message: AgentMessage): message is EditableMessage {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult" ||
    message.role === "custom"
  );
}

/** The single editable message an entry contributes, if any. */
export function editableMessage(entry: ProjectedSessionEntry): EditableMessage | undefined {
  if (entry.messages.length !== 1) return undefined;
  const [message] = entry.messages;
  return message && isEditable(message) ? message : undefined;
}

/** Same rule as Pi's projected estimate: the current system message plus every other message. */
export function contextTokens(messages: readonly AgentMessage[]): number {
  const system = getCurrentSystemMessage(messages);
  let tokens = system ? estimateTokens(system) : 0;
  for (const message of messages) {
    if (message.role !== "system") tokens += estimateTokens(message);
  }
  return tokens;
}

export function messageTokens(message: AgentMessage): number {
  return estimateTokens(message);
}

type ContentPart = Exclude<ContextEditableContent, string>[number];

function isTextOrImage(part: ContentPart): part is TextContent | ImageContent {
  return part.type === "text" || part.type === "image";
}

function isAssistantPart(part: ContentPart): part is TextContent | ThinkingContent | ToolCall {
  return part.type === "text" || part.type === "thinking" || part.type === "toolCall";
}

/** Applies replacement content the way Pi does: roles without string content get one text part. */
export function withContent(
  message: EditableMessage,
  content: ContextEditableContent,
): EditableMessage {
  const parts = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  switch (message.role) {
    case "user":
    case "custom":
      if (typeof content === "string") return { ...message, content };
      if (content.every(isTextOrImage)) return { ...message, content };
      break;
    case "assistant":
      if (parts.every(isAssistantPart)) return { ...message, content: parts };
      break;
    case "toolResult":
      if (parts.every(isTextOrImage)) return { ...message, content: parts };
      break;
  }
  throw new Error(`A ${message.role} message cannot hold this replacement content.`);
}

/** Applies edits to projected entries without mutating them. */
export function applyEdits(
  entries: readonly ProjectedSessionEntry[],
  edits: readonly Edit[],
): ProjectedSessionEntry[] {
  if (edits.length === 0) return [...entries];
  const byId = new Map(edits.map((edit) => [edit.targetId, edit.content]));
  return entries.map((entry) => {
    const content = byId.get(entry.sourceEntry.id);
    const message = editableMessage(entry);
    return content !== undefined && message
      ? { ...entry, messages: [withContent(message, content)] }
      : entry;
  });
}

export function projectedMessages(entries: readonly ProjectedSessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => entry.messages);
}

/** Entry IDs that already have a context edit on the branch. */
export function editedEntryIds(branch: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "context_edit") ids.add(entry.targetId);
  }
  return ids;
}

export function toDrafts(edits: readonly Edit[]): ContextEditEntryDraft[] {
  return edits.map((edit) => ({
    type: "context_edit",
    targetId: edit.targetId,
    replacement: { content: edit.content },
  }));
}
