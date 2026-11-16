# Pi Extensions

Monorepo for Hugo's Pi extensions. It is the single source of truth for their development, CI and npm releases.

| Package                                     | npm              | Minimum Pi |
| ------------------------------------------- | ---------------- | ---------- |
| [`pi-context-kit`](packages/pi-context-kit) | `pi-context-kit` | 1.0.3      |
| [`pi-onlooker`](packages/pi-onlooker)       | `pi-onlooker`    | 1.5.1      |
| [`pi-claude-pro`](packages/pi-claude-pro)   | `pi-claude-pro`  | 1.0.3      |

## Install

Each package installs on its own: `pi install npm:<package>`, or a local path to `packages/<package>`.

## Layout

Each extension lives in `packages/<name>/` and keeps its own manifest, README, changelog, source and tests. The root uses pnpm workspaces.

## Checks

Run `pnpm run verify`. It runs `pnpm check` (oxfmt in check mode, then oxlint with type-aware rules through `oxlint-tsgolint`), then each package's `check` script (TypeScript and offline tests), then the pi-onlooker test suite.

Each package must declare `"type": "module"` in its `package.json`; otherwise, TypeScript `NodeNext` treats its `.ts` files as CommonJS and rejects `import` and `export`.

Lint rules apply to source and tests alike, including the `typescript/no-unsafe-*` rules. In `packages/*/test/**`, only `no-console`, `no-base-to-string` and `promise/no-callback-in-promise` are off. In `packages/*/scripts/**`, `no-console` is off. Cyclomatic complexity is limited to 10 in pi-context-kit and pi-claude-pro, and to 20 in pi-onlooker (its `vite.config.ts`). Inline `oxlint-disable` and `eslint-disable` comments are rejected.

## CI

`.github/workflows/ci.yml` runs `pnpm run verify` on Node 22 and 24, checks each package against its minimum Pi version and the latest Pi, and audits the workflows with zizmor.

## Release

Each package is released on its own:

1. Add a `## [X.Y.Z]` entry to `packages/<package>/CHANGELOG.md` on `main`.
2. Wait for CI to pass on that commit.
3. Publish a GitHub release with the tag `<package>@vX.Y.Z`.

`.github/workflows/release.yml` checks the tag, the commit and the changelog entry, sets the version and publishes to npm with trusted publishing, through the `npm` environment. It does not rerun the checks; it relies on CI on `main`.

Configure each package's npm trusted publisher with this repository, `release.yml` and the `npm` environment. Restrict that environment to tags `*@v*` and make the owner its required reviewer. A published version cannot be replaced: fix a bad release with a new version.

## Migration

Imported packages are snapshots of tracked files at a source commit, without lockfiles, nested workspace files or `.github/`, then formatted with oxfmt. Their earlier history stays in the source repositories, which are frozen after the import.

| Package          | Source                       | Commit                                     | License |
| ---------------- | ---------------------------- | ------------------------------------------ | ------- |
| `pi-context-kit` | `HugoLopes45/pi-context-kit` | `3b8199ae051a346f23935002ec594bbe356b0c0e` | MIT     |
| `pi-onlooker`    | `HugoLopes45/pi-onlooker`    | `eb626e20579cce9f65f8a725bdd7c5449eebe0dc` | MIT     |
| `pi-claude-pro`  | `HugoLopes45/pi-claude-pro`  | `0d68b46ccff704477421a24ff9a8db2340ba80e6` | MIT     |

`pi-context-kit` commit `6d7330ff09b61ae801c90735a920beb26e506aa4` is ported afterward by cherry-pick.

Do not commit credentials, environment files, session journals or local agent settings.
