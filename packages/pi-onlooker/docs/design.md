# Design

The exact behavior of pi-onlooker. Terms in capitals are defined in [GLOSSARY.md](../GLOSSARY.md). Keep this file true to the code: change it in the same pull request as the behavior.

## Principles

1. The Onlooker advises. It never vetoes, cancels a tool, or overrides the user.
2. Rules live in code, not in the prompt. A custom Onlooker Prompt cannot change tools, evidence checks, caps or delivery.
3. Observed content is data. The Onlooker never follows instructions found in it.
4. Failures pause the Onlooker except an exhausted consultation quota. They never stop the agent.
5. One Onlooker per agent session. An Onlooker Session is never observed.

## Onlooker Session

- One private Pi session per observed session. It is persisted only when the observed session has a session file; with `--no-session` it stays in memory.
- Loads no extension, skill, context file, prompt template or theme. System prompt: the Onlooker Prompt, then one `Especially pay attention to:\n<attention>…</attention>` block per non-empty `ONLOOKER.md`: `<agentDir>/ONLOOKER.md`, then `ONLOOKER.md` and `.pi/ONLOOKER.md` in each folder from the git root (else home, else the working folder alone) down to the working folder. Read when the session is built. The agent's `AGENTS.md` files reach the Onlooker as evidence, inside the Observed Setup, never as its own instructions.
- Shares the agent's model registry and credentials.
- Model: `model`, or the agent's model. When the agent changes model and `model` is unset, the session resets.
- Thinking level: `thinkingLevel`, default `high`, never the agent's. Reasoning tokens bill as output, so following `xhigh` or `max` costs more; a fixed level also avoids a reset when the agent changes level.
- Tools: the protected `read`, `grep`, `find`, `ls`, plus `onlooker_report`. Paths resolve through symlinks and must stay in the project folder. The observed journal is explicitly denied, including in-project paths and symlink aliases. Paths containing spaces that Pi normalizes are refused before SDK dispatch. Secret names are refused in any letter case: `.env*` (except `.env.example`, `.env.sample`, `.env.template`), `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ecdsa_sk`, `id_ed25519`, `id_ed25519_sk`, `*.pem`, `*.key`, `*.p8`, `*.ppk`, `*.p12`, `*.pfx`, `*.jks`, `*.tfvars`, `*.tfstate`, `*.tfstate.backup`, and files named `secret`, `credential`, `token` or `password` (or their plurals) with no extension or a data extension (`.json`, `.yaml`, `.toml`, `.env`, `.txt` and similar). Source files such as `token.ts` stay readable.
- Display name: `name`, default `Onlooker`. A rename does not rebuild the session. Each delivered finding records its name; delayed continuations refer to findings without assuming the current name matches.
- Rebuilt on: a setting change other than `name`, a branch or session change, a compaction of the observed session, a resume after a pause, or new evidence larger than the seed budget.

## Review Evidence

What the observed model received, as JSON:

| Kept                                | Removed                     | Marked                                          |
| ----------------------------------- | --------------------------- | ----------------------------------------------- |
| roles, text, reasoning text, images | replay signatures           | redacted reasoning                              |
| tool calls with arguments           | display-only tool `details` | responses ended by error, abort or output limit |
| tool-result text with error status  | provider metadata, IDs      |                                                 |

Each tool call and its result share a `ref`: the first 8 base64url characters of the SHA-256 of the native call ID.

A tool result longer than 4,000 characters keeps its first and last 2,000 characters around `[… N characters omitted from this tool result; the full result is not available to this Onlooker]`. Other text is never cut. Same input, same bytes, so the prompt cache stays valid.

## Context Seed

Sent with the first Review or Consultation of an Onlooker Session. Later prompts carry only new messages.

Always included:

1. Observed Setup: the agent's system prompt, and each tool's name with a one-line summary.
2. Original request: the first user-typed message; after a compaction, the compaction summary plus the first user-typed message after it. Compaction summaries, findings, other extension messages and `!` output never count as requests.
3. The newest turn and the request that started it.

Then the newest older turns that fit. A turn (an assistant message with all its tool results) is never split. Text that does not fit is shortened with a marker. When messages are left out, the seed lists the positions of the kept ones and states that omitted evidence is unavailable. Left-out messages are never sent later.

Budget: window / 4 (window 128,000 if the model declares none), at most 50,000 tokens. When new evidence exceeds the budget, the session is rebuilt from a new seed.

## Token calibration

Budgets are in tokens as the provider reports them. Pi estimates 1 token per 4 characters, which is too low for JSON. The estimate is multiplied by a factor per model:

- Start: 2.
- Sample: a prompt adding at least 2,000 estimated tokens. Ratio = (reported input tokens of its first response − session size before) / estimate.
- Update: factor = ratio rounded up to 0.25, within 1 to 3, only if the ratio is more than 0.05 above or 0.35 below the factor. The dead band keeps the prompt cache stable.
- Kept in memory only: back to 2 after a reload.

