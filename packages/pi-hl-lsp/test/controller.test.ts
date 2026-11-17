import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished, vi } from "vitest";

import { LspController } from "../src/controller.js";
import { LanguageServer } from "../src/server.js";
import type { LspSettings } from "../src/settings.js";
import { directory } from "./fixtures.js";

const fixture = fileURLToPath(new URL("./protocol-server.ts", import.meta.url));
// Protocol events the fixture logged after its launch line.
const events = async (spawnLog: string) =>
  (await readFile(spawnLog, "utf8")).trim().split("\n").slice(1);

async function controller(
  mode = "normal",
  consent = true,
  trusted = true,
  overrides: Partial<LspSettings> = {},
) {
  const cwd = await directory();
  await writeFile(join(cwd, "tsconfig.json"), "{}");
  const file = join(cwd, "index.ts");
  await writeFile(file, "const value = 1;\n");
  const spawnLog = join(cwd, "spawns.log");
  const settings: LspSettings = {
    enabled: true,
    name: "HL LSP",
    allowProjectExecution: consent,
    timeoutMs: 5000,
    formatOnWrite: false,
    servers: {
      typescript: {
        command: process.execPath,
        args: [fixture, mode, spawnLog],
      },
    },
    ...overrides,
  };
  const instance = new LspController(cwd, settings, trusted);
  onTestFinished(() => instance.dispose());
  return { instance, file, spawnLog };
}

it("evicts the least recently used baseline once 128 files have one", async () => {
  const { instance, file } = await controller("error-lines");
  const folder = dirname(file);
  const paths = Array.from({ length: 129 }, (_, index) => join(folder, `file${index}.ts`));
  const first = join(folder, "file0.ts");
  const last = join(folder, "file128.ts");
  for (const path of paths) await writeFile(path, "ERROR\n");
  const signal = new AbortController().signal;
  for (const path of paths) await instance.newErrors(path, signal);
  // The 129th file pushed out the first file's baseline, so its error reads as new again.
  expect(await instance.newErrors(first, signal)).toHaveLength(1);
  // The newest file keeps its baseline, so its error is no longer new.
  expect(await instance.newErrors(last, signal)).toEqual([]);
}, 60_000);

it("requires separate global project-execution consent before launch", async () => {
  const { instance, file } = await controller("normal", false);
  expect(await instance.query("hover", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "blocked",
  });
});

