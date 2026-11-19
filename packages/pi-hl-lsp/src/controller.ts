import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { errorText } from "pi-hl-utils/errors";
import { Type } from "typebox";
import { Value } from "typebox/value";
import * as rpc from "vscode-jsonrpc/node";

import {
  codeActionItem,
  codeActionList,
  type CodeActionItem,
  contextDiagnostics,
  displayText,
  editOf,
  isResolvable,
  listedAction,
  type Range,
} from "./code-actions.js";
import { detectLanguages, findServer } from "./detect.js";
import {
  busyObservation,
  diagnosticResult,
  pullResult,
  settledObservation,
  unchangedObservation,
  unionObservation,
  type Observation,
} from "./diagnostics.js";
import {
  callHierarchyItems,
  formatCalls,
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatSymbols,
  formatWorkspaceSymbols,
  type LineReader,
} from "./format.js";
import { presetFor } from "./presets.js";
import { outside } from "./project-files.js";
import {
  applyTextEdits,
  applyWorkspaceEdit,
  moveFile,
  planMove,
  type ChangedFile,
  type FileMove,
} from "./rename.js";
import { resolveRoute, serverDefinitions, type Route, type ServerDefinition } from "./routing.js";
import { LanguageServer, type Initialization } from "./server.js";
import { type LspSettings, type ServerConfig } from "./settings.js";
import { bounded, isIdentifierCharacter } from "./text.js";

export type Operation =
  | "hover"
  | "definition"
  | "type_definition"
  | "implementation"
  | "references"
  | "incoming_calls"
  | "outgoing_calls"
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
  server: string;
  generation: number;
  state: {
    document: Document | undefined;
    initialization: Initialization | undefined;
    failure: string | undefined;
    edits: Map<string, number>;
    published: Map<string, { text: string; edits: number; observation: Observation }>;
    pending: Map<string, unknown>;
    reads: number;
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
  server: string;
  configured: boolean;
  instances: InstanceStatus[];
  // How to set up a detected language that has no server configured.
  setup?: string | undefined;
};
export type EditCheck =
  | { outcome: "checked"; compared: boolean; errors: Diagnostic[] }
  | { outcome: "unchecked"; reason: string };
export type FormatOutcome =
  | { outcome: "unchanged" }
  | { outcome: "formatted"; edits: number }
  | { outcome: "skipped"; reason: string };
const publication = Type.Object({ uri: Type.String() });
const capability = {
  hover: "hoverProvider",
  definition: "definitionProvider",
  type_definition: "typeDefinitionProvider",
  implementation: "implementationProvider",
  references: "referencesProvider",
  symbols: "documentSymbolProvider",
  workspace_symbols: "workspaceSymbolProvider",
  incoming_calls: "callHierarchyProvider",
  outgoing_calls: "callHierarchyProvider",
} as const;
const method = {
  hover: "textDocument/hover",
  definition: "textDocument/definition",
  type_definition: "textDocument/typeDefinition",
  implementation: "textDocument/implementation",
  references: "textDocument/references",
  symbols: "textDocument/documentSymbol",
  workspace_symbols: "workspace/symbol",
  incoming_calls: "callHierarchy/incomingCalls",
  outgoing_calls: "callHierarchy/outgoingCalls",
} as const;
// No measurement supports 500 ms: one TypeScript sample sent a second publication for one edit 1136 ms after the first, so SETTLE_MS can miss it.
const SETTLE_MS = 500;
const QUIET_MS = 1000;
// Each baseline is a short error-count map. An evicted file reports all its errors as new on its next edit.
const BASELINE_LIMIT = 128;
// Each retained publication holds a file's text, up to the 1 MiB snapshot limit.
const RETAINED_LIMIT = 128;

async function snapshot(file: string, signal: AbortSignal): Promise<string> {
  const input: AsyncIterable<unknown> = createReadStream(file, { signal });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of input) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Invalid file stream");
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error("File exceeds the 1 MiB snapshot limit");
      chunks.push(chunk);
    }
  } catch (error) {
    // A stream stopped by its signal reports a generic AbortError, so the signal's reason is thrown.
    signal.throwIfAborted();
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}

const lineBreak = /\r\n|\r|\n/u;

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

