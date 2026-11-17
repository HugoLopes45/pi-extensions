import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished } from "vitest";

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
  onTestFinished(() => client.dispose());
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

it("rejects unsolicited server writes through the native RPC default", async () => {
  const client = await server("effects");
  await client.initialize();
  expect(await client.request("textDocument/hover", {})).toEqual({
    rejected: -32601,
  });
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
  ["grandchild", 200],
  ["stubborn-grandchild", 2500],
])("stops the server's descendants when it is disposed (%s)", async (mode, wait) => {
  const client = await server(mode, 5000);
  await client.initialize();
  const reply = await client.request("textDocument/hover", {});
  if (!(typeof reply === "object" && reply !== null && "pid" in reply))
    throw new Error("Fixture did not report its child pid");
  const { pid } = reply;
  if (typeof pid !== "number") throw new Error("Fixture child pid is not a number");
  await client.dispose();
  await delay(wait);
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

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
