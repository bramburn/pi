# Impl: Compaction error-fix implementation phase

**Realises:** REQ-COMPACTION (`R-COMPACTION-001`, `R-COMPACTION-002`, `R-COMPACTION-003`, `R-COMPACTION-004`, `R-COMPACTION-005`, `R-COMPACTION-006`, `R-COMPACTION-007`, `R-COMPACTION-008`, `R-COMPACTION-009`, `R-COMPACTION-010`)
**Depends on phases:** —
**Verifies via:** `packages/coding-agent/test/suite/compaction-skip-typed.test.ts`

## Work items (DAG)

| ID | Work item | Depends on | Realises | Verified by |
|---|---|---|---|---|
| W-01 | Define `CompactionSkipReason`, `CompactionPreparationOutcome`, `prepareCompactionResult()` (the R27 companion `prepareCompactionOutcome()`, in-tree name), `formatCompactionSkipReason()`, and `CompactionSkippedError` (carrying `skipReason`; its `message` is the formatted skip reason and matches `/Nothing to compact\|Already compacted\|nothing to summarize\|no valid cut point/i`) in `packages/coding-agent/src/core/compaction/compaction.ts:907-1040` while keeping `prepareCompaction()` as a compatibility wrapper | — | REQ-COMPACTION (`R-COMPACTION-001`, `R-COMPACTION-002`, `R-COMPACTION-003`, `R-COMPACTION-010`) | `packages/coding-agent/test/suite/compaction-skip-typed.test.ts` |
| W-02 | Extend `AgentSessionEvent` (`compaction_end` at `packages/coding-agent/src/core/agent-session.ts:195-208`) with `skipped?: boolean`, `skipReason?: CompactionSkipReason`, and `skipMessage?: string`; update `compact()` (`:2265-2278`) to emit `compaction_end { skipped: true, errorMessage: undefined }` and then throw `CompactionSkippedError`, while `_runBackgroundCompaction()` (`:2520-2538`) emits `skipped: true` and resolves `undefined`, and `_runAutoCompaction()` (`:2879`) returns `false` without `errorMessage` or `session_compact_failed` | W-01 | REQ-COMPACTION (`R-COMPACTION-001`, `R-COMPACTION-006`, `R-COMPACTION-008`, `R-COMPACTION-009`, `R-COMPACTION-010`) | `packages/coding-agent/test/suite/compaction-skip-typed.test.ts` |
| W-03 | Enforce pre-flight feasibility check and branch-leaf skip latch (`_thresholdCompactionSkippedAtLeafId`) in `AgentSession._startThresholdBackgroundCompaction()` (`packages/coding-agent/src/core/agent-session.ts:2452-2476`), clearing the latch when a compaction appends (`:2353`) or the branch leaf advances (`:2474`) | W-01, W-02 | REQ-COMPACTION (`R-COMPACTION-004`, `R-COMPACTION-005`) | `packages/coding-agent/test/suite/compaction-skip-typed.test.ts` |
| W-04 | Handle `compaction_end` with `event.skipped` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3613-3636` so manual triggers render via `showStatus` / warning notice, threshold/background triggers stay quiet, and `showError` / `reportProviderError` are never called on skips | W-02 | REQ-COMPACTION (`R-COMPACTION-003`, `R-COMPACTION-006`, `R-COMPACTION-007`, `R-COMPACTION-008`, `R-COMPACTION-009`) | `packages/coding-agent/test/suite/compaction-skip-typed.test.ts` |
| W-05 | Ensure extension `ctx.compact()` binding in `packages/coding-agent/src/core/agent-session.ts:3292-3307` and companion external extension `c:/dev/ai-compact-hot-swap/index.ts:436,464` (executed in the `fix-compaction` task) pass `background: true` (or receive `CompactionSkippedError` matching `/Nothing to compact\|Already compacted\|nothing to summarize\|no valid cut point/i`) so skip outcomes are never surfaced as errors | W-02 | REQ-COMPACTION (`R-COMPACTION-010`) | `packages/coding-agent/test/suite/compaction-skip-typed.test.ts` |

The branch-leaf ID returned by `this.sessionManager.getLeafId()` uniquely identifies whether any new entry has been appended or navigated to since a threshold skip: `SessionManager` assigns a fresh entry ID to every appended message, custom entry, or branch summary and updates the leaf pointer on tree navigation (`packages/coding-agent/src/core/agent-session.ts:2426,3006,3108`), which is exactly `R-COMPACTION-005`'s AC2 latch-clear condition and what `W-03`'s `_thresholdCompactionSkippedAtLeafId` keys on.

## Verification strategy

- **Unit level (`prepareCompactionResult` & `CompactionSkippedError`):** Verify all three skip reasons (`"already-compacted"`, `"nothing-to-summarize"`, `"no-cut-point"`), their human-readable messages, and `CompactionSkippedError` properties (`skipReason`, `name`, and a `message` matching `/Nothing to compact|Already compacted|nothing to summarize|no valid cut point/i`) against synthetic `SessionEntry[]` branches in `packages/coding-agent/test/suite/compaction-skip-typed.test.ts`.
- **Session integration level (`AgentSession` + faux provider):** Using `packages/coding-agent/test/suite/harness.ts` and the faux provider:
 1. Drive a session where `shouldCompact` is true (`contextTokens > contextWindow - reserveTokens`) but all post-compaction messages fit inside `keepRecentTokens`. Verify `_startThresholdBackgroundCompaction` latches on the leaf ID, does not emit `compaction_start` or `compaction_end` with `errorMessage`, and does not re-fire on a subsequent prompt until new messages are appended.
 2. Call blocking `session.compact()` on a small branch; verify `compaction_end` fires with `skipped: true`, `skipReason: "nothing-to-summarize"`, `errorMessage === undefined`, and the returned promise rejects with `CompactionSkippedError`. Call `session.compactInBackground()` on the same branch; verify `compaction_end` fires with `skipped: true`, `background: true`, `errorMessage === undefined`, and the returned promise resolves `undefined`.
 3. Trigger a genuine provider error from the faux summariser stream; verify `compaction_end` fires with `skipped` undefined, `errorMessage` populated, and `session.compact()` rejects with the provider error.
- **Typecheck & lint gate:** Run `bun run check` from repo root and run the targeted vitest suite via `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/compaction-skip-typed.test.ts` from `packages/coding-agent`.

## Rollback

- Revert commits touching `packages/coding-agent/src/core/compaction/compaction.ts`, `packages/coding-agent/src/core/compaction/index.ts`, `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, and `packages/coding-agent/test/suite/compaction-skip-typed.test.ts`.
- Because `CompactionEntry` on-disk schema (`packages/coding-agent/src/core/session-manager.ts`) is unchanged by this phase, rolling back requires no session file migration.

## Out of scope

- **Summariser model selection (`compactionModel`):** Routing summarisation through a user-configured catalog model in `settings.json` (`_getSummarizationRequestAuth` at `packages/coding-agent/src/core/agent-session.ts:647-711`) is intentional uncommitted work already in the tree and must not be modified or reverted.
- **Compaction summary prompt and quality:** Changes to `SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT`, or chunk-splitting budgets in `packages/coding-agent/src/core/compaction/compaction.ts:539-890`.
- **Branch summarisation algorithm:** Tree-navigation summarisation in `packages/coding-agent/src/core/compaction/branch-summarization.ts`.

## Traceability

- **Realises:** `REQ-COMPACTION` (`R-COMPACTION-001` through `R-COMPACTION-010`)
- **Depends on ADRs:** `ADR-0005`
- **References:** `REQ-COMPACTION`, `ADR-0005`
