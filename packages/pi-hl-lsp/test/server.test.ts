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