it("requires project trust before launch, even with global consent", async () => {
  const { instance, file, spawnLog } = await controller("normal", true, false);
  expect(await instance.query("hover", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "blocked",
  });
  await expect(readFile(spawnLog, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("names only the disabled condition and its fix", async () => {
  const { instance, file } = await controller("normal", true, true, {
    enabled: false,
  });
  expect(await instance.query("hover", file, { line: 1, column: 7 })).toEqual({
    outcome: "blocked",
    reason: "LSP is off; run /hl-lsp on",
  });
});

it("names the trust and consent fixes, not the enable fix, when both fail", async () => {
  const { instance, file } = await controller("normal", false, false);
  const result = await instance.query("hover", file, { line: 1, column: 7 });
  expect(result).toMatchObject({ outcome: "blocked" });
  const reason = "reason" in result ? result.reason : undefined;
  expect(reason).toContain("run /trust, then restart Pi");
  expect(reason).toContain("allowProjectExecution");
  expect(reason).not.toContain("/hl-lsp on");
});

it("names the server key and its fix when no server is configured for the language", async () => {
  const { instance, file } = await controller();
  const root = join(file, "..");
  await writeFile(join(root, "pyproject.toml"), "");
  await writeFile(join(root, "main.py"), "");
  const result = await instance.query("hover", join(root, "main.py"), {
    line: 1,
    column: 1,
  });
  expect(result).toMatchObject({
    outcome: "unavailable",
    reason:
      'No server configured for "python"; add servers.python with /hl-lsp set servers <JSON> --global (this replaces the whole servers map)',
  });
});

it("routes a custom server end to end by its name, file type and root marker", async () => {
  const cwd = await directory();
  await writeFile(join(cwd, "project.foo-root"), "");
  const file = join(cwd, "main.foo");
  await writeFile(file, "const value = 1;\n");
  const instance = new LspController(
    cwd,
    {
      enabled: true,
      name: "HL LSP",
      allowProjectExecution: true,
      timeoutMs: 5000,
      formatOnWrite: false,
      servers: {
        mylsp: {
          command: process.execPath,
          args: [fixture, "normal", join(cwd, "spawns.log")],
          fileTypes: [".foo"],
          rootMarkers: ["project.foo-root"],
        },
      },
    },
    true,
  );
  onTestFinished(() => instance.dispose());
  expect(await instance.query("hover", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "completed",
    server: "mylsp",
    text: "const value: number",
  });
});

it("reports the timeout and the configured server commands in status", async () => {
  const { instance } = await controller();
  expect(instance.status()).toMatchObject({
    timeoutMs: 5000,
    servers: { typescript: process.execPath },
  });
});

it("routes, synchronizes, and returns bounded read-only hover output", async () => {
  const { instance, file } = await controller();
  const result = await instance.query("hover", file, { line: 1, column: 7 });
  expect(result).toHaveProperty("text", "const value: number");
  expect(result).toMatchObject({
    outcome: "completed",
    server: "typescript",
    source: "untrusted_lsp",
  });
});

it("resolves a symbol to the 0-based character of its first match on the line", async () => {
  const { instance, file } = await controller("echo-position");
  expect(await instance.query("hover", file, { line: 1, symbol: "value" })).toMatchObject({
    text: "0:6",
  });
});

it("resolves a column of 1 to character 0", async () => {
  const { instance, file } = await controller("echo-position");
  expect(await instance.query("hover", file, { line: 1, column: 1 })).toMatchObject({
    text: "0:0",
  });
});

it("names the line text when the symbol is missing", async () => {
  const { instance, file } = await controller("echo-position");
  await expect(instance.query("hover", file, { line: 1, symbol: "absent" })).rejects.toThrow(
    'Symbol "absent" is not on the line: const value = 1;',
  );
});

it("lists the 1-based columns when the symbol occurs twice", async () => {
  const { instance, file } = await controller("echo-position");
  await writeFile(file, "value + value;\n");
  await expect(instance.query("hover", file, { line: 1, symbol: "value" })).rejects.toThrow(
    "occurs at columns 1, 9; give column instead",
  );
});

it("does not match a symbol inside a longer identifier", async () => {
  const { instance, file } = await controller("echo-position");
  await expect(instance.query("hover", file, { line: 1, symbol: "val" })).rejects.toThrow(
    'Symbol "val" is not on the line: const value = 1;',
  );
});

it("resolves a line in a CR-only file", async () => {
  const { instance, file } = await controller("echo-position");
  await writeFile(file, "a\rconst value = 1;");
  expect(await instance.query("hover", file, { line: 2, symbol: "value" })).toMatchObject({
    text: "1:6",
  });
});

it("rejects line 0 and a line past the end", async () => {
  const { instance, file } = await controller("echo-position");
  await expect(instance.query("hover", file, { line: 0, column: 1 })).rejects.toThrow(
    "Line is outside the file snapshot",
  );
  await expect(instance.query("hover", file, { line: 3, column: 1 })).rejects.toThrow(
    "Line is outside the file snapshot",
  );
});

it("counts a non-ASCII prefix in UTF-16 code units", async () => {
  const { instance, file } = await controller("echo-position");
  await writeFile(file, "const é = value;\n");
  expect(await instance.query("hover", file, { line: 1, symbol: "value" })).toMatchObject({
    text: "0:10",
  });
});

it("requires exactly one of symbol or column", async () => {
  const { instance, file } = await controller("echo-position");
  await expect(instance.query("hover", file, { line: 1 })).rejects.toThrow(
    "Give exactly one of symbol or column",
  );
  await expect(
    instance.query("hover", file, { line: 1, symbol: "value", column: 1 }),
  ).rejects.toThrow("Give exactly one of symbol or column");
});

it("allows the column just past the line end and rejects one further", async () => {
  const { instance, file } = await controller("echo-position");
  expect(await instance.query("hover", file, { line: 1, column: 17 })).toMatchObject({
    text: "0:16",
  });
  await expect(instance.query("hover", file, { line: 1, column: 18 })).rejects.toThrow(
    "Column is beyond the line end",
  );
});

it("keeps a bounded leading part of an oversized single-line response", async () => {
  const { instance, file } = await controller("chatty");
  const result = await instance.query("hover", file, { line: 1, column: 7 });
  expect(result).toMatchObject({ outcome: "completed", truncated: true });
  const text = "text" in result ? result.text : undefined;
  expect(text).toMatch(/^x{500}/u);
  expect(Buffer.byteLength(String(text))).toBeLessThanOrEqual(8192);
});

it("reports unversioned empty diagnostics as partial and omits automatic certification", async () => {
  const { instance, file } = await controller();
  expect(await instance.query("diagnostics", file)).toMatchObject({
    outcome: "partial",
    evidence: "settled_unversioned",
    projectComplete: false,
  });
  expect(await instance.summary()).toMatchObject({
    evidence: "settled_unversioned",
    reportedCount: 0,
  });
});

it("settles a staged unversioned publication on its last list", async () => {
  const { instance, file } = await controller("staged");
  expect(await instance.query("diagnostics", file)).toMatchObject({
    outcome: "partial",
    evidence: "settled_unversioned",
    diagnostics: [{ code: 2322 }],
  });
});

it("returns unchanged_empty after a silent clean edit, then answers the same document at once", async () => {
  const { instance, file } = await controller("dedupe-empty");
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "settled_unversioned",
    diagnostics: [],
  });
  await writeFile(file, "const value = 2;\n");
  const edited = performance.now();
  expect(await instance.query("diagnostics", file)).toMatchObject({
    outcome: "partial",
    evidence: "unchanged_empty",
    diagnostics: [],
  });
  expect(performance.now() - edited).toBeLessThan(1500);
  const again = performance.now();
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "unchanged_empty",
  });
  expect(performance.now() - again).toBeLessThan(100);
});

