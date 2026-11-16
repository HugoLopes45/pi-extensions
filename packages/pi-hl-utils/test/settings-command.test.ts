import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  completeSettingsCommandArguments,
  parseSettingsCommand,
  registerSettingsCommand,
  type SettingsChangeCommand,
  type SettingsCommand,
  type SettingsCommandInvocation,
  type SettingsCommandSpec,
  type SettingsCompletionSpec,
} from "../src/settings-command.js";
import { type CommandSession, startCommandSession } from "../testing/command-session.js";

const schema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
interface Options {
  enabled?: boolean;
  limit?: number;
}
const optionKeys = ["enabled", "limit"] as const;
type Key = (typeof optionKeys)[number];
type Command = SettingsCommand<Options, Key>;

const usage = "Usage: /demo [on|off|status|inherit [key]|set <key> <JSON>]";
const spec: SettingsCommandSpec<Options, Key> = {
  usage,
  optionKey(text) {
    const key = optionKeys.find((candidate) => candidate === text);
    if (!key) throw new Error(`Unknown option ${text}`);
    return key;
  },
  parseOptions(value) {
    if (!Value.Check(schema, value)) throw new Error("Invalid option value");
    return value;
  },
  toggle: (enabled) => ({ key: "enabled", patch: { enabled } }),
};
const parse = (input: string): Command => parseSettingsCommand(input, spec);

describe("parseSettingsCommand", () => {
  it("opens the menu for blank input and reports status", () => {
    expect(parse("")).toEqual({ action: "menu" });
    expect(parse("   ")).toEqual({ action: "menu" });
    expect(parse("status")).toEqual({ action: "status" });
  });

  it("rejects a scope flag on the menu and status", () => {
    expect(() => parse("--global")).toThrow(usage);
    expect(() => parse("status --project")).toThrow(usage);
  });

  it("maps on and off to the toggle at the session scope by default", () => {
    expect(parse("on")).toEqual({
      action: "set",
      scope: "session",
      key: "enabled",
      patch: { enabled: true },
    });
    expect(parse("off")).toMatchObject({ patch: { enabled: false } });
  });

  it("reads a trailing scope flag", () => {
    expect(parse("off --global")).toMatchObject({ scope: "global" });
    expect(parse("on  --project")).toMatchObject({ scope: "project" });
  });

  it("inherits the toggle's key without an argument and a validated key otherwise", () => {
    expect(parse("inherit")).toEqual({
      action: "inherit",
      scope: "session",
      key: "enabled",
    });
    expect(parse("inherit limit --project")).toEqual({
      action: "inherit",
      scope: "project",
      key: "limit",
    });
    expect(() => parse("inherit nonsense")).toThrow("Unknown option nonsense");
  });

  it("parses `set <key> <JSON>` through the spec's validation", () => {
    expect(parse("set limit 4 --global")).toEqual({
      action: "set",
      scope: "global",
      key: "limit",
      patch: { limit: 4 },
    });
    expect(() => parse("set limit 0")).toThrow("Invalid option value");
    expect(() => parse("set nonsense 1")).toThrow("Unknown option nonsense");
    expect(() => parse("set limit {oops")).toThrow(
      'limit value is not JSON; quote text, for example "request" or "provider/model-id"',
    );
  });

  it("throws the usage for malformed commands", () => {
    expect(() => parse("set limit")).toThrow(usage);
    expect(() => parse("bogus")).toThrow(usage);
  });
});

describe("completeSettingsCommandArguments", () => {
  const completion: SettingsCompletionSpec = {
    optionKeys,
    parse,
  };
  const values = (prefix: string) =>
    completeSettingsCommandArguments(prefix, completion).map((item) => item.value);

  it("offers the words that start with the prefix, labelled by value", () => {
    expect(values("s")).toEqual(["status", "set"]);
    expect(completeSettingsCommandArguments("of", completion)).toEqual([
      { value: "off", label: "off" },
    ]);
  });

  it("offers option keys after set and inherit, replacing the whole prefix", () => {
    expect(values("set ")).toEqual(["set enabled", "set limit"]);
    expect(values("inherit l")).toEqual(["inherit limit"]);
    expect(values("on ")).not.toContain("on enabled");
  });

  it("offers scope flags once the command parses at the session scope", () => {
    expect(values("on ")).toEqual(["on --global", "on --project"]);
    expect(values("inherit limit --")).toEqual([
      "inherit limit --global",
      "inherit limit --project",
    ]);
    expect(values("off --p")).toEqual(["off --project"]);
  });

  it("offers no scope flag for an incomplete command or one that already has a scope", () => {
    expect(values("set limit ")).toEqual([]);
    expect(values("on --global ")).toEqual([]);
    expect(values("status ")).toEqual([]);
  });
});

