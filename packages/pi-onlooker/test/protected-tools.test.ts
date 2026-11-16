import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentText } from "@earendil-works/pi-ai";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { createProtectedReadTools } from "../src/protected-tools.js";
import { createSdkHarness, reply, toolCall } from "./fixtures/sdk-harness.js";

let base: string;
let root: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "onlooker-protected-")));
  root = join(base, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(base, "outside"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const needle = 1;\n");
  await writeFile(join(root, ".env"), "NEEDLE_KEY=SECRET-ENV\n");
  await writeFile(join(root, ".env.example"), "NEEDLE_KEY=\n");
  await writeFile(join(root, "config", "credentials.json"), '{"needle":"SECRET-CRED"}\n');
  await writeFile(join(root, "deploy.pem"), "needle SECRET-PEM\n");
  await writeFile(join(root, "src", "token.ts"), "export const tokenize = 1;\n");
  await writeFile(join(root, "config", "secrets.yaml"), "needle: SECRET-YAML\n");
  // Its own directory: on a case-insensitive file system `.ENV` would replace `.env`.
  await mkdir(join(root, "upper", ".GIT"), { recursive: true });
  await writeFile(join(root, "upper", ".ENV"), "needle SECRET-UPPER-ENV\n");
  await writeFile(join(root, "upper", "ID_RSA"), "needle SECRET-UPPER-KEY\n");
  await writeFile(join(root, "upper", ".GIT", "config"), "needle SECRET-UPPER-GIT\n");
  await writeFile(join(root, "..notes"), "dotted name\n");
  await symlink(root, join(base, "project-link"));
  await writeFile(join(base, "outside", "leak.ts"), "needle SECRET-OUTSIDE\n");
  await symlink(join(base, "outside", "leak.ts"), join(root, "src", "link.ts"));
  await symlink(join(base, "outside"), join(root, "linked-dir"));
});
afterAll(() => rm(base, { recursive: true, force: true }));

/** One scripted model call of `name` through a real session; resolves to its result text. */
async function run(
  name: string,
  args: Parameters<typeof toolCall>[1],
  toolRoot = root,
  observedJournal?: string,
): Promise<string> {
  const h = await createSdkHarness([
    (pi) => {
      for (const tool of createProtectedReadTools(toolRoot, () => observedJournal))
        pi.registerTool(tool);
    },
  ]);
  h.responses.push(toolCall(name, args), reply("done"));
  await h.session.prompt("go");
  const result = h.session.messages.find((message) => message.role === "toolResult");
  if (!result || result.role !== "toolResult") throw new Error(`no result from ${name}`);
  const text = contentText(result.content);
  if (result.isError) throw new Error(text);
  return text;
}

