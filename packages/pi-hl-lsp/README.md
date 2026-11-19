# pi-hl-lsp

Private, disabled-by-default LSP extension for Pi. Requires Pi 1.5.2 or newer and Node.js 22.19.0 or newer. This package is not installed in the live agent.

## Scope

The extension provides 16 tools. Ten tools read: `hl_lsp_hover`, `hl_lsp_definition`, `hl_lsp_type_definition`, `hl_lsp_implementation`, `hl_lsp_references`, `hl_lsp_incoming_calls`, `hl_lsp_outgoing_calls`, `hl_lsp_symbols`, `hl_lsp_workspace_symbols`, and `hl_lsp_diagnostics`. `hl_lsp_code_actions` lists the code actions at a position. Three tools edit files on disk: `hl_lsp_rename`, `hl_lsp_rename_file`, and `hl_lsp_apply_code_action`. `hl_lsp_status` and `hl_lsp_reload` manage servers. Navigation tools take a 1-based line and either a symbol name on that line or a 1-based column. Call tools use the first item that the server prepares for the position, and name it when the server prepares several. `hl_lsp_workspace_symbols` takes a query and finds matching symbols across the project of any file you pass. `hl_lsp_diagnostics` takes one file, or up to 20 paths checked one after another.

The three edit tools apply the server's edits all or none, after a check that each file still has the text the server saw. If a write fails, the written files are restored; a file that cannot be restored is named in `Could not restore: <files>.`. Each file is replaced in one step through a temporary file next to it, and keeps its permissions; a read-only file is refused before any write. Before the first write, the original and new text of each file and the move go to a journal under `~/.pi/agent/hl-lsp/journal/`, removed after the last step. If the process is killed during the edit, or the restore after a failure fails, the next Pi start undoes the edit and says so. A file changed since then is kept and named, and its journal stays. `hl_lsp_rename_file` moves the file with a hard link and an unlink, so it never replaces an existing file; a file system that refuses the link fails with `The file system refuses the hard link that moving the file needs (<code>)`. `hl_lsp_apply_code_action` takes the index and title from a fresh `hl_lsp_code_actions` list; it never runs a server command. If the files changed but the server could not be told, the result ends with `the server was not updated: <reason>`.

`hl_lsp_status` lists each configured server key with its state, root, open document count and supported tools. It starts no server. `hl_lsp_reload` takes one configured server key and stops its running instances; the next request starts a fresh one. Both tools obey the same enablement, trust and consent gate as the others.

Each session owns its server processes. Servers start only when a tool needs them. Pi runs the tools sequentially through its native execution mechanism.

Diagnostics use push publications, and pull requests when the server offers them. A pull answer is provisional: for one quiet window of 1 second, a publication joins it, and a refresh request makes the extension pull again. The answer joins the pull result with the publications settled for the same document version, errors first. A publication for a file that is not open is kept with the file's text on disk, and joins the answer when the file opens with the same text. Results carry one of four `evidence` values. Matching versions never certify the whole project.

| `evidence`            | Meaning                                                                   | `outcome`   |
| --------------------- | ------------------------------------------------------------------------- | ----------- |
| `revision_correlated` | The publication carries the document version.                             | `completed` |
| `settled_unversioned` | An unversioned publication, with no newer one for 500 ms.                 | `partial`   |
| `unchanged_empty`     | After an edit, no publication for 1 s, and the previous result was empty. | `partial`   |
| `server_busy`         | A progress token is still open at the end of the wait; nothing settled.   | `partial`   |

If no result settles before the request deadline, the tool fails with `No settled diagnostics before the timeout`. An empty `partial` result is never counted as clean: a server without versions can send errors after an empty list.

Natural model requests can receive one transient summary of the latest settled observation. The summary includes its `evidence`. The extension rereads the file first. Automatic summaries exclude diagnostic prose.