## Scheduling

The Review Backlog counts completed turns not yet covered. A Review covers the whole backlog.

| `reviewEvery` | A Review starts                              |
| ------------- | -------------------------------------------- |
| `"turn"`      | after each turn that is not a Read-only Turn |
| `N`           | every `N` turns, and when the request ends   |
| `"request"`   | when the request ends                        |
| any           | at once after a turn with a failed tool call |

Read-only Turn: at least one tool call, all of them built-in `read`, `grep`, `find`, `ls`, or tools with `readOnlyHint: true`. `bash`, unknown tools, no tool call, or an abnormal end disqualify the turn. Only `"turn"` treats them specially.

Catch-up Wait: after each turn, while the backlog is at least 3 turns and a Review runs, the agent waits, 30 s at most. No running Review, no wait.

Headless end: the Onlooker waits up to 120 s for the remaining Reviews, then cancels an unfinished one.

Each Review or Consultation permits 8 investigative calls. Further calls in the same model turn are blocked with an instruction to conclude. The next model turn may report or answer; another investigative call aborts the operation. Batched calls cannot count as ignoring a warning they have not received yet.

## Findings

A Review ends with one `onlooker_report` call: `findings[]`, each with `severity`, `message`, `evidence: { refs?, quote? }`.

- At least one `ref` or a `quote` is required by the schema.
- A finding is dropped if it has no evidence or cites a `ref` never sent to this Onlooker Session. Quotes are not checked.
- An invalid call is rejected with the reason. After 2 invalid calls the Review ends with no findings; the Onlooker does not pause.
- At most 4, ordered blocker, concern, nit.
- A finding equal to a delivered one (after text normalization) is skipped unless its severity is higher.

### Delivery

Findings are delivered when their Review ends, even if the agent completed newer turns during the Review. The agent judges whether a finding still applies.

| Severity  | Agent running     | Agent stopped    |
| --------- | ----------------- | ---------------- |
| `nit`     | context, no steer | context, no turn |
| `concern` | steer             | context, no turn |
| `blocker` | steer             | context, no turn |

- Corrective Turn: after a delivered Concern or Blocker, one hidden turn when the run ends, so an unattended agent continues. Conditions: `correct` on, interactive mode only, a normal end (no abort, no error), at most 1 per request. Its hidden prompt: "Consider the findings reported above. Act on those that apply; you decide. Then continue the user's task until it is done." When the findings arrive before the run ends, Pi's `agent_before_settle` hook continues the same run (`continue: true`). When a Review ends after settlement, the Onlooker starts a new run with `triggerTurn`.
- A request starts at a user prompt. The Corrective Turn count resets at the next one.
- The agent sees `<name> <severity>: <message>`, using the configured name at delivery. The evidence and recorded name stay in the message details.

## Compaction of the Onlooker Session

After a Review, if the Onlooker Session is larger than window / 2 (128,000 fallback), at most 100,000 tokens, Pi's native compaction summarizes it. The summary keeps the observed request and instructions, reported findings, open concerns, and what the Onlooker verified.

- Pi keeps `compaction.keepRecentTokens` of recent history.
- Runs after delivery, with its own 120 s limit. Its cost counts under compactions.
- On failure or timeout, the session is discarded and the next Review starts from a new seed. No pause.
- Why 100,000: every Review re-reads the whole session, so cost per Review follows session size, not window size. The cap trades verbatim recall of old evidence for cheaper Reviews; read tools cannot recover omitted evidence from the raw journal.

## Cost reporting

`/onlooker status` shows the totals since the session start or the last reload, separately for Reviews, consultations and compactions: operations, model calls, input, cache read, cache write and output tokens, cost and wall time. Operations that prompted the model count, including failed and cancelled ones; a compaction that Pi declines does not. No known price: `cost unknown`. A native compaction records one aggregated response even if the SDK makes multiple summary requests; its token totals are aggregated, but its displayed call count is not a request counter. It also counts the Context Seeds sent, the observed messages they omitted or shortened, and the tool results capped at 4,000 characters in the evidence sent.

## Prompt cache retention

Set per request on the Onlooker's own requests. Never `PI_CACHE_RETENTION`; the agent's requests are unchanged.

| Provider    | Retention                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------- |
| `openai`    | Always long (`prompt_cache_retention: "24h"`). Free.                                         |
| `anthropic` | Pi default: 1 h only with `PI_CACHE_RETENTION=long` (writes cost 2× input instead of 1.25×). |
| others      | Pi default.                                                                                  |

## Failures

Pi's retries apply first. Then, if a Review or Consultation fails, times out, or has no model, the Onlooker pauses with the reason. Consultation tool-quota exhaustion is local to that call: it returns an error and discards its aborted private runtime without pausing automatic Reviews. It never switches model on its own. `enabled` stays true. `/onlooker on`, a setting change or the menu's Resume line restarts it.