it("clears the quiet timer of a waiting query when the controller is disposed", async () => {
  const { instance, file } = await controller("dedupe-empty");
  await instance.query("diagnostics", file);
  await writeFile(file, "const value = 2;\n");
  const setTimer = vi.spyOn(globalThis, "setTimeout");
  const clearTimer = vi.spyOn(globalThis, "clearTimeout");
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const started = setTimer.mock.calls.length;
  const pending = instance.query("diagnostics", file);
  const quietIndex = () =>
    setTimer.mock.calls.findIndex(([, ms], index) => index >= started && ms === 1000);
  await vi.waitFor(() => expect(quietIndex()).toBeGreaterThanOrEqual(0));
  const index = quietIndex();
  // Attached before dispose, so the rejection that dispose causes has a handler.
  const outcome = pending.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : "not an error"),
  );
  await instance.dispose();
  expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[index]?.value);
  // dispose aborts the query with its own reason, so the wait no longer reads as a settle timeout.
  expect(await outcome).toBe("Controller is closed");
});

it("reports the caller's abort reason instead of a settle timeout", async () => {
  const { instance, file } = await controller("silent");
  const caller = new AbortController();
  const query = instance.query("diagnostics", file, undefined, caller.signal);
  caller.abort(new Error("caller cancelled"));
  await expect(query).rejects.toThrow("caller cancelled");
});

it("matches a publication whose URI encodes @ as %40", async () => {
  const { instance, file } = await controller("encoded-uri");
  const scoped = join(file, "..", "@scope+x", "index.ts");
  await mkdir(join(file, "..", "@scope+x"));
  await writeFile(scoped, "const value = 1;\n");
  expect(await instance.query("diagnostics", scoped)).toMatchObject({
    evidence: "settled_unversioned",
    reportedCount: 1,
  });
});

it("keeps a string diagnostic code from the server", async () => {
  const { instance, file } = await controller("string-code");
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    diagnostics: [{ code: "reportMissingImports" }],
  });
});

it("resolves a versioned publication without waiting for the settle period", async () => {
  const { instance, file } = await controller("versioned");
  await instance.query("hover", file, { line: 1, column: 7 });
  const other = join(file, "..", "other.ts");
  await writeFile(other, "const other = 1;\n");
  const started = performance.now();
  expect(await instance.query("diagnostics", other)).toMatchObject({
    evidence: "revision_correlated",
    reportedCount: 1,
  });
  expect(performance.now() - started).toBeLessThan(100);
});

it("answers from a pull the server offers, without waiting for a push", async () => {
  const { instance, file, spawnLog } = await controller("pull-static", true, true, {
    timeoutMs: 1000,
  });
  expect(await instance.query("diagnostics", file)).toMatchObject({
    outcome: "completed",
    evidence: "revision_correlated",
    diagnostics: [{ code: "E0308" }],
  });
  expect(await events(spawnLog)).toEqual(["pull"]);
});

it("pulls once the server registers the pull method after initialization", async () => {
  const { instance, file, spawnLog } = await controller("pull-dynamic", true, true, {
    timeoutMs: 1000,
  });
  await instance.query("hover", file, { line: 1, column: 7 });
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    diagnostics: [{ code: "E0308" }],
  });
  expect(await events(spawnLog)).toEqual(["pull"]);
});

it("pulls when the server registers the pull method in reply to the first open", async () => {
  const { instance, file, spawnLog } = await controller("pull-late-registration", true, true, {
    timeoutMs: 1000,
  });
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    diagnostics: [{ code: "E0308" }],
  });
  expect(await events(spawnLog)).toEqual(["pull"]);
});

it("lists the pulled item and the pushed item for the same version", async () => {
  const { instance, file } = await controller("pull-and-push", true, true, {
    timeoutMs: 1000,
  });
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    reportedCount: 2,
    diagnostics: [{ code: "E0308" }, { code: 2322 }],
  });
});

it("lists an item that the pull and the push both return once", async () => {
  const { instance, file } = await controller("pull-duplicate", true, true, {
    timeoutMs: 1000,
  });
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    reportedCount: 1,
    diagnostics: [{ code: 2322 }],
  });
});

