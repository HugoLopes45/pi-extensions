import { truncateHead } from "@earendil-works/pi-coding-agent";

const marker = "... [truncated]";

// truncateHead returns empty content when its first line exceeds maxBytes, so cap each line first.
export function bounded(
  text: string,
  limits: { maxBytes: number; maxLines: number },
): { content: string; truncated: boolean } {
  const lineBudget = limits.maxBytes - Buffer.byteLength(marker);
  let lineTruncated = false;
  const lines = text.split("\n").map((line) => {
    if (Buffer.byteLength(line) <= limits.maxBytes) return line;
    lineTruncated = true;
    return `${prefix(line, lineBudget)}${marker}`;
  });
  const head = truncateHead(lines.join("\n"), limits);
  return { content: head.content, truncated: head.truncated || lineTruncated };
}

// Returns the longest whole-character prefix of text within maxBytes.
function prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}