Files synchronize on explicit semantic requests. After a successful `edit` or `write` tool call, the extension checks the edited file once, for at most 3 seconds, and appends the errors that the change introduced to the tool result. Files changed through `bash` are not checked. After an edit tool of this extension, each changed file is checked in turn, at most 10 files; a note counts the others. Errors are compared with the last settled observation of the same file. Without one, the note says that the errors may be older. A check that does not finish says `<file> was not checked for errors: <reason>`, for example `the server reported more errors than are compared` or `the server is still busy`. A server that sends nothing when its diagnostics stay the same and offers no pull gives `the server reported nothing after the edit` for each clean edit of a clean file: in local runs, typescript-language-server did this for each such edit (10 of 10 through the edit tool). An empty list without a version is not evidence either, because such a server can send the type errors later (up to 1410 ms later in a loaded local run), so it gives `the server gave no version, so its errors may still arrive`. Edits trigger no other analysis. The extension never executes server-requested commands.

## Output

Each result starts with a header: `hl-lsp <operation> <file>: <outcome>`. The file is relative to the session cwd when it is inside that directory, otherwise absolute.

Locations print as `path:line:col`, 1-based, followed by two spaces and the trimmed source line. Source lines appear only for readable files inside the session cwd.

`hl_lsp_status` prints one line per configured server key, for example `typescript: running root=/project open=1 tools=hover definition diagnostics`. A key without a running instance reads `not started`. A failed instance shows its reason. Tools read `unknown` until the server initializes.

Outcomes other than `completed` and `partial` set `isError: true`.

Output is capped. Hover is limited to 8 KiB and 100 lines. Other bodies are limited to 16 KiB and 250 lines. Output lists at most 50 locations after de-duplication, 200 symbol lines and 20 diagnostics. Omitted items end with `... N more`.

## Configuration

The `hl-lsp` namespace uses shared layered settings backed by Pi. `servers`, `allowProjectExecution`, `timeoutMs`, `formatOnWrite`, and `ignoredLanguages` are global-only. Trusted project settings and session overrides may change `enabled` and `name`. Untrusted project settings are ignored.

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

Commands must be absolute paths. Built-in keys are `typescript`, `python`, `rust`, and `swift`. Other keys configure custom servers; see Servers. No server is downloaded.

`/hl-lsp-setup` detects the project's languages that have no server, and offers the server found in the project or on `PATH`, with an install hint when none is found. It needs a trusted project and the interactive terminal. A chosen server is started once as a check; a server that starts is saved to the global `servers`, and a failed one stays offered. In a trusted project and the interactive terminal, the same dialog opens at startup. The languages dismissed there are saved to `ignoredLanguages` and not offered again at startup; `/hl-lsp-setup` still offers them. Control characters in the dialog's paths and errors are shown escaped.

`set servers` replaces the whole `servers` map, so include every server in the same JSON value.

Servers receive only `HOME` and `PATH` from the environment.

`allowProjectExecution` acknowledges that an approved server may execute project-controlled code. Project trust is also required. This is not a sandbox.

`formatOnWrite` (default `false`) formats the file after a successful edit or write, when its server offers formatting. The server's edits apply all or none, after the same version check as rename. The tool result names the formatted file. Indentation is two spaces, or tabs when the file's first indented line starts with a tab. Formatting can rewrite lines that the model did not change.

`/hl-lsp` opens the shared settings menu. It shows `enabled` and `name`, plus `timeoutMs`, `allowProjectExecution`, and `formatOnWrite` in global scope. Configure servers through `/hl-lsp-setup` or JSON commands, not the menu.

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

## Servers

A server key must match `^[a-z][a-z0-9-]{0,39}$`. Up to 32 servers can be configured.

A built-in key needs only `command` and `args`. A custom key also needs `fileTypes` and `rootMarkers`, because it has no built-in routing.

Two servers that claim one file type are refused. The error names both servers and the file type.

