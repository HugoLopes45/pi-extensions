import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { diagnosticResult, type Observation } from "./diagnostics.js";
import { resolveRoute, type Route } from "./routing.js";
import { LanguageServer, type Initialization } from "./server.js";
import type { LspSettings, ServerConfig, ServerFamily } from "./settings.js";
import { bounded } from "./text.js";

export type Operation = "hover" | "definition" | "references" | "symbols" | "diagnostics";
type Position = { line: number; character: number };
type SelectedRoute = Extract<Route, { outcome: "completed" }>;
type Document = {
  file: string;
  uri: string;
  text: string;
  version: number;
  observation: Observation | undefined;
  waiting: ReturnType<typeof Promise.withResolvers<Observation>> | undefined;
};
type Instance = {
  client: LanguageServer;
  ready: Promise<Initialization>;
  root: string;
  server: ServerFamily;
  generation: number;
  state: { document: Document | undefined };
};
const publication = Type.Object({ uri: Type.String() });
const capability = {
  hover: "hoverProvider",
  definition: "definitionProvider",
  references: "referencesProvider",
  symbols: "documentSymbolProvider",
} as const;
const method = {
  hover: "textDocument/hover",
  definition: "textDocument/definition",
  references: "textDocument/references",
  symbols: "textDocument/documentSymbol",
} as const;