describe("the registered command through a Pi session", () => {
  const sessions: CommandSession[] = [];
  afterEach(() => {
    for (const started of sessions.splice(0)) started.cleanup();
  });
  const invocation = (
    overrides: Partial<SettingsCommandInvocation<Options, Key>> = {},
  ): SettingsCommandInvocation<Options, Key> => ({
    status: vi.fn<() => void>(),
    menu: vi.fn<() => Promise<void>>(async () => {}),
    change: vi.fn<(command: SettingsChangeCommand<Options, Key>) => Promise<void>>(async () => {}),
    ...overrides,
  });
  const startDemo = async (
    start: () => SettingsCommandInvocation<Options, Key> | undefined,
    mode: "tui" | "print",
  ) => {
    const started = await startCommandSession(
      (pi) =>
        registerSettingsCommand(pi, {
          name: "demo",
          description: "Demo",
          optionKeys,
          parse: spec,
          start,
        }),
      mode,
    );
    sessions.push(started);
    return started.session;
  };

  it("opens the menu in a TUI and shows the status otherwise", async () => {
    const hooks = invocation();
    const tui = await startDemo(() => hooks, "tui");
    await tui.prompt("/demo");
    expect(hooks.menu).toHaveBeenCalledOnce();
    const print = await startDemo(() => hooks, "print");
    await print.prompt("/demo");
    expect(hooks.status).toHaveBeenCalledOnce();
    await tui.prompt("/demo status");
    expect(hooks.status).toHaveBeenCalledTimes(2);
  });

  it("hands a set or inherit command to the change hook", async () => {
    const hooks = invocation();
    const session = await startDemo(() => hooks, "tui");
    await session.prompt("/demo set limit 4 --global");
    expect(hooks.change).toHaveBeenLastCalledWith({
      action: "set",
      scope: "global",
      key: "limit",
      patch: { limit: 4 },
    });
    await session.prompt("/demo inherit enabled");
    expect(hooks.change).toHaveBeenLastCalledWith({
      action: "inherit",
      scope: "session",
      key: "enabled",
    });
  });

  it("runs the check before parsing, so a failed check wins over malformed input", async () => {
    const fail = vi.fn<(cause: unknown) => void>();
    const hooks = invocation({
      check: () => {
        throw new Error("Demo session is unavailable");
      },
      fail,
    });
    const session = await startDemo(() => hooks, "tui");
    await session.prompt("/demo set nope");
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Demo session is unavailable" }),
    );
  });

  it("passes a parse or hook failure to the fail hook, or rethrows it without one", async () => {
    const fail = vi.fn<(cause: unknown) => void>();
    const withFail = await startDemo(() => invocation({ fail }), "tui");
    await withFail.prompt("/demo set nope 1");
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: "Unknown option nope" }));

    const strict = await startDemo(
      () =>
        invocation({
          status: () => {
            throw new Error("status failed");
          },
        }),
      "tui",
    );
    const errors = vi.fn<(error: { error: string }) => void>();
    strict.extensionRunner.onError(errors);
    await strict.prompt("/demo status");
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ error: "status failed" }));
  });

  it("does nothing when the invocation has no work", async () => {
    const session = await startDemo(() => undefined, "tui");
    const errors = vi.fn<(error: { error: string }) => void>();
    session.extensionRunner.onError(errors);
    await session.prompt("/demo set limit 4");
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("registerSettingsCommand", () => {
  it("registers the command with its description and the words and keys it completes", () => {
    const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>();
    registerSettingsCommand(
      { registerCommand },
      {
        name: "demo",
        description: "Demo",
        optionKeys,
        parse: spec,
        start: () => undefined,
      },
    );
    expect(registerCommand).toHaveBeenCalledWith(
      "demo",
      expect.objectContaining({ description: "Demo" }),
    );
    const options = registerCommand.mock.calls[0]?.[1];
    expect(options?.getArgumentCompletions?.("set li")).toEqual([
      { value: "set limit", label: "set limit" },
    ]);
  });
});
