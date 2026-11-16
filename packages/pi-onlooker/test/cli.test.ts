import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vite-plus/test";

import { arrayContaining, objectContaining } from "./fixtures/matchers.js";

const execute = promisify(execFile);
const cli = fileURLToPath(
  new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const onlooker = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/cli-extension.ts", import.meta.url));

// One run per axis value: each of CodeMode and OAuth is on in one case and off in the other.
it.each([
  [false, true],
  [true, false],
])(
  "settles Onlooker reviews through the bundled CLI before and after reload (CodeMode: %s, OAuth: %s)",
  async (withCodeMode, withOAuth) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-onlooker-cli-"));
    const agentDir = join(dir, "agent");
    try {
      await mkdir(agentDir);
      await writeFile(
        join(agentDir, "auth.json"),
        JSON.stringify({
          [withOAuth ? "onlooker-cli-fixture" : "unused-offline-oauth"]: {
            type: "oauth",
            access: "offline-access",
            refresh: "offline-refresh",
            expires: withOAuth ? 0 : 4102444800000,
          },
        }),
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({
          defaultTools: [withCodeMode ? "+codemode" : "-codemode"],
          codemode: { mode: withCodeMode ? "only" : "on" },
          extensions: ["-builtin:tool-search"],
        }),
      );
      const completed = execute(
        process.execPath,
        [
          cli,
          "--offline",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "-e",
          fixture,
          "-e",
          onlooker,
          "--provider",
          "onlooker-cli-fixture",
          "--model",
          "model",
          "--no-session",
          "--print",
          "/onlooker on",
          "Complete the first offline task",
          "Ask Onlooker which path to inspect",
          "/onlooker status",
          "/onlooker-cli-probe",
          "/onlooker-cli-reload",
          "Complete the second offline task",
          "/onlooker status",
          "/onlooker-cli-probe",
        ],
        {
          cwd: dir,
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
          timeout: 20000,
        },
      );
      completed.child.stdin?.end();
      const { stdout, stderr } = await completed;
      const output = stdout + stderr;
      const probes = [...output.matchAll(/^ONLOOKER_CLI_PROBE=(.+)$/gm)].map((match): unknown =>
        JSON.parse(match[1] ?? "null"),
      );
      expect(probes).toHaveLength(2);
      for (const probe of probes) {
        expect(probe).toMatchObject({
          status: { state: "armed", error: null, backlog: 0, settings: { enabled: true } },
          activeTools: arrayContaining(["read", "onlooker_ask"]),
        });
        expect(record(probe).activeTools).toSatisfy(
          (tools) => Array.isArray(tools) && tools.includes("codemode") === withCodeMode,
        );
      }
      const resources = [...output.matchAll(/^ONLOOKER_CLI_RESOURCES=(.+)$/gm)].map(
        (match): unknown => JSON.parse(match[1] ?? "null"),
      );
      // The Onlooker Session loads no extension, so only the observed session reports resources.
      expect(resources.map((resource) => record(resource).privateRole)).toEqual([false, false]);
      expect(output.match(/^ONLOOKER_CLI_CONSULTATION=Inspect the native path\.$/gm)).toHaveLength(
        1,
      );
      // A direct `onlooker_ask` turn is read-only and joins the next Review; through codemode it
      // is a script call with its own Review.
      const reviewInferences = withCodeMode ? 4 : 3;
      expect(output.match(/^ONLOOKER_CLI_INFERENCE=review$/gm)).toHaveLength(reviewInferences);
      expect(output.match(/^ONLOOKER_CLI_INFERENCE=consultation$/gm)).toHaveLength(1);
      expect(output.match(/^ONLOOKER_CLI_INFERENCE=observed$/gm)).toHaveLength(4);
      expect(
        output.match(new RegExp(`^ONLOOKER_CLI_AUTH=${withOAuth ? "oauth" : "api-key"}$`, "gm")),
      ).toHaveLength(5 + reviewInferences);
      expect(output.match(/^ONLOOKER_CLI_REFRESH$/gm) ?? []).toHaveLength(withOAuth ? 1 : 0);
      const refreshed = objectContaining({
        type: "oauth",
        access: "refreshed-offline-access",
        refresh: "offline-refresh",
        expires: 4102444800000,
      });
      // Both variants write auth.json; only the OAuth one stores this provider's credential.
      const auth = record(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")));
      expect(auth["onlooker-cli-fixture"]).toEqual(withOAuth ? refreshed : undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30000,
);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected a JSON object, got ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
}
