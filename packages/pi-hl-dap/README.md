# pi-hl-dap: debug configured programs in Pi

[![CI](https://github.com/HugoLopes45/pi-extensions/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/HugoLopes45/pi-extensions/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Launch and inspect a configured [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) session from [Pi](https://pi.dev).** This package is private and not published. From the repository root, install its workspace dependencies and register the local package:

```bash
pnpm install --ignore-scripts
pi install ./packages/pi-hl-dap
```

Configure an adapter and a launch profile before asking Pi to debug a program.

## Why pi-hl-dap

- Set source breakpoints, step through code, and inspect stopped frames and variables.
- Keep one Debug Session and its Desired Breakpoints across tool calls.
- Inspect Node and TypeScript worker threads and child processes with vscode-js-debug.
- Receive compact tool text and complete structured results, with a passive TUI widget.

## Quick start

You need macOS or Linux, Node.js 22.19 or later, Pi 1.5.2 or later, and a user-managed Debug Adapter executable. This release candidate is verified on macOS arm64 and Linux arm64 with Pi 1.5.2. Windows is unsupported.

1. Install the local package with the commands above.
2. Add an adapter and a launch profile under `hlDap` in Pi settings, as shown in [Settings](#settings).
3. Start Pi, or run `/reload` in an existing session.
4. Ask Pi to set breakpoints and launch the profile with the `hl_dap_*` tools.

Do not load another copy of this extension: the `hl_dap_*` tool names collide. Pi HL DAP has no adapter discovery, installer, or catalog.

This is a private release candidate installed from a local checkout, not from the npm registry. `pi install` records the checkout path: moving or deleting the checkout breaks the install, `pi update` never changes it, and the bundled `pi-hl-utils` workspace dependency needs `pnpm install` in the checkout first.

## How it works

### Tools

Pi HL DAP registers one tool per operation, all acting on the same single Debug Session and grouped under the `hl_dap` namespace:

| Tool                     | Arguments                                                        |
| ------------------------ | ---------------------------------------------------------------- |
| `hl_dap_launch`          | optional `profile`, `program`, `args`, `cwd`, `launch_arguments` |
| `hl_dap_set_breakpoints` | `file_path`, `breakpoints`                                       |
| `hl_dap_continue`        | none                                                             |
| `hl_dap_next`            | none                                                             |
| `hl_dap_step_in`         | none                                                             |
| `hl_dap_step_out`        | none                                                             |
| `hl_dap_pause`           | none                                                             |
| `hl_dap_stack`           | optional `thread_id`, `start`, `count`                           |
| `hl_dap_variables`       | `frame_id` or `variables_reference`; optional `start`, `count`   |
| `hl_dap_evaluate`        | `expression`; optional `frame_id`                                |
| `hl_dap_status`          | none                                                             |
| `hl_dap_stop`            | none                                                             |

Every tool is declared to the model (`direct` exposure). Use `hl_dap_stop` to end a runaway Debuggee and `hl_dap_pause` to interrupt one whose execution wait timed out or yielded to a steer.

`hl_dap_launch` selects a profile (it may be omitted only when exactly one valid profile exists). `program`, `args`, and `cwd` replace the same profile arguments; relative `program` and `cwd` paths resolve from Pi's project working directory. `launch_arguments` is an object of adapter launch arguments for this launch only, merged (shallow) over the profile's `arguments`, so one launch can set `autoAttachChildProcesses: false` without editing settings; `program`, `args`, and `cwd` still win over it. It is named `launch_arguments`, after the profile's `arguments`, because `args` already means the Debuggee's command-line arguments. A Debug Session is single-active: launching while one is active fails. Desired Breakpoints are complete per-file lists and survive `hl_dap_stop` and later launches in the same Pi conversation session; `[]` clears a file and drops it from `desired_breakpoints`. During a live Debug Session, a list the primary target refuses leaves the previous list in place; once the primary accepts it, the new list stays even when a live child session refuses it, and the call reports that refusal as an error. A refused `hl_dap_pause` in a live child session is an error too. Relative breakpoint paths also resolve from Pi's project working directory. A breakpoint file that does not exist yet is still stored, with a `warnings` entry that the breakpoints will not bind until it exists.

Execution and inspection require a stopped Debuggee: `hl_dap_continue`, `hl_dap_next`, `hl_dap_step_in`, `hl_dap_step_out`, `hl_dap_stack`, `hl_dap_variables`, and `hl_dap_evaluate`. `hl_dap_pause` requires a running Debuggee. `hl_dap_status` reports the current state and consumes unread output; `hl_dap_stop` is idempotent. `hl_dap_stack` defaults to the stopped thread, offset `0`, and count `20`; `hl_dap_variables` takes exactly one `frame_id` or `variables_reference` and defaults its count to `100` (Pi HL DAP declares `supportsVariablePaging`, so the adapter pages the variables); `hl_dap_evaluate` defaults to the top Stack Frame. Pi runs a batch of tool calls that includes a DAP tool sequentially, in the order the model issued them. Calls that a codemode script starts together, for example with `Promise.all`, are queued the same way by Pi, so they never overlap on the Debug Session. A script cannot use one call to interrupt another's execution wait: a `hl_dap_pause` started with `hl_dap_continue` runs only after the wait ends.

Execution waits end on a stop, exit, cancellation, a Steer Yield, or `executionMs`; an execution timeout reports `running`. Request, startup, and shutdown timeouts are errors. A natural exit leaves a terminal snapshot available from `hl_dap_status` until the next launch, with `exit_code` when it is known:

- from the adapter's `exited` event;
- with the Supported `vscode-js-debug` adapter, which sends none, from the `Process exited with code N` report it makes while it owns the Debuggee's output (profile `console` absent or `internalConsole`, and `outputCapture` not `std`). Pi HL DAP infers `0` only there, when the Debug Session ends without that report. A Debuggee killed by a signal also reads `0`, because that is what `vscode-js-debug` reports;
- with a terminal `console` (`integratedTerminal`, `externalTerminal`), from the exit status of the process Pi HL DAP ran for the adapter. A signal kill has none.

Otherwise `exit_code` is omitted, never guessed: this covers `outputCapture: "std"`, a Debug Session that `hl_dap_stop` ends, and an adapter failure. A call rejected because of the Debug Session state, such as `hl_dap_stack` after the Debuggee exited, is an error result that still reports the current state.

### Annotations and script results

Each tool carries MCP-style annotations that permission extensions can use:

| Tools                                                                                                     | Read-only | Destructive | Idempotent | Open world |
| --------------------------------------------------------------------------------------------------------- | --------- | ----------- | ---------- | ---------- |
| `hl_dap_stack`, `hl_dap_variables`, `hl_dap_status`                                                       | yes       | no          | yes        | no         |
| `hl_dap_launch`, `hl_dap_continue`, `hl_dap_next`, `hl_dap_step_in`, `hl_dap_step_out`, `hl_dap_evaluate` | no        | yes         | no         | yes        |
| `hl_dap_set_breakpoints`                                                                                  | no        | yes         | yes        | yes        |
| `hl_dap_pause`                                                                                            | no        | no          | yes        | no         |
| `hl_dap_stop`                                                                                             | no        | yes         | yes        | no         |

Launching, resuming, stepping, and evaluating run the Debuggee's code, so they can do anything the program does. `hl_dap_set_breakpoints` is annotated the same way because a breakpoint `condition` is also evaluated as Debuggee code. Replacing a file's breakpoints with the same list changes nothing more, so it is idempotent.

Each tool declares an output schema. Codemode scripts receive a structured result: the Debug Session state, all drained Debuggee output, and the operation's complete data (`breakpoints`, `stack_frames` and `total_frames`, `scopes` or `variables`, or `evaluation`). `hl_dap_set_breakpoints`, `hl_dap_launch`, and `hl_dap_status` also carry `desired_breakpoints`; no other tool does. The execution tools, `hl_dap_pause`, and `hl_dap_status` carry `rejected_child_sessions` when Pi HL DAP could not debug a child session (see Child sessions). These results are not truncated to the transcript limits; the one exception is that `hl_dap_variables` with `frame_id` leaves expensive scopes unexpanded. A state failure resolves to the current state with an `error` field instead of rejecting.

### Output and lifecycle

Each successful tool call drains currently unread Debuggee output. Adapter `output` events with the `telemetry` category are dropped; every other category (including `important` and uncategorized output) is kept. Pi HL DAP retains at most 1 MiB of unread output, reporting discarded older bytes.

Tool text is a few compact lines, never a raw JSON dump. A stop reads `stopped (breakpoint) at app.js:3:5 in add (frame 12) · thread 1`: the top Stack Frame's file, line, column, function, and id come with every result that waits for a stop (and with `hl_dap_status` once one has), so no separate `hl_dap_stack` call is needed. Adapters such as js-debug renumber Stack Frames after each resume, so use the id from the latest stop. Further lines carry the adapter's stop `description` and the `hitBreakpointIds` (matching the `id` values `hl_dap_set_breakpoints` reports for a live Debug Session; DAP lets the adapter pick any integer, negative included, and Pi HL DAP reports it unchanged). Your breakpoint lists ids and an adapter's entry stop has none, so the reason and the ids tell them apart. Only `hl_dap_set_breakpoints`, `hl_dap_launch`, and `hl_dap_status` list Desired Breakpoints in text (the latter two only when some exist), so a stepping result never repeats them. A call that waits and ends still `running` says `(wait timed out)`, `(wait cancelled)` when the call was cancelled, or `(wait steered)` after a Steer Yield. A `hl_dap_pause` that ends still `running` says `(no stop after pause)`.

Stack Frames, variables, and evaluations are one line per row. In `hl_dap_stack` text, each run of two or more Stack Frames the adapter hints as noise (a frame `presentationHint` of `subtle` or `label`, or a source `presentationHint` of `deemphasize`, as vscode-js-debug sets for runtime internals and async boundaries) collapses to one line such as `… 13 deemphasized frames (ids 34–46)`. Those ids still work with `hl_dap_variables` and `hl_dap_evaluate`, a lone hinted frame keeps its own line, and `stack_frames` in `structuredContent` lists every frame. Adapter strings are flattened onto one line with `\n` escapes. Drained Debuggee output follows under its own heading. `structuredContent` keeps its fields' strings verbatim, and adds `stop_description`, `hit_breakpoint_ids`, `top_frame`, and, for a stop in a child session, `child_session`. `hl_dap_variables` with `frame_id` lists scopes the adapter marks expensive, such as js-debug's Global, by name and `variables_reference` without expanding them; pass that reference to expand one. In `structuredContent` such a scope has no `variables`.

Tool text follows Pi's 2,000-line/50-KB visible limit and is cut at whole lines; a first line alone over the byte limit is cut mid-line, so the visible part is never empty. When truncated, the retained complete result is written to a Result Spill and its path appears in the result. If spill storage fails, the action remains successful and the result keeps the start of the text under the same limit, followed by a warning that says the action completed, that repeating the call will not help, and the storage error as a one-line cause of at most 500 characters. `details.spill_error` holds the same bounded cause, `spill_path` is absent, and `structuredContent` stays complete. Do not repeat the action to recover a spill.

Adapter stderr retains its newest 1 MiB in the session directory and process or protocol failures name that path. Failed requests report the adapter's own error text and name the path only when stderr has content. With `--no-session`, Pi provides no session directory, so these files use a private directory under the OS temporary directory instead. Normal session teardown removes it; forced termination may leave temporary files behind.

Adapters start lazily at `launch`, use the project working directory, and are owned by one Pi conversation session. `hl_dap_stop`, launch cancellation, adapter failure, and session shutdown attempt DAP termination when the adapter advertises it, then disconnect before terminating owned POSIX process groups. Session shutdown ends the Debug Session for good: it waits for a startup in flight, stops the adapter and any Debuggee that startup started, and a later `launch` reports a state error. It also removes session files. Cancelling an execution wait only ends that wait; the live Debug Session remains recoverable. The tool result reports it as `execution_wait_cancelled: true` while the Debuggee still runs; a stop or exit that raced the cancellation is reported as itself.

Each adapter connection receives its own `shutdownMs` budget, shared by its DAP requests, owned adapter process group, and final stderr snapshot. Each owned Debuggee process group receives a separate budget at its cleanup stage. This is not a total session shutdown budget. Artifact disposal follows these stages without that deadline.

Cleanup still attempts every remaining channel and group after an error. Channel or process-group cleanup failure leaves the state `terminated` and rejects the cleanup request. The observer reports the combined failure once. The next `launch` or `stop` reports a typed recovery error, preserves the cleanup cause, names up to five individual cleanup causes in its message, warns that processes may have survived, and resets to `idle`. After a failed `stop`, a later launch can start a new Debug Session. Pi session shutdown retains its cached outcome, and after it every launch reports the closed state; recovery does not turn a failed shutdown into success.

Debugger operations prune owned process groups only when a native probe confirms absence; uncertain groups stay owned. Unexpected probe errors trigger the same cleanup path. Probing narrows, but cannot eliminate, process-group ID reuse.

### Steer Yield

Pi hands a Queued Steer to the agent only after every tool call in the current batch has returned, so a long execution wait would delay the user's or a parent agent's redirection. `hl_dap_launch`, `hl_dap_continue`, `hl_dap_next`, `hl_dap_step_in`, and `hl_dap_step_out` therefore end their wait early, as a Steer Yield, when a Queued Steer is pending for the tool's Pi session (the shared signal in `pi-hl-utils/steering`; follow-ups never count). A yield behaves like a cancelled wait: the request that started or resumed the Debuggee was still sent, the Debug Session stays `running` and the Debuggee is untouched, and `hl_dap_pause` or `hl_dap_stop` can act on it later. A wait that starts while a steer is pending ends right after that request is sent, because a steer stays pending until Pi starts the next turn. It is not the tool's abort signal: the result reports `execution_wait_steered: true` beside `execution_wait_cancelled`, with text `running (wait steered)`. A wait that ended because the Debuggee stopped or exited reports that, even if a steer was pending. `hl_dap_pause` never yields: it only confirms the stop it requested, and yielding would report the Debuggee as `running` moments before it stops.

### Observer UI

In TUI mode, calls and results follow Pi's built-in tool rendering. The header is the tool name (`hl_dap_stack`), its target, and muted arguments; expanding a call lists only explicitly supplied arguments. A result previews the tool text, 20 lines for `hl_dap_stack` and `hl_dap_variables` and 10 for everything else, followed by Pi's `... (N more lines, ctrl+o to expand)` hint. A running call, including a long execution wait, shows Pi's `Elapsed` footer and a finished one `Took`.

One `pi-hl-dap` widget above the editor follows launching, running, stopped, and terminated activity: a `DAP` title with the adapter, profile, and elapsed time, then a row led by a Status Mark with the state, stop reason or exit code, and source location. It is derived only from lifecycle transitions and successful results Pi HL DAP has already received; it sends no additional DAP request and provides no human debugger controls. Stopped source locations clear on resume. The terminal snapshot remains for ten seconds, while idle sessions have no widget. A refused `hl_dap_launch` leaves the widget of the active Debug Session in place. RPC, JSON, and print modes do not mount it. An asynchronous failure that arrives during a tool call is notified once no tool call is active, unless a failed tool call carries that same failure as its cause.

The model still receives the compact text, Debuggee output, truncation, and Result Spill notice described above. Only the human-visible copies of Debuggee output and adapter-supplied strings (widget and tool call rows) are stripped of terminal sequences and unsafe controls; the raw tool result and Result Spill retain the original bytes.

### Child sessions

When the Debuggee starts a worker thread or a child process (a test runner's workers, for example), `vscode-js-debug` asks Pi HL DAP to debug it as a child session with `startDebugging`. Pi HL DAP opens a channel for the child against the same adapter process, applies Desired Breakpoints before the child runs, and starts it, so breakpoints in code a child runs bind like any other. Children of children are debugged the same way. Launching `vitest run` stops at a breakpoint in code a test imports, with either the `forks` or the `threads` pool.

Child sessions fold into the one Debug Session:

- **One stop at a time.** A stop in a child session reads like any other, with a `child session:` line (`child_session` in `structuredContent`) naming it:

  ```text
  stopped (breakpoint) at math.js:3:13 in add (frame 1) · thread 1
  child session: forks.js [2992814]
  ```

`hl_dap_stack`, `hl_dap_variables`, `hl_dap_evaluate`, `hl_dap_continue`, and the step tools act on the target whose stop is reported. When several targets stop at once (parallel test workers, say), the others wait: the next `hl_dap_continue` or step reports a waiting stop at once instead of running on.

- **Thread ids.** Each target numbers its own threads, so with `vscode-js-debug` Pi HL DAP reports its own thread ids, which never collide across targets.
- **Breakpoints.** `hl_dap_set_breakpoints` updates every target. A Breakpoint is reported verified when any target verified it, under the id the Debuggee's own target gave it; `hit_breakpoint_ids` from a child uses those same ids.
- **`hl_dap_pause`** pauses every target and reports the first stop.
- **`debugger;` statements and exceptions** in a child stop like those in the Debuggee.
- **Lifetime.** A child that ends closes only its own channel. The Debug Session still ends with the Debuggee, and `hl_dap_stop` closes every channel.

A child session Pi HL DAP cannot debug is named once in the next `hl_dap_launch`, `hl_dap_continue`, `hl_dap_next`, `hl_dap_step_in`, `hl_dap_step_out`, `hl_dap_pause`, or `hl_dap_status` result, in text and in `rejected_child_sessions` (`type`, `name`, `target_id`, `message`); breakpoints in it never bind. A child session that fails after it started is named the same way, and breakpoints in it stop binding. To skip debugging child processes, pass `launch_arguments: { autoAttachChildProcesses: false }`; they then run without a debugger. Worker threads have no such switch. Paths inside `launch_arguments` are passed to the adapter as written; only the top-level `program` and `cwd` are resolved.

## Settings

Pi HL DAP reads only the `hlDap` key from Pi's global `settings.json` and trusted project `.pi/settings.json`:

```json
{
  "hlDap": {
    "timeouts": {
      "startupMs": 10000,
      "requestMs": 10000,
      "executionMs": 30000,
      "shutdownMs": 5000
    },
    "adapters": {
      "node": {
        "command": "node",
        "args": ["/absolute/path/to/dapDebugServer.js", "$PORT", "127.0.0.1"],
        "environment": {},
        "preset": "vscode-js-debug",
        "transport": {
          "type": "tcp",
          "host": "127.0.0.1",
          "port": 0
        }
      }
    },
    "profiles": {
      "node": {
        "adapter": "node",
        "adapterID": "pwa-node",
        "arguments": {
          "type": "pwa-node",
          "console": "internalConsole"
        }
      }
    }
  }
}
```

An Adapter Definition needs a non-empty `command` and `transport`; `args` and `environment` default to an empty array and object, respectively. `transport` is either `"stdio"` or a TCP object with `type: "tcp"`; its host defaults to `127.0.0.1`, and a missing or zero port selects a local port. TCP arguments may use `$PORT` anywhere in an argument, and Pi HL DAP also supplies that selected port as `PORT` in the adapter environment. `$PORT` is invalid for stdio adapters. Environment strings overlay the inherited environment; `null` removes an inherited variable.

`preset` names packaged adapter data: `vscode-js-debug`, `lldb-dap`, or `debugpy`. It supplies the `adapterID` sent in `initialize`, the `channels` policy, and, for `vscode-js-debug`, the exit-code report its adapter never sends as `exited`. An unknown preset quarantines the Adapter Definition like any other invalid field. `channels` is `{ "sessions": "root" | "promoted", "firstSessionIsPrimary"?: boolean, "targetIdKey"?: string }` and only `sessions` is required: `promoted` lets the adapter ask for Debug targets and Child sessions with `startDebugging`, and `firstSessionIsPrimary` says the first such channel is the primary target rather than a Child session. An Adapter Definition's own `channels` overrides the preset field by field; the preset's other fields stay. Without a preset every adapter keeps `sessions: "root"`, so nothing is promoted. **Migration:** an existing `vscode-js-debug` Adapter Definition must add `"preset": "vscode-js-debug"`; without it the adapter is treated as a plain root-channel adapter, so it gets no primary target promotion, no Child sessions, and no exit-code fallback. A Launch Profile may also set `adapterID` to override both the preset's and the launch argument `type` (the older fallback is the argument `type`, then the Adapter Definition ID).

A Launch Profile needs an existing Adapter Definition ID and opaque JSON-object `arguments`. Global and trusted-project timeouts merge by field. Each timeout is an integer from 1 to 2147483647 ms, the longest delay a Node.js timer keeps. `shutdownMs` applies per connection and owned Debuggee process-group cleanup stage, not to the whole session; see [Output and lifecycle](#output-and-lifecycle). Adapter and profile maps merge by ID: a project entry replaces the complete global entry; `null` removes it. Invalid project replacements still shadow global entries. Invalid entries are quarantined independently and produce path-qualified warnings at session start, while unrelated valid entries stay available. Untrusted project settings are ignored. Use Pi `/reload` to reload settings.

### Adapters

Keep configured adapter paths available. Editor updates can remove versioned extension directories, including a bundled `debugpy` used through `PYTHONPATH`. If an update replaces that directory, update the Adapter Definition's `environment.PYTHONPATH` and run `/reload`. Pi HL DAP does not repair adapter installations or discover replacement paths.

Node/TypeScript through Microsoft `vscode-js-debug` 1.117.0 is Supported. Download the `js-debug-dap-v1.117.0.tar.gz` release from [vscode-js-debug releases](https://github.com/microsoft/vscode-js-debug/releases/tag/v1.117.0), extract it, then set the Node adapter command to `node`, add `"preset": "vscode-js-debug"`, and point its TCP arguments at `dapDebugServer.js` followed by `$PORT`, as above.

Rust and Swift through `lldb-dap` 21.0.0 (LLVM, from Xcode) and Python through `debugpy` 1.8.20 on Python 3.9.6 are Supported on macOS arm64 for synthetic public-session smokes: breakpoints, stack, locals, evaluate, a normal exit, and early stop for the native targets, and stdio plus TCP parent-and-child sessions for Python. These smokes use small synthetic fixtures, so they show the adapter conversation works for that language; they do not guarantee every project. A Child session the adapter asks for connects only to the adapter's declared transport endpoint; Pi HL DAP never uses a connection address or executable from the `startDebugging` request.

| Adapter or version                | Status                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `vscode-js-debug` 1.117.0         | Supported. The real adapter tests pass on macOS arm64 with Pi 1.5.2.                                         |
| `lldb-dap` 21.0.0                 | Supported for Rust and Swift command-line fixtures on macOS arm64. Synthetic smokes only.                    |
| `debugpy` 1.8.20 (Python 3.9.6)   | Supported on macOS arm64 for stdio, and TCP parent-and-child fixtures. Synthetic public-session smokes only. |
| Other `vscode-js-debug` versions  | Not certified                                                                                                |
| Any other standards-based adapter | Candidate, not certified: it may work through DAP, with no compatibility promise                             |

iOS apps and simulators are unverified and outside this release's supported scope.

#### `stopOnEntry` re-stops inside the first function

Leave `stopOnEntry` out of a `vscode-js-debug` profile unless you need the entry stop. For that stop js-debug sets a breakpoint at line 0, column 0 of the program and never removes it. When the program starts with a function declaration, V8 moves that breakpoint to the function's first statement, so every call to the function stops again with reason `entry`, which looks like a stale stop reason or an ignored breakpoint condition. Without `stopOnEntry`, `hl_dap_launch` runs to your first breakpoint and each stop is reason `breakpoint`. To tell the two apart when it does happen, read the stop text: your breakpoint lists `hit breakpoint ids` (`hit_breakpoint_ids` in `structuredContent`), while an entry stop has none. The stop `description` is the same (`Paused on breakpoint`) for both, so rely on the reason and the ids.

## Limits

Pi HL DAP supports configured stdio and TCP adapters, one active Debug Session, source breakpoints, core execution control, stack/variables/evaluation, and headless `runInTerminal`. The Supported `vscode-js-debug` workflow uses one adapter-owned primary target channel and one channel per child session, all folded into the one model-facing Debug Session (see Child sessions). A `startDebugging` request is served only when the Adapter Definition declares promoted sessions and its transport can host another channel (TCP does, stdio does not); otherwise it is refused with a failure reply. It excludes attach, restart, function/data/instruction breakpoints, hit counts, logpoints, memory, disassembly, modules, user-requested child Debug Sessions, raw DAP requests, `launch.json`, WebSocket, persistence, and a directly operated debugger UI.

Trusted project settings can run arbitrary local executables with Pi's permissions. Review adapter commands and configuration before trusting a project.

The test suite covers macOS arm64 and Linux arm64 with Pi 1.5.2, including the pinned real `vscode-js-debug` adapter. Rust, Swift, and Python synthetic smoke coverage is macOS arm64 only. Node.js 22.19 is the supported minimum. Real-model acceptance is unverified; this build is not certified with a real model. Windows is unsupported: HL DAP stops adapters through POSIX owned process groups, and tests that depend on them are skipped there.

On Linux, shutdown confirms that an owned process group is gone before it reports success. A container whose PID 1 does not reap orphans keeps a killed descendant visible, so shutdown fails within `shutdownMs` instead of claiming success; run the container with an init such as `docker run --init`.

One DAP frame over 8 MiB ends the transport, so it fails the whole Debug Session instead of one call.

Inbound responses and events may use `seq` 0, as `lldb-dap` 21.0.0 does; a negative or non-integer `seq`, an inbound request `seq` below 1, and a response `request_seq` below 1 still fail the envelope.

HL DAP sends `terminate` only when the adapter advertises `supportsTerminateRequest`; sending it to an adapter such as `lldb-dap` 21.0.0 that does not advertise it can abort the adapter and leave an orphan zombie. Cleanup requires every owned process to be absent, including the Debuggee. Pre-existing zombies cannot be reaped by HL DAP and are not claimed cleaned.

A stalled adapter stderr write, for example on a hung filesystem, ends with the `shutdownMs` budget: shutdown reports that failure and skips later snapshots, the pending write itself cannot be cancelled, and the last stderr bytes may be missing.

### Test fixture preparation

Default checks stay offline and retain the real-adapter integration tests. Prepare the pinned fixture explicitly before the first check:

```bash
node packages/pi-hl-dap/scripts/fetch-vscode-js-debug.mjs
pnpm --filter pi-hl-dap run check
```

Preparation downloads and hash-verifies vscode-js-debug 1.117.0; later preparation calls reuse the matching package-local fixture under `tools/vscode-js-debug/js-debug/`. Offline test setup validates the pinned integrity marker and adapter entry point, and reports preparation instructions when either is missing or invalid. For an incomplete extract, remove its `.fixture-integrity` marker before preparation so the cached marker cannot prevent repair. CI prepares the fixture before checks. Tests use isolated Pi settings and synthetic programs, not repository or personal settings.

## Troubleshooting

**No launch profile is available.** Check that `hlDap.profiles` references a valid adapter. Review startup settings warnings, then run `/reload`.

**The adapter fails to start.** Check the configured command, arguments, transport, and permissions. Inspect the stderr path reported by the error.

**The Debuggee is still running after a wait ends.** Use `hl_dap_status`, `hl_dap_pause`, or `hl_dap_stop`. A timeout or steer yield does not stop it.

**Node repeatedly stops inside the first function.** Remove `stopOnEntry` unless you need an entry stop. See [Adapters](#adapters).

## Update, try or remove

The package is local and unpublished. Update your checkout and workspace dependencies, then restart Pi or run `/reload`.

```bash
pi -e ./packages/pi-hl-dap       # try without installing, from the repository root
pi remove ./packages/pi-hl-dap  # remove the local installation, then restart Pi
```

Do not load the installed package and the one-session copy together.

## Contributing

See [CONTRIBUTING.md](https://github.com/HugoLopes45/pi-extensions/blob/main/CONTRIBUTING.md) for setup, checks and releases. Report bugs on [GitHub Issues](https://github.com/HugoLopes45/pi-extensions/issues), and vulnerabilities through [SECURITY.md](https://github.com/HugoLopes45/pi-extensions/blob/main/SECURITY.md).

## Author

Built by [Hugo Lopes](https://github.com/HugoLopes45), a senior frontend developer based in Paris, passionate about AI and agent harnesses.

## License

[MIT](LICENSE)