it("falls back to the push path when a pull fails with an error other than cancellation", async () => {
  const { instance, file, spawnLog } = await controller("pull-error", true, true, {
    timeoutMs: 1000,
  });
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    diagnostics: [{ code: 2322 }],
  });
  expect(await events(spawnLog)).toEqual(["pull"]);
});

it("retries a pull the server cancels, once", async () => {
  const { instance, file, spawnLog } = await controller("pull-cancel-once", true, true, {
    timeoutMs: 1000,
  });
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    diagnostics: [{ code: "E0308" }],
  });
  expect(await events(spawnLog)).toEqual(["pull", "pull"]);
});

it("falls back to the push path when the retried pull is cancelled too", async () => {
  const { instance, file, spawnLog } = await controller("pull-cancel-always", true, true, {
    timeoutMs: 1000,
  });
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    diagnostics: [{ code: 2322 }],
  });
  expect(await events(spawnLog)).toEqual(["pull", "pull"]);
});

it("fails with the timeout error when the server never publishes", async () => {
  const { instance, file } = await controller("silent", true, true, {
    timeoutMs: 1000,
  });
  await expect(instance.query("diagnostics", file)).rejects.toThrow(
    "No settled diagnostics before the timeout",
  );
});

it("reports an unreadable summary snapshot once, then drops the stale summary", async () => {
  const { instance, file } = await controller("versioned");
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
  });
  expect(await instance.summary()).toMatchObject({ reportedCount: 1 });
  await writeFile(file, "x".repeat(1024 * 1024 + 1));
  await expect(instance.summary()).rejects.toThrow("1 MiB snapshot limit");
  expect(await instance.summary()).toBeUndefined();
});

it("drops the automatic summary when the file's route changes", async () => {
  const { instance, file } = await controller("versioned");
  const sub = join(file, "..", "sub");
  await mkdir(sub);
  await writeFile(join(sub, "index.ts"), "const value = 1;\n");
  expect(await instance.query("diagnostics", join(sub, "index.ts"))).toMatchObject({
    evidence: "revision_correlated",
  });
  expect(await instance.summary()).toMatchObject({ reportedCount: 1 });
  await writeFile(join(sub, "tsconfig.json"), "{}");
  expect(await instance.summary()).toBeUndefined();
});

it("does not issue requests for capabilities that the server did not advertise", async () => {
  const { instance, file } = await controller();
  expect(await instance.query("definition", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "unsupported",
  });
});

it("queries type definition and implementation when the server advertises them", async () => {
  const { instance, file } = await controller("type-navigation");
  expect(await instance.query("type_definition", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "completed",
    text: "index.ts:1:7  const value = 1;",
  });
  expect(await instance.query("implementation", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "completed",
    text: "impl.ts:3:1",
  });
});

it("queries incoming and outgoing calls of the prepared item", async () => {
  const { instance, file } = await controller("call-hierarchy");
  expect(await instance.query("incoming_calls", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "completed",
    text: "caller.ts:3:5 caller of value",
  });
  expect(await instance.query("outgoing_calls", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "completed",
    text: "callee.ts:1:1 callee of value",
  });
});

it("says which prepared item the calls belong to when prepare returns several", async () => {
  const { instance, file } = await controller("call-hierarchy-several");
  expect(await instance.query("incoming_calls", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "completed",
    text: "prepare returned 2 items; calls of the first: value\ncaller.ts:3:5 caller of value",
  });
});

it("does not issue call hierarchy requests when the server lacks the provider", async () => {
  const { instance, file } = await controller();
  expect(await instance.query("incoming_calls", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "unsupported",
  });
});

it("fails a malformed call hierarchy response", async () => {
  const { instance, file } = await controller("call-hierarchy-bogus");
  await expect(instance.query("incoming_calls", file, { line: 1, column: 7 })).rejects.toThrow(
    "Unexpected LSP incoming_calls response shape",
  );
});

it("finds a symbol by name in a project, opening the queried file first", async () => {
  const { instance, file } = await controller("workspace-symbols");
  expect(
    await instance.query("workspace_symbols", file, undefined, undefined, "value"),
  ).toMatchObject({
    outcome: "completed",
    text: "variable value  index.ts:1:7  const value = 1;",
  });
});

it("prints a workspace symbol without a range as its path", async () => {
  const { instance, file } = await controller("workspace-symbols");
  expect(
    await instance.query("workspace_symbols", file, undefined, undefined, "pathonly"),
  ).toMatchObject({
    outcome: "completed",
    text: "variable pathonly  index.ts",
  });
});

