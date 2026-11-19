---
"pi-hl-lsp": patch
---

A rename or file move that edits several files now changes all of them or none, even when Pi is killed during the edit: the next Pi start undoes the unfinished edit, and a read-only file is refused before any file is written.
