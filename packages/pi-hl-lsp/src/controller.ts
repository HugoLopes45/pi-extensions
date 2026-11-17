import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { errorText } from "pi-hl-utils/errors";
import { Type } from "typebox";
import { Value } from "typebox/value";
import * as rpc from "vscode-jsonrpc/node";

import {
  diagnosticResult,
  pullResult,
  settledObservation,
  unchangedObservation,
  unionObservation,
  type Observation,
} from "./diagnostics.js";
import {
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatSymbols,
  formatWorkspaceSymbols,
  type LineReader,
} from "./format.js";
import { outside, resolveRoute, type Route } from "./routing.js";
import { LanguageServer, type Initialization } from "./server.js";
import {
  serverFamilies,
  type LspSettings,
  type ServerConfig,
  type ServerFamily,
} from "./settings.js";
import { bounded } from "./text.js";

export type Operation =
  | "hover"
  | "definition"
  | "type_definition"
  | "implementation"
  | "references"
  | "symbols"
  | "workspace_symbols"
  | "diagnostics";
type Position = { line: number; character: number };
export type NavigationTarget = {
  line: number;
  symbol?: string | undefined;
  column?: number | undefined;
};
type SelectedRoute = Extract<Route, { outcome: "completed" }>;
type Document = {
  file: string;
  uri: string;
  text: string;
  version: number;
  observation: Observation | undefined;
  waiting: ReturnType<typeof Promise.withResolvers<Observation>> | undefined;
  // Pending settle or quiet timer; the next publication replaces it.
  timer: ReturnType<typeof setTimeout> | undefined;
  // Set when the previous document of this file settled empty and this document changed it.
  silenceMeansClean: boolean;
};
type Instance = {
  client: LanguageServer;
  ready: Promise<Initialization>;
  root: string;
  server: ServerFamily;
  generation: number;
  state: {
    document: Document | undefined;
    initialization: Initialization | undefined;
    failure: string | undefined;
  };
};
export type InstanceStatus = {
  root: string;
  state: "starting" | "running" | "failed";
  reason?: string | undefined;
  openDocuments: number;
  tools: Operation[] | undefined;
};
export type ServerStatus = {
  server: ServerFamily;
  instances: InstanceStatus[];
};
const publication = Type.Object({ uri: Type.String() });
const capability = {
  hover: "hoverProvider",
  definition: "definitionProvider",
  type_definition: "typeDefinitionProvider",
  implementation: "implementationProvider",
  references: "referencesProvider",
  symbols: "documentSymbolProvider",
  workspace_symbols: "workspaceSymbolProvider",
} as const;
const method = {
  hover: "textDocument/hover",
  definition: "textDocument/definition",
  type_definition: "textDocument/typeDefinition",
  implementation: "textDocument/implementation",
  references: "textDocument/references",
  symbols: "textDocument/documentSymbol",
  workspace_symbols: "workspace/symbol",
} as const;
// Measured on typescript-language-server; see lsp-dev/research/reports/publish-timing.md.
const SETTLE_MS = 500;
const QUIET_MS = 1000;

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

const lineBreak = /\r\n|\r|\n/u;
const identifierCharacter = /[A-Za-z0-9_$]/u;

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && identifierCharacter.test(character);
}

function symbolCharacter(line: string, symbol: string): number {
  if (symbol.length === 0) throw new Error("Symbol must not be empty");
  const matches: number[] = [];
  for (let index = line.indexOf(symbol); index !== -1; index = line.indexOf(symbol, index + 1))
    if (
      !isIdentifierCharacter(line[index - 1]) &&
      !isIdentifierCharacter(line[index + symbol.length])
    )
      matches.push(index);
  const [first] = matches;
  if (first === undefined)
    throw new Error(`Symbol "${symbol}" is not on the line: ${line.slice(0, 200)}`);
  if (matches.length > 1)
    throw new Error(
      `Symbol "${symbol}" occurs at columns ${matches.map((index) => index + 1).join(", ")}; give column instead`,
    );
  return first;
}

function columnCharacter(line: string, column: number): number {
  if (!Number.isSafeInteger(column) || column < 1)
    throw new Error("Column must be a positive integer");
  if (column - 1 > line.length) throw new Error("Column is beyond the line end");
  return column - 1;
}