it("caps workspace symbols at fifty lines and reports the rest", async () => {
  const { instance, file } = await controller("workspace-symbols");
  const result = await instance.query("workspace_symbols", file, undefined, undefined, "many");
  expect(result).toMatchObject({ outcome: "completed", truncated: true });
  const text = "text" in result ? result.text : undefined;
  expect(text?.split("\n")).toHaveLength(51);
  expect(text).toMatch(/\n\.\.\. 10 more$/u);
});

it("does not search workspace symbols when the server lacks workspaceSymbolProvider", async () => {
  const { instance, file } = await controller();
  expect(
    await instance.query("workspace_symbols", file, undefined, undefined, "value"),
  ).toMatchObject({ outcome: "unsupported" });
});

it("rejects a malformed workspace symbol response", async () => {
  const { instance, file } = await controller("workspace-symbols");
  await expect(
    instance.query("workspace_symbols", file, undefined, undefined, "bogus"),
  ).rejects.toThrow("Unexpected LSP workspace_symbols response shape");
});

it("holds a workspace symbol query until progress ends", async () => {
  const { instance, file, spawnLog } = await controller("progress-load");
  expect(
    await instance.query("workspace_symbols", file, undefined, undefined, "value"),
  ).toMatchObject({ outcome: "completed" });
  const lines = await events(spawnLog);
  expect(
    lines.filter((line) => !line.startsWith("create")).map((line) => line.split(" ")[0]),
  ).toEqual(["begin", "end", "symbol"]);
});

it("waits for progress that starts only after the first document is opened", async () => {
  const { instance, file, spawnLog } = await controller("progress-late");
  expect(
    await instance.query("workspace_symbols", file, undefined, undefined, "value"),
  ).toMatchObject({ outcome: "completed" });
  const lines = await events(spawnLog);
  expect(lines.map((line) => line.split(" ")[0])).toEqual(["begin", "end", "symbol"]);
});

it("answers the workDoneProgress create request with null", async () => {
  const { instance, file, spawnLog } = await controller("progress-load");
  await instance.query("workspace_symbols", file, undefined, undefined, "value");
  expect(await events(spawnLog)).toContain("create null");
});

it("waits a quiet window after progress ends before a workspace symbol query", async () => {
  const { instance, file, spawnLog } = await controller("progress-load");
  await instance.query("workspace_symbols", file, undefined, undefined, "value");
  const lines = await events(spawnLog);
  const at = (name: string) =>
    Number(lines.find((line) => line.startsWith(`${name} `))?.split(" ")[1]);
  expect(at("symbol") - at("end")).toBeGreaterThanOrEqual(300);
});

it("sends a workspace symbol query after half the call timeout while progress never ends", async () => {
  const { instance, file, spawnLog } = await controller("progress-stuck", true, true, {
    timeoutMs: 1000,
  });
  expect(
    await instance.query("workspace_symbols", file, undefined, undefined, "value"),
  ).toMatchObject({ outcome: "completed" });
  const lines = await events(spawnLog);
  expect(
    lines.filter((line) => !line.startsWith("create")).map((line) => line.split(" ")[0]),
  ).toEqual(["begin", "symbol"]);
});

it("waits for the server status to report quiescence before a workspace symbol query", async () => {
  const { instance, file, spawnLog } = await controller("server-status");
  expect(
    await instance.query("workspace_symbols", file, undefined, undefined, "value"),
  ).toMatchObject({ outcome: "completed" });
  const lines = await events(spawnLog);
  expect(lines.map((line) => line.split(" ")[0])).toEqual(["quiet", "symbol"]);
});

async function packages(cwd: string, count: number) {
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const root = join(cwd, `package-${index}`);
      await mkdir(root);
      await writeFile(join(root, "tsconfig.json"), "{}");
      await writeFile(join(root, "index.ts"), "const value = 1;\n");
      return join(root, "index.ts");
    }),
  );
}

it("does not count failed instances toward the eight-instance limit", async () => {
  const { instance, file, spawnLog } = await controller("wrong-encoding");
  for (const path of await packages(join(file, ".."), 9))
    await expect(instance.query("hover", path, { line: 1, column: 7 })).rejects.toThrow(
      "Unsupported LSP position encoding",
    );
  expect((await readFile(spawnLog, "utf8")).trim().split("\n")).toHaveLength(9);
});

