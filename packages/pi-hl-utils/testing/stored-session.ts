import type { Message } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  CURRENT_SESSION_VERSION,
  parseSessionEntries,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const timestamp = "2026-01-01T00:00:00.000Z";

/**
 * The messages Pi hands an extension after loading a session file that stores `stored` as its
 * message entries. Records may break this Pi version's types, as a newer Pi or a corrupt file can.
 */
export function loadStoredMessages(stored: readonly unknown[]): Message[] {
  const records = [
    { type: "session", version: CURRENT_SESSION_VERSION, id: "stored", timestamp, cwd: "/" },
    ...stored.map((message, index) => ({
      type: "message",
      id: `m${index}`,
      parentId: index ? `m${index - 1}` : null,
      timestamp,
      message,
    })),
  ];
  const entries = parseSessionEntries(records.map((record) => JSON.stringify(record)).join("\n"));
  return convertToLlm(
    SessionManager.inMemory("/", undefined, entries).buildSessionContext().messages,
  );
}