function characterOf(line: string, target: NavigationTarget): number {
  if (target.symbol !== undefined && target.column === undefined)
    return symbolCharacter(line, target.symbol);
  if (target.column !== undefined && target.symbol === undefined)
    return columnCharacter(line, target.column);
  throw new Error("Give exactly one of symbol or column");
}

// The target line is 1-based; the returned LSP position is 0-based.
function resolvePosition(text: string, target: NavigationTarget | undefined): Position {
  if (!target) throw new Error("A line and a symbol or column are required");
  const line = text.split(lineBreak)[target.line - 1];
  if (line === undefined) throw new Error("Line is outside the file snapshot");
  return { line: target.line - 1, character: characterOf(line, target) };
}

// Only settled observations reach document.observation.
function settle(document: Document, observation: Observation): void {
  clearTimeout(document.timer);
  document.timer = undefined;
  document.observation = observation;
  document.waiting?.resolve(observation);
}

// A URI that is not a file: URL cannot match a document.
function fileOf(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

async function diagnostics(document: Document, signal: AbortSignal): Promise<Observation> {
  if (document.observation) return document.observation;
  const waiting = Promise.withResolvers<Observation>();
  document.waiting = waiting;
  // No publication has followed a clean edit yet, so silence means the diagnostics are still empty.
  if (document.silenceMeansClean && document.timer === undefined)
    document.timer = setTimeout(() => settle(document, unchangedObservation()), QUIET_MS);
  const abort = () => waiting.reject(new Error("No settled diagnostics before the timeout"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    return await waiting.promise;
  } finally {
    signal.removeEventListener("abort", abort);
    document.waiting = undefined;
  }
}

// Location reads stay inside the real cwd, and the queried file reuses the snapshot already taken.
function sourceLines(document: Document, cwd: string, signal: AbortSignal): LineReader {
  return async (file) => {
    try {
      const real = await realpath(file);
      if (outside(cwd, real) || !(await stat(real)).isFile()) return undefined;
      const text = real === document.file ? document.text : await snapshot(real, signal);
      return text.split(/\r?\n/u);
    } catch {
      return undefined;
    }
  };
}

async function formatResponse(
  operation: Exclude<Operation, "diagnostics">,
  response: unknown,
  cwd: string,
  lines: LineReader,
) {
  if (operation === "hover") return formatHover(response);
  if (operation === "symbols") return formatSymbols(response);
  if (operation === "workspace_symbols") return formatWorkspaceSymbols(response, cwd, lines);
  return formatLocations(response, cwd, lines, operation);
}

// LSP ServerCancelled: the server asks for the pull to be sent again.
const serverCancelled = -32802;

// Sends the pull at most twice; a non-cancellation error or a transport failure is never retried.
async function pullReport(
  client: LanguageServer,
  document: Document,
  signal: AbortSignal,
): Promise<{ report: unknown } | undefined> {
  const params = { textDocument: { uri: document.uri } };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return {
        report: await client.request("textDocument/diagnostic", params, signal),
      };
    } catch (error) {
      if (!client.active) throw error;
      const cancelled = error instanceof rpc.ResponseError && error.code === serverCancelled;
      if (attempt === 2 || !cancelled) return undefined;
    }
  }
}

// A pull answers for this document version; a push already settled for it joins the answer.
// A failed pull leaves the answer to the push path.
async function pulledObservation(
  client: LanguageServer,
  document: Document,
  signal: AbortSignal,
): Promise<Observation | undefined> {
  const answer = await pullReport(client, document, signal);
  if (!answer) return undefined;
  const pulled = pullResult(answer.report);
  return document.observation ? unionObservation(pulled, document.observation) : pulled;
}

