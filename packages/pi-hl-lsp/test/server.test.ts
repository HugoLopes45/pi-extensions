import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished, vi } from "vitest";

import { LanguageServer } from "../src/server.js";
import { directory } from "./fixtures.js";

async function server(
  mode = "normal",
  timeout = 1000,
  publish: (value: unknown) => void = () => {},
  onClose: (error: Error) => void = () => {},
) {
  const root = await directory();
  const ready = Promise.withResolvers<void>();
  let readyReceived = false;
  const client = new LanguageServer(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("./protocol-server.ts", import.meta.url)), mode, "--ready"],
    },
    root,
    timeout,
    (value) => {
      if (readyReceived) publish(value);
      else {
        readyReceived = true;
        ready.resolve();
      }
    },
    (error) => {
      ready.reject(error);
      onClose(error);
    },
  );
  onTestFinished(() =>
    client.dispose().catch((error: unknown) => {
      // A test that makes SIGKILL fail has already asserted this rejection.
      if (!(error instanceof Error && error.message === "LSP process group did not stop"))
        throw error;
    }),
  );
  await ready.promise;
  return client;
}

it("closes an idle instance when publication validation fails", async () => {
  const closed = Promise.withResolvers<Error>();
  const client = await server(
    "normal",
    1000,
    () => {
      throw new Error("Invalid publication");
    },
    closed.resolve,
  );
  await client.initialize();
  await client.notify("test/fail", {});
  const result = await Promise.race([
    closed.promise.then((error) => error.message),
    delay(300, "not closed"),
  ]);
  expect(result).toBe("Invalid publication");
  await client.dispose();
});

it("closes an idle instance when a progress notification is invalid", async () => {
  const closed = Promise.withResolvers<Error>();
  const client = await server("normal", 1000, () => {}, closed.resolve);
  await client.initialize();
  await client.notify("test/invalid-progress", {});
  const result = await Promise.race([
    closed.promise.then((error) => error.message),
    delay(300, "not closed"),
  ]);
  expect(result).toBe("Invalid progress notification");
  await client.dispose();
});

it("initializes and returns a real framed RPC response", async () => {
  const client = await server();
  expect(await client.initialize()).toMatchObject({
    capabilities: { hoverProvider: true },
  });
  expect(await client.request("textDocument/hover", {})).toMatchObject({
    contents: { value: "const value: number" },
  });
});

it("rejects an unnegotiated position encoding", async () => {
  const client = await server("wrong-encoding");
  await expect(client.initialize()).rejects.toThrow(/encoding/iu);
});

it("answers workspace/applyEdit without applying the edit", async () => {
  const client = await server("effects");
  await client.initialize();
  expect(await client.request("textDocument/hover", {})).toEqual({
    reply: {
      applied: false,
      failureReason: "client applies edits only through its tools",
    },
  });
});

it("answers each standard server request with its LSP 3.17 reply", async () => {
  const published = Promise.withResolvers<unknown>();
  const client = await server("normal", 1000, published.resolve);
  await client.initialize();
  await client.notify("test/server-requests", {});
  const value = await published.promise;
  // The folder entry is checked by its uri and name below.
  expect(value).toMatchObject({
    uri: "file:///server-requests",
    diagnostics: [],
    replies: {
      "window/workDoneProgress/create": null,
      "client/registerCapability": null,
      "client/unregisterCapability": null,
      "workspace/configuration": [null, null],
      "workspace/workspaceFolders": [{}],
      "workspace/applyEdit": {
        applied: false,
        failureReason: "client applies edits only through its tools",
      },
      "window/showMessageRequest": null,
      "window/showDocument": { success: false },
      "workspace/semanticTokens/refresh": null,
      "workspace/inlayHint/refresh": null,
      "workspace/inlineValue/refresh": null,
      "workspace/codeLens/refresh": null,
      "workspace/diagnostic/refresh": null,
      "test/unknown": { error: -32601 },
    },
  });
  expect(value).toHaveProperty(
    ["replies", "workspace/workspaceFolders", 0, "uri"],
    expect.stringMatching(/\/hl-lsp-fixture-/u),
  );
  expect(value).toHaveProperty(
    ["replies", "workspace/workspaceFolders", 0, "name"],
    expect.stringMatching(/^hl-lsp-fixture-/u),
  );
});

it("settles ignored requests at the total deadline", async () => {
  const client = await server("ignore", 1000);
  await client.initialize();
  await expect(client.request("textDocument/hover", {})).rejects.toThrow(/timeout|deadline/iu);
});

async function hoverWithin(mode: string, ms = 1000) {
  const client = await server(mode, 5000);
  await client.initialize();
  return Promise.race([
    client.request("textDocument/hover", {}).then(
      () => "completed",
      (error: unknown) => (error instanceof Error ? error.message : "rejected"),
    ),
    delay(ms, "still waiting"),
  ]);
}

it("fails a pending request on an invalid frame instead of waiting for the deadline", async () => {
  expect(await hoverWithin("invalid-frame")).toMatch(/JSON/u);
});

it("rejects a frame whose Content-Length the reader would read differently", async () => {
  expect(await hoverWithin("double-length")).toMatch(/Content-Length/u);
});

it.each(["mixed-case-length", "cr-cr", "hex-length"])(
  "rejects a frame header the reader would split differently (%s)",
  async (mode) => {
    expect(await hoverWithin(mode)).toMatch(/^LSP frame/u);
  },
);

it("accepts a frame header the reader accepts", async () => {
  expect(await hoverWithin("tab-length")).toBe("completed");
});

it("keeps a server whose total output exceeds 8 MiB across many messages", async () => {
  const client = await server("chatty", 5000);
  await client.initialize();
  for (let index = 0; index < 10; index += 1)
    await expect(client.request("textDocument/hover", {})).resolves.toBeDefined();
  expect(client.active).toBe(true);
});

