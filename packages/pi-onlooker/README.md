# pi-onlooker

**A second pair of eyes for the Pi coding agent.** A second AI model checks the agent's work while it runs. When the agent gets something wrong, the Onlooker tells it, and the agent fixes it before you have to.

Coding agents sometimes say "done, all tests pass" when the last test run failed. They skip one of your instructions, or retry the same broken command again and again. pi-onlooker catches these problems for you.

## Install in two steps

> **Not on npm yet.** Until the first release, step 1 fails. Use a local copy instead: `pi install ./pi-onlooker` from the folder that contains your clone.

1. Install the package:

   ```bash
   pi install npm:pi-onlooker
   ```

2. In Pi, turn it on for all your projects:

   ```text
   /onlooker on --global
   ```

That is all. The footer now shows `○  Onlooker` and the Onlooker model while waiting for work. To stop, run `/onlooker off --global`.

You need Pi 1.5.1 or later and Node.js 22.19 or later. The Onlooker stays off until you turn it on.

## What you see

The agent writes "All tests pass." After the Review, the agent receives this message:

```text
Onlooker blocker: The agent says the tests pass, but the last test run (ref kX3b9_Qa) failed.
```

The agent reads it at its next step and corrects its work. You do nothing.

## What it catches

- An instruction that the agent broke, or work that you did not ask for.
- A failure that the agent repeats without a change.
- A claim such as "tests pass" or "done" that the work does not prove.
- A small cleanup worth doing.

Each finding points to its proof: a tool call or a quote from the session. The Onlooker drops a finding without proof, so it does not nag with vague opinions.

## Before you install