// basedpyright registers the pull method in reply to the first open, after this call has read
// pullDiagnostics, so a push wait also starts a pull when that registration arrives.
async function diagnosticsObservation(
  instance: Instance,
  document: Document,
  signal: AbortSignal,
): Promise<Observation> {
  const { client } = instance;
  if (client.pullDiagnostics)
    return (await pulledObservation(client, document, signal)) ?? diagnostics(document, signal);
  const pulled = Promise.withResolvers<Observation | undefined>();
  const pushWait = new AbortController();
  const push = diagnostics(document, AbortSignal.any([signal, pushWait.signal]));
  const stop = client.onPullRegistration(() =>
    pulled.resolve(pulledObservation(client, document, signal)),
  );
  try {
    return await Promise.race([push, pulled.promise.then((answer) => answer ?? push)]);
  } finally {
    stop();
    // A pull that won leaves no push wait behind; a push that won has already settled.
    pushWait.abort();
  }
}

async function readResponse(
  operation: Operation,
  instance: Instance,
  document: Document,
  position: Position | undefined,
  search: string | undefined,
  signal: AbortSignal,
  cwd: string,
) {
  if (operation === "diagnostics") {
    const observation = await diagnosticsObservation(instance, document, signal);
    return { ...observation, ...formatDiagnostics(observation) };
  }
  const response = await instance.client.request(
    method[operation],
    operation === "workspace_symbols"
      ? { query: search }
      : {
          textDocument: { uri: document.uri },
          ...(position ? { position } : {}),
          ...(operation === "references" ? { context: { includeDeclaration: false } } : {}),
        },
    signal,
  );
  const formatted = await formatResponse(
    operation,
    response,
    cwd,
    sourceLines(document, cwd, signal),
  );
  return { outcome: "completed", source: "untrusted_lsp", ...formatted };
}

