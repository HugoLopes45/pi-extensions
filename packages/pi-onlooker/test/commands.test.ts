import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import onlooker from "../src/index.js";
import { anyInstance, stringContaining, stringMatching } from "./fixtures/matchers.js";
import { createSdkHarness, reply } from "./fixtures/sdk-harness.js";

describe("Onlooker commands through the native SDK", () => {
  it("offers and accepts only enabled, name, model, thinkingLevel, reviewEvery and correct", async () => {
    const { session, manager } = await createSdkHarness([onlooker]);
    const complete = session.extensionRunner?.getCommand("onlooker")?.getArgumentCompletions;
    const values = async (prefix: string) => (await complete?.(prefix))?.map((item) => item.value);
    expect(await values("")).toEqual(["on", "off", "status", "inherit", "set"]);
    expect(await values("set ")).toEqual([
      "set enabled",
      "set name",
      "set model",
      "set thinkingLevel",
      "set reviewEvery",
      "set correct",
    ]);
    for (const command of ["set maxToolCalls 8", 'set prompt "x"', "prompt"]) {
      await session.prompt(`/onlooker ${command}`);
      const status = manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");
      expect(status).toMatchObject({
        data: { error: stringMatching(/Unknown|Usage/) },
      });
    }
  });

  it("inherits display names across native scopes and restores the default", async () => {
    const { session, manager } = await createSdkHarness([onlooker]);
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");
    await session.prompt('/onlooker set name "Marcel" --global');
    expect(status()).toMatchObject({
      data: { settings: { name: "Marcel" }, sources: { name: "global" } },
    });
    await session.prompt('/onlooker set name "Inspector gadget"');
    expect(status()).toMatchObject({
      data: { settings: { name: "Inspector gadget" }, sources: { name: "session" } },
    });
    await session.reload();
    await session.prompt("/onlooker status");
    expect(status()).toMatchObject({ data: { settings: { name: "Inspector gadget" } } });
    await session.prompt("/onlooker inherit name");
    expect(status()).toMatchObject({ data: { settings: { name: "Marcel" } } });
    await session.prompt("/onlooker inherit name --global");
    expect(status()).toMatchObject({
      data: { settings: { name: "Onlooker" }, sources: { name: "default" } },
    });
  });

  it.each([
    "",
    "   ",
    " Marcel",
    "Marcel ",
    "Marcel\nInjected",
    "Marcel\u001b[31m",
    "Marcel\u009b31m",
  ])("rejects an unsafe display name %j without changing settings", async (name) => {
    const { session, manager } = await createSdkHarness([onlooker]);
    await session.prompt(`/onlooker set name ${JSON.stringify(name)}`);
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toMatchObject({ data: { error: stringContaining("name") } });
    await session.prompt("/onlooker status");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toMatchObject({ data: { settings: { name: "Onlooker" } } });
  });

  it("completes settings keys and only valid trailing scopes without rewriting JSON", async () => {
    const { session } = await createSdkHarness([onlooker]);
    const complete = session.extensionRunner?.getCommand("onlooker")?.getArgumentCompletions;
    const values = async (prefix: string) => (await complete?.(prefix))?.map((item) => item.value);
    expect(await values("o")).toEqual(["on", "off"]);
    expect(await values("inherit r")).toEqual(["inherit reviewEvery"]);
    expect(await values("set  thinkingL")).toEqual(["set  thinkingLevel"]);
    for (const prefix of ["on ", "off ", "inherit reviewEvery "]) {
      expect(await values(prefix)).toEqual([`${prefix}--global`, `${prefix}--project`]);
    }
    expect(await values("inherit ")).toContain("inherit --global");
    expect(await values('set model "provider/model  --global" --p')).toEqual([
      'set model "provider/model  --global" --project',
    ]);
    expect(await values("set reviewEvery 5 ")).toEqual([
      "set reviewEvery 5 --global",
      "set reviewEvery 5 --project",
    ]);
    for (const prefix of [
      "status ",
      "on --global ",
      "set nonexistent ",
      "set reviewEvery 0 ",
      'set model "unfinished --p',
      "unknown ",
    ]) {
      expect(await values(prefix)).toEqual([]);
    }
    await session.reload();
    expect(
      await session.extensionRunner?.getCommand("onlooker")?.getArgumentCompletions?.("on --p"),
    ).toEqual([{ value: "on --project", label: "on --project" }]);
  });

  it("does not poll other processes' settings and adopts them on native reload", async () => {
    const documents = {
      global: JSON.stringify({ onlooker: { reviewEvery: 5 } }),
      project: "{}",
    };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        const next = update(documents[scope]);
        if (next !== undefined) documents[scope] = next;
      },
    };
    const { session, manager } = await createSdkHarness([onlooker], {
      settings: SettingsManager.fromStorage(storage),
    });
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");
    documents.global = JSON.stringify({ onlooker: { reviewEvery: 23 } });
    await session.prompt("/onlooker status");
    expect(status()).toMatchObject({
      data: { settings: { reviewEvery: 5 } },
    });
    await session.reload();
    await session.prompt("/onlooker status");
    expect(status()).toMatchObject({
      data: { settings: { reviewEvery: 23 } },
    });
  });

  it("writes the owning native file backend even when its directories differ from the SDK cwd", async () => {
    const { dir } = await createSdkHarness([]);
    await mkdir(join(dir, ".pi"));
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ theme: "light", otherExtension: { keep: true } }),
    );
    await writeFile(
      join(dir, ".pi", "settings.json"),
      JSON.stringify({ onlooker: { reviewEvery: 2 } }),
    );
    const native = SettingsManager.create(dir, dir);
    const { session } = await createSdkHarness([onlooker], { settings: native });
    native.applyOverrides({ compaction: { enabled: false } });
    await session.prompt("/onlooker on --global");
    await session.prompt('/onlooker set thinkingLevel "low" --project');
    // Scoped writes leave the effective runtime overrides alone.
    expect(native.getCompactionEnabled()).toBe(false);
    const restored = SettingsManager.create(dir, dir);
    const resumed = await createSdkHarness([onlooker], { settings: restored });
    await resumed.session.prompt("/onlooker status");
    expect(
      resumed.manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toMatchObject({
      data: {
        settings: { enabled: true, thinkingLevel: "low", reviewEvery: 2 },
        sources: { enabled: "global", thinkingLevel: "project", reviewEvery: "project" },
      },
    });
    expect(restored.getGlobalSettings()).toMatchObject({
      theme: "light",
      otherExtension: { keep: true },
    });
  });

  it("discards a scoped command awaiting native flush when the session shuts down", async () => {
    const documents = { global: "{}", project: "{}" };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        const next = update(documents[scope]);
        if (next !== undefined) documents[scope] = next;
      },
    };
    const settings = SettingsManager.fromStorage(storage);
    const { session, manager } = await createSdkHarness([onlooker], { settings });
    settings.setTheme("light");
    const before = manager.getEntries();
    const pending = session.prompt("/onlooker on --global");
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "reload" });
    await pending;
    expect(manager.getEntries()).toEqual(before);
    const resumed = await createSdkHarness([onlooker], {
      settings: SettingsManager.fromStorage(storage),
    });
    await resumed.session.prompt("/onlooker status");
    expect(
      resumed.manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toMatchObject({ data: { settings: { enabled: false }, sources: { enabled: "default" } } });
  });

  it("repairs invalid Onlooker values in native BOM JSON but never overwrites malformed documents", async () => {
    const documents = {
      global:
        "\uFEFF" +
        JSON.stringify({
          theme: "light",
          otherExtension: { keep: true },
          onlooker: { reviewEvery: 0 },
        }),
      project: "{}",
    };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        const next = update(documents[scope]);
        if (next !== undefined) documents[scope] = next;
      },
    };
    const { session, manager } = await createSdkHarness([onlooker], {
      settings: SettingsManager.fromStorage(storage),
    });
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");
    await session.prompt("/onlooker status");
    expect(status()).toMatchObject({
      data: {
        state: "paused",
        error: stringContaining("reviewEvery"),
      },
    });
    await session.prompt("/onlooker set reviewEvery 5 --global");
    expect(status()).toMatchObject({
      data: {
        settings: { reviewEvery: 5 },
        error: null,
      },
    });
    expect(SettingsManager.fromStorage(storage).getGlobalSettings()).toMatchObject({
      otherExtension: { keep: true },
      theme: "light",
    });
    documents.global = "{broken";
    await session.prompt("/onlooker on --global");
    expect(documents.global).toBe("{broken");
    expect(status()).toMatchObject({
      data: {
        settings: { enabled: false },
        error: anyInstance(String),
      },
    });
  });

  it("replays selected-branch overrides through resume and fork, excluding abandoned settings", async () => {
    const { session, manager, responses, dir } = await createSdkHarness([onlooker]);
    responses.push(reply("Recorded"));
    await session.prompt("Record the initial task");
    await session.prompt("/onlooker set reviewEvery 17");
    const selected = manager.getLeafId();
    if (!selected) throw new Error("Missing selected branch");
    await session.prompt("/onlooker set reviewEvery 42");
    await session.navigateTree(selected, { summarize: false });
    await session.prompt("/onlooker status");
    const file = manager.getSessionFile();
    if (!file) throw new Error("Native session was not persisted");
    for (const restored of [SessionManager.open(file), SessionManager.forkFrom(file, dir, dir)]) {
      const resumed = await createSdkHarness([onlooker], { manager: restored });
      await resumed.session.prompt("/onlooker status");
      expect(
        restored
          .getBranch()
          .findLast(
            (entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status",
          ),
      ).toMatchObject({
        data: {
          settings: { reviewEvery: 17 },
          sources: { reviewEvery: "session" },
        },
      });
      await resumed.session.prompt("/onlooker inherit reviewEvery");
      expect(
        restored
          .getBranch()
          .findLast(
            (entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status",
          ),
      ).toMatchObject({
        data: {
          settings: { reviewEvery: "turn" },
          sources: { reviewEvery: "default" },
        },
      });
    }
  });

  it("ignores untrusted project settings and refuses project writes", async () => {
    const documents = {
      global: JSON.stringify({ onlooker: { reviewEvery: 13 } }),
      project: "{broken",
    };
    const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
      withLock(scope, update) {
        const next = update(documents[scope]);
        if (next !== undefined) documents[scope] = next;
      },
    };
    const settings = SettingsManager.fromStorage(storage, { projectTrusted: false });
    const { session, manager } = await createSdkHarness([onlooker], { settings });
    await session.prompt("/onlooker status");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toMatchObject({
      data: {
        settings: { reviewEvery: 13 },
        sources: { reviewEvery: "global" },
        error: null,
      },
    });
    await session.prompt("/onlooker on --project");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toMatchObject({ data: { error: stringContaining("trusted project") } });
    expect(documents.project).toBe("{broken");
  });

  it("keeps a private Onlooker Session inert even when globally enabled", async () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("pi-onlooker-role", {
      role: "onlooker",
      observedSessionId: "observed-root",
    });
    const document = { onlooker: { enabled: true }, retry: { enabled: false } };
    const { session, requests } = await createSdkHarness([onlooker], {
      manager,
      settings: SettingsManager.inMemory(document),
    });
    await session.prompt("/onlooker on");
    expect(
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status"),
    ).toMatchObject({ data: { state: "private" } });
    expect(
      manager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-settings"),
    ).toBe(false);
    expect(requests).toEqual([]);
  });

  it("sets and inherits exact options while rejecting malformed values", async () => {
    const { session, manager } = await createSdkHarness([onlooker]);
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");
    await session.prompt('/onlooker set model "provider/model-id"');
    expect(status()).toMatchObject({
      data: {
        settings: { model: "provider/model-id" },
        sources: { model: "session" },
      },
    });
    await session.prompt('/onlooker set thinkingLevel "extreme"');
    expect(status()).toMatchObject({
      data: { error: stringContaining("thinkingLevel") },
    });
    expect(status()).toMatchObject({
      data: { settings: { reviewEvery: "turn" } },
    });
    for (const value of ['"request"', "5", '"turn"']) {
      await session.prompt(`/onlooker set reviewEvery ${value}`);
      const parsed: unknown = JSON.parse(value);
      expect(status()).toMatchObject({
        data: {
          settings: { reviewEvery: parsed },
          sources: { reviewEvery: "session" },
        },
      });
    }
    for (const value of ['"task"', "0"]) {
      await session.prompt(`/onlooker set reviewEvery ${value}`);
      expect(status()).toMatchObject({
        data: { error: stringContaining("reviewEvery") },
      });
      await session.prompt("/onlooker status");
      expect(status()).toMatchObject({
        data: { settings: { reviewEvery: "turn" } },
      });
    }
    await session.prompt("/onlooker set reviewEvery 0 --global");
    expect(status()).toMatchObject({
      data: {
        error: stringContaining("Invalid global Onlooker settings"),
      },
    });
    await session.prompt("/onlooker inherit model");
    expect(status()).toMatchObject({
      data: { sources: { model: "default" } },
    });
  });
  it("lets a session disable a global default and return to inheritance", async () => {
    const document = {
      onlooker: { enabled: true },
      retry: { enabled: false },
    };
    const { session, manager, requests } = await createSdkHarness([onlooker], {
      settings: SettingsManager.inMemory(document),
    });
    const status = () =>
      manager
        .getBranch()
        .findLast((entry) => entry.type === "custom" && entry.customType === "pi-onlooker-status");

    await session.prompt("/onlooker status");
    expect(status()).toMatchObject({
      data: {
        state: "armed",
        settings: { enabled: true },
        sources: {
          enabled: "global",
        },
      },
    });

    await session.prompt("/onlooker off");
    expect(status()).toMatchObject({
      data: {
        state: "disabled",
        settings: { enabled: false },
        sources: { enabled: "session" },
      },
    });

    await session.prompt("/onlooker inherit");
    expect(status()).toMatchObject({
      data: {
        state: "armed",
        settings: { enabled: true },
        sources: { enabled: "global" },
      },
    });
    expect(requests).toEqual([]);
  });
});
