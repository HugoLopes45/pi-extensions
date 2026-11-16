# Contributing

## Setup

You need Node.js 22.22.1 or later and pnpm 12.18. `mise install` installs both from `mise.toml`.

```bash
pnpm install
pnpm run verify   # vp check (format, lint, type check), tests
pnpm run format   # fix formatting in src and test
```

Try your copy in Pi:

```bash
pi -e ./src/index.ts
```

## Code map

| Path                                              | Role                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/index.ts`                                    | Extension entry: events, `onlooker_ask`, footer.                          |
| `src/onlooker-observer.ts`                        | Scheduling, Reviews, delivery, pause, projection settings and spend.      |
| `src/onlooker-findings.ts`                        | Finding normalization, selection and evidence validation.                 |
| `src/onlooker-session.ts`                         | The private Onlooker Session.                                             |
| `src/onlooker-evidence.ts`                        | Review Evidence, Context Seed and seed notes.                             |
| `src/onlooker-contract.ts`                        | Onlooker Prompt, `onlooker_report` schema, severities.                    |
| `src/onlooker-calibration.ts`                     | Token calibration per model.                                              |
| `src/protected-tools.ts`                          | The read tools and their path rules.                                      |
| `src/onlooker-settings.ts`                        | Settings, defaults and scopes.                                            |
| `src/onlooker-command.ts`, `src/onlooker-menu.ts` | `/onlooker` command and menu.                                             |
| `src/onlooker-rendering.ts`                       | Status and message rendering.                                             |
| `src/utils/evidence.ts`                           | Evidence projection, text caps and capped-result counts.                  |
| `src/utils/expand-on-click.ts`                    | Mouse expansion and its per-item state.                                   |
| `src/utils/ui.ts`                                 | Presentation primitives and tool duration tracking.                       |
| `src/utils/`                                      | Code with no Onlooker knowledge.                                          |
| `test/`                                           | Vitest tests. `test/fixtures/` runs real Pi sessions with fake providers. |

## Rules

- Read [docs/design.md](docs/design.md) before you change behavior. Use the terms of [GLOSSARY.md](GLOSSARY.md).
- Write a failing test first. Test through Pi's public API; fake only the model provider.
- Keep a rule in code, not in the Onlooker Prompt, when code can enforce it.
- The Onlooker must stay read-only. Never add a tool that writes, runs commands or reaches the network.
- Use Pi's native features before you add code. Add no runtime dependency without a discussion.
- In the same pull request, update `README.md`, `docs/design.md`, `GLOSSARY.md` and the `Unreleased` part of `CHANGELOG.md` when behavior changes.
- Markdown: one paragraph per line.

## Pull requests

CI must pass `Check (Node 22)` and `Check (Node 24)`. On Node 24, CI also checks the oldest supported Pi (1.5.1) and the latest Pi.

## Releases

Follow [Release](../../README.md#release) in the monorepo README, with the tag `pi-onlooker@vX.Y.Z`. For the first release, also remove the "Not on npm yet" note from `README.md`.