// A changed file keeps the silence memory of its previous observation.
function nextDocument(
  route: SelectedRoute,
  text: string,
  previous: Document | undefined,
  changing: boolean,
): Document {
  return {
    file: route.file,
    uri: pathToFileURL(route.file).href,
    text,
    version: (previous?.version ?? 0) + 1,
    observation: undefined,
    waiting: undefined,
    timer: undefined,
    silenceMeansClean: changing && previous?.observation?.diagnostics.length === 0,
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
  clearTimeout(previous?.timer);
  const document = nextDocument(route, text, previous, changing);
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

const operations: readonly Operation[] = [
  "hover",
  "definition",
  "type_definition",
  "implementation",
  "references",
  "symbols",
  "workspace_symbols",
  "diagnostics",
];

// Lists the operations that a query would not refuse as unsupported.
function supportedOperations(capabilities: Initialization["capabilities"]): Operation[] {
  return operations.filter((operation) => missingCapability(operation, capabilities) === undefined);
}

function instanceStatus({ client, root, state }: Instance): InstanceStatus {
  const failed = !client.active;
  return {
    root,
    state: failed ? "failed" : state.initialization ? "running" : "starting",
    reason: failed
      ? bounded(state.failure ?? "LSP instance is closed", {
          maxBytes: 512,
          maxLines: 1,
        }).content
      : undefined,
    openDocuments: state.document ? 1 : 0,
    tools: state.initialization && supportedOperations(state.initialization.capabilities),
  };
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

type Diagnostic = Observation["diagnostics"][number];

// Errors are compared by code and message, so an error that moved still matches its earlier copy.
function errorKey(item: Diagnostic): string {
  return `${item.code ?? ""}\u0000${item.message}`;
}

function errorCounts(diagnostics: Diagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of diagnostics) {
    if (item.severity !== 1) continue;
    const key = errorKey(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export class LspController {
  private readonly instances = new Map<string, Instance>();
  private readonly lifetime = new AbortController();
  // Error counts of the last settled diagnostics observation of each file.
  private readonly baseline = new Map<string, Map<string, number>>();
  private generation = 0;
  private selected: { instance: Instance; document: Document } | undefined;

  constructor(
    private readonly cwd: string,
    private readonly settings: LspSettings,
    private readonly trusted: boolean,
  ) {}

  private configured(): ServerFamily[] {
    return serverFamilies.filter((server) => this.settings.servers[server] !== undefined);
  }

  serverStatus() {
    const refusal = this.gate();
    if (refusal) return refusal;
    const instances = [...this.instances.values()];
    return {
      outcome: "completed" as const,
      servers: this.configured().map((server): ServerStatus => ({
        server,
        instances: instances.filter((instance) => instance.server === server).map(instanceStatus),
      })),
    };
  }

  // Stops the running instances of one configured server; the next query starts a fresh one.
  async reload(server: string) {
    const refusal = this.gate();
    if (refusal) return refusal;
    const configured = this.configured();
    const family = configured.find((candidate) => candidate === server);
    if (family === undefined)
      return {
        outcome: "unavailable" as const,
        reason: `Unknown server "${server}"; configured servers: ${configured.join(", ") || "none"}`,
      };
    const stopped = [...this.instances].filter(([, instance]) => instance.server === family);
    await disposeAll(stopped.map(([, instance]) => instance));
    for (const [key, instance] of stopped)
      if (this.instances.get(key) === instance) this.instances.delete(key);
    return { outcome: "completed" as const, stopped: stopped.length };
  }

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
    const state: Instance["state"] = {
      document: undefined,
      initialization: undefined,
      failure: undefined,
    };
    const client = new LanguageServer(
      config,
      route.root,
      this.settings.timeoutMs,
      (value) => {
        const document = state.document;
        if (!document || !Value.Check(publication, value) || fileOf(value.uri) !== document.file)
          return;
        const report = diagnosticResult(value, document.version);
        if (report.outcome === "superseded") return;
        clearTimeout(document.timer);
        if (report.evidence === "revision_correlated") {
          settle(document, settledObservation(report));
          return;
        }
        document.timer = setTimeout(() => settle(document, settledObservation(report)), SETTLE_MS);
      },
      (error) => {
        state.failure = errorText(error);
        state.document?.waiting?.reject(error);
      },
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
    instance.ready.then(
      (initialization) => {
        state.initialization = initialization;
      },
      (error: unknown) => {
        state.failure = errorText(error);
      },
    );
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
    if (!this.trusted) failures.push("project is not trusted; run /trust, then restart Pi");
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
    search: string | undefined,
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
    // Diagnostics keep their own settle path; a query waits for loading and then sends with the remaining deadline.
    if (operation !== "diagnostics")
      await instance.client.settled(deadline, this.settings.timeoutMs / 2);
    const result = await readResponse(
      operation,
      instance,
      document,
      position,
      search,
      deadline,
      await realpath(this.cwd),
    );
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

  async query(
    operation: Operation,
    file: string,
    target?: NavigationTarget,
    signal?: AbortSignal,
    search?: string,
  ) {
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
    const position =
      operation === "diagnostics" || operation === "symbols" || operation === "workspace_symbols"
        ? undefined
        : resolvePosition(text, target);
    const instance = await this.instance(route, config, deadline);
    const result = await this.exchange(
      route,
      instance,
      operation,
      position,
      search,
      text,
      deadline,
    );
    if ("diagnostics" in result) this.baseline.set(route.file, errorCounts(result.diagnostics));
    return result;
  }

  // Errors of the file that the previous settled observation did not have; undefined when no check finished.
  async newErrors(file: string, signal: AbortSignal): Promise<Diagnostic[] | undefined> {
    const route = await resolveRoute(file, this.cwd);
    if (route.outcome !== "completed") return undefined;
    const before = this.baseline.get(route.file) ?? new Map<string, number>();
    const result = await this.query("diagnostics", file, undefined, signal);
    if (!("diagnostics" in result)) return undefined;
    const seen = new Map<string, number>();
    return result.diagnostics.filter((item) => {
      if (item.severity !== 1) return false;
      const key = errorKey(item);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return count > (before.get(key) ?? 0);
    });
  }

  private async snapshotMatches(document: Document, instance: Instance): Promise<boolean> {
    const route = await resolveRoute(document.file, this.cwd);
    if (
      route.outcome !== "completed" ||
      route.file !== document.file ||
      route.root !== instance.root ||
      route.server !== instance.server
    )
      return false;
    const text = await snapshot(
      document.file,
      AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.settings.timeoutMs)]),
    );
    return text === document.text;
  }

  // A failed check deselects the document so the failure surfaces once, not on every turn.
  private async selectionMatches(selected: {
    instance: Instance;
    document: Document;
  }): Promise<boolean> {
    try {
      return await this.snapshotMatches(selected.document, selected.instance);
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
    if (!observation) return undefined;
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
      evidence: observation.evidence,
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
