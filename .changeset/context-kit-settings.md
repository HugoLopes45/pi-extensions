---
"pi-context-kit": patch
---

Settings now live in the `context-kit` entry of Pi's `settings.json`, globally and per project, with a session layer changed by `/context-kit`. On first start, each layer without a `context-kit` entry is imported once: its `context-kit.json` when that file exists, which is then renamed to `context-kit.json.migrated`, otherwise the 0.3 `contextKit` block of `settings.json`. The `/context-kit` menu lists every setting. Per-layer validation now ignores a whole layer when one key is invalid or unknown, so the other layers still apply.
