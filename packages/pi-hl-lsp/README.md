# pi-hl-lsp

Private, disabled-by-default read-only LSP extension for Pi. Requires Pi 1.5.2 or newer and Node.js 22.19.0 or newer. This package is not installed in the live agent.

## Scope

The extension provides five read-only tools: `hl_lsp_hover`, `hl_lsp_definition`, `hl_lsp_references`, `hl_lsp_symbols`, and `hl_lsp_diagnostics`. Positions are zero-based UTF-16 coordinates.

Each session owns its server processes. Servers start only when a tool needs them. Pi runs the tools sequentially through its native execution mechanism.

Diagnostics use push publications. Unversioned observations remain `partial`. Matching versions can complete an observation, but never certify the whole project.

Natural model requests can receive one transient summary of the latest revision-correlated observation. The extension rereads the file first. Automatic summaries exclude diagnostic prose.

Files synchronize on explicit semantic requests. Edits do not trigger background analysis. The extension does not apply server edits or execute server-requested commands.

## Configuration

The `hl-lsp` namespace uses shared layered settings backed by Pi. `servers`, `allowProjectExecution`, and `timeoutMs` are global-only. Trusted project settings and session overrides may change `enabled` and `name`. Untrusted project settings are ignored.

Example global settings fragment:

```json
{
  "hl-lsp": {
    "enabled": true,
    "name": "HL LSP",
    "allowProjectExecution": true,
    "timeoutMs": 5000,
    "servers": {
      "typescript": {
        "command": "/absolute/path/to/typescript-language-server",
        "args": ["--stdio"]
      }
    }
  }
}
```

Commands must be absolute paths. Supported server keys are `typescript`, `python`, and `rust`. No server is downloaded or selected automatically.

`allowProjectExecution` acknowledges that an approved server may execute project-controlled code. Project trust is also required. This is not a sandbox.

`/hl-lsp` opens the shared settings menu. It shows `enabled` and `name`, plus `timeoutMs` and `allowProjectExecution` in global scope. Configure servers through JSON commands, not the menu.

```text
/hl-lsp status
/hl-lsp on
/hl-lsp off --project
/hl-lsp set name "HL LSP"
/hl-lsp set servers {"typescript":{"command":"/absolute/path/to/typescript-language-server","args":["--stdio"]}} --global
/hl-lsp inherit enabled --global
/reload
```

Commands default to session scope; `--global` and `--project` select persistent settings. `inherit` removes the selected key without changing other fields. `status` uses Pi notifications without adding model or session context. Native Pi `/reload` stops the previous servers and reloads external settings changes.

Session overrides use versioned entries in native Pi history. Development `hlLsp` settings and unversioned history entries are not migrated. Start a new session for older development history.

Session overrides cannot approve executables or bypass project trust. All writes are validated before persistence. Invalid settings disable LSP without interrupting Pi or other extensions.

## Boundaries

- Routing recognizes local project markers and exposes `local-marker` coverage.
- Escaped file symlinks are rejected during routing. This does not provide atomic protection against concurrent filesystem changes.
- Competing Python environments and nested Cargo manifests are not guessed. Explicit unsupported or ambiguous outcomes preserve uncertainty.
- Virtual documents and unmarked files are unsupported.
- Each file snapshot is limited to 1 MiB. Each session tracks at most eight server/root pairs.
- Incoming server data that is not yet handled is limited to 8 MiB per instance. Bytes are released when the connection takes their message off its queue. Total traffic over a session is not limited.
- Explicit output includes at most 20 diagnostics, with bounded messages and omission counts. Only numeric diagnostic codes are retained.
- Navigation text is limited to 8 KiB and reports truncation. It remains untrusted server data.
- Transport requests and notification writes have cancellation deadlines.
- On POSIX, each server runs in its own process group. Disposal sends SIGTERM to the group and SIGKILL two seconds later if a member remains. If SIGKILL is refused, disposal fails with "LSP process group did not stop". A descendant that leaves the group, for example by starting a new session, is not stopped. On Windows, only the server process is stopped, and process cleanup is not certified.
- Executable identity binding, CPU limits, and resident-memory limits are not certified.

## Verification

From the workspace root:

```sh
pnpm --filter pi-hl-lsp run check
pnpm check
```

The package check runs strict type checks and tests. The root check runs formatting and lint. Cyclomatic complexity is limited to 10.

Tests use temporary homes, controlled stdio servers, public Pi SDK lifecycle APIs, in-memory model services, and a faux provider. They make no external model calls.

Real-server checks must run against the packed artifact. Spike results are not acceptance evidence for this runtime.

## Deferred product requirements

Pull diagnostics, full TypeScript project-reference routing, Python environment binding, Cargo workspace resolution, and virtual documents remain unimplemented.

Post-edit background analysis, guarded mutations, configuration migration, automatic server discovery, and whole-project diagnostic coverage remain unimplemented.

Global resource bounds and real-agent effectiveness remain unverified. No live activation or publication is part of this package.

## Conventions

The package reuses public Pi APIs and `vscode-jsonrpc` framing. Settings writes are the exception: they go through Pi's private settings storage via `pi-hl-utils`. It has no separate extension host, watcher, scheduler, or mutation engine.
