---
name: pi-onlooker
description: Diagnose pi-onlooker. Use when Reviews do not run, a finding never arrives, findings miss the point, onlooker_ask is missing or fails, the Onlooker is paused, or it costs too much.
license: MIT
disable-model-invocation: true
---

# Diagnose pi-onlooker

Goal: find the cause and give the user the command that fixes it.

Rules:

- Only the user can run `/onlooker`. Give the exact command, then wait for the pasted output.
- Do not edit `settings.json`. The extension reads it only at startup and on `/reload`.
- Base each conclusion on status output. If the output does not show the cause, say "Cause unknown".

## Steps

1. Ask the user to run `/onlooker status` and paste the output.
2. Find the first matching row below. Give its fix.
3. Ask for `/onlooker status` again. Fixed when it shows the intended settings, no error, and the symptom is gone.

## Symptoms

| Status shows                                                | Cause                                                     | Fix                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `enabled` false                                             | Off by default.                                           | `/onlooker on --global`. Without a flag, it lasts this session only.                  |
| error `Onlooker project settings require a trusted project` | Project settings need a trusted project.                  | Trust the project, or use `--global`.                                                 |
| paused, with an error                                       | A Review or `onlooker_ask` failed.                        | Fix the named cause, then `/onlooker on`.                                             |
| error `Onlooker model is unavailable`                       | `model` names a model with no credentials or no entry.    | `/onlooker set model "provider/model-id" --global`, then `/onlooker on`.              |
| error `Onlooker review deadline exceeded`                   | A Review took more than 120 s.                            | Faster `model` or lower `thinkingLevel`. Then `/onlooker on`.                         |
| `N findings without valid evidence dropped`                 | The finding cited no `ref` or quote, or an unknown `ref`. | If frequent, use a stronger `model`.                                                  |
| `N Reviews ended by invalid reports`                        | The model sent 2 invalid `onlooker_report` calls.         | If frequent, use a stronger `model`.                                                  |
| high cost                                                   | Each Review re-reads the Onlooker history.                | In this order: `reviewEvery` `"request"`, a cheaper `model`, a lower `thinkingLevel`. |

Other symptoms:

- **No Review.** `reviewEvery` `"turn"` skips a turn that only reads. `N` and `"request"` wait for their cadence point. A failed tool call always starts a Review.
- **`onlooker_ask` missing.** The tool exists only while `enabled` is true. While paused, it returns the pause reason.
- **A finding ignores long tool output.** Results longer than 4,000 characters keep their start and end; the Onlooker can `read` the full result in the session file.

## Reply

1. Bold first line: the cause and the fix, in one sentence.
2. The commands to run.
3. `Verdict: Fixed`, `Verdict: Not fixed` or `Verdict: Cause unknown`.
4. `**Next:**` one action.
