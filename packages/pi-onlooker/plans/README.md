# Architecture refactor plans

**Initial analysis baseline:** d6d233c plus the pre-existing dirty working tree in `../pi-onlooker`.
**Implementation baseline:** 19935e9, handed over by the CTO with tracked files unchanged.

The user initially selected planning only with hl-improve, then authorized the agreed refactor. The first tranche is implemented in `253a311` and verified locally. CI remains unverified.

## Execution order

| Priority | Plan                                                                                 | Status                             | Dependencies                                         |
| -------- | ------------------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------- |
| 1        | [001: Split cohesive responsibilities](001-split-cohesive-responsibilities.md)       | Implemented locally; CI unverified | CTO baseline 19935e9                                 |
| 2        | [002: Finish the configurable display name](002-finish-configurable-display-name.md) | Implemented locally; CI unverified | Current-tree baseline and exclusive writer confirmed |

The plan orders fresh baseline verification, finding calculations, evidence helpers, mouse expansion extraction and final review. Spend extraction is removed. Duration extraction is deferred to a separate tranche; `projection()` stays in the observer. Each verified extraction is a safe stopping point. Full implementation verification also requires the existing CI matrix; local Node 26 results do not replace it.

## Local commit composition

The user authorized local commits without a push. Each intermediate state was checked in a temporary tracked-file snapshot using the installed `vp check src test vitest.config.ts` and `vp test run` commands: `f4b2279` (direct delivery and bounded native corrections), 315 tests; `2976336` (display name), 330 tests; `b904b52` (shared footer marks), 331 tests. All three states passed formatting, lint and types with complexity unchanged at 20. Local checks use Node 26; the Node 22/24 CI matrix remains unverified. Local journals are excluded from commits.

The cancellation regression first checked too early and passed; after awaiting background review completion, it failed with three provider calls instead of two. The fix forwards the native settlement cancellation flag before any correction scheduling. A follow-up independent review approved that fix. Earlier verification counts below remain historical evidence.

## Configurable-name handoff

Plan 002 was implemented after the user authorized leaving hl-improve planning mode. Continuations no longer use the current name, the shared title is immutable again, and menu names are validated without silently trimming whitespace. Documentation is updated. Final `pnpm run verify` exited 0: 329 tests in 30 files, with format/lint/types passing and complexity enabled at 20. Independent close-out review reported no issues. CI remains unverified. The plan records failed regression runs, fixes and execution counts; its old excerpts are explicitly historical.

The former superseded-finding flow and newer `correct` option are concurrent work, not part of the display-name request. Plan 002 explicitly preserves that work and requires ownership before editing shared files. Dependencies, performance, whole-repository security and unrelated behavior changes were not audited in this focused review.

## Supported opportunities

- The observer mixes independently testable rules and calculations with asynchronous lifecycle ownership. Extract calculations, not the lifecycle state machine.
- Extract expansion with its WeakMap. Duration tracking has a distinct lifetime, but stays intact in `ui.ts` to limit this tranche.
- Put `seedNote` in `onlooker-evidence.ts` and `cappedResults(messages, cap)` beside `capText` in `utils/evidence.ts`. Keep projection settings in the observer.

## Considered and dismissed

- Removing or restoring concurrent delivery semantics as part of display naming: outside the request; ownership must be established instead.
- Renaming tool/command identifiers or adding a mutable shared title API: not necessary for the requested display-name option.
- Treating the scout's report as verified evidence: rejected because it violated its no-command brief; direct reads supply this review's evidence.
- Splitting every file above an arbitrary length: length alone does not establish conflicting responsibilities.
- Splitting Review, Consultation, delivery and scheduling into service classes now: shared epochs, runtime identity, queue identities and cancellation create coupling, not clean boundaries.
- Splitting `index.ts` into a controller and several registration wrappers: current closures share generation guards, session identity and menu lifecycle; no narrow replacement contract was established.
- Splitting every renderer or settings helper: the inspected symbol maps do not justify that churn in this first pass.
- A generic async-operation abstraction for Reviews and Consultations: similar code has different completion and cancellation semantics; do not unify it during extraction.
- A repository-wide folder taxonomy, barrel files or dependency injection framework: no requirement supports the extra structure.

## CTO agreement

The Orca discussion confirmed findings, seed notes, cap counting and expansion as the first tranche. The plan incorporates the agreed removal of spend extraction, duration deferral and retention of `projection()`. At the refactor baseline, `checkEvidence(findings, known)` received the reference union built by the observer. Direct delivery in `f4b2279` removed deferred findings and their reference union; the helper now receives supplied references only. Keep the no-import-from-observer invariant; cycle detection alone does not enforce it. The CTO paused repository writes and handed over baseline 19935e9 before implementation. His remaining lint patch is outside this tranche.

## Implementation results

The three extractions are complete. `pnpm run verify` passed after each extraction and after the test cleanup fix: four runs, each with 318 passing tests across 30 files. The last run checked 69 files for format, lint and types. The added public-session test covers seed notes without a session file.

Independent review found one test-journal cleanup defect. It was corrected and the follow-up review reported no remaining issues. Final LSP diagnostics had no errors, including the previously reported cadence diagnostic. `git diff --check` returned 0 for tracked changes. CI was not run. The plan contains exact run counts, the initial test setup failure and review references.

The five journals from early test runs are preserved outside the repository at `/tmp/pi-onlooker-refactor-journals.9ORQlP`; deletion was denied. No additional journal remained after the corrected test ran.

## Historical planning evidence and limits

The plan records historical verification commands and execution counts. At the initial baseline, local typecheck, lint, format check and all 317 tests passed. Current `verify` runs `check` then `test`; the old standalone scripts no longer exist. These historical results do not verify the current tree. CI, supported Node versions and Pi compatibility combinations were not run.

For the initial version, a fresh `reviewer` subagent checked the written plan against targeted source reads and reported no issues. Its verdict was ready for handoff, not implemented or verified. A final `git diff --check` ran once and passed for tracked changes; the two new plan files were still untracked and were reviewed directly.

For the CTO reconciliation, `git diff --no-index --check` against `/dev/null` returned exit code 1 for each added document, with no stdout or stderr diagnostics. The author checked the revised scope, step numbering and package scripts. An independent rereview was attempted, but the reviewer could not read either document because access was denied. That documentation-only reconciliation had no completed independent rereview. The later implementation and cleanup fix received the independent reviews recorded above.

This was a focused source-architecture investigation, not a complete security, performance, dependencies, product-direction or test-coverage audit. No performance improvement or perfect architecture is claimed. The first exploratory subagent launch failed because `explorer` was not an available agent. Codegraph had no project index; direct reads, bounded searches and LSP references supplied the evidence.