describe("protected read tools", () => {
  it("expose exactly read, grep, find and ls", () => {
    expect(
      createProtectedReadTools(root)
        .map((tool) => tool.name)
        .toSorted(),
    ).toEqual(["find", "grep", "ls", "read"]);
  });

  it("read a project file", async () => {
    expect(await run("read", { path: "src/a.ts" })).toContain("export const needle");
  });

  it.each([
    [".env"],
    ["config/credentials.json"],
    ["config/secrets.yaml"],
    ["deploy.pem"],
    ["src/link.ts"],
    ["linked-dir/leak.ts"],
    ["../outside/leak.ts"],
    ["upper/.ENV"],
    ["upper/ID_RSA"],
    ["upper/.GIT/config"],
  ])("refuse to read %s", async (path) => {
    await expect(run("read", { path })).rejects.toThrow(/Onlooker cannot read/);
  });

  it.each(["id_ecdsa", "id_dsa", "id_ecdsa_sk", "id_ed25519_sk", "AuthKey_test.p8", "key.ppk"])(
    "refuses private key %s",
    async (name) => {
      const path = `config/${name}`;
      await writeFile(join(root, path), "needle SYNTHETIC-PRIVATE-KEY");
      await expect(run("read", { path })).rejects.toThrow(/Onlooker cannot read/);
      await expect(run("grep", { pattern: "needle", path })).rejects.toThrow(
        /Onlooker cannot read/,
      );
    },
  );

  it("refuses a Unicode-space path whose SDK spelling points outside the project", async () => {
    await writeFile(join(root, "safe\u00a0name.ts"), "safe decoy");
    await symlink(join(base, "outside", "leak.ts"), join(root, "safe name.ts"));
    await expect(run("read", { path: "safe\u00a0name.ts" })).rejects.toThrow(
      /Onlooker cannot read/,
    );
  });

  it.each(["grep", "find", "ls"])("%s refuses Unicode-space directory collisions", async (name) => {
    const path = `${name}\u00a0dir`;
    await mkdir(join(root, path));
    await symlink(join(base, "outside"), join(root, `${name} dir`));
    await expect(run(name, { path, pattern: "needle" })).rejects.toThrow(/Onlooker cannot read/);
  });

  it("read source code named like a secret", async () => {
    expect(await run("read", { path: "src/token.ts" })).toContain("tokenize");
  });

  it("read a file whose name starts with two dots", async () => {
    expect(await run("read", { path: "..notes" })).toContain("dotted name");
  });

  it("read through a root path that is a symlink", async () => {
    expect(await run("read", { path: "src/a.ts" }, join(base, "project-link"))).toContain(
      "export const needle",
    );
  });

  it("refuses the observed journal even inside the project", async () => {
    const session = join(root, "session.jsonl");
    await writeFile(
      session,
      '{"role":"bashExecution","excludeFromContext":true,"output":"SYNTHETIC-EXCLUDED"}\n',
    );
    await expect(run("read", { path: session }, root, session)).rejects.toThrow(
      /Onlooker cannot read/,
    );
    const alias = join(root, "session-alias.jsonl");
    await symlink(session, alias);
    await expect(run("read", { path: alias }, root, session)).rejects.toThrow(
      /Onlooker cannot read/,
    );
    await expect(run("grep", { path: alias, pattern: "SYNTHETIC" }, root, session)).rejects.toThrow(
      /Onlooker cannot read/,
    );
    expect(await run("grep", { pattern: "SYNTHETIC-EXCLUDED" }, root, session)).not.toContain(
      "SYNTHETIC-EXCLUDED",
    );
  });

  it.each(["read", "grep"])("%s refuses journal aliases and out-of-root journals", async (name) => {
    const session = join(base, "outside", `session-${name}.jsonl`);
    const alias = join(root, `journal-${name}.jsonl`);
    await writeFile(session, "needle SYNTHETIC-EXCLUDED");
    await symlink(session, alias);
    for (const path of [session, alias])
      await expect(
        run(name, name === "read" ? { path } : { path, pattern: "needle" }, root, session),
      ).rejects.toThrow(/Onlooker cannot read/);
    expect(await run("grep", { path: ".", pattern: "needle" }, root, session)).not.toContain(
      "SYNTHETIC-EXCLUDED",
    );
  });

  it("read project files while the observed journal does not exist yet", async () => {
    expect(
      await run("read", { path: "src/a.ts" }, root, join(base, "outside", "missing.jsonl")),
    ).toContain("export const needle");
  });

  it("allow example env files", async () => {
    expect(await run("read", { path: ".env.example" })).toContain("NEEDLE_KEY=");
  });

  it("grep never returns lines from denied or out-of-root files", async () => {
    const output = await run("grep", {
      pattern: "(?i)needle",
      ignoreCase: true,
    });
    expect(output).toContain("src/a.ts");
    expect(output).not.toMatch(/SECRET/);
    expect(output).not.toMatch(/^\.env:/m);
  });

  it.each([
    ["first\rsecond\nneedle\n", "text.txt:2: needle"],
    ["needle\rtail\n", "text.txt:1: needle\rtail"],
  ])("preserves ripgrep line semantics for %j", async (content, expected) => {
    const isolated = await mkdtemp(join(base, "line-semantics-"));
    await writeFile(join(isolated, "text.txt"), content);
    expect(await run("grep", { pattern: "needle" }, isolated)).toContain(expected);
  });

  it("verifies a match after a long nonmatching line and preserves truncated matches", async () => {
    const isolated = await mkdtemp(join(base, "long-lines-"));
    await writeFile(
      join(isolated, "text.txt"),
      `${"a".repeat(2_000_000)}\nneedle\nneedle ${"b".repeat(1_000)}`,
    );
    const output = await run("grep", { pattern: "needle" }, isolated);
    expect(output).toContain("text.txt:2: needle");
    expect(output).toContain(`text.txt:3: needle ${"b".repeat(493)}... [truncated]`);
  });

  it("does not attribute denied content to an allowed file through a newline filename", async () => {
    const isolated = join(base, "ambiguous");
    await mkdir(join(isolated, "src"), { recursive: true });
    await mkdir(join(isolated, ".ssh", "prefix\nsrc"), { recursive: true });
    await writeFile(join(isolated, "src", "a.ts"), "safe");
    await writeFile(join(isolated, ".ssh", "prefix\nsrc", "a.ts"), "needle SYNTHETIC-HIDDEN");
    expect(await run("grep", { pattern: "needle" }, isolated)).not.toContain("SYNTHETIC-HIDDEN");
  });

  it("grep refuses a denied search path", async () => {
    await expect(run("grep", { pattern: "needle", path: ".env" })).rejects.toThrow(
      /Onlooker cannot read/,
    );
  });

  it("find hides denied and out-of-root files", async () => {
    const output = await run("find", { pattern: "**/*" });
    expect(output).toContain("src/a.ts");
    expect(output).not.toMatch(/credentials\.json|deploy\.pem|leak\.ts|^\.env$|^upper\/./m);
  });

  it("ls hides denied entries", async () => {
    const output = await run("ls", { path: "." });
    expect(output).toContain("src/");
    expect(output).toContain(".env.example");
    expect(output).not.toMatch(/^\.env$|deploy\.pem/m);
  });

  it("ls refuses a directory outside the project", async () => {
    await expect(run("ls", { path: "linked-dir" })).rejects.toThrow(/Onlooker cannot read/);
  });
});
