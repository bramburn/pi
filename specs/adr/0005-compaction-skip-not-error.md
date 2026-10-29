# ADR-0005: Compaction no-op is a typed skip, not a user-facing error

**Status:** accepted
**Date:** 2026-10-20
**Domain:** compaction

## Context

`prepareCompaction()` (`packages/coding-agent/src/core/compaction/compaction.ts:944-950`) returns `undefined` across three distinct no-op conditions classified by `prepareCompactionResult()` (`compaction.ts:952-1040`): the branch tip is already a compaction entry (`:956`, `"already-compacted"`), the cut-point entry lacks an ID (`:986`, `"no-cut-point"`), or `messagesToSummarize` and `turnPrefixMessages` are both empty (`:1013`, `"nothing-to-summarize"`) because all entries since the last compaction fit within `keepRecentTokens` (default 20,000 at `settings-manager.ts:1024`, or `contextWindow * retainRatio` under DeepSeek Harness at `agent-session.ts:2240,2475`).

While `_runAutoCompaction()` (`packages/coding-agent/src/core/agent-session.ts:2879`) silently returns `false` on `!preparation`, throwing untyped `Error("Already compacted")` or `Error("Nothing to compact (session too small)")` in `compact()` or `_runBackgroundCompaction()` previously emitted `compaction_end` with `errorMessage`, which `interactive-mode.ts:3624-3636` rendered as a red error and sent to Sentry via `reportProviderError`. Furthermore, when `shouldCompact()` (`compaction.ts:249`) is true near the context limit while `prepareCompactionResult()` has `< keepRecentTokens` summarisable tokens, threshold checks (`agent-session.ts:520,775,2809`) would re-fire on every prompt unless pre-checked and latched. Extensions calling `ctx.compact()` (`agent-session.ts:3292`) such as `c:/dev/ai-compact-hot-swap/index.ts:436,464` received untyped errors in `onError` and called `ctx.ui.notify(..., "error")` (`interactive-mode.ts:2800` -> `showError` `:4628`), producing repeated red `Error:` lines.

## Decision

We will introduce a typed skip result for compaction preparation (`CompactionSkipReason`: `"already-compacted" | "nothing-to-summarize" | "no-cut-point"` via `prepareCompactionResult()` while retaining `prepareCompaction()` as a compatibility wrapper), propagate skips through `compaction_end` (`skipped?: boolean`, `skipReason?: CompactionSkipReason`, `skipMessage?: string`, `errorMessage: undefined`), resolve `undefined` from `compactInBackground()` on skip while rejecting blocking `AgentSession.compact()` with `CompactionSkippedError` (whose `message` is the formatted skip reason and matches the extension skip-downgrade regex `/Nothing to compact|Already compacted|nothing to summarize|no valid cut point/i`) after emitting the skipped `compaction_end` event, pre-check and latch threshold skips until the branch leaf changes, and render skips as status/warning notices without invoking `showError` or `reportProviderError`.

`prepareCompaction()` remains backwards-compatible by returning `CompactionPreparation | undefined`, while a companion outcome function (`prepareCompactionOutcome()`, shipped in the current tree as `prepareCompactionResult()`) returns the typed ready-or-skip outcome `{ status: "ready", preparation } | { status: "skip", reason, message }` (in-tree shape: `{ skipped: false, preparation } | { skipped: true, skipReason, reason }`): `prepareCompaction` is part of the public SDK surface documented in `packages/coding-agent/docs/compaction.md:208` and is tested directly across existing compaction tests.

Blocking `AgentSession.compact()` rejects with a typed `CompactionSkippedError` after emitting `compaction_end` with `skipped: true` and `errorMessage: undefined`, while `compactInBackground()` resolves `undefined` on skip (matching its `Promise<CompactionResult | undefined>` signature): this honors the existing signatures on both paths, keeps R-COMPACTION-001's structured-skip intent (typed error plus skipped event, not a generic exception), and preserves the error-handling expectations of direct RPC/SDK callers.