// The range of a code action request: the whole line, or the anchored symbol or column on it.
function actionRange(text: string, target: NavigationTarget): Range {
  const line = text.split(lineBreak)[target.line - 1];
  if (line === undefined) throw new Error("Line is outside the file snapshot");
  const row = target.line - 1;
  if (target.symbol === undefined && target.column === undefined)
    return {
      start: { line: row, character: 0 },
      end: { line: row, character: line.length },
    };
  const start = characterOf(line, target);
  return {
    start: { line: row, character: start },
    end: { line: row, character: start + (target.symbol?.length ?? 0) },
  };
}

// A query deadline keeps its own message; any other abort reports the reason its caller gave.
function abortReason(signal: AbortSignal, deadlineMessage: string): unknown {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? new Error(deadlineMessage)
    : signal.reason;
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
  const abort = () =>
    waiting.reject(abortReason(signal, "No settled diagnostics before the timeout"));
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
  operation: Exclude<Operation, "diagnostics" | "incoming_calls" | "outgoing_calls">,
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

// Number of text edits sent for the file; a publication made before an edit is stale.
function editsOf(state: Instance["state"], file: string): number {
  return state.edits.get(file) ?? 0;
}

// A new text of the file last synchronized is an edit; the same file reopened after another is not.
function noteEdit(state: Instance["state"], previous: Document | undefined, file: string): void {
  if (previous?.file === file) state.edits.set(file, editsOf(state, file) + 1);
}

// The latest publication stays in the answer while the file has the text and edits it was published for.
function knownObservation(state: Instance["state"], document: Document): Observation | undefined {
  const retained = state.published.get(document.file);
  if (document.observation || !retained) return document.observation;
  const current =
    retained.text === document.text && retained.edits === editsOf(state, document.file);
  return current ? retained.observation : undefined;
}

// Only a regular file inside the root is read: opening a named pipe blocks a thread-pool thread until a
// writer appears, and a file outside the root never opens in this instance.
async function unopenedText(file: string, root: string, signal: AbortSignal): Promise<string> {
  const real = await realpath(file);
  if (outside(root, real) || !(await stat(real)).isFile())
    throw new Error("Not a regular file inside the root");
  return snapshot(real, signal);
}

// A project check publishes for files that are not open. Such a publication describes the text on disk,
// so it is kept with that text and joins the answer once the file opens with the same text.
function retainUnopened(
  state: Instance["state"],
  file: string,
  root: string,
  value: unknown,
  signal: AbortSignal,
): void {
  const report = diagnosticResult(value, 0);
  // A versioned publication belongs to an earlier open of the file, not to its text on disk.
  if (report.outcome === "superseded" || report.evidence !== "unversioned_observation") return;
  // An empty list only clears earlier findings, so the file is not read for it.
  if (report.reportedCount === 0) {
    state.pending.delete(file);
    state.published.delete(file);
    return;
  }
  const edits = editsOf(state, file);
  // Many publications at once would otherwise start as many reads.
  if (state.reads >= RETAINED_LIMIT) {
    // An older read for this file must not settle in place of the dropped, newer publication.
    state.pending.delete(file);
    state.published.delete(file);
    return;
  }
  state.pending.set(file, value);
  state.reads += 1;
  unopenedText(file, root, signal)
    .finally(() => {
      state.reads -= 1;
    })
    .then(
      (text) => {
        if (state.pending.get(file) !== value) return;
        state.pending.delete(file);
        if (editsOf(state, file) !== edits) return;
        state.published.delete(file);
        state.published.set(file, {
          text,
          edits,
          observation: settledObservation(report),
        });
        // The oldest entry goes first; a file without one falls back to its own pull.
        const oldest = state.published.keys().next();
        if (state.published.size > RETAINED_LIMIT && !oldest.done)
          state.published.delete(oldest.value);
      },
      // An unreadable file has no text to tie the publication to, so the publication is not kept.
      () => {
        if (state.pending.get(file) === value) state.pending.delete(file);
      },
    );
}

// A pull answers for this document version; a push already settled for it joins the answer.
// A failed pull leaves the answer to the push path.
async function pulledObservation(
  client: LanguageServer,
  document: Document,
  signal: AbortSignal,
  state: Instance["state"],
): Promise<Observation | undefined> {
  const answer = await pullReport(client, document, signal);
  if (!answer) return undefined;
  const pulled = pullResult(answer.report);
  const known = knownObservation(state, document);
  return known ? unionObservation(pulled, known) : pulled;
}

// Quiet means no progress event, no open progress token, and no publication for QUIET_MS.
// A refresh request ends the wait early; activity or an open token at the progress bound leaves the answer busy.
async function quietOrRefresh(
  client: LanguageServer,
  refreshed: Promise<true>,
  signal: AbortSignal,
  progress: AbortSignal,
): Promise<"refreshed" | "quiet" | "busy"> {
  const bound = Promise.withResolvers<"busy">();
  const stop = () => bound.resolve("busy");
  progress.addEventListener("abort", stop, { once: true });
  try {
    return await quietLoop(client, refreshed, signal, progress, bound.promise);
  } finally {
    progress.removeEventListener("abort", stop);
  }
}

async function quietLoop(
  client: LanguageServer,
  refreshed: Promise<true>,
  signal: AbortSignal,
  progress: AbortSignal,
  bound: Promise<"busy">,
): Promise<"refreshed" | "quiet" | "busy"> {
  for (;;) {
    if (progress.aborted) return "busy";
    const quiet = delay(QUIET_MS, false, { signal }).catch(() => {
      throw abortReason(signal, "No settled diagnostics before the timeout");
    });
    const outcome = await Promise.race([
      refreshed.then(() => "refreshed" as const),
      quiet.then(() => "quiet" as const),
      client.nextActivity.then(() => "active" as const),
      bound,
    ]);
    if (outcome === "busy") return outcome;
    if (outcome === "active") continue;
    if (outcome === "refreshed" || !client.busy) return outcome;
    if (!(await client.awaitIdle(AbortSignal.any([signal, progress])))) return "busy";
  }
}

// A progress token still open at the progress bound leaves the last settled answer, or none.
function busyAnswer(state: Instance["state"], document: Document): Observation {
  return knownObservation(state, document) ?? busyObservation();
}

// A pull is provisional: the server may still be analyzing. For one quiet window a push joins
// the answer, and a refresh request makes the client pull once more.
async function provisionalPull(
  client: LanguageServer,
  document: Document,
  signal: AbortSignal,
  progress: AbortSignal,
  state: Instance["state"],
): Promise<Observation | undefined> {
  const refreshed = Promise.withResolvers<true>();
  const stop = client.onDiagnosticRefresh(() => refreshed.resolve(true));
  try {
    const first = await pulledObservation(client, document, signal, state);
    // An empty or absent pull does not settle while server work-done progress is open; it repeats once that ends.
    if (client.busy && (first === undefined || first.diagnostics.length === 0)) {
      if (!(await client.awaitIdle(AbortSignal.any([signal, progress]))))
        return busyAnswer(state, document);
      return await provisionalPull(client, document, signal, progress, state);
    }
    if (first === undefined) return undefined;
    const outcome = await quietOrRefresh(client, refreshed.promise, signal, progress);
    if (outcome === "busy") return busyAnswer(state, document);
    // A pull after a refresh is provisional too: servers refresh while they still load.
    if (outcome === "refreshed") return provisionalPull(client, document, signal, progress, state);
    const known = knownObservation(state, document);
    return known ? unionObservation(first, known) : first;
  } finally {
    stop();
  }
}

// Some servers register the pull method in reply to the first open, after this call has read
// pullDiagnostics, so a push wait also starts a pull when that registration arrives.
async function diagnosticsObservation(
  instance: Instance,
  document: Document,
  signal: AbortSignal,
  progress: AbortSignal,
): Promise<Observation> {
  const { client } = instance;
  if (client.pullDiagnostics)
    return (
      (await provisionalPull(client, document, signal, progress, instance.state)) ??
      diagnostics(document, signal)
    );
  const pulled = Promise.withResolvers<Observation | undefined>();
  const pushWait = new AbortController();
  const push = diagnostics(document, AbortSignal.any([signal, pushWait.signal]));
  const stop = client.onPullRegistration(() =>
    pulled.resolve(provisionalPull(client, document, signal, progress, instance.state)),
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
  progress: AbortSignal,
  cwd: string,
) {
  if (operation === "diagnostics") {
    const observation = await diagnosticsObservation(instance, document, signal, progress);
    return { ...observation, ...formatDiagnostics(observation) };
  }
  if (operation === "incoming_calls" || operation === "outgoing_calls") {
    if (!position) throw new Error("A line and a symbol or column are required");
    const formatted = await callsResponse(
      operation,
      instance.client,
      document.uri,
      position,
      cwd,
      signal,
    );
    return { outcome: "completed", source: "untrusted_lsp", ...formatted };
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

// Calls belong to the first item that prepare returns for the position.
async function callsResponse(
  operation: "incoming_calls" | "outgoing_calls",
  client: LanguageServer,
  uri: string,
  position: Position,
  cwd: string,
  signal: AbortSignal,
) {
  const prepared = callHierarchyItems(
    await client.request(
      "textDocument/prepareCallHierarchy",
      { textDocument: { uri }, position },
      signal,
    ),
  );
  const [first] = prepared;
  const response =
    first === undefined ? null : await client.request(method[operation], { item: first }, signal);
  return formatCalls(response, operation, prepared, cwd);
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
  noteEdit(instance.state, previous, route.file);
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

// The model cannot enable a server, so it is told what the user can run; undefined without discovery.
async function setupHint(
  server: string,
  markerDir: string,
  cwd: string,
): Promise<string | undefined> {
  const install = presetFor(server)?.discovery?.install;
  if (install === undefined) return undefined;
  const found = await findServer(server, markerDir, cwd, process.env.PATH);
  return found
    ? `${found.command} is installed: ask the user to run /hl-lsp-setup`
    : `none is installed: install one (${install}), then ask the user to run /hl-lsp-setup`;
}

async function unconfigured(route: SelectedRoute, cwd: string) {
  const { server } = route;
  const hint =
    (await setupHint(server, route.root, cwd)) ??
    `add servers.${server} with /hl-lsp set servers <JSON> --global (this replaces the whole servers map)`;
  return {
    ...route,
    outcome: "unavailable" as const,
    reason: `No server configured for "${server}"; ${hint}`,
  };
}

// Only a server that advertises prepareProvider is asked; null means no rename target here.
async function prepareRefusal(
  instance: Instance,
  capabilities: Initialization["capabilities"],
  textDocument: { uri: string },
  position: Position,
  deadline: AbortSignal,
): Promise<string | undefined> {
  if (
    typeof capabilities.renameProvider !== "object" ||
    capabilities.renameProvider.prepareProvider !== true
  )
    return undefined;
  const prepared = await instance.client.request(
    "textDocument/prepareRename",
    { textDocument, position },
    deadline,
  );
  return prepared === null ? "Rename is not available at this position" : undefined;
}

// Indentation follows the first indented line: a tab selects tabs, otherwise spaces.
function formattingOptions(text: string) {
  const indent = /^[ \t]+(?=\S)/mu.exec(text)?.[0] ?? "";
  return { tabSize: 2, insertSpaces: !indent.startsWith("\t") };
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
  "incoming_calls",
  "outgoing_calls",
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
  const abort = () =>
    aborted.reject(abortReason(deadline, "LSP server is still starting; retry the request"));
  deadline.addEventListener("abort", abort, { once: true });
  try {
    deadline.throwIfAborted();
    return await Promise.race([instance.ready, aborted.promise]);
  } finally {
    deadline.removeEventListener("abort", abort);
  }
}

// A disposed instance keeps no settle timer, and a query still waiting on that timer fails.
function releaseDocument(instance: Instance): void {
  const document = instance.state.document;
  clearTimeout(document?.timer);
  document?.waiting?.reject(new Error("LSP instance is closed"));
}

// Every cleanup must finish before the caller continues, even when another one fails first.
async function disposeAll(instances: Instance[]): Promise<void> {
  for (const instance of instances) releaseDocument(instance);
  const results = await Promise.allSettled(instances.map((instance) => instance.client.dispose()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

// The files are already written, so a failure to update the server is reported with the result, not as it.
async function unsynced(step: () => Promise<void>): Promise<string | undefined> {
  try {
    await step();
    return undefined;
  } catch (error) {
    return errorText(error);
  }
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

// Resolving fills in the edit of an action that the list answered without one.
async function resolvedAction(
  client: LanguageServer,
  action: CodeActionItem,
  deadline: AbortSignal,
): Promise<CodeActionItem> {
  const answer = await client.request("codeAction/resolve", action, deadline);
  if (!Value.Check(codeActionItem, answer)) throw new Error("Invalid resolved code action");
  return answer;
}

export class LspController {
  private readonly instances = new Map<string, Instance>();
  private readonly lifetime = new AbortController();
  // Error counts of the last settled diagnostics observation of each file.
  private readonly baseline = new Map<string, Map<string, number>>();
  private generation = 0;
  private selected: { instance: Instance; document: Document } | undefined;
  private readonly definitions: ServerDefinition[];

  constructor(
    private readonly cwd: string,
    private readonly settings: LspSettings,
    private readonly trusted: boolean,
  ) {
    this.definitions = serverDefinitions(settings.servers);
  }

  // Server paths are real paths; a symlinked cwd must be resolved before comparing or displaying them.
  root(): Promise<string> {
    return realpath(this.cwd);
  }

  private configured(): string[] {
    return Object.keys(this.settings.servers);
  }

  async serverStatus() {
    const refusal = this.gate();
    if (refusal) return refusal;
    const instances = [...this.instances.values()];
    const detected = await detectLanguages(this.cwd);
    const servers = await Promise.all(
      this.definitions.map(async ({ name }): Promise<ServerStatus> => {
        const configured = Object.hasOwn(this.settings.servers, name);
        const markerDir = detected.get(name);
        return {
          server: name,
          configured,
          instances: instances.filter((instance) => instance.server === name).map(instanceStatus),
          ...(configured || markerDir === undefined
            ? {}
            : { setup: await setupHint(name, markerDir, this.cwd) }),
        };
      }),
    );
    return { outcome: "completed" as const, servers };
  }

  // Stops the running instances of one configured server; the next query starts a fresh one.
  async reload(server: string) {
    const refusal = this.gate();
    if (refusal) return refusal;
    const configured = this.configured();
    if (!configured.includes(server))
      return {
        outcome: "unavailable" as const,
        reason: `Unknown server "${server}"; configured servers: ${configured.join(", ") || "none"}`,
      };
    const stopped = [...this.instances].filter(([, instance]) => instance.server === server);
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
        Object.entries(this.settings.servers).map(([name, server]) => [name, server.command]),
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
      edits: new Map(),
      published: new Map(),
      pending: new Map(),
      reads: 0,
    };
    const client = new LanguageServer(
      config,
      route.root,
      this.settings.timeoutMs,
      (value) => {
        const document = state.document;
        if (!Value.Check(publication, value)) return;
        const file = fileOf(value.uri);
        if (file !== undefined && file !== document?.file)
          retainUnopened(state, file, route.root, value, this.lifetime.signal);
        if (!document || file !== document.file) return;
        const report = diagnosticResult(value, document.version);
        if (report.outcome === "superseded") return;
        state.published.set(document.file, {
          text: document.text,
          edits: editsOf(state, document.file),
          observation: settledObservation(report),
        });
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

  // Re-inserting moves the file to the newest position, so the first key is the least recently used.
  private rememberBaseline(file: string, counts: Map<string, number>): void {
    this.baseline.delete(file);
    this.baseline.set(file, counts);
    if (this.baseline.size <= BASELINE_LIMIT) return;
    const oldest = this.baseline.keys().next().value;
    if (oldest !== undefined) this.baseline.delete(oldest);
  }

  private async evictOldest(): Promise<void> {
    if (this.instances.size < 8) return;
    const [key, oldest] = this.instances.entries().next().value ?? [];
    if (key === undefined || oldest === undefined) return;
    // A group that did not stop stays listed, so session cleanup still reports it.
    await disposeAll([oldest]);
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
    progress: AbortSignal,
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
    if (operation !== "diagnostics") await instance.client.settled(deadline, this.halfTimeoutMs);
    const result = await readResponse(
      operation,
      instance,
      document,
      position,
      search,
      deadline,
      progress,
      await this.root(),
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
    const deadline = this.deadlineFor(signal);
    deadline.throwIfAborted();
    const route = await resolveRoute(file, this.cwd, this.definitions);
    if (route.outcome !== "completed") return route;
    const config = this.settings.servers[route.server];
    if (!config) return unconfigured(route, this.cwd);
    const text = await snapshot(route.file, deadline);
    const position =
      operation === "diagnostics" || operation === "symbols" || operation === "workspace_symbols"
        ? undefined
        : resolvePosition(text, target);
    const instance = await this.instance(route, config, deadline);
    // The progress wait ends early enough for the post-read edit check to run before the deadline.
    const progress = AbortSignal.timeout(
      Math.max(0, this.settings.timeoutMs - Math.max(250, Math.ceil(this.settings.timeoutMs / 10))),
    );
    const result = await this.exchange(
      route,
      instance,
      operation,
      position,
      search,
      text,
      deadline,
      progress,
    );
    if ("diagnostics" in result) this.rememberBaseline(route.file, errorCounts(result.diagnostics));
    return result;
  }

  /**
   * The file's errors after an edit. A compared check keeps only the errors the previous check did
   * not have; without one every error is kept. Undefined when no server is expected to check the file.
   */
  async newErrors(file: string, signal: AbortSignal): Promise<EditCheck | undefined> {
    if (this.gate()) return undefined;
    const route = await resolveRoute(file, this.cwd, this.definitions);
    if (route.outcome !== "completed") return undefined;
    const before = this.baseline.get(route.file);
    const result = await this.query("diagnostics", file, undefined, signal);
    if (!("diagnostics" in result))
      return {
        outcome: "unchecked",
        reason: "reason" in result ? result.reason : "no diagnostics returned",
      };
    if (result.evidence === "server_busy")
      return { outcome: "unchecked", reason: "the server is still busy" };
    if (result.evidence === "unchanged_empty")
      return {
        outcome: "unchecked",
        reason: "the server reported nothing after the edit",
      };
    const shown = result.diagnostics.filter((item) => item.severity === 1);
    if (result.reportedErrors > shown.length)
      return {
        outcome: "unchecked",
        reason: "the server reported more errors than are compared",
      };
    const seen = new Map<string, number>();
    const errors = shown.filter((item) => {
      const key = errorKey(item);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return count > (before?.get(key) ?? 0);
    });
    // An unversioned list can precede the type check, so only a new error in it is evidence.
    if (result.evidence === "settled_unversioned" && errors.length === 0)
      return {
        outcome: "unchecked",
        reason: "the server gave no version, so its errors may still arrive",
      };
    return { outcome: "checked", compared: before !== undefined, errors };
  }

  // The server computes the edit; rename.ts checks it, and only then does any file change.
  async rename(file: string, target: NavigationTarget, newName: string, signal?: AbortSignal) {
    const refusal = this.gate();
    if (refusal) return refusal;
    const deadline = this.deadlineFor(signal);
    deadline.throwIfAborted();
    const route = await resolveRoute(file, this.cwd, this.definitions);
    if (route.outcome !== "completed") return route;
    const config = this.settings.servers[route.server];
    if (!config) return unconfigured(route, this.cwd);
    const text = await snapshot(route.file, deadline);
    const position = resolvePosition(text, target);
    const instance = await this.instance(route, config, deadline);
    const { capabilities } = await ready(instance, deadline);
    deadline.throwIfAborted();
    if (!capabilities.renameProvider)
      return {
        ...route,
        outcome: "unsupported" as const,
        reason: "Server did not advertise this capability",
      };
    const document = await synchronize(
      instance,
      route,
      text,
      deadline,
      supportsChange(capabilities),
    );
    await instance.client.settled(deadline, this.halfTimeoutMs);
    const textDocument = { uri: document.uri };
    const refused = await prepareRefusal(instance, capabilities, textDocument, position, deadline);
    if (refused) return { ...route, outcome: "refused" as const, reason: refused };
    const edit = await instance.client.request(
      "textDocument/rename",
      { textDocument, position, newName },
      deadline,
    );
    const applied = await applyWorkspaceEdit(edit, await this.root(), document);
    if (applied.outcome !== "written") return { ...route, ...applied };
    return {
      ...route,
      outcome: "completed" as const,
      changed: applied.changed,
      unsynced: await unsynced(() =>
        this.resync(instance, route, applied.changed, supportsChange(capabilities), deadline),
      ),
    };
  }

  // Formats the file an edit just wrote; the server's edits are applied all or none, as in rename.
  async format(file: string, signal: AbortSignal): Promise<FormatOutcome> {
    if (!this.settings.formatOnWrite || this.gate() !== undefined) return { outcome: "unchanged" };
    const route = await resolveRoute(file, this.cwd, this.definitions);
    if (route.outcome !== "completed") return { outcome: "unchanged" };
    const config = this.settings.servers[route.server];
    if (!config) return { outcome: "unchanged" };
    const instance = await this.instance(route, config, signal);
    const { capabilities } = await ready(instance, signal);
    if (!capabilities.documentFormattingProvider) return { outcome: "unchanged" };
    const text = await snapshot(route.file, signal);
    const document = await synchronize(instance, route, text, signal, supportsChange(capabilities));
    const edits = await instance.client.request(
      "textDocument/formatting",
      { textDocument: { uri: document.uri }, options: formattingOptions(text) },
      signal,
    );
    if (edits === null || (Array.isArray(edits) && edits.length === 0))
      return { outcome: "unchanged" };
    const applied = await applyTextEdits(edits, await this.root(), document);
    if (applied.outcome !== "written") return { outcome: "skipped", reason: applied.reason };
    return {
      outcome: "formatted",
      edits: applied.changed.reduce((sum, { edits }) => sum + edits, 0),
    };
  }

  // The server computes the import edits; the edits and the move are one all-or-nothing step, and a null edit names none.
  async renameFile(oldPath: string, newPath: string, signal?: AbortSignal) {
    const refusal = this.gate();
    if (refusal) return refusal;
    const deadline = this.deadlineFor(signal);
    deadline.throwIfAborted();
    const route = await resolveRoute(oldPath, this.cwd, this.definitions);
    if (route.outcome !== "completed") return route;
    const config = this.settings.servers[route.server];
    if (!config) return unconfigured(route, this.cwd);
    const root = await this.root();
    const plan = await planMove(route.file, newPath, root);
    if (plan.outcome === "refused")
      return { ...route, outcome: "refused" as const, reason: plan.reason };
    const instance = await this.instance(route, config, deadline);
    const { capabilities } = await ready(instance, deadline);
    deadline.throwIfAborted();
    if (!capabilities.workspace?.fileOperations?.willRename)
      return {
        ...route,
        outcome: "unsupported" as const,
        reason: "Server did not advertise workspace.fileOperations.willRename",
      };
    return this.applyFileRename(instance, route, plan.move, capabilities, root, deadline);
  }

  // The move runs after the import edits are written; if it fails, the edits are restored.
  private async applyFileRename(
    instance: Instance,
    route: SelectedRoute,
    move: FileMove,
    capabilities: Initialization["capabilities"],
    root: string,
    deadline: AbortSignal,
  ) {
    const document =
      instance.state.document?.file === route.file
        ? await synchronize(
            instance,
            route,
            await snapshot(route.file, deadline),
            deadline,
            supportsChange(capabilities),
          )
        : undefined;
    const files = [
      {
        oldUri: pathToFileURL(move.from).href,
        newUri: pathToFileURL(move.to).href,
      },
    ];
    const edit = await instance.client.request("workspace/willRenameFiles", { files }, deadline);
    const applied = await applyWorkspaceEdit(edit === null ? {} : edit, root, document, () =>
      moveFile(move),
    );
    if (applied.outcome !== "written") return { ...route, ...applied };
    const reason = await unsynced(async () => {
      if (capabilities.workspace?.fileOperations?.didRename)
        await instance.client.notify("workspace/didRenameFiles", { files }, deadline);
      if (document)
        await synchronize(
          instance,
          { ...route, file: move.to },
          await snapshot(move.to, deadline),
          deadline,
          false,
        );
    });
    return {
      ...route,
      outcome: "completed" as const,
      unsynced: reason,
      move,
      changed: applied.changed.map((change) =>
        change.file === move.from ? { ...change, file: move.to } : change,
      ),
    };
  }

  // AbortSignal.timeout throws on a fractional delay, and an odd timeoutMs is valid.
  private get halfTimeoutMs(): number {
    return Math.floor(this.settings.timeoutMs / 2);
  }

  private deadlineFor(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(this.settings.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
  }

  // Lists the code actions at a position, with the cached diagnostics that overlap its range as context.
  private async listedActions(file: string, target: NavigationTarget, deadline: AbortSignal) {
    // The diagnostics wait ends at half the call timeout counted from the start of the listing, so readiness shortens it.
    const budget = AbortSignal.timeout(this.halfTimeoutMs);
    const route = await resolveRoute(file, this.cwd, this.definitions);
    if (route.outcome !== "completed") return route;
    const config = this.settings.servers[route.server];
    if (!config) return unconfigured(route, this.cwd);
    const text = await snapshot(route.file, deadline);
    const range = actionRange(text, target);
    const instance = await this.instance(route, config, deadline);
    const { capabilities } = await ready(instance, deadline);
    deadline.throwIfAborted();
    if (!capabilities.codeActionProvider)
      return {
        ...route,
        outcome: "unsupported" as const,
        reason: "Server did not advertise this capability",
      };
    const document = await synchronize(
      instance,
      route,
      text,
      deadline,
      supportsChange(capabilities),
    );
    await instance.client.settled(deadline, this.halfTimeoutMs);
    const observation = await diagnosticsObservation(
      instance,
      document,
      AbortSignal.any([deadline, budget]),
      budget,
    ).catch((error: unknown) => {
      deadline.throwIfAborted();
      if (!budget.aborted) throw error;
      return document.observation;
    });
    const response = await instance.client.request(
      "textDocument/codeAction",
      {
        textDocument: { uri: document.uri },
        range,
        context: {
          diagnostics: contextDiagnostics(observation?.diagnostics ?? [], range),
        },
      },
      deadline,
    );
    if (!Value.Check(codeActionList, response)) throw new Error("Invalid code action list");
    return {
      route,
      instance,
      document,
      canChange: supportsChange(capabilities),
      resolves:
        typeof capabilities.codeActionProvider === "object" &&
        capabilities.codeActionProvider.resolveProvider === true,
      actions: response ?? [],
    };
  }

  async codeActions(file: string, target: NavigationTarget, signal?: AbortSignal) {
    const refusal = this.gate();
    if (refusal) return refusal;
    const listed = await this.listedActions(file, target, this.deadlineFor(signal));
    if (!("actions" in listed)) return listed;
    return {
      ...listed.route,
      outcome: "completed" as const,
      actions: listed.actions.map((action) => listedAction(action, listed.resolves)),
    };
  }

  // The edit is applied only when the listed title still matches, so a stale index is refused.
  async applyCodeAction(
    file: string,
    target: NavigationTarget,
    index: number,
    title: string,
    signal?: AbortSignal,
  ) {
    const refusal = this.gate();
    if (refusal) return refusal;
    const deadline = this.deadlineFor(signal);
    const listed = await this.listedActions(file, target, deadline);
    if (!("actions" in listed)) return listed;
    const refuse = (reason: string) => ({
      ...listed.route,
      outcome: "refused" as const,
      reason,
    });
    const chosen = listed.actions[index - 1];
    if (chosen === undefined)
      return refuse(`There is no code action ${index}; list the code actions again`);
    const shown = displayText(chosen.title);
    if (shown !== title)
      return refuse(
        `Code action ${index} is "${shown}", not "${title}"; list the code actions again`,
      );
    const action = isResolvable(chosen, listed.resolves)
      ? await resolvedAction(listed.instance.client, chosen, deadline)
      : chosen;
    const edit = editOf(action);
    if (edit === undefined) return refuse(`Code action ${index} has no edit; commands are not run`);
    const applied = await applyWorkspaceEdit(edit, await this.root(), listed.document);
    if (applied.outcome !== "written") return { ...listed.route, ...applied };
    return {
      ...listed.route,
      outcome: "completed" as const,
      changed: applied.changed,
      unsynced: await unsynced(() =>
        this.resync(listed.instance, listed.route, applied.changed, listed.canChange, deadline),
      ),
    };
  }

  // An applied edit to the open document is sent back to the server, so its diagnostics follow the new text.
  private async resync(
    instance: Instance,
    route: SelectedRoute,
    changed: ChangedFile[],
    canChange: boolean,
    deadline: AbortSignal,
  ): Promise<void> {
    if (!changed.some(({ file }) => file === route.file)) return;
    await synchronize(instance, route, await snapshot(route.file, deadline), deadline, canChange);
  }

  private async snapshotMatches(document: Document, instance: Instance): Promise<boolean> {
    const route = await resolveRoute(document.file, this.cwd, this.definitions);
    if (
      route.outcome !== "completed" ||
      route.file !== document.file ||
      route.root !== instance.root ||
      route.server !== instance.server
    )
      return false;
    const text = await snapshot(document.file, this.deadlineFor());
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
    this.lifetime.abort(new Error("Controller is closed"));
    const instances = [...this.instances.values()];
    this.instances.clear();
    this.baseline.clear();
    this.selected = undefined;
    await disposeAll(instances);
  }
}