async function snapshot(file: string, signal: AbortSignal): Promise<string> {
  const input: AsyncIterable<unknown> = createReadStream(file, { signal });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Invalid file stream");
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("File exceeds the 1 MiB snapshot limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validatePosition(text: string, position: Position | undefined): void {
  if (
    !position ||
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  )
    throw new Error("A nonnegative UTF-16 position is required");
  const line = text.split(/\r?\n/u)[position.line];
  if (line === undefined || position.character > line.length)
    throw new Error("Position is outside the file snapshot");
}

async function diagnostics(document: Document, signal: AbortSignal): Promise<Observation> {
  if (document.observation) return document.observation;
  const waiting = Promise.withResolvers<Observation>();
  document.waiting = waiting;
  const abort = () => {
    try {
      signal.throwIfAborted();
    } catch (error) {
      waiting.reject(error);
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await waiting.promise;
  } finally {
    signal.removeEventListener("abort", abort);
    document.waiting = undefined;
  }
}

async function readResponse(
  operation: Operation,
  instance: Instance,
  document: Document,
  position: Position | undefined,
  signal: AbortSignal,
) {
  if (operation === "diagnostics") return diagnostics(document, signal);
  const response = await instance.client.request(
    method[operation],
    {
      textDocument: { uri: document.uri },
      ...(position ? { position } : {}),
      ...(operation === "references" ? { context: { includeDeclaration: false } } : {}),
    },
    signal,
  );
  const serialized = JSON.stringify(response);
  if (serialized === undefined) throw new Error("Invalid LSP response");
  const output = bounded(serialized, { maxBytes: 8192, maxLines: 100 });
  return {
    outcome: "completed",
    source: "untrusted_lsp",
    format: "lsp-json",
    response: output.content,
    truncated: output.truncated,
  };
}

async function synchronize(
  instance: Instance,
  route: SelectedRoute,
  text: string,
  signal: AbortSignal,
  canChange: boolean,
): Promise<Document> {
  const previous = instance.state.document;
  if (previous?.file === route.file && previous.text === text) return previous;
  const changing = canChange && previous?.file === route.file;
  if (previous && !changing)
    await instance.client.notify(
      "textDocument/didClose",
      { textDocument: { uri: previous.uri } },
      signal,
    );
  const document: Document = {
    file: route.file,
    uri: pathToFileURL(route.file).href,
    text,
    version: (previous?.version ?? 0) + 1,
    observation: undefined,
    waiting: undefined,
  };
  instance.state.document = document;
  await sendContent(instance, document, route.language, changing, signal);
  return document;
}

function sendContent(
  instance: Instance,
  document: Document,
  language: string,
  changing: boolean,
  signal: AbortSignal,
): Promise<void> {
  const { uri, version, text } = document;
  return changing
    ? instance.client.notify(
        "textDocument/didChange",
        { textDocument: { uri, version }, contentChanges: [{ text }] },
        signal,
      )
    : instance.client.notify(
        "textDocument/didOpen",
        { textDocument: { uri, languageId: language, version, text } },
        signal,
      );
}

function supportsChange(capabilities: Initialization["capabilities"]): boolean {
  const sync = capabilities.textDocumentSync;
  return ((typeof sync === "object" ? sync.change : sync) ?? 0) > 0;
}

function missingCapability(
  operation: Operation,
  capabilities: Initialization["capabilities"],
): string | undefined {
  if (operation !== "diagnostics" && !capabilities[capability[operation]])
    return "Server did not advertise this capability";
  const sync = capabilities.textDocumentSync;
  if (!sync || (typeof sync === "object" && !sync.openClose))
    return "Server does not support document open/close synchronization";
  return undefined;
}

async function ready(instance: Instance, deadline: AbortSignal): Promise<Initialization> {
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(new Error("LSP server is still starting; retry the request"));
  deadline.addEventListener("abort", abort, { once: true });
  try {
    deadline.throwIfAborted();
    return await Promise.race([instance.ready, aborted.promise]);
  } finally {
    deadline.removeEventListener("abort", abort);
  }
}

// Every cleanup must finish before the caller continues, even when another one fails first.
async function disposeAll(instances: Instance[]): Promise<void> {
  const results = await Promise.allSettled(instances.map((instance) => instance.client.dispose()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

export class LspController {
  private readonly instances = new Map<string, Instance>();
  private readonly lifetime = new AbortController();
  private generation = 0;
  private selected: { instance: Instance; document: Document } | undefined;

  constructor(
    private readonly cwd: string,
    private readonly settings: LspSettings,
    private readonly trusted: boolean,
  ) {}

  status() {
    return {
      enabled: this.settings.enabled,
      trusted: this.trusted,
      projectExecutionAllowed: this.settings.allowProjectExecution,
      timeoutMs: this.settings.timeoutMs,
      servers: Object.fromEntries(
        Object.entries(this.settings.servers).flatMap(([family, server]) =>
          server ? [[family, server.command]] : [],
        ),
      ),
      instances: [...this.instances.values()].map(({ root, server, generation, client }) => ({
        root,
        server,
        generation,
        active: client.active,
      })),
    };
  }

  private current(instance: Instance, document: Document): boolean {
    return (
      !this.lifetime.signal.aborted &&
      instance.client.active &&
      this.instances.get(`${instance.server}:${instance.root}`) === instance &&
      instance.state.document === document
    );
  }

  private async instance(
    route: SelectedRoute,
    config: ServerConfig,
    signal: AbortSignal,
  ): Promise<Instance> {
    const key = `${route.server}:${route.root}`;
    const previous = this.instances.get(key);
    if (previous?.client.active) {
      // Map order is recency order: the first key is the least recently used.
      this.instances.delete(key);
      this.instances.set(key, previous);
      return previous;
    }
    const failed = [...this.instances].filter(([, existing]) => !existing.client.active);
    // Evicted instances stay visible to dispose() until their process group is stopped.
    try {
      await disposeAll(failed.map(([, existing]) => existing));
    } finally {
      for (const [other, existing] of failed)
        if (this.instances.get(other) === existing) this.instances.delete(other);
    }
    await this.evictOldest();
    signal.throwIfAborted();
    const state: Instance["state"] = { document: undefined };
    const client = new LanguageServer(
      config,
      route.root,
      this.settings.timeoutMs,
      (value) => {
        const document = state.document;
        if (!document || !Value.Check(publication, value) || value.uri !== document.uri) return;
        const result = diagnosticResult(value, document.version);
        if (result.outcome === "superseded") return;
        document.observation = result;
        document.waiting?.resolve(result);
      },
      (error) => state.document?.waiting?.reject(error),
    );
    const instance = {
      client,
      // Start outlives the query deadline, so a slow server becomes usable on a later call.
      ready: client.initialize(this.lifetime.signal),
      root: route.root,
      server: route.server,
      generation: ++this.generation,
      state,
    };
    instance.ready.catch(() => {});
    this.instances.set(key, instance);
    return instance;
  }

  private async evictOldest(): Promise<void> {
    if (this.instances.size < 8) return;
    const [key, oldest] = this.instances.entries().next().value ?? [];
    if (key === undefined || oldest === undefined) return;
    // A group that did not stop stays listed, so session cleanup still reports it.
    await oldest.client.dispose();
    if (this.instances.get(key) === oldest) this.instances.delete(key);
  }

  private gate(): { outcome: "unavailable" | "blocked"; reason: string } | undefined {
    if (this.lifetime.signal.aborted)
      return { outcome: "unavailable", reason: "Controller is closed" };
    const failures: string[] = [];
    if (!this.settings.enabled) failures.push("LSP is off; run /hl-lsp on");
    if (!this.trusted) failures.push("project is not trusted; run /trust");
    if (!this.settings.allowProjectExecution)
      failures.push(
        "project execution is not allowed; run /hl-lsp set allowProjectExecution true --global",
      );
    return failures.length > 0 ? { outcome: "blocked", reason: failures.join("; ") } : undefined;
  }

  private async exchange(
    route: SelectedRoute,
    instance: Instance,
    operation: Operation,
    position: Position | undefined,
    text: string,
    deadline: AbortSignal,
  ) {
    const { capabilities } = await ready(instance, deadline);
    deadline.throwIfAborted();
    const reason = missingCapability(operation, capabilities);
    if (reason) return { ...route, outcome: "unsupported", reason };
    const document = await synchronize(
      instance,
      route,
      text,
      deadline,
      supportsChange(capabilities),
    );
    this.selected = { instance, document };
    const result = await readResponse(operation, instance, document, position, deadline);
    if (!this.current(instance, document) || (await snapshot(route.file, deadline)) !== text)
      return {
        ...route,
        outcome: "superseded",
        reason: "Document or instance changed during the request",
      };
    return {
      ...route,
      ...result,
      generation: instance.generation,
      documentVersion: document.version,
      checkedAt: Date.now(),
    };
  }

  async query(operation: Operation, file: string, position?: Position, signal?: AbortSignal) {
    const refusal = this.gate();
    if (refusal) return refusal;
    const deadline = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(this.settings.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    deadline.throwIfAborted();
    const route = await resolveRoute(file, this.cwd);
    if (route.outcome !== "completed") return route;
    const config = this.settings.servers[route.server];
    if (!config)
      return {
        ...route,
        outcome: "unavailable",
        reason: `No server configured for "${route.server}"; add servers.${route.server} with /hl-lsp set servers <JSON> --global (this replaces the whole servers map)`,
      };
    const text = await snapshot(route.file, deadline);
    if (operation !== "diagnostics" && operation !== "symbols") validatePosition(text, position);
    const instance = await this.instance(route, config, deadline);
    return this.exchange(route, instance, operation, position, text, deadline);
  }

  private async snapshotMatches(document: Document): Promise<boolean> {
    const route = await resolveRoute(document.file, this.cwd);
    if (route.outcome !== "completed" || route.file !== document.file) return false;
    const text = await snapshot(
      document.file,
      AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.settings.timeoutMs)]),
    );
    return text === document.text;
  }

  // A failed check deselects the document so the failure surfaces once, not on every turn.
  private async selectionMatches(selected: { document: Document }): Promise<boolean> {
    try {
      return await this.snapshotMatches(selected.document);
    } catch (error) {
      if (this.selected === selected) this.selected = undefined;
      throw error;
    }
  }

  async summary() {
    const selected = this.selected;
    if (!selected || !this.current(selected.instance, selected.document)) return undefined;
    const { instance, document } = selected;
    const observation = document.observation;
    if (!observation || observation.evidence !== "revision_correlated") return undefined;
    if (!(await this.selectionMatches(selected))) return undefined;
    if (
      this.selected !== selected ||
      !this.current(instance, document) ||
      document.observation !== observation
    )
      return undefined;
    return {
      source: "hl-lsp",
      coverage: "observed",
      projectComplete: false,
      server: instance.server,
      generation: instance.generation,
      documentVersion: document.version,
      reportedCount: observation.reportedCount,
      omitted: observation.omitted,
      receivedAt: observation.receivedAt,
      checkedAt: Date.now(),
      diagnostics: observation.diagnostics.map(({ code, severity, range }) => ({
        code,
        severity,
        range,
      })),
    };
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    const instances = [...this.instances.values()];
    this.instances.clear();
    this.selected = undefined;
    await disposeAll(instances);
  }
}
