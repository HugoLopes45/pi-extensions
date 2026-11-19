# pi-hl-lsp

## 0.1.1

### Patch Changes

- Send no diagnostic summary to the model while the open file has no diagnostics, and drop internal bookkeeping fields from the summary, to save tokens on every request.
  The LSP state no longer appears in the footer; `hl_lsp_status` reports it.
  A language server frame header longer than 4 KiB is rejected.