it("evicts the oldest instance to start a ninth", async () => {
  const { instance, file, spawnLog } = await controller();
  const paths = await packages(join(file, ".."), 8);
  for (const path of paths)
    expect(await instance.query("hover", path, { line: 1, column: 7 })).toMatchObject({
      outcome: "completed",
    });
  const first = Number((await readFile(spawnLog, "utf8")).split("\n")[0]);
  expect(await instance.query("hover", file, { line: 1, column: 7 })).toMatchObject({
    outcome: "completed",
  });
  const roots = instance.status().instances.map((listed) => listed.root);
  expect(roots).toHaveLength(8);
  expect(roots).not.toContain(join(paths[0] ?? "", ".."));
  expect(() => process.kill(first, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

it("evicts the least recently used instance, not the first started", async () => {
  const { instance, file } = await controller();
  const paths = await packages(join(file, ".."), 8);
  for (const path of [...paths, paths[0] ?? ""])
    await instance.query("hover", path, { line: 1, column: 7 });
  await instance.query("hover", file, { line: 1, column: 7 });
  const roots = instance.status().instances.map((listed) => listed.root);
  expect(roots).toContain(join(paths[0] ?? "", ".."));
  expect(roots).not.toContain(join(paths[1] ?? "", ".."));
});

const launches = async (spawnLog: string) =>
  (await readFile(spawnLog, "utf8")).split("\n").filter((line) => /^\d+$/u.test(line)).length;
const position = { line: 1, column: 7 };

it("warm: keeps the server after a request timeout", async () => {
  const { instance, file, spawnLog } = await controller("ignore", true, true, {
    timeoutMs: 1000,
  });
  await instance.query("diagnostics", file);
  await expect(instance.query("hover", file, position)).rejects.toThrow("aborted due to timeout");
  await expect(instance.query("hover", file, position)).rejects.toThrow("aborted due to timeout");
  expect(await launches(spawnLog)).toBe(1);
  expect(await events(spawnLog)).toContain("cancel");
});

it("warm: keeps the server after the caller cancels", async () => {
  const { instance, file, spawnLog } = await controller("ignore");
  await instance.query("diagnostics", file);
  // A query inside the 1 s readiness grace sends nothing, so the cancel needs a request already sent.
  await delay(1100);
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(instance.query("hover", file, position, AbortSignal.timeout(50))).rejects.toThrow(
      "aborted due to timeout",
    );
  expect(await launches(spawnLog)).toBe(1);
  expect(await events(spawnLog)).toContain("cancel");
});

it("warm: keeps the server after an LSP error response", async () => {
  const { instance, file, spawnLog } = await controller("error-hover");
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(instance.query("hover", file, position)).rejects.toThrow("content modified");
  expect(await launches(spawnLog)).toBe(1);
});

it("warm: lets a slow server finish starting after the request deadline", async () => {
  const { instance, file, spawnLog } = await controller("slow-init", true, true, {
    timeoutMs: 300,
  });
  await expect(instance.query("hover", file, position)).rejects.toThrow("still starting");
  await vi.waitFor(
    async () =>
      expect(await instance.query("hover", file, position)).toMatchObject({
        outcome: "completed",
      }),
    { timeout: 3000, interval: 100 },
  );
  expect(await launches(spawnLog)).toBe(1);
});

it.skipIf(process.platform === "win32")("rejects dispose when SIGKILL is refused", async () => {
  const { instance, file, spawnLog } = await controller("stubborn-server");
  await instance.query("hover", file, { line: 1, column: 7 });
  const pid = Number((await readFile(spawnLog, "utf8")).trim());
  const kill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (signal === "SIGKILL") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill(target, signal);
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
    process.kill(pid, "SIGKILL");
  });
  await expect(instance.dispose()).rejects.toThrow("LSP process group did not stop");
});

it.skipIf(process.platform === "win32")(
  "keeps an evicted failed instance visible until its group is killed",
  async () => {
    const { instance, file, spawnLog } = await controller("stubborn-garbage");
    await packages(join(file, ".."), 1);
    const root = join(file, "..", "package-0");
    const failed = join(root, "index.ts");
    await instance.query("diagnostics", failed);
    const group = -(await lastPid(spawnLog));
    const failing = instance.query("hover", failed, { line: 1, column: 7 }).catch(() => undefined);
    await vi.waitFor(() => expect(instance.status().instances[0]?.active).toBe(false));
    const kill = vi.spyOn(process, "kill");
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const evicting = instance.query("diagnostics", file);
    // controller.dispose() only reaches instances still in the map, so the evicted one must
    // stay listed until its escalation ends.
    while (!kill.mock.calls.some(([target, signal]) => target === group && signal === "SIGKILL")) {
      expect(instance.status().instances.map((listed) => listed.root)).toContain(root);
      await delay(10);
    }
    await evicting;
    await failing;
  },
);

// The first server's group looks gone and refuses SIGKILL, so its cleanup rejects at once
// while the other servers still run their two-second escalation.
function refuseFirstGroup(spawnLog: string) {
  const first = () => Number(readFileSync(spawnLog, "utf8").split("\n")[0]);
  const kill = process.kill.bind(process);
  const spy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target !== -first()) return kill(target, signal);
    if (signal === 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    if (signal === "SIGKILL") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill(target, signal);
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
    process.kill(first(), "SIGKILL");
  });
  return spy;
}

const lastPid = async (spawnLog: string) =>
  Number((await readFile(spawnLog, "utf8")).trim().split("\n").at(-1));

