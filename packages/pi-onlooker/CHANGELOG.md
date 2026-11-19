# Changelog

Pi shows the entries newer than your installed version after `pi update`.

## 0.1.4

### Patch Changes

- The package installs and updates with npm again. Earlier versions declared their bundled shared code with pnpm's `workspace:` protocol, which npm rejects with "Unsupported URL Type", for example when Pi updates the package.

## 0.1.3

### Patch Changes

- A Review that passes its 120 s deadline no longer pauses the Onlooker. The next turn's Review covers its turns instead, and the Onlooker pauses only after 3 late Reviews in a row.
- Text from the reviewer model, provider errors and settings now shows without terminal control sequences, so it can no longer change the window title, clear the screen or add hidden links. Line breaks and tabs stay.

## 0.1.2

### Patch Changes

- An unknown key in the `onlooker` settings entry is now reported as `unknown option <key>`. In the `/onlooker` menu, two quick presses on a cycled row now advance it twice instead of writing the same value twice.

## 0.1.1

### Patch Changes

- The README installs from npm and uses neutral display name examples.

## 0.1.0 - 2026-11-16

- First release. A second AI model checks the Pi agent's work and tells it when it breaks your instructions, repeats a failure or claims work it did not do. It works in a private session and reports Blockers, Concerns and Nits, each with evidence.
- Requires Pi 1.5.1 or later. On Pi 1.5.0, grep results for lines that contain a carriage return are hidden.
- Each finding the agent receives states the last turn the Review observed, the number of later turns it did not review, and its evidence as `tool#ref` or a quote. The Onlooker drops a finding whose quote does not occur verbatim in the evidence it was given. This reduces the risk that the agent acts on an outdated or invented finding; it does not prove the finding still applies.
- Concerns and Blockers can trigger one corrective continuation per interactive request. Set `correct` to `false` to disable it. Cancelling during post-run compaction suppresses pending and late corrective continuations until a new user request.
- The Onlooker can only use `read`, `grep`, `find` and `ls`, inside the project and the agent's session file. Secret files are refused.
- The agent can ask the Onlooker a question with `onlooker_ask`.
- With `--no-session`, the Onlooker keeps its private session in memory and writes no file.
- `ONLOOKER.md` files give the Onlooker review guidance the agent never sees.
- The footer shows the Onlooker state with activity, waiting and pause icons, its display name and its model. `/onlooker status` shows the details.
- Set the display name in the `/onlooker` menu or with `/onlooker set name "Inspector gadget"`. Renaming keeps the private session and the attribution of earlier findings.
- At its tool call limit, the Onlooker is asked to report with what it has, instead of being paused.
- The default prompt tells the Onlooker that the agent's choice of tool for a step is not an instruction violation.
- `/onlooker status` shows the cost of Reviews, consultations and compactions separately, and the evidence the Onlooker did not see in full.
- `/onlooker` command and menu with six settings (`enabled`, `name`, `model`, `thinkingLevel`, `reviewEvery`, `correct`) per session, project or global scope, and `/skill:pi-onlooker` for diagnosis. Other limits are fixed. Anthropic Reviews use the 1-hour prompt cache with Pi's `PI_CACHE_RETENTION=long`.
