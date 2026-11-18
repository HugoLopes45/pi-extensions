import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { presetFor } from "../src/presets.js";
import { setupSpec } from "../src/setup-menu.js";
import { checkServer, findOffers, setupChanges, type Offer } from "../src/setup.js";
import { directory } from "./fixtures.js";

const protocolServer = fileURLToPath(new URL("./protocol-server.ts", import.meta.url));

async function executable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
}

it("offers each detected language that is not known, with its server or install hint", async () => {
  const root = await directory();
  const bin = await directory();
  await writeFile(join(root, "Cargo.toml"), "[package]\n");
  await mkdir(join(root, "tools"));
  await writeFile(join(root, "tools", "requirements.txt"), "");
  await mkdir(join(root, "ios", "App.xcodeproj"), { recursive: true });
  await executable(join(bin, "rust-analyzer"));
  const offers = await findOffers(root, new Set(["python"]), bin);
  expect(offers).toEqual([
    {
      language: "rust",
      root,
      server: { command: join(bin, "rust-analyzer"), args: [] },
      install: "rustup component add rust-analyzer",
      fileTypes: [".rs"],
    },
    {
      language: "swift",
      root: join(root, "ios"),
      server: undefined,
      install: presetFor("swift")?.discovery?.install,
      fileTypes: [".swift"],
    },
  ]);
});

it("reports a server that completes the handshake as ready and a failing one by its error", async () => {
  const root = await directory();
  const ready = { command: process.execPath, args: [protocolServer, "normal"] };
  expect(await checkServer(ready, root, 5000)).toBeUndefined();
  const failing = {
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
  };
  expect(await checkServer(failing, root, 5000)).toMatch(/\S/u);
});

it("stops a server whose handshake times out", async () => {
  const root = await directory();
  const pidFile = join(root, "pid");
  const hang = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const error = await checkServer({ command: process.execPath, args: ["-e", hang] }, root, 300);
  expect(error).toMatch(/\S/u);
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow("ESRCH");
});

const rust: Offer = {
  language: "rust",
  root: "/p",
  server: { command: "/bin/rust-analyzer", args: [] },
  install: "rustup component add rust-analyzer",
  fileTypes: [".rs"],
};
const python: Offer = {
  language: "python",
  root: "/p",
  server: { command: "/bin/pyright-langserver", args: ["--stdio"] },
  install: "pipx install basedpyright",
  fileTypes: [".py"],
};

it("adds enabled servers to the global ones, turns LSP on and remembers skipped languages", () => {
  const typescript = { command: "/bin/tsls", args: ["--stdio"] };
  const changes = setupChanges(
    { servers: { typescript }, ignoredLanguages: ["go"] },
    [rust],
    ["swift"],
    true,
  );
  expect(changes).toEqual([
    {
      action: "set",
      key: "servers",
      patch: {
        servers: {
          typescript,
          rust: { command: "/bin/rust-analyzer", args: [] },
        },
      },
    },
    { action: "set", key: "enabled", patch: { enabled: true } },
    {
      action: "set",
      key: "allowProjectExecution",
      patch: { allowProjectExecution: true },
    },
    {
      action: "set",
      key: "ignoredLanguages",
      patch: { ignoredLanguages: ["go", "swift"] },
    },
  ]);
  expect(setupChanges({}, [], ["swift"], false)).toEqual([
    {
      action: "set",
      key: "ignoredLanguages",
      patch: { ignoredLanguages: ["swift"] },
    },
  ]);
});

function action(spec: ReturnType<typeof setupSpec>) {
  const row = spec.rows(spec.read(), "session").find((item) => item.kind === "action");
  if (row?.kind !== "action") throw new Error("no action row");
  return row;
}

it("lists found servers as enabled, missing ones in the headline, and consent as no", () => {
  const swift: Offer = {
    ...rust,
    language: "swift",
    server: undefined,
    install: "install Xcode",
  };
  const spec = setupSpec([rust, swift], true, async () => new Map());
  const view = spec.read();
  expect(view.headline.join("\n")).toContain("swift: not installed. Install: install Xcode");
  expect(spec.rows(view, "session")).toMatchObject([
    { kind: "cycle", id: "rust", own: "enable", values: ["enable", "skip"] },
    { kind: "cycle", id: "consent", own: "no", values: ["no", "yes"] },
    { kind: "action", id: "apply", value: "1 server" },
  ]);
});

it("refuses to enable before consent, then enables only the chosen servers", async () => {
  const chosen: Offer[][] = [];
  const spec = setupSpec([rust, python], true, async (offers) => {
    chosen.push(offers);
    return new Map([
      ["rust", undefined],
      ["python", "exited with status 1"],
    ]);
  });
  await expect(action(spec).run()).rejects.toThrow("run project code");
  await spec.apply("session", { id: "consent", value: "yes" });
  await spec.apply("session", { id: "python", value: "skip" });
  await spec.apply("session", { id: "python", value: "enable" });
  await action(spec).run();
  expect(chosen).toEqual([[rust, python]]);
  const headline = spec.read().headline.join("\n");
  expect(headline).toContain("rust: ready");
  expect(headline).toContain("python: failed: exited with status 1 (not saved)");
  expect(spec.rows(spec.read(), "session")).toEqual([]);
});

it("enables once when the action is chosen again while servers start", async () => {
  let calls = 0;
  const spec = setupSpec([rust], false, async () => {
    calls++;
    return new Map([["rust", undefined]]);
  });
  await Promise.all([action(spec).run(), action(spec).run()]);
  expect(calls).toBe(1);
});

it("needs no consent when every found server is skipped", async () => {
  const chosen: Offer[][] = [];
  const spec = setupSpec([rust], true, async (offers) => {
    chosen.push(offers);
    return new Map();
  });
  await spec.apply("session", { id: "rust", value: "skip" });
  await action(spec).run();
  expect(chosen).toEqual([[]]);
});

it("shows only install guidance when no detected server is installed", () => {
  const swift: Offer = {
    ...rust,
    language: "swift",
    server: undefined,
    install: "install Xcode",
  };
  const spec = setupSpec([swift], true, async () => new Map());
  expect(spec.read().headline.join("\n")).toContain("swift: not installed");
  expect(spec.rows(spec.read(), "session")).toEqual([]);
});

it("needs no consent row when project execution is already allowed", async () => {
  const chosen: Offer[][] = [];
  const spec = setupSpec([rust], false, async (offers) => {
    chosen.push(offers);
    return new Map([["rust", undefined]]);
  });
  expect(spec.rows(spec.read(), "session").map((row) => row.kind)).toEqual(["cycle", "action"]);
  await action(spec).run();
  expect(chosen).toEqual([[rust]]);
});
