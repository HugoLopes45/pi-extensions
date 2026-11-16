import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  truncateLine,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isMissingFileError } from "pi-hl-utils/errors";

/** Directories whose content is credentials or VCS internals (remote URLs can hold tokens). */
const deniedDirectories = new Set([".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker"]);
const deniedNames = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
]);
const deniedExtensions = /\.(?:pem|key|p8|ppk|p12|pfx|jks|tfvars|tfstate(?:\.backup)?)$/i;
/** Data files only, so source code such as `token.ts` stays reviewable. */
const deniedStems =
  /^(?:secrets?|credentials?|tokens?|passwords?)(?:\.(?:json|ya?ml|toml|ini|env|txt|cfg|conf|xml))?$/i;
const exampleEnv = /^\.env\.(?:example|sample|template)$/i;

/** Whether a root-relative path names a file the Onlooker must never read. */
function deniedPath(rootRelative: string): boolean {
  // Lowercase: macOS and Windows file systems are case-insensitive by default.
  const parts = rootRelative.toLowerCase().split(sep);
  const name = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some((part) => deniedDirectories.has(part))) return true;
  if (deniedDirectories.has(name) || deniedNames.has(name)) return true;
  if (name.startsWith(".env") && !exampleEnv.test(name)) return true;
  return deniedExtensions.test(name) || deniedStems.test(name);
}

/** Keep only requested LF-delimited previews; an unmatched giant line must not be buffered. */
async function grepSourceLines(
  path: string,
  positions: Set<number>,
  previewSize: number,
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const input = createReadStream(path, { signal });
  const chunks: AsyncIterable<Uint8Array> = input;
  const decoder = new StringDecoder("utf8");
  const last = Math.max(...positions);
  let number = 1;
  let prefix = "";
  try {
    for await (const chunk of chunks) {
      signal?.throwIfAborted();
      const text = decoder.write(chunk);
      let start = 0;
      while (start < text.length) {
        const end = text.indexOf("\n", start);
        if (positions.has(number))
          prefix = (prefix + text.slice(start, end < 0 ? undefined : end)).slice(0, previewSize);
        if (end < 0) break;
        if (positions.has(number))
          result.set(number, truncateLine(prefix.replace(/\r$/u, "")).text);
        prefix = "";
        start = end + 1;
        if (++number > last) break;
      }
      if (number > last) break;
    }
    if (number <= last && positions.has(number))
      result.set(number, truncateLine((prefix + decoder.end()).replace(/\r$/u, "")).text);
    return result;
  } finally {
    input.destroy();
  }
}

/**
 * Pi's read-only tools confined to one project root. Every path, including each file a search
 * returns, is resolved through symlinks and must stay inside the root and outside the denylist.
 * The observed journal is excluded even inside the root: it can contain context-excluded output.
 */
