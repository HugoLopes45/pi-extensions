import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { LayeredSettingScope } from "./layered-settings.js";

/** One parsed settings command. */
export type SettingsCommand<Options, Key extends string> =
  | { action: "menu" }
  | { action: "status" }
  | { action: "set"; scope: LayeredSettingScope; key: Key; patch: Options }
  | { action: "inherit"; scope: LayeredSettingScope; key: Key };

/** What a settings command supplies to {@link parseSettingsCommand}. */
export interface SettingsCommandSpec<Options, Key extends string> {
  /** Error message for a malformed command or a scope flag on `status` or the bare menu. */
  usage: string;
  /** Validate a typed option key, throwing for an unknown one. */
  optionKey: (text: string) => Key;
  /** Validate `{ [key]: value }` for one scope, throwing for an invalid value. */
  // The value is parsed user JSON; the spec's option schema validates it before use.
  parseOptions: (value: unknown, scope: LayeredSettingScope) => Options;
  /** The key and patch that `on` (true) and `off` (false) set; `inherit` alone clears this key. */
  toggle: (enabled: boolean) => { key: Key; patch: Options };
}

/**
 * Parse `[on|off|status|inherit [key]|set <key> <JSON>] [--global|--project]`. Blank input opens the menu. A trailing flag selects the scope, `session` by
 * default. Validation errors come from the spec; a malformed command throws `spec.usage`.
 */
export function parseSettingsCommand<Options, Key extends string>(
  input: string,
  spec: SettingsCommandSpec<Options, Key>,
): SettingsCommand<Options, Key> {
  const { text, scope, flagged } = splitScope(input);
  if (text === "" || text === "status") {
    if (flagged) throw new Error(spec.usage);
    return text === "" ? { action: "menu" } : { action: "status" };
  }
  if (text === "on" || text === "off")
    return { action: "set", scope, ...spec.toggle(text === "on") };
  const inherit = /^inherit(?:\s+(\S+))?$/.exec(text);
  if (inherit)
    return {
      action: "inherit",
      scope,
      key: spec.optionKey(inherit[1] ?? spec.toggle(true).key),
    };
  return parseSet(text, scope, spec);
}

function splitScope(input: string): {
  text: string;
  scope: LayeredSettingScope;
  flagged: boolean;
} {
  const trimmed = input.trim();
  for (const scope of ["global", "project"] as const) {
    const before = trimmed.slice(0, -`--${scope}`.length);
    const text = before.trimEnd();
    if (trimmed.endsWith(`--${scope}`) && text.length < before.length)
      return { text, scope, flagged: true };
  }
  return { text: trimmed, scope: "session", flagged: false };
}

function parseSet<Options, Key extends string>(
  text: string,
  scope: LayeredSettingScope,
  spec: SettingsCommandSpec<Options, Key>,
): SettingsCommand<Options, Key> {
  const set = /^set\s+(\S+)\s+(\S[\s\S]*)$/.exec(text);
  if (!set?.[1] || !set[2]) throw new Error(spec.usage);
  const key = spec.optionKey(set[1]);
  let value: unknown;
  try {
    value = JSON.parse(set[2]);
  } catch (cause) {
    throw new Error(
      `${key} value is not JSON; quote text, for example "request" or "provider/model-id"`,
      { cause },
    );
  }
  const patch = spec.parseOptions({ [key]: value }, scope);
  return { action: "set", scope, key, patch };
}

/** What a settings command supplies to {@link completeSettingsCommandArguments}. */
export interface SettingsCompletionSpec {
  /** Option keys completed after `set ` and `inherit `. */
  optionKeys: readonly string[];
  /** The command's parser, used to offer a scope flag once the command is complete. */
  parse: (text: string) => { action: string; scope?: LayeredSettingScope };
}