it.skipIf(process.platform === "win32")(
  "rejects dispose only after every other instance finishes its cleanup",
  async () => {
    const { instance, file, spawnLog } = await controller("stubborn-server");
    for (const path of await packages(join(file, ".."), 2))
      await instance.query("hover", path, { line: 1, column: 7 });
    const group = -(await lastPid(spawnLog));
    const kill = refuseFirstGroup(spawnLog);
    await expect(instance.dispose()).rejects.toThrow("LSP process group did not stop");
    expect(kill.mock.calls).toContainEqual([group, "SIGKILL"]);
  },
);

it.skipIf(process.platform === "win32")(
  "evicts failed instances only after every cleanup finishes",
  async () => {
    const { instance, file, spawnLog } = await controller("stubborn-garbage");
    const kill = refuseFirstGroup(spawnLog);
    const paths = await packages(join(file, ".."), 2);
    for (const path of paths) await instance.query("diagnostics", path);
    const group = -(await lastPid(spawnLog));
    const failing = paths.map((path) =>
      instance.query("hover", path, { line: 1, column: 7 }).catch(() => undefined),
    );
    await vi.waitFor(() =>
      expect(instance.status().instances.map((listed) => listed.active)).toEqual([false, false]),
    );
    await expect(instance.query("diagnostics", file)).rejects.toThrow(
      "LSP process group did not stop",
    );
    expect(kill.mock.calls).toContainEqual([group, "SIGKILL"]);
    await Promise.all(failing);
  },
);

it("shuts a healthy initialized server down with shutdown, then exit", async () => {
  const { instance, file, spawnLog } = await controller("handshake");
  await instance.query("hover", file, { line: 1, column: 7 });
  await instance.dispose();
  expect(await events(spawnLog)).toEqual(["shutdown", "exit"]);
});

it("returns soon after a healthy server exits", async () => {
  const { instance, file } = await controller("handshake");
  await instance.query("hover", file, { line: 1, column: 7 });
  const started = performance.now();
  await instance.dispose();
  expect(performance.now() - started).toBeLessThan(40);
});

it.skipIf(process.platform === "win32")(
  "returns soon after the last group member exits",
  async () => {
    const { instance, file } = await controller("lingering-child");
    await instance.query("hover", file, { line: 1, column: 7 });
    const started = performance.now();
    await instance.dispose();
    expect(performance.now() - started).toBeLessThan(40);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps probing every millisecond while the clock shows no elapsed wait",
  async () => {
    // Counts real probes before a real 30 ms exit, so the result depends on the scheduler; the
    // exact rule is pinned by dispose-probe.test.ts, and this keeps a check on real processes.
    const { instance, file, spawnLog } = await controller("slow-lingering-child");
    await instance.query("hover", file, { line: 1, column: 7 });
    const group = -(await lastPid(spawnLog));
    const kill = vi.spyOn(process, "kill");
    vi.spyOn(performance, "now").mockReturnValue(performance.now());
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    await instance.dispose();
    vi.restoreAllMocks();
    const probes = kill.mock.calls.filter(([target, signal]) => target === group && signal === 0);
    expect(probes.length).toBeGreaterThanOrEqual(15);
  },
);

it.each([
  ["sync-log", ["didOpen 1", "didChange 2", "didClose", "didOpen 3"]],
  ["sync-open-close", ["didOpen 1", "didClose", "didOpen 2", "didClose", "didOpen 3"]],
])("synchronizes a changed file and a different file (%s)", async (mode, expected) => {
  const { instance, file, spawnLog } = await controller(mode);
  const other = join(file, "..", "other.ts");
  await writeFile(other, "const other = 1;\n");
  await instance.query("diagnostics", file);
  await writeFile(file, "const value = 2;\n");
  // The observation must come from the new version, not from the first snapshot.
  expect(await instance.query("diagnostics", file)).toMatchObject({
    evidence: "revision_correlated",
    documentVersion: 2,
  });
  await instance.query("diagnostics", other);
  expect(await events(spawnLog)).toEqual(expected);
});

it("falls back to signals within the budget when shutdown gets no answer", async () => {
  const { instance, file, spawnLog } = await controller("mute-shutdown");
  await instance.query("hover", file, { line: 1, column: 7 });
  const started = performance.now();
  await instance.dispose();
  expect(performance.now() - started).toBeLessThan(2500);
  expect(await events(spawnLog)).toEqual(["shutdown"]);
});

it.skipIf(process.platform === "win32")(
  "accepts a SIGKILL refused by a group whose server is exiting",
  async () => {
    const { instance, file, spawnLog } = await controller("mute-shutdown");
    await instance.query("hover", file, { line: 1, column: 7 });
    const group = -(await lastPid(spawnLog));
    const kill = process.kill.bind(process);
    // macOS answers EPERM while the dying server is a zombie that Node has not reaped yet.
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === group && signal === "SIGKILL")
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return kill(target, signal);
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    await expect(instance.dispose()).resolves.toBeUndefined();
  },
);

