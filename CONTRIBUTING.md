# Contributing

Small, focused contributions are welcome. Discuss a large behavior change in an issue before you implement it.

## Setup

You need Node.js 22.19 or later. Corepack installs the pnpm version of `package.json`.

```bash
corepack enable pnpm
pnpm install
pnpm run verify
```

To try a package in Pi, run `pi -e ./packages/<package>` from the repository root. Do not load another copy of the same extension in that session.

## Checks

`pnpm run verify` runs `pnpm check` (oxfmt in check mode, then oxlint with type-aware rules through `oxlint-tsgolint`), then each package's `check` script (TypeScript with the shared root `tsconfig.json`, then Vitest offline tests). The tests use fake providers and never call a real model.

Lint rules apply to source and tests alike, including the `typescript/no-unsafe-*` rules. In `packages/*/test/**`, only `no-console`, `no-base-to-string` and `promise/no-callback-in-promise` are off. In `packages/*/scripts/**`, `no-console` is off. One root `.oxlintrc.json` lints every package. Cyclomatic complexity is limited to 10 in pi-context-kit and pi-claude-pro, and to 20 in pi-onlooker. Split a function that is too complex. Inline `oxlint-disable` and `eslint-disable` comments are rejected.

Each package must declare `"type": "module"` in its `package.json`; otherwise, TypeScript `NodeNext` treats its `.ts` files as CommonJS and rejects `import` and `export`.

`.github/workflows/ci.yml` runs `pnpm run verify` on Node 22 and 24, checks each package against its minimum Pi version and the latest Pi, and audits the workflows with zizmor. It runs on pull requests and on pushes to `main`.

## Rules

- Write a failing test first. A bug fix comes with a regression test that fails before the fix. Test through Pi's public API; fake only the model provider.
- Do not weaken tests or input validation to pass checks.
- Use Pi's native features and small changes before new dependencies or abstractions. Host-provided peer dependencies stay `"*"`.
- Keep each extension independent of personal paths, prompts and other extensions. Preserve unrelated user instructions and session content.
- Never put credentials, account data or private conversation content in commits, screenshots or logs. Do not commit environment files, session journals or local agent settings.
- pi-claude-pro: offline tests cannot prove that Anthropic accepts subscription requests. `pnpm --filter pi-claude-pro run check:live` sends a real request with your Pi login and consumes account usage; run it only with the account owner's permission. State whether a change was tested offline, live, or both.
- pi-onlooker: the Onlooker stays read-only. Keep a rule in code, not in the Onlooker Prompt, when code can enforce it.

## Documentation

Each package has the same documentation files: `README.md`, `CHANGELOG.md` and `LICENSE`. Contribution and security rules exist only at the repository root. Do not commit internal documents such as plans or design notes: the code, the tests and the git history are the reference. Documentation is in English only.

A package README has these sections, in this order. Leave out a section only when the package has nothing for it.

1. `# <package>: <what it does for the user>`, the badges, a bold one-sentence pitch, the install command and one line about what to do next.
2. `## Why <package>`: the benefits, as a bullet list. Sections that show the package at work, such as an example, come right after it.
3. `## Quick start`: the requirements in one sentence, then numbered steps.
4. `## Footer`: a table of what the footer shows.
5. `## Commands`: the slash commands.
6. `## How it works`. Sections that explain the behavior further come right after it.
7. `## Settings`.
8. `## Limits`: risks, costs, privacy and what the package cannot do.
9. `## Troubleshooting`: a message or symptom in bold, then the fix.
10. `## FAQ`.
11. `## Update, try or remove`.
12. `## Contributing`, `## Author` and `## License`, with the same text in each package.

Write one paragraph per line. Use `bash` for shell code blocks. Link to files outside the package with absolute GitHub URLs, because npm shows the README without the repository. When behavior changes, update the README and the `Unreleased` section of `CHANGELOG.md` in the same pull request.

## Add an extension

1. Create `packages/<extension>/` with the same layout as the other packages: `extensions/index.ts` as the entry, modules in `src/`, tests in `test/`, and `README.md`, `CHANGELOG.md` and `LICENSE`.
2. Copy `package.json` from another package, then change `name`, `description`, `keywords`, `homepage` and `repository.directory`. Keep `"version": "0.1.0"`, `"type": "module"`, the `check` and `prepublishOnly` scripts, `files`, `engines`, the `pi` manifest and the Pi peer dependencies at `"*"`.
3. Add `tsconfig.json` with `{"extends": "../../tsconfig.json", "include": ["extensions", "src", "test"]}`, and adjust `include` to the folders of the package.
4. In `.oxlintrc.json`, add `packages/<extension>/**` to the `files` of the override that limits `eslint/complexity` to 10.
5. In `.github/workflows/ci.yml`, run the package's `check` script on its minimum Pi version, and add that version to the `pi` matrix if it is new. Add each `@earendil-works/*` package that the extension depends on to `PI_PACKAGES`, so the Pi version jobs pin it.
6. In the root `README.md`, add one row to the Extensions table. Until the first release, write `Not released yet` in the Install column.
7. Run `pnpm install` and `pnpm run verify`.

The first npm version of a new package is published by hand, because npm accepts a trusted publisher only for a package that exists. After it, configure the trusted publisher as described in [Releases](#releases); later versions go through `release.yml`.

## Pull requests

Open a branch or fork, then submit a pull request against `main`. Explain the problem, the minimal fix and the checks you ran. Keep unrelated changes in separate pull requests. Give the pull request a title that describes the user-visible change; release notes are generated from these titles.

## Releases

Only the repository owner publishes. Each package is released on its own:

1. Move the `Unreleased` entries of `packages/<package>/CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`, in words a user understands, and merge to `main`. Pi shows this entry to users after `pi update`.
2. Wait for CI to pass on that commit.
3. Publish a GitHub release with the tag `<package>@vX.Y.Z`, for example `pi-context-kit@v0.4.3`.

`.github/workflows/release.yml` checks the tag, the commit and the changelog entry, sets the version and publishes to npm with trusted publishing, through the `npm` environment. It does not rerun the checks; it relies on CI on `main`. Do not bump the version in pull requests: the tag sets it.

Configure each package's npm trusted publisher with this repository, `release.yml` and the `npm` environment. Restrict that environment to tags `*@v*` and make the owner its required reviewer. A published version cannot be replaced: fix a bad release with a new version.

## Provenance

Imported packages are snapshots of tracked files at a source commit, without lockfiles, nested workspace files or `.github/`, then formatted with oxfmt. Their earlier history stays in the source repositories, which are frozen after the import.

| Package          | Source                       | Commit                                     | License |
| ---------------- | ---------------------------- | ------------------------------------------ | ------- |
| `pi-context-kit` | `HugoLopes45/pi-context-kit` | `3b8199ae051a346f23935002ec594bbe356b0c0e` | MIT     |
| `pi-onlooker`    | `HugoLopes45/pi-onlooker`    | `eb626e20579cce9f65f8a725bdd7c5449eebe0dc` | MIT     |
| `pi-claude-pro`  | `HugoLopes45/pi-claude-pro`  | `0d68b46ccff704477421a24ff9a8db2340ba80e6` | MIT     |

`pi-context-kit` commit `6d7330ff09b61ae801c90735a920beb26e506aa4` is ported afterward by cherry-pick.