/** Native command completion values replace the entire argument prefix. */
export function completeSettingsCommandArguments(
  prefix: string,
  spec: SettingsCompletionSpec,
): AutocompleteItem[] {
  const candidates = ["on", "off", "status", "inherit", "set"];
  const keyPrefix = /^((?:set|inherit)\s+)\S*$/.exec(prefix)?.[1];
  if (keyPrefix) candidates.push(...spec.optionKeys.map((key) => `${keyPrefix}${key}`));
  const scopePrefix = beforeLastWord(prefix);
  if (scopePrefix !== undefined) {
    try {
      if (spec.parse(scopePrefix).scope === "session")
        candidates.push(`${scopePrefix}--global`, `${scopePrefix}--project`);
    } catch {
      // Incomplete commands and JSON values cannot accept a scope yet.
    }
  }
  return candidates
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({ value, label: value }));
}

/** The prefix up to its last whitespace, when the word after it is empty or a flag. */
function beforeLastWord(prefix: string): string | undefined {
  let end = prefix.length;
  while (end > 0 && !/\s/.test(prefix.charAt(end - 1))) end--;
  const word = prefix.slice(end);
  return end > 0 && (word === "" || word.startsWith("--")) ? prefix.slice(0, end) : undefined;
}

/** The commands that apply one validated change: `set` and `inherit`. */
export type SettingsChangeCommand<Options, Key extends string> = Extract<
  SettingsCommand<Options, Key>,
  { action: "set" | "inherit" }
>;

/** What one invocation of a settings command does; each extension owns its status text and errors. */
export interface SettingsCommandInvocation<Options, Key extends string> {
  /** Throws when the command cannot run; it runs before the command is parsed. */
  check?: () => void;
  /** Shows the status: the `status` command, and the menu outside a TUI. */
  status: () => void | Promise<void>;
  /** Opens the settings menu in a TUI. */
  menu: () => Promise<void>;
  /** Applies one `set` or `inherit`. */
  change: (command: SettingsChangeCommand<Options, Key>) => Promise<void>;
  /** Receives a failure of the check, the parse or a hook; without it the failure propagates to Pi. */
  fail?: (cause: unknown) => void;
}

/** How a settings command parses, and what each invocation of it starts. */
export interface SettingsCommandDispatch<
  Options,
  Key extends string,
  Context extends Pick<ExtensionContext, "mode">,
> {
  parse: SettingsCommandSpec<Options, Key>;
  /** Starts one invocation; undefined when there is nothing to run. */
  start: (ctx: Context) => SettingsCommandInvocation<Options, Key> | undefined;
}

/** What Pi needs to register one settings command. */
export interface SettingsCommandRegistration<
  Options,
  Key extends string,
> extends SettingsCommandDispatch<Options, Key, ExtensionCommandContext> {
  name: string;
  description: string;
  /** Option keys completed after `set` and `inherit`. */
  optionKeys: readonly string[];
}

/**
 * Runs one invocation: the check, then the parse, then the menu, status or change. A failure of
 * any of them goes to `fail` when the invocation has one.
 */
function settingsCommandHandler<
  Options,
  Key extends string,
  Context extends Pick<ExtensionContext, "mode">,
>(
  dispatch: SettingsCommandDispatch<Options, Key, Context>,
): (args: string, ctx: Context) => Promise<void> {
  return async (args, ctx) => {
    const invocation = dispatch.start(ctx);
    if (!invocation) return;
    try {
      invocation.check?.();
      const command = parseSettingsCommand(args, dispatch.parse);
      if (command.action === "menu" && ctx.mode === "tui") await invocation.menu();
      else if (command.action === "set" || command.action === "inherit")
        await invocation.change(command);
      else await invocation.status();
    } catch (cause) {
      if (!invocation.fail) throw cause;
      invocation.fail(cause);
    }
  };
}

/** Registers one settings command with its dispatch and its argument completions. */
export function registerSettingsCommand<Options, Key extends string>(
  pi: Pick<ExtensionAPI, "registerCommand">,
  registration: SettingsCommandRegistration<Options, Key>,
): void {
  pi.registerCommand(registration.name, {
    description: registration.description,
    getArgumentCompletions: (prefix) =>
      completeSettingsCommandArguments(prefix, {
        optionKeys: registration.optionKeys,
        parse: (text) => parseSettingsCommand(text, registration.parse),
      }),
    handler: settingsCommandHandler(registration),
  });
}
