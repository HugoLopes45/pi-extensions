---
"pi-claude-pro": patch
"pi-context-kit": patch
"pi-onlooker": patch
---

The package installs and updates with npm again. Earlier versions declared their bundled shared code with pnpm's `workspace:` protocol, which npm rejects with "Unsupported URL Type", for example when Pi updates the package.
