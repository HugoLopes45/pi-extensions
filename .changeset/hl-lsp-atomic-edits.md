---
"pi-hl-lsp": patch
---

Rename and file move operations check for read-only files before writing. A journal records the planned edits and any move before the first write.
