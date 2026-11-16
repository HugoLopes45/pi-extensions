# Pi Extensions

Monorepo for Hugo's Pi extensions. It is the single source of truth for their development, CI and npm releases.

| Package                                     | npm              | Minimum Pi |
| ------------------------------------------- | ---------------- | ---------- |
| [`pi-context-kit`](packages/pi-context-kit) | `pi-context-kit` | 1.0.3      |
| [`pi-onlooker`](packages/pi-onlooker)       | `pi-onlooker`    | 1.5.1      |
| [`pi-claude-pro`](packages/pi-claude-pro)   | `pi-claude-pro`  | 1.0.3      |

## Install

Each package installs on its own: `pi install npm:<package>`, or `pi install ./packages/<package>` from the root of a clone. pi-onlooker is not on npm yet, so use the local path for it.

## Layout

Each extension lives in `packages/<name>/` with its own manifest, README, changelog, license, source and tests. The root uses pnpm workspaces.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, documentation rules and releases, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Migration

Imported packages are snapshots of tracked files at a source commit, without lockfiles, nested workspace files or `.github/`, then formatted with oxfmt. Their earlier history stays in the source repositories, which are frozen after the import.

| Package          | Source                       | Commit                                     | License |
| ---------------- | ---------------------------- | ------------------------------------------ | ------- |
| `pi-context-kit` | `HugoLopes45/pi-context-kit` | `3b8199ae051a346f23935002ec594bbe356b0c0e` | MIT     |
| `pi-onlooker`    | `HugoLopes45/pi-onlooker`    | `eb626e20579cce9f65f8a725bdd7c5449eebe0dc` | MIT     |
| `pi-claude-pro`  | `HugoLopes45/pi-claude-pro`  | `0d68b46ccff704477421a24ff9a8db2340ba80e6` | MIT     |

`pi-context-kit` commit `6d7330ff09b61ae801c90735a920beb26e506aa4` is ported afterward by cherry-pick.

Do not commit credentials, environment files, session journals or local agent settings.
