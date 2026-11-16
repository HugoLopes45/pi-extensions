# Changelog

Pi shows the entries newer than your installed version after `pi update`.

## [Unreleased]

- Requires Pi 1.5.1 or later. On Pi 1.5.0, grep results for lines that contain a carriage return are hidden.
- Findings no longer wait for revalidation after newer turns, and Concern cooldowns and per-request Nit caps are removed. Evidence validation and deduplication remain.
- Concerns and Blockers can trigger one corrective continuation per interactive request. Set `correct` to `false` to disable it. Cancelling during post-run compaction suppresses pending and late corrective continuations until a new user request.

- The footer uses fixed activity, waiting and pause icons instead of state labels or a backlog count. It retains the display name and model. Detailed status remains available through `/onlooker status`.

- Set the display name in the `/onlooker` menu or with `/onlooker set name "Inspector gadget"`. Renaming preserves the private session and earlier findings’ attribution.

- First release. A second AI model checks the Pi agent's work and tells it when it breaks your instructions, repeats a failure or claims work it did not do. It works in a private session and reports Blockers, Concerns and Nits, each with evidence.
- The Onlooker can only use `read`, `grep`, `find` and `ls`, inside the project and the agent's session file. Secret files are refused.
- The agent can ask the Onlooker a question with `onlooker_ask`.
- With `--no-session`, the Onlooker keeps its private session in memory and writes no file.
- `ONLOOKER.md` files give the Onlooker review guidance the agent never sees.
- The footer shows the Onlooker state and its model.
- At its tool call limit, the Onlooker is asked to report with what it has, instead of being paused.
- The default prompt tells the Onlooker that the agent's choice of tool for a step is not an instruction violation.
- `/onlooker status` shows the cost of Reviews, consultations and compactions separately, and the evidence the Onlooker did not see in full.
- `/onlooker` command and menu with six settings (`enabled`, `name`, `model`, `thinkingLevel`, `reviewEvery`, `correct`) per session, project or global scope, and `/skill:pi-onlooker` for diagnosis. Other limits are fixed. Anthropic Reviews use the 1-hour prompt cache with Pi's `PI_CACHE_RETENTION=long`.
