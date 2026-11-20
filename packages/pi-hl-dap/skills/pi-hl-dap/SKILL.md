---
name: pi-hl-dap
description: Configure or diagnose Pi HL DAP when an Adapter Definition or Launch Profile fails, a Debug Session is stuck, or breakpoints do not bind.
license: MIT
disable-model-invocation: true
---

# Pi HL DAP troubleshooting

## Rules

- Ask the user before each call that runs or changes the Debuggee: `hl_dap_launch`, `hl_dap_set_breakpoints` (a `condition` runs as Debuggee code), `hl_dap_continue`, `hl_dap_next`, `hl_dap_step_in`, `hl_dap_step_out`, `hl_dap_evaluate`, `hl_dap_pause`, `hl_dap_stop`.
- Settings fields and semantics come only from the Settings section of [`../../README.md`](../../README.md). Do not invent fields.
- Settings changes apply only after the user runs `/reload`. You cannot run it; ask the user.

## Procedure

1. Find the effective Adapter Definition and Launch Profile. Pi HL DAP reads the `hlDap` key from global `settings.json` and trusted project `.pi/settings.json`. A project entry replaces the global entry with the same ID; `null` removes it.
2. Call `hl_dap_status` for the Debug Session state. Read the path-qualified settings warnings shown at session start, and the adapter stderr file whose path the failure names.
3. Without launching, check that the adapter `command` exists and that the files named in its `args` and in the profile `arguments` exist.
4. To change settings: edit one settings file, check that it parses as JSON, then ask the user to run `/reload`.
5. With approval, launch once. Stop when the Debug Session reaches the expected state, or when one exact adapter or protocol error remains. Quote that error verbatim.

## Known causes

| Symptom                                                                                                                       | Cause                                                                                                                                                     | Fix                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown Launch Profile`, `launch requires profile`, or `references unavailable Adapter Definition`                           | Profile missing or invalid, or its `adapter` ID is not a valid Adapter Definition                                                                         | Fix the entry named by the settings warning, then `/reload`                                                                                        |
| Adapter process or protocol failure                                                                                           | Wrong `command`, `args`, `transport`, or permissions                                                                                                      | Read the stderr path named in the error                                                                                                            |
| `running (wait timed out)` or `running (wait steered)`                                                                        | The wait ended; the Debuggee still runs                                                                                                                   | Call `hl_dap_status`, then ask before `hl_dap_pause` or `hl_dap_stop`                                                                              |
| `running (no stop after pause)`                                                                                               | The pause wait ended without a confirmed stop                                                                                                             | Call `hl_dap_status`, then ask before `hl_dap_stop`                                                                                                |
| `vscode-js-debug`: repeated stops with reason `entry` inside the program's first function, with no `hit breakpoint ids:` line | The profile sets `stopOnEntry`; js-debug's entry breakpoint moved into that function                                                                      | Remove `stopOnEntry` from the Launch Profile                                                                                                       |
| `vscode-js-debug`: breakpoints in worker threads or child processes never bind, no `child session:` line                      | Child sessions need promoted sessions (from `"preset": "vscode-js-debug"` or `channels.sessions: "promoted"`) and a TCP transport; stdio cannot host them | Make the effective sessions `promoted`: set `"preset": "vscode-js-debug"` and remove any `channels.sessions: "root"` override. Use a TCP transport |
| Result lists `rejected_child_sessions`                                                                                        | Pi HL DAP could not debug that child; its breakpoints never bind                                                                                          | If the child's file runs standalone, launch it as `program`                                                                                        |

## Child sessions (`vscode-js-debug` preset)

- A stop in a worker thread or child process names it in a `child session:` line (`child_session` in `structuredContent`). One stop is reported at a time; stack, variables, evaluate, continue, and step act on that stop.
- To run child processes without a debugger, pass `launch_arguments: { autoAttachChildProcesses: false }` to `hl_dap_launch`. Worker threads have no such switch.