## Consequences

**Positive:**
- Eliminates repeated red TUI errors when context is above `shouldCompact` but summarisable tokens are below `keepRecentTokens`.
- Distinguishes `"already-compacted"`, `"nothing-to-summarize"`, and `"no-cut-point"`, removing the misleading `"session too small"` message on large sessions.
- Stops polluting Sentry (`reportProviderError`) with benign compaction no-ops.
- Pre-check and branch-leaf latch prevent redundant background compaction launches on every turn/prompt.
- Preserves a typed rejection (`CompactionSkippedError`) on blocking `compact()` for RPC/SDK callers while keeping `compaction_end.errorMessage` undefined and matching extension skip-downgrade regexes (`/Nothing to compact|Already compacted|nothing to summarize|no valid cut point/i`).

**Negative:**
- Adds `skipped`, `skipReason`, and `skipMessage` fields to `compaction_end` in `AgentSessionEvent` (`agent-session.ts:195-208`), requiring event consumers to check `event.skipped` alongside `event.errorMessage`.
- Callers of blocking `compact()` that treat any rejection as a fatal failure must either use `compactInBackground()` or catch `CompactionSkippedError`.

**Neutral:**
- Genuine summariser provider errors and exhausted overflow retries continue to populate `errorMessage`, call `showError`, and report to telemetry.

## Alternatives considered

- **Resolve `undefined` on both blocking `compact()` and `compactInBackground()`:** Rejected in Phase E (R28) because direct RPC/SDK callers and unmigrated extensions awaiting blocking `compact()` expect a rejection when no `CompactionResult` is produced; throwing `CompactionSkippedError` after emitting `compaction_end { skipped: true, errorMessage: undefined }` satisfies both event listeners and promise callers.
- **Keep throwing generic `Error` and downgrade at the UI only:** Rejected because `_startThresholdBackgroundCompaction` would still re-fire every prompt, `reportProviderError` would still fire on `compaction_end.errorMessage`, and `compaction_start` would still fire unnecessarily.
- **Pre-filter at each trigger without a typed result:** Rejected because manual `/compact` and extension `ctx.compact()` still execute when there is nothing to summarise and need an accurate, typed skip reason to display to the user.
- **Disable automatic compaction:** Rejected because automatic background compaction is required to keep long sessions within model context windows before hitting hard overflow errors.

## Compliance checklist

- [ ] `compaction.ts` exports `CompactionSkipReason`, `CompactionPreparationOutcome`, `prepareCompactionResult()` (the R27 companion `prepareCompactionOutcome()`, in-tree name), `formatCompactionSkipReason()`, and `CompactionSkippedError` (carrying `skipReason`; its `message` matches `/Nothing to compact|Already compacted|nothing to summarize|no valid cut point/i`).
- [ ] `AgentSession` emits `compaction_end` with `skipped: true` and `errorMessage: undefined` when compaction skips in `compact()` or `_runBackgroundCompaction()`.
- [ ] Blocking `AgentSession.compact()` rejects with `CompactionSkippedError` after emitting the skipped `compaction_end` event, whereas `compactInBackground()` resolves `undefined`.
- [ ] `_startThresholdBackgroundCompaction()` pre-checks preparation feasibility and latches skips until the branch leaf ID changes.
- [ ] `interactive-mode.ts` handles `compaction_end` with `skipped: true` (and any `CompactionSkippedError` from manual compaction) via status/warning notification, never calling `showError` or `reportProviderError`.
- [ ] Automated test in `packages/coding-agent/test/suite/compaction-skip-typed.test.ts` verifies blocking `compact()` rejects with `CompactionSkippedError`, `compactInBackground()` resolves `undefined`, and threshold compaction latches without emitting `errorMessage`.

## Traceability

- **Realises:** `REQ-COMPACTION` (`R-COMPACTION-001` through `R-COMPACTION-010`)
- **Depends on ADRs:** None
- **Referenced by:** `REQ-COMPACTION`, `IMPL-COMPACTION`