it("fails on a header that never ends", async () => {
  expect(await hoverWithin("endless-header", 4000)).toMatch(/wire budget/iu);
});

it("fails when a burst of small frames exceeds 8 MiB awaiting decode", async () => {
  expect(await hoverWithin("burst", 4000)).toMatch(/wire budget/iu);
});

it.skipIf(process.platform === "win32").each([
  ["grandchild", 1000, ["SIGTERM"]],
  ["stubborn-grandchild", 2500, ["SIGTERM", "SIGKILL"]],
])(
  "signals the server's process group before dispose resolves (%s)",
  async (mode, limit, signals) => {
    const client = await server(mode, 5000);
    await client.initialize();
    const reply = await client.request("textDocument/hover", {});
    if (!(typeof reply === "object" && reply !== null && "group" in reply))
      throw new Error("Fixture did not report its process group");
    const { group } = reply;
    const kill = vi.spyOn(process, "kill");
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const started = performance.now();
    await client.dispose();
    expect(performance.now() - started).toBeLessThan(limit);
    const sent = kill.mock.calls
      .filter(
        ([target], index) =>
          target === -Number(group) && kill.mock.results[index]?.type === "return",
      )
      .map(([, signal]) => signal);
    for (const signal of signals) expect(sent).toContain(signal);
  },
);

it.skipIf(process.platform === "win32")(
  "escalates on time when the wall clock moves back",
  async () => {
    const client = await server("stubborn-grandchild", 5000);
    await client.initialize();
    await client.request("textDocument/hover", {});
    const closing = client.dispose();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 60_000);
    const outcome = await Promise.race([closing.then(() => "disposed"), delay(2500, "waiting")]);
    vi.restoreAllMocks();
    await closing;
    expect(outcome).toBe("disposed");
  },
);

it.skipIf(process.platform === "win32")(
  "leaves no unhandled rejection when a failed server refuses SIGKILL",
  async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    const client = await server("stubborn-server", 5000, () => {
      throw new Error("Publication rejected");
    });
    await client.initialize();
    const reply = await client.request("textDocument/hover", {});
    if (!(typeof reply === "object" && reply !== null && "pid" in reply))
      throw new Error("Fixture did not report its pid");
    const { pid } = reply;
    if (typeof pid !== "number") throw new Error("Fixture pid is not a number");
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (signal === "SIGKILL") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return kill(target, signal);
    });
    onTestFinished(() => {
      process.off("unhandledRejection", record);
      vi.restoreAllMocks();
      process.kill(pid, "SIGKILL");
    });
    await client.notify("test/fail", {});
    await delay(2600);
    expect(client.active).toBe(false);
    expect(unhandled).toEqual([]);
  },
);

it("decodes frames split into single bytes", async () => {
  const client = await server("fragmented", 5000);
  await client.initialize();
  await expect(client.request("textDocument/hover", {})).resolves.toMatchObject({
    contents: { value: "const value: number" },
  });
});

it("propagates cancellation without leaving a live request", async () => {
  const client = await server("ignore");
  await client.initialize();
  const abort = new AbortController();
  const result = client.request("textDocument/hover", {}, abort.signal);
  abort.abort(new Error("Caller cancelled"));
  await expect(result).rejects.toThrow("Caller cancelled");
  expect(client.active).toBe(true);
});

it("gives initialization its own budget, longer than the request timeout", async () => {
  const client = await server("slow-init", 300);
  await expect(client.initialize()).resolves.toMatchObject({
    capabilities: { hoverProvider: true },
  });
});

it("bounds notification writes when the server stops reading", async () => {
  const client = await server("backpressure");
  await client.initialize();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      client.notify("large", { text: "x".repeat(4 * 1024 * 1024) }).then(
        () => "sent",
        () => "rejected",
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("not bounded"), 1500);
      }),
    ]);
    expect(outcome).toBe("rejected");
  } finally {
    clearTimeout(timer);
  }
});

it("rejects oversized input before decoding its JSON payload", async () => {
  const client = await server("oversized");
  await expect(client.initialize()).rejects.toThrow(/wire budget/iu);
});

it("treats a dynamically registered pull method as pull support", async () => {
  const client = await server("pull-dynamic");
  await client.initialize();
  await vi.waitFor(() => expect(client.pullDiagnostics).toBe(true));
});

it("reports no pull support when the server offers none", async () => {
  const client = await server();
  await client.initialize();
  expect(client.pullDiagnostics).toBe(false);
});

it("drops pull support after the server unregisters the method", async () => {
  const client = await server("pull-unregistered");
  await client.initialize();
  await vi.waitFor(() => expect(client.pullDiagnostics).toBe(true));
  await client.notify("test/unregister", {});
  await vi.waitFor(() => expect(client.pullDiagnostics).toBe(false));
});

it("answers a server refresh request and keeps the instance up", async () => {
  const closed = Promise.withResolvers<Error>();
  const answered = Promise.withResolvers<void>();
  const client = await server("diagnostic-refresh", 1000, () => answered.resolve(), closed.resolve);
  await client.initialize();
  expect(
    await Promise.race([
      answered.promise.then(() => "answered"),
      closed.promise.then((error) => error.message),
      delay(1000, "no answer"),
    ]),
  ).toBe("answered");
});

it("fails the instance on an invalid capability registration", async () => {
  const closed = Promise.withResolvers<Error>();
  const client = await server("bad-registration", 1000, () => {}, closed.resolve);
  await client.initialize();
  expect(await closed.promise).toHaveProperty(
    "message",
    "Invalid client/registerCapability payload",
  );
});
