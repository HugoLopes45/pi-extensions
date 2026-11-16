# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Small, focused contributions are welcome. Discuss large behavior changes in an issue before implementing them.

## Local checks

Use Node.js 22.19 or later. CI checks Node 22 and 24.

```bash
pnpm install
pnpm run check
```

`pnpm run check` validates TypeScript and the offline tests. `pnpm check` at the monorepo root validates formatting and lint, including cyclomatic complexity (at most 10 per function). Split a function that is too complex; inline `oxlint-disable` and `eslint-disable` comments are rejected. The tests use Pi's faux provider, not a real model.

CI also installs Pi `1.0.3`, the oldest supported version, and the latest published Pi packages on Node 24, and reruns these checks.
Keep the lockfile baseline reproducible; do not replace it with an unbounded dependency tree. Host-provided peer dependencies stay `*`.

For an optional manual test in Pi:

```bash
pi -e .
```

Do not load another copy of this extension in the same session.

## Changes

- Keep the extension independent of personal paths, prompts, and other extensions.
- Preserve unrelated user instructions and session content.
- Prefer existing Pi APIs and small changes over new dependencies or abstractions.
- Add a regression test for a bug and check that it fails before the fix.
- Do not weaken tests or input validation to pass checks.
- Update the English and the Simplified Chinese version of a document in the same pull request.
- Give the pull request a title that describes the user-visible change. Release notes are generated from these titles.
- Never include credentials, account data, or private conversation content in commits, screenshots, or logs.

## Pull requests

Open a branch or fork, then submit a pull request against `main`.

Explain the problem, the minimal fix, and the checks you ran. Keep unrelated changes in separate pull requests.

`main` requires a pull request and successful `Check (Node 22)` and `Check (Node 24)` checks against the current base.
No third-party approval is required, so a solo maintainer can merge after CI succeeds.

## Releases

Follow [Release](../../README.md#release) in the monorepo README, with the tag `pi-context-kit@vX.Y.Z`. Do not bump the package version in pull requests. Write `CHANGELOG.md` in English only, because Pi reads only this file.

## Security

Use the [private reporting process](SECURITY.md) for vulnerabilities. Do not put exploit details or credentials in a public issue.
