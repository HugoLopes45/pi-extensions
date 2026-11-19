import type * as timersPromises from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished, vi } from "vitest";

import { LanguageServer } from "../src/server.js";

// Records each probe delay and returns at once, so the doubling rule is observed exactly.
const timers = vi.hoisted(() => ({ waits: [] as unknown[] }));
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof timersPromises>()),
  setTimeout: async (wait: unknown, value: unknown) => {
    timers.waits.push(wait);
    return value;
  },
}));

it.skipIf(process.platform === "win32")(
  "does not double the probe delay while the clock shows no elapsed wait",
  async () => {
    const client = new LanguageServer(
      {
        command: process.execPath,
        args: [fileURLToPath(new URL("./protocol-server.ts", import.meta.url)), "normal"],
      },
      process.cwd(),
      5000,
      () => {},
    );
    const kill = process.kill.bind(process);
    let probes = 0;
    // The group answers the first five probes, is gone at the sixth, and so refuses SIGKILL with
    // ESRCH; the real SIGTERM still stops the fixture.
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target >= 0 || signal === "SIGTERM") return kill(target, signal);
      if (signal === 0) probes += 1;
      if (signal === 0 && probes < 6) return true;
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    vi.spyOn(performance, "now").mockReturnValue(performance.now());
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    await client.dispose();
    expect(probes).toBe(6);
    expect(timers.waits).toEqual([1, 1, 1, 1, 1]);
  },
);