export function createProtectedReadTools(
  root: string,
  observedJournal: () => string | undefined = () => undefined,
): ToolDefinition[] {
  /** The real path when it is readable, else undefined. */
  async function permitted(path: string): Promise<string | undefined> {
    let real: string;
    let inside: string;
    try {
      real = await realpath(path);
      inside = relative(await realpath(root), real);
    } catch {
      return undefined;
    }
    const journal = observedJournal();
    if (journal) {
      const journalPath = await realpath(journal).catch((error: unknown) => {
        if (isMissingFileError(error)) return undefined;
        throw error;
      });
      if (real === journalPath) return undefined;
    }
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
    return deniedPath(inside) ? undefined : real;
  }

  async function checked(input: string | undefined): Promise<string> {
    const requested = resolve(root, (input ?? ".").replace(/^@/, ""));
    const canonical = await permitted(requested);
    // Pi rewrites these spaces after our check, including in canonical symlink targets.
    const rewritten = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/u;
    if (!canonical || rewritten.test(requested) || rewritten.test(canonical))
      throw new Error(`Onlooker cannot read ${input ?? "."}`);
    return canonical;
  }

  /** Keep result lines whose path resolves to a permitted file, plus Pi's trailing notice. */
  async function filterLines(
    text: string,
    candidates: (line: string) => string[],
    base: string,
    verify?: (line: string, path: string) => Promise<boolean>,
  ): Promise<string> {
    const notice = /\n\n\[[^\n]*\]$/.exec(text);
    const body = notice ? text.slice(0, notice.index) : text;
    const kept: string[] = [];
    for (const line of body.split("\n")) {
      for (const path of candidates(line)) {
        if ((await permitted(resolve(base, path))) && (!verify || (await verify(line, path)))) {
          kept.push(line);
          break;
        }
      }
    }
    if (!kept.length) return "No permitted results";
    return kept.join("\n") + (notice?.[0] ?? "");
  }

  const read = createReadToolDefinition(root);
  const grep = createGrepToolDefinition(root);
  const find = createFindToolDefinition(root);
  const ls = createLsToolDefinition(root, {
    operations: {
      exists: async (path) => Boolean(await permitted(path)),
      stat: (path) => stat(path),
      readdir: async (path) => {
        const names = await readdir(path);
        const allowed = await Promise.all(names.map((name) => permitted(resolve(path, name))));
        return names.filter((_name, index) => allowed[index]);
      },
    },
  });

  return [
    defineTool({
      ...read,
      async execute(id, params, signal, onUpdate, ctx) {
        const path = await checked(params.path);
        return read.execute(id, { ...params, path }, signal, onUpdate, ctx);
      },
    }),
    defineTool({
      ...grep,
      async execute(id, params, signal, _onUpdate, ctx) {
        const path = await checked(params.path);
        const directory = (await stat(path)).isDirectory();
        const result = await grep.execute(id, { ...params, path }, signal, undefined, ctx);
        // A single-file search was already checked and prints only its basename.
        if (!directory) return result;
        // `path:12: text` for matches, `path-12- text` for context lines.
        const prefixes = (line: string) =>
          [...line.matchAll(/[:-]\d+[:-] /g)].map((match) => line.slice(0, match.index));
        // Filenames can contain newlines: prove the text belongs to the permitted file,
        // rather than trusting a human-formatted path prefix from a denied file.
        const wanted = new Map<string, Set<number>>();
        for (const block of result.content) {
          if (block.type !== "text") continue;
          for (const line of block.text.split("\n")) {
            for (const match of line.matchAll(/[:-](\d+)[:-] /g)) {
              const candidate = line.slice(0, match.index);
              const number = Number(match[1]);
              if (!Number.isSafeInteger(number) || number < 1) continue;
              const positions = wanted.get(candidate) ?? new Set<number>();
              positions.add(number);
              wanted.set(candidate, positions);
            }
          }
        }
        const verified = new Map<string, Map<number, string>>();
        const verify = async (line: string, candidate: string) => {
          const match = /^[:-](\d+)[:-] ([\s\S]*)$/u.exec(line.slice(candidate.length));
          const positions = wanted.get(candidate);
          if (!match || !positions) return false;
          let source = verified.get(candidate);
          if (!source) {
            const previewSize =
              Math.max(
                ...result.content.map((block) => (block.type === "text" ? block.text.length : 0)),
              ) + 1;
            source = await grepSourceLines(
              await checked(resolve(path, candidate)),
              positions,
              previewSize,
              signal,
            );
            verified.set(candidate, source);
          }
          return source.get(Number(match[1])) === match[2];
        };
        return {
          ...result,
          details: undefined,
          content: await Promise.all(
            result.content.map(async (item) =>
              item.type === "text"
                ? {
                    ...item,
                    text: await filterLines(item.text, prefixes, path, verify),
                  }
                : item,
            ),
          ),
        };
      },
    }),
    defineTool({
      ...find,
      async execute(id, params, signal, _onUpdate, ctx) {
        const path = await checked(params.path);
        const result = await find.execute(id, { ...params, path }, signal, undefined, ctx);
        return {
          ...result,
          details: undefined,
          content: await Promise.all(
            result.content.map(async (item) =>
              item.type === "text"
                ? {
                    ...item,
                    text: await filterLines(item.text, (line) => [line.replace(/\/$/, "")], path),
                  }
                : item,
            ),
          ),
        };
      },
    }),
    defineTool({
      ...ls,
      async execute(id, params, signal, onUpdate, ctx) {
        const path = await checked(params.path);
        return ls.execute(id, { ...params, path }, signal, onUpdate, ctx);
      },
    }),
  ];
}
