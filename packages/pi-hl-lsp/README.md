# pi-hl-lsp

Private, disabled-by-default read-only LSP extension for Pi. Requires Pi 1.5.2 or newer and Node.js 22.19.0 or newer. This package is not installed in the live agent.

## Scope

The extension provides eight read-only tools: `hl_lsp_hover`, `hl_lsp_definition`, `hl_lsp_type_definition`, `hl_lsp_implementation`, `hl_lsp_references`, `hl_lsp_symbols`, `hl_lsp_workspace_symbols`, and `hl_lsp_diagnostics`. Navigation tools take a 1-based line and either a symbol name on that line or a 1-based column. `hl_lsp_workspace_symbols` takes a query and finds matching symbols across the project of any file you pass.

`hl_lsp_status` lists each configured server key with its state, root, open document count and supported tools. It starts no server. `hl_lsp_reload` takes one configured server key and stops its running instances; the next request starts a fresh one. Both tools obey the same enablement, trust and consent gate as the others.

Each session owns its server processes. Servers start only when a tool needs them. Pi runs the tools sequentially through its native execution mechanism.

Diagnostics use push publications. Results carry one of three `evidence` values. Matching versions never certify the whole project.

| `evidence`            | Meaning                                                                   | `outcome`   |
| --------------------- | ------------------------------------------------------------------------- | ----------- |
| `revision_correlated` | The publication carries the document version.                             | `completed` |
| `settled_unversioned` | An unversioned publication, with no newer one for 500 ms.                 | `partial`   |
| `unchanged_empty`     | After an edit, no publication for 1 s, and the previous result was empty. | `partial`   |

If no result settles before the request deadline, the tool fails with `No settled diagnostics before the timeout`.

Natural model requests can receive one transient summary of the latest settled observation. The summary includes its `evidence`. The extension rereads the file first. Automatic summaries exclude diagnostic prose.

Files synchronize on explicit semantic requests. After a successful edit or write, the extension checks the edited file once, for at most 3 seconds, and appends the errors that the change introduced to the tool result. Errors are compared with the last settled observation of the same file. Edits trigger no other analysis. The extension does not apply server edits or execute server-requested commands.

## Output

Each result starts with a header: `hl-lsp <operation> <file>: <outcome>`. The file is relative to the session cwd when it is inside that directory, otherwise absolute.

Locations print as `path:line:col`, 1-based, followed by two spaces and the trimmed source line. Source lines appear only for readable files inside the session cwd.

`hl_lsp_status` prints one line per configured server key, for example `typescript: running root=/project open=1 tools=hover definition diagnostics`. A key without a running instance reads `not started`. A failed instance shows its reason. Tools read `unknown` until the server initializes.

Outcomes other than `completed` and `partial` set `isError: true`.

Output is capped. Hover is limited to 8 KiB and 100 lines. Other bodies are limited to 16 KiB and 250 lines. Output lists at most 50 locations after de-duplication, 200 symbol lines and 20 diagnostics. Omitted items end with `... N more`.

## Configuration

The `hl-lsp` namespace uses shared layered settings backed by Pi. `servers`, `allowProjectExecution`, and `timeoutMs` are global-only. Trusted project settings and session overrides may change `enabled` and `name`. Untrusted project settings are ignored.

LSP runs only when all three conditions hold. A refusal names each failed condition and its fix.

- LSP is on: run `/hl-lsp on`.
- The project is trusted: run `/trust`, then restart Pi.
- Project execution is allowed: run `/hl-lsp set allowProjectExecution true --global`.

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

`set servers` replaces the whole `servers` map, so include every server in the same JSON value.

Servers receive only `HOME` and `PATH` from the environment.

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
- One in-boundary `.venv` or `venv` routes; the server picks its interpreter. Two environments are ambiguous. An environment outside the boundary is blocked.
- Python projects are marked by `pyproject.toml`, `pyrightconfig.json`, `setup.py`, or `setup.cfg`. `requirements.txt` marks a project only when none of these is found up to the boundary.
- A Cargo crate routes to the nearest in-boundary `[workspace]` manifest at or above it, passing over package manifests. Manifests over 64 KiB, symlinks and directories are not read.
- If no readable workspace manifest is found, the crate routes to itself when no parent `Cargo.toml` exists. A parent `Cargo.toml` makes the file `ambiguous`, including a symlink or one over 64 KiB.
- Files under `node_modules` route to the project that contains `node_modules`.
- Virtual documents and unmarked files are unsupported.
- Each file snapshot is limited to 1 MiB. Each session keeps at most eight server/root pairs running. A ninth pair stops the least recently used one first; a request still running on the stopped server fails with "LSP instance is closed".
- Incoming server data that is not yet handled is limited to 8 MiB per instance. Bytes are released when the connection takes their message off its queue. Total traffic over a session is not limited.
- Explicit output includes at most 20 diagnostics, with bounded messages and omission counts. Only numeric diagnostic codes are retained.
- Output is bounded as described under Output. It remains untrusted server data.
- Transport requests and notification writes have cancellation deadlines. A request timeout, a cancel or an LSP error response leaves the server running. Server start has its own 60-second budget; a request that arrives while the server is still starting fails with "LSP server is still starting; retry the request", and the start continues.
- On POSIX, each server runs in its own process group. Disposal first sends `shutdown` and then `exit` to a healthy initialized server. It then sends SIGTERM to the group, and SIGKILL if a member remains two seconds after disposal started. If SIGKILL is refused, disposal fails with "LSP process group did not stop". A descendant that leaves the group, for example by starting a new session, is not stopped. On Windows, only the server process is stopped, and process cleanup is not certified.
- Executable identity binding, CPU limits, and resident-memory limits are not certified.

## Verification

From the workspace root:

```sh
pnpm --filter pi-hl-lsp run check
pnpm check
```

The package check builds `dist`, runs strict type checks, and then runs tests. The root check runs formatting and lint. Cyclomatic complexity is limited to 10.

Tests use temporary homes, controlled stdio servers, public Pi SDK lifecycle APIs, in-memory model services, and a faux provider. They make no external model calls.

Real-server checks must run against the packed artifact. Spike results are not acceptance evidence for this runtime.

## Deferred product requirements

Pull diagnostics, full TypeScript project-reference routing, Python interpreter binding, and virtual documents remain unimplemented.

Post-edit background analysis, guarded mutations, configuration migration, automatic server discovery, and whole-project diagnostic coverage remain unimplemented.

Global resource bounds and real-agent effectiveness remain unverified. No live activation or publication is part of this package.

## Conventions

The package reuses public Pi APIs and `vscode-jsonrpc` framing. Settings writes are the exception: they go through Pi's private settings storage via `pi-hl-utils`. It has no separate extension host, watcher, scheduler, or mutation engine.