it.skipIf(process.platform === "win32").each([
  ["resolves when a fresh probe finds the group gone", "ESRCH", "resolved"],
  ["rejects while the group still refuses", "EPERM", "LSP process group did not stop"],
])("after the server exits and SIGKILL is refused, %s", async (_case, refusal, expected) => {
  const { instance, file, spawnLog } = await controller("stubborn-grandchild");
  await instance.query("hover", file, { line: 1, column: 7 });
  const group = -(await lastPid(spawnLog));
  const kill = process.kill.bind(process);
  let killed = false;
  // The server leaves on SIGTERM; its grandchild ignores it until SIGKILL. macOS may answer EPERM
  // for a group whose last member is an unreaped zombie, so the real SIGKILL is delivered, the
  // system is given time to reap, and EPERM is reported.
  vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target !== group) return kill(target, signal);
    if (signal === "SIGKILL") {
      kill(target, signal);
      killed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    if (killed && refusal === "EPERM")
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill(target, signal);
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const outcome = await instance.dispose().then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : "rejected"),
  );
  expect(outcome).toBe(expected);
});

it.skipIf(process.platform === "win32")(
  "keeps one two-second budget for a server that ignores shutdown and SIGTERM",
  async () => {
    const { instance, file, spawnLog } = await controller("stubborn-mute");
    await instance.query("hover", file, { line: 1, column: 7 });
    const started = performance.now();
    await instance.dispose();
    expect(performance.now() - started).toBeLessThan(2500);
    expect(await events(spawnLog)).toEqual(["shutdown"]);
  },
);

it("does not send shutdown to a server that never finished initializing", async () => {
  const { instance, file, spawnLog } = await controller("wrong-encoding");
  await expect(instance.query("hover", file, { line: 1, column: 7 })).rejects.toThrow(
    "Unsupported LSP position encoding",
  );
  await instance.dispose();
  expect(await events(spawnLog)).toEqual([]);
});

it("sends nothing but exit after shutdown when a pending request is aborted", async () => {
  const cwd = await directory();
  const spawnLog = join(cwd, "spawns.log");
  const client = new LanguageServer(
    { command: process.execPath, args: [fixture, "slow-shutdown", spawnLog] },
    cwd,
    5000,
    () => {},
  );
  onTestFinished(() => client.dispose());
  await client.initialize();
  const abort = new AbortController();
  const outcome = client.request("textDocument/hover", {}, abort.signal).then(
    () => "resolved",
    (error: unknown) => error,
  );
  const disposing = client.dispose();
  // The fixture answers shutdown after 500 ms; the abort lands inside that window.
  await vi.waitFor(async () => expect(await events(spawnLog)).toContain("shutdown"));
  abort.abort(new Error("Caller cancelled"));
  await disposing;
  expect(await outcome).toHaveProperty("message", "Caller cancelled");
  expect(await events(spawnLog)).toEqual(["shutdown", "exit"]);
});

it.skipIf(process.platform === "win32")(
  "prints no source text for an in-cwd symlink that points outside the cwd",
  async () => {
    const { instance, file } = await controller("special-targets");
    const root = join(file, "..");
    const outside = join(await directory(), "secret.ts");
    await writeFile(outside, "const secret = 1;\n");
    await symlink(outside, join(root, "link.ts"));
    await writeFile(join(root, "pipe.ts"), "const pipe = 1;\n");
    expect(await instance.query("definition", file, position)).toMatchObject({
      outcome: "completed",
      text: "link.ts:1:1\npipe.ts:1:1  const pipe = 1;",
    });
  },
);

it.skipIf(process.platform === "win32")(
  "does not read a FIFO target, so the definition completes before its deadline",
  async () => {
    const { instance, file } = await controller("special-targets", true, true, {
      timeoutMs: 2000,
    });
    const root = join(file, "..");
    await writeFile(join(root, "link.ts"), "const link = 1;\n");
    execFileSync("mkfifo", [join(root, "pipe.ts")]);
    const started = performance.now();
    expect(await instance.query("definition", file, position)).toMatchObject({
      outcome: "completed",
      text: "link.ts:1:1  const link = 1;\npipe.ts:1:1",
    });
    expect(performance.now() - started).toBeLessThan(1500);
  },
);

it("prevents use after disposal", async () => {
  const { instance, file } = await controller();
  await instance.dispose();
  const result = await instance.query("hover", file, { line: 1, column: 7 });
  expect(result).toMatchObject({ outcome: "unavailable" });
  expect(result).toHaveProperty("reason", expect.stringContaining("closed"));
});