- **It only reads.** It cannot edit files, run commands or use the network. It never blocks the agent and never overrides you. Failures pause it while the agent continues, except an exhausted consultation quota. See [Privacy and access](#privacy-and-access).
- **It costs model calls.** Each Review is a paid request to the model that you pick. For the lowest cost, use one Review per request: `/onlooker set reviewEvery "request" --global`. `/onlooker status` shows what you spent. See [Cost](#cost).
- **It sees your conversation.** The Onlooker model receives the agent's conversation. Pick a provider that you trust with it. It refuses secret files such as `.env` and private keys.
- **It uses the models you already have.** By default, it uses the agent's model. You can pick any model that Pi can use.
- **It rarely makes the agent wait.** The agent waits, at most 30 s, only when 3 turns are not yet reviewed.

pi-onlooker is for people who let the Pi agent work alone on longer tasks and want fewer false "done" messages. It is advice, not a gate: if you need to block commands before they run, use a permission extension, such as Pi's `permission-gate` example, instead.

## How it works

After the agent finishes a turn, the Onlooker reviews it. Each finding has a severity:

| Severity  | Use                                 | Effect                                      |
| --------- | ----------------------------------- | ------------------------------------------- |
| `blocker` | Wrong or unsafe work, false claims. | Steers the running agent.                   |
| `concern` | A real risk or a likely wrong path. | Steers the running agent.                   |
| `nit`     | Small, low-risk cleanup.            | Added to the conversation without steering. |

Steering is Pi's native message queue: the agent reads the finding at its next step, without an abort. Findings are advice: the agent decides whether each applies. After a Concern or Blocker, in an interactive session, the Onlooker starts one hidden turn when the run ends (a Corrective Turn): the agent decides what to do with the findings, then continues your task. Set `correct` to `false` to turn this off. The Onlooker never blocks a tool and never overrides you. Failures pause it while the agent continues, except an exhausted consultation quota.

The agent can also ask the Onlooker a question with the `onlooker_ask` tool. The answer is plain Markdown and creates no finding. After 8 investigative calls, further calls are blocked and the model gets one turn to conclude. If it requests more tools on that turn, the consultation fails without pausing automatic Reviews. Supply the diff in the question or observed context for a change review: the Onlooker has no Git command tool.

## Footer

| Footer                           | State                                                                     |
| -------------------------------- | ------------------------------------------------------------------------- |
| `○  Onlooker · claude-haiku-4-5` | Waiting for the next Review; dim indicator.                               |
| `●  Onlooker · claude-haiku-4-5` | Reviewing or answering `onlooker_ask`; colored activity indicator.        |
| `!  Onlooker · claude-haiku-4-5` | Paused; warning-colored indicator. See `/onlooker status` for the reason. |
| nothing                          | Off.                                                                      |

The footer uses the configured display name and shows the model without its provider. The backlog count stays in `/onlooker status`, not in the footer.

## Commands

```text
/onlooker                     settings menu
/onlooker status              state, settings, backlog, cost, last error
/onlooker on | off            enable, disable, or resume after a pause
/onlooker set <key> <JSON>    change a setting
/onlooker inherit [key]       remove a setting at this scope (no key: enabled)
```

A change applies to the current session only. Add `--project` or `--global` to save it. The session value wins over the project value, which wins over the global value. Project settings need a trusted project.

Values are JSON, so put text in quotes: `/onlooker set model "anthropic/claude-haiku-4-5"`.

## Settings

You can also write them in Pi's `settings.json` (`~/.pi/agent/settings.json` or `.pi/settings.json`), under `onlooker`:

```json
{ "onlooker": { "enabled": true, "model": "anthropic/claude-haiku-4-5", "reviewEvery": "request" } }
```

| Key             | Default           | Meaning                                                                                                 |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `name`          | `"Onlooker"`      | Display name, such as `"Marcel"` or `"Inspector gadget"`.                                               |
| `enabled`       | `false`           | Onlooker on or off.                                                                                     |
| `model`         | the agent's model | `"provider/model-id"` for Reviews and `onlooker_ask`.                                                   |
| `thinkingLevel` | `"high"`          | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` or `"max"`. Never copied from the agent. |
| `reviewEvery`   | `"turn"`          | `"turn"`, `"request"` or a number of turns. See below.                                                  |
| `correct`       | `true`            | After a Concern or Blocker, start one Corrective Turn so the agent continues.                           |

Other limits are fixed: at most 4 findings per Review, 1 Corrective Turn per request, 8 tool calls and 120 s per Review or `onlooker_ask` call, tool results cut to 4,000 characters, a first Context Seed of a quarter of the model's context window (at most 50,000 tokens), and compaction of the Onlooker history past half the window (at most 100,000 tokens). The agent waits for the running Review, at most 30 s, when 3 turns are not yet reviewed. The Onlooker always sees the agent's reasoning. For a 1-hour Anthropic prompt cache, set Pi's `PI_CACHE_RETENTION=long`; OpenAI Reviews always use the long cache.

### Display name

Open `/onlooker`, select `name`, and enter Marcel or Inspector gadget. Spaces are allowed; blank names, surrounding whitespace and control characters are rejected. Enter `inherit` to remove the selected scope’s override.

To save a name globally, run `/onlooker set name "Inspector gadget" --global`. The name appears in the footer, status and findings. Renaming keeps the private session and earlier findings’ attribution unchanged. The menu title, `/onlooker` command and `onlooker_ask` tool identifier stay fixed.

### `reviewEvery`

- `"turn"`: a Review after each turn that changes something. A turn that only reads waits for the next Review.
- a number `N`: a Review every N turns and at the end of the request.
- `"request"`: one Review at the end of the request. Cheapest; findings come after the agent stops.

A failed tool call starts a Review at once, whatever the value.

### `ONLOOKER.md`

Write what the Onlooker should watch for in an `ONLOOKER.md` file. The agent never sees it. The Onlooker reads `~/.pi/agent/ONLOOKER.md`, then `ONLOOKER.md` and `.pi/ONLOOKER.md` in each folder from the git root (or your home folder) down to the working folder. All files apply, in that order. Project guidance files and their `.pi` directories must not be symlinks; such links stop session creation. The Onlooker already judges the agent against the agent's own `AGENTS.md` files, so do not copy them here.

## Cost

Each Review can make several paid requests to the Onlooker model. Each request resends its active private history; cache savings depend on the provider. Seed and compaction budgets are estimates, not spending caps. To pay less: `reviewEvery: "request"`, a cheaper `model`, or a lower `thinkingLevel`. `/onlooker status` shows, separately for Reviews, consultations and compactions: model calls, input, cache and output tokens, cost and time. It also counts the observed messages the Onlooker did not see in full.

## Privacy and access

- The Onlooker model receives the agent's conversation. Pick a provider you trust with it.
- The Onlooker runs in its own private Pi session, with the agent's providers and credentials. That session loads no other extension, skill or context file.
- Its tools can only read: `read`, `grep`, `find`, `ls`. They see the project folder, but cannot read the observed session journal, even inside that folder. They refuse known secret filenames such as `.env`, private keys, credentials and `.git`. Paths containing Unicode spaces that Pi rewrites are rejected.
- The extension itself runs with Pi's permissions. Install it only if you trust it.

## When something goes wrong

Run `/onlooker status` first. It shows the error and the counts of withheld and dropped findings. For a guided diagnosis, run `/skill:pi-onlooker`.

| Message                                               | Fix                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `Onlooker: paused: ...`                               | Fix the cause in the message, then `/onlooker on`.            |
| `Onlooker model is unavailable: ...`                  | Set a model from `/model`, or `/onlooker inherit model`.      |
| `Onlooker review deadline exceeded`                   | Faster `model` or lower `thinkingLevel`. Then `/onlooker on`. |
| `Onlooker project settings require a trusted project` | Trust the project, or use `--global`.                         |
| `... is not JSON; quote text values ...`              | Put the value in quotes.                                      |

## More

- [docs/design.md](docs/design.md): exact rules for evidence, scheduling, delivery and cost.
- [GLOSSARY.md](GLOSSARY.md): the terms.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md).

MIT license.
