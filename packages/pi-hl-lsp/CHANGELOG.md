# pi-hl-lsp

## 0.1.2

### Patch Changes

- Rename and file move operations check for read-only files before writing. A journal records the planned edits and any move before the first write.
- Apply separate insertions at the same position in server order.
- Preserve editor saves after failed or interrupted edits. Pi reports the files and keeps the journal for manual recovery instead of rewriting the workspace.
- Prepare the standalone npm packages with installation instructions for Pi. LSP includes the changelog alongside the compiled extension; DAP includes the debugger skill and uses your configured adapter.

## 0.1.1

### Patch Changes

- Send no diagnostic summary to the model while the open file has no diagnostics, and drop internal bookkeeping fields from the summary, to save tokens on every request.
  The LSP state no longer appears in the footer; `hl_lsp_status` reports it.
  A language server frame header longer than 4 KiB is rejected.
