# Changelog

Pi shows the entries newer than your installed version after `pi update`.

## 1.4.6

### Patch Changes

- The package installs and updates with npm again. Earlier versions declared their bundled shared code with pnpm's `workspace:` protocol, which npm rejects with "Unsupported URL Type", for example when Pi updates the package.

## 1.4.5

### Patch Changes

- The settings menu accepts a Claude Code version that reads as a decimal number, such as 2.1.

## 1.4.4

### Patch Changes

- Claude Pro settings now live in `settings.json` under the `claude-pro` key, with session, project, and global layers. `/claude-pro` opens a settings menu, `/claude-pro status` shows the model, access and plan usage, and `on`, `off`, `inherit`, and `set` change one option. New options are `claudeCodeVersion`, `usageCacheSeconds`, `footerWindows`, `warnAt`, `footer`, and `extraUsageWarning`.

## 1.4.3

### Patch Changes

- The documentation is in English only. The Simplified Chinese translation is removed.

## 1.4.2 - 2026-11-13

- Documentation in Simplified Chinese: README, contribution guide and security policy. No change to the extension.

## 1.4.1 - 2026-11-13

- Requires Node.js 22.19 or later, as Pi does. CI checks Pi 1.0.3, the oldest supported version, and the latest Pi.

## 1.4.0 - 2026-11-13

- The footer warns when Anthropic bills a request as extra usage.
- The new `/claude-pro` command shows your login, your limits and the likely cause of extra usage.
- The footer label changes from `Claude Pro` to `Claude plan`.

## 1.3.0 - 2026-11-11

- The footer shows the weekly Fable limit when you use Fable.

## 1.2.2 - 2026-11-11

- The README starts with the plan benefit and lists Fable.

## 1.2.1 - 2026-11-11

- A spent extra usage limit is found by its error text.

## 1.2.0 - 2026-11-11

- When a model needs a newer Claude Code version, the request is sent again with that version.
- The extension no longer reads the installed Claude Code version.

## 1.1.3 - 2026-11-11

- Sends the newer of the installed and the bundled Claude Code versions.

## 1.1.2 - 2026-11-11

- An extra usage HTTP 429 stays retryable, and a failing `claude --version` is named.
- The usage lookup is skipped behind a proxy base URL.

## 1.1.1 - 2026-11-11

- Sends the billing block on message-thread continuations, which Anthropic otherwise rejects with HTTP 429 after every tool call.

## 1.1.0 - 2026-10-05

- Claude Code is optional. Without it, the extension uses the bundled Claude Code version.
- Pi's documentation section moves from the system prompt to the first user message of every request.
- The usage lookup is cached per access token, so a new login never sees the usage of the previous one.
- A spent Opus or Sonnet weekly limit counts only for requests to that model.

## 1.0.1 - 2026-10-05

- Sets the package author.

## 1.0.0 - 2026-10-05

- Sends Claude Pro and Max subscription requests from Pi as Claude Code requests.
- Shows subscription usage in the footer.
- Explains a spent subscription limit with its reset time, and stops Pi from retrying it.