| Field                   | Required    | Meaning                                                                                                                  |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `command`               | yes         | Absolute path to the server executable. Wrappers use `args`, for example `/usr/bin/xcrun` with `sourcekit-lsp`.          |
| `args`                  | yes         | Command-line arguments, at most 32.                                                                                      |
| `fileTypes`             | custom only | Extensions with a leading dot, 1 to 32. Replaces the built-in list.                                                      |
| `rootMarkers`           | custom only | File or directory names, 1 to 32. A leading `*` matches a suffix, for example `*.xcodeproj`. Replaces the built-in list. |
| `dependencyDirs`        | no          | Directory names of installed dependencies, 1 to 32. A root marker inside one is passed over. Replaces the built-in list. |
| `languageId`            | no          | Map from extension to LSP language id. Default: the built-in table, else the server key.                                 |
| `initializationOptions` | no          | JSON object sent in `initialize`.                                                                                        |
| `settings`              | no          | JSON object answered to `workspace/configuration` by section, and sent in `workspace/didChangeConfiguration`.            |

TypeScript, built-in:

```json
"typescript": { "command": "/absolute/path/to/typescript-language-server", "args": ["--stdio"] }
```

Python with basedpyright, built-in:

```json
"python": { "command": "/absolute/path/to/basedpyright-langserver", "args": ["--stdio"] }
```

Rust with rust-analyzer, built-in:

```json
"rust": { "command": "/absolute/path/to/rust-analyzer", "args": [] }
```

Swift with sourcekit-lsp through SwiftPM, built-in:

```json
"swift": { "command": "/usr/bin/xcrun", "args": ["sourcekit-lsp"] }
```

Swift with an iOS app project is not yet proven. The planned path is to generate `buildServer.json` with xcode-build-server, then use the Swift entry above. This path has not been run.

clangd, custom:

```json
"clangd": { "command": "/usr/bin/clangd", "args": [], "fileTypes": [".c"], "rootMarkers": ["compile_commands.json"] }
```

The matrix lists the probes that ran. Each probe ran the built `dist` on the local machine, not the packed artifact.

| Key          | Server and version                                   | Probe                 | Result                                                                                                                               |
| ------------ | ---------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `typescript` | typescript-language-server 6.0.3                     | ts-smoke, 3 runs      | Hover, definition and diagnostics pass.                                                                                              |
| `python`     | basedpyright 1.39.9                                  | py-pull, 3 runs       | Diagnostics pass. Two environments are refused, 3 runs.                                                                              |
| `rust`       | rust-analyzer 1.99.1                                 | rust-pull, 3 runs     | Errors arrive after a delay. The first pull can return `no result`, an open issue.                                                   |
| `swift`      | sourcekit-lsp, Swift 6.4.2, through `/usr/bin/xcrun` | swift-spm, 3 runs     | Diagnostics, definition, references, workspace symbols, call hierarchy and rename complete without error. The probe expects no text. |
| clangd       | clangd 21.0.0 (custom)                               | clangd-custom, 3 runs | Diagnostics and definition pass.                                                                                                     |
| iOS app      | sourcekit-lsp with xcode-build-server                | none                  | Not yet proven.                                                                                                                      |

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
- Explicit output includes at most 20 diagnostics, errors first, with bounded messages and omission counts. Diagnostic codes are kept as strings or safe integers.
- A publication for a file that is not open is kept only for a regular file inside the server root. At most 128 such files are read at once, and at most 128 publications are kept per instance.
- Each server instance gets its root as its only workspace folder.
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

Full TypeScript project-reference routing, Python interpreter binding, and virtual documents remain unimplemented.

Post-edit background analysis, configuration migration, and whole-project diagnostic coverage remain unimplemented.

Global resource bounds and real-agent effectiveness remain unverified. No live activation or publication is part of this package.

## Conventions

The package reuses public Pi APIs and `vscode-jsonrpc` framing. Settings writes are the exception: they go through Pi's private settings storage via `pi-hl-utils`. It has no separate extension host, watcher, scheduler, or mutation engine.
