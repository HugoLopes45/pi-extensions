# Changelog

Pi shows the entries newer than your installed version after `pi update`.

## 0.4.4

### Patch Changes

- Settings now live in the `context-kit` entry of Pi's `settings.json`, globally and per project, with a session layer changed by `/context-kit`. On first start, each layer without a `context-kit` entry is imported once: its `context-kit.json` when that file exists, which is then renamed to `context-kit.json.migrated`, otherwise the 0.3 `contextKit` block of `settings.json`. The `/context-kit` menu lists every setting. Per-layer validation now ignores a whole layer when one key is invalid or unknown, so the other layers still apply.

## 0.4.3

### Patch Changes

- An early summary can no longer be longer than the room left under the threshold. Before, Pi could generate a longer summary that pi-context-kit then rejected.
- The documentation is in English only. The Simplified Chinese translation is removed.
- The README states that handoff notes and summaries skip the `context` and `before_provider_request` hooks of other extensions, as Pi's own compaction summaries do.

## 0.4.2 - 2026-11-13

- Documentation in Simplified Chinese: README, contribution guide and security policy. No change to the extension.

## 0.4.1 - 2026-11-13

- The README has a quick start and a troubleshooting section. No change to the extension.

## 0.4.0 - 2026-11-13

- The footer shows how full the context is and when cleanup starts, for example `Context 62% · cleanup at 75%`.
- `/context-kit` opens a panel to turn cleanup on or off, and to choose when and how to clean up.
- Settings move to their own file: `~/.pi/agent/context-kit.json`, and `.pi/context-kit.json` in a trusted project. At the first start, the `contextKit` entry of Pi's `settings.json` moves there with the same behavior.
- The default threshold is now `75%`. Set `"threshold": "pi"` to wait for Pi's limit as before.

## 0.3.2 - 2026-11-11

- Documentation only.

## 0.3.1 - 2026-11-11

- Documentation and package metadata only.

## 0.3.0 - 2026-11-11

- Breaking: the `staleSuffixTokens` setting is removed. Remove it from your settings.
- Supports Pi 1.5. Pi 1.0.3 is still the oldest supported version.
- Requires Node.js 22.19 or later, as Pi does.
- pi-context-kit edits the context only at the threshold, in one batch, so the provider's prompt cache breaks less often.
- After a handoff note, shaking runs only when pruning is not enough.
- With Pi's compaction off, pi-context-kit changes the context only on `/compact`.
- Background handoff notes are cancelled after session-tree navigation.

## 0.2.1 - 2026-10-06

- The README explains each term, the steps of a session, and each setting.

## 0.2.0 - 2026-10-06

- Handoff notes use the session's thinking level and tool choice, so Anthropic can reuse the cached conversation.
- An earlier threshold compacts at the end of a turn, even when no handoff note is ready.
- Recall regex searches are bounded and can be cancelled.
- Handoff notes that are truncated, too large or that call a tool are rejected.
- A failed threshold note is not retried until the next compaction.
