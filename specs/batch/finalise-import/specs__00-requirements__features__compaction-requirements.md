# Compaction Requirements

## Scope

This specification governs how context compaction in `qi` classifies, surfaces, latches, and reports no-op compaction attempts versus genuine compaction failures across manual, threshold-triggered, overflow-recovery, and extension-initiated compaction flows. It does not govern summariser model selection, summary prompt wording, or branch navigation summarisation.

## Requirements

### R-COMPACTION-001: Typed skip outcome for no-op compaction preparation

**Priority:** MUST
**Statement:** The system represents a compaction preparation attempt that finds nothing eligible to summarise as a structured skip outcome, resolving `undefined` on background compaction and rejecting with a typed skip error on blocking compaction after emitting the skip completion event.
**Rationale:** Currently `prepareCompaction` (`packages/coding-agent/src/core/compaction/compaction.ts:907-964`) returns bare `undefined`, causing `AgentSession.compact()` (`packages/coding-agent/src/core/agent-session.ts:2245-2252`) and `AgentSession._runBackgroundCompaction()` (`packages/coding-agent/src/core/agent-session.ts:2480-2486`) to throw generic `Error("Already compacted")` or `Error("Nothing to compact (session too small)")`. Those untyped exceptions propagate into `compaction_end` with `errorMessage: "Compaction failed: ..."` (`agent-session.ts:2367,2572`) and into extension `onError` callbacks (`agent-session.ts:3246`), surfacing benign no-ops as red error banners (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2800,3624-3636,4628`).
**Acceptance criteria:**
- AC1: Given a session branch where compaction preparation finds no eligible messages to summarise, when compaction preparation runs, then it returns a structured skip outcome identifying why compaction cannot proceed without throwing.
- AC2: Given a compaction run that terminates due to a skip outcome, when the session emits the terminal compaction completion event, then the event marks `skipped: true` with the structured skip reason and leaves `errorMessage` undefined.
- AC3: Given a blocking manual compaction call on a branch that skips, when the skip completion event has been emitted, then the call rejects with a typed skip error carrying the skip reason and a message prefixed with `"Nothing to compact: "` while background compaction resolves `undefined`.
**Source:** `specs/batch/batch-context.md` §3.4; `ADR-0005`

### R-COMPACTION-002: Distinct skip reasons for compaction preparation

**Priority:** MUST
**Statement:** The system distinguishes between a branch whose latest entry is already a compaction checkpoint, a branch whose entries since the latest checkpoint fit within the recent-token retention budget, and a branch lacking a valid cut-point entry identifier.
**Rationale:** `prepareCompactionResult` (`packages/coding-agent/src/core/compaction/compaction.ts:906-1002`) classifies early-return branches (`:909` latest entry is `"compaction"`, `:944` missing `firstKeptEntry.id`, `:969` empty `messagesToSummarize` and `turnPrefixMessages`) into `CompactionSkipReason` (`"already-compacted" | "nothing-to-summarize" | "no-cut-point"`). Callers previously re-checked only whether the last entry was `"compaction"` and misclassified every other case as `"Nothing to compact (session too small)"`.
**Acceptance criteria:**
- AC1: Given a branch whose tip entry has type `"compaction"`, when compaction preparation evaluates the branch, then the skip reason is `"already-compacted"`.
- AC2: Given a branch whose summarisable messages and turn-prefix messages are empty because all entries since the last compaction fit within the kept recent-token budget, when compaction preparation evaluates the branch, then the skip reason is `"nothing-to-summarize"`.
- AC3: Given an empty branch or a branch whose computed cut-point entry lacks an entry identifier, when compaction preparation evaluates the branch, then the skip reason is `"no-cut-point"`.
**Source:** `specs/batch/batch-context.md` §3.4; `ADR-0005`

### R-COMPACTION-003: Accurate user-facing skip descriptions

**Priority:** MUST
**Statement:** The system describes each compaction skip using wording that matches the specific skip reason without labelling a previously compacted or high-retention session as too small.
**Rationale:** When `keepRecentTokens` is 20,000 (`packages/coding-agent/src/core/settings-manager.ts:1024`) or raised to `Math.floor(contextWindow * retainRatio)` by the DeepSeek Harness (`packages/coding-agent/src/core/agent-session.ts:2239-2241,2474-2476`), a large session that recently compacted or has a large kept tail hits `messagesToSummarize.length === 0` at `compaction.ts:969`. Labelling that state `"Nothing to compact (session too small)"` misleads users into thinking their context is tiny when it is actually near the context window limit.
**Acceptance criteria:**
- AC1: Given a skip reason of `"nothing-to-summarize"`, when the system formats a human-readable skip message, then the message states that there is nothing to summarise because all entries since the last compaction are within the retained recent-token window.
- AC2: Given a skip reason of `"already-compacted"`, when the system formats a human-readable skip message, then the message states that the session is already compacted with no new entries since the last compaction.
- AC3: Given a skip reason of `"no-cut-point"`, when the system formats a human-readable skip message, then the message states that no valid cut point was found for compaction.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-004: Pre-flight feasibility check before threshold background compaction

**Priority:** MUST
**Statement:** The system verifies that compaction preparation can produce a non-empty summarisation span before starting a threshold-triggered background compaction.
**Rationale:** `shouldCompact` (`packages/coding-agent/src/core/compaction/compaction.ts:249-252`) checks only `contextTokens > contextWindow - reserveTokens`, while `prepareCompactionResult` (`compaction.ts:906-1002`) requires messages outside `keepRecentTokens`. When `shouldCompact` is true but `prepareCompactionResult` cannot cut any messages, `_startThresholdBackgroundCompaction` (`packages/coding-agent/src/core/agent-session.ts:2404-2433`) pre-checks feasibility so it never emits `compaction_start` or enters `_runBackgroundCompaction` only to skip.
**Acceptance criteria:**
- AC1: Given `shouldCompact` evaluates to true at a turn boundary or post-run check, when compaction preparation for the current branch returns a skip outcome, then `_startThresholdBackgroundCompaction` does not launch a background compaction task or emit `compaction_start`.
- AC2: Given `shouldCompact` evaluates to true and compaction preparation returns a valid preparation payload, when `_startThresholdBackgroundCompaction` runs, then background compaction starts normally.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-005: Branch-growth latch for skipped threshold compaction

**Priority:** MUST
**Statement:** The system latches a skipped threshold compaction state against the current branch leaf and suppresses further threshold compaction attempts until a new entry is appended or the active branch leaf changes.
**Rationale:** Threshold checks fire pre-prompt (`packages/coding-agent/src/core/agent-session.ts:769-777`), between turns (`:512-533`), and post-run (`:2809-2812`). Because `_backgroundCompaction` is cleared in `finally` (`:2581`), a session where `shouldCompact` is true but `prepareCompactionResult` skips will re-evaluate on every turn and prompt unless latched against `_thresholdCompactionSkippedAtLeafId` (`:324,2414-2427`) until branch state changes.
**Acceptance criteria:**
- AC1: Given a threshold check that resulted in a compaction skip at branch leaf `L`, when another threshold check runs while the branch leaf is still `L`, then the system skips compaction evaluation without re-running preparation or emitting events.
- AC2: Given a latched threshold skip at branch leaf `L`, when a new message entry is appended or the session navigates to a different branch leaf `L2`, then the latch clears and the next threshold check evaluates normally.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-006: Non-error status rendering for automatic and background skips

**Priority:** MUST
**Statement:** The system renders skipped automatic or background compactions as transient or silent informational status rather than error notifications.
**Rationale:** `_runAutoCompaction` (`packages/coding-agent/src/core/agent-session.ts:2843-2845`) returns `false` silently when `!preparation`, and `_runBackgroundCompaction` (`:2492-2508`) emits `compaction_end` with `skipped: true` and `errorMessage: undefined`, so `interactive-mode.ts:3624-3636` never renders red error text.
**Acceptance criteria:**
- AC1: Given a threshold-triggered compaction that skips, when the interactive session processes the outcome, then no red error banner or error line is appended to the transcript.
- AC2: Given a background compaction that is superseded or skipped after launch, when `compaction_end` fires with `skipped: true`, then the interactive session updates status without calling the error display channel.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-007: Non-error notice for manual compaction skips

**Priority:** MUST
**Statement:** The system surfaces a manual compaction skip to the user as an informational or warning notice explaining the skip reason without styling it as a failure.
**Rationale:** When a user invokes `/compact` (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`) on a branch with nothing eligible to summarise, they need feedback explaining why no summary was written, but routing through `showError` (`interactive-mode.ts:3624-3636,4628`) falsely signals a system fault.
**Acceptance criteria:**
- AC1: Given a user-initiated manual compaction on a branch where preparation skips, when `compaction_end` fires with `reason: "manual"` and `skipped: true`, then the interactive session displays the human-readable skip reason via the status or warning notification channel and does not call `showError`.
- AC2: Given a user-initiated manual compaction that skips, when `compaction_end` completes, then the session remains idle and ready for input without requiring recovery.
**Source:** `specs/batch/batch-context.md` §3.4; `ADR-0005`

### R-COMPACTION-008: Preservation of error reporting for genuine compaction failures

**Priority:** MUST
**Statement:** The system reports genuine compaction failures caused by summarisation request errors, invalid model configuration, or exhausted overflow recovery attempts through the error notification channel and failure events.
**Rationale:** Converting no-op skips to non-errors must not mask real provider failures (such as network drops after retries, authentication errors in `_getSummarizationRequestAuth` at `packages/coding-agent/src/core/agent-session.ts:635`, or truncated summary responses at `packages/coding-agent/src/core/compaction/compaction.ts:619-626`).
**Acceptance criteria:**
- AC1: Given a compaction attempt where the summarisation request fails after configured retries, when `compaction_end` fires, then `skipped` is not set, `errorMessage` contains the failure description, `session_compact_failed` is emitted to extensions, and the interactive session displays the error.
- AC2: Given an overflow recovery compaction that exhausts `maxOverflowRetries` (`packages/coding-agent/src/core/agent-session.ts:2695-2709`), when `compaction_end` fires, then it is treated as a genuine failure and displayed via the error channel.
**Source:** `specs/batch/batch-context.md` §3.4

### R-COMPACTION-009: Exclusion of compaction skips from error telemetry

**Priority:** MUST
**Statement:** The system excludes skipped compactions from provider error telemetry reporting and extension failure telemetry events.
**Rationale:** `interactive-mode.ts:3624-3636` invokes `reportProviderError` whenever `compaction_end` carries `errorMessage`, which previously sent benign `"Already compacted"` and `"Nothing to compact"` skips to error telemetry. Similarly, `session_compact_failed` (`packages/coding-agent/docs/compaction.md:402-415`) is intended for failed or aborted compactions, not no-op skips.
**Acceptance criteria:**
- AC1: Given a compaction that terminates with `skipped: true`, when `compaction_end` is handled in interactive mode, then `reportProviderError` is not called.
- AC2: Given a compaction that terminates with `skipped: true`, when `AgentSession` finishes handling the skip, then `session_compact_failed` is not emitted.
**Source:** `specs/batch/batch-context.md` §3.4; `ADR-0005`

### R-COMPACTION-010: Split blocking/background skip contract for SDK and extension callers

**Priority:** MUST
**Statement:** The system resolves background compaction skips to `undefined` without invoking extension error callbacks while rejecting blocking compaction skips with a typed skip error whose message matches extension skip-downgrade patterns.
**Rationale:** Extension `ctx.compact()` (`packages/coding-agent/src/core/agent-session.ts:3234-3249`) runs `compactInBackground()` when `options?.background` is true (resolving `undefined` on skip so neither `onComplete` nor `onError` fires) and runs blocking `this.compact()` otherwise. Direct RPC/SDK callers and unmigrated extensions awaiting blocking `compact()` expect a rejected promise when no `CompactionResult` is produced, whereas `CompactionSkippedError` (`packages/coding-agent/src/core/compaction/compaction.ts:893-903`) with message `"Nothing to compact: <reason>"` lets callers distinguish skips via `instanceof CompactionSkippedError` or the skip-phrase regex `/Nothing to compact|Already compacted|nothing to summarize|no valid cut point/i` (`c:/dev/ai-compact-hot-swap/index.ts:436,464`).
**Acceptance criteria:**
- AC1: Given an extension calling `ctx.compact({ background: true, onComplete, onError })` when compaction preparation skips, when `compactInBackground` resolves `undefined`, then `onError` is not called.
- AC2: Given a caller invoking blocking `session.compact()` when compaction preparation skips, when `compaction_end` has been emitted with `skipped: true` and `errorMessage: undefined`, then `session.compact()` rejects with `CompactionSkippedError` carrying `skipReason`, `reason`, and a `message` starting with `"Nothing to compact: "`.
- AC3: Given an extension calling `ctx.compact({ onComplete, onError })` without `background: true` when compaction preparation skips, when `CompactionSkippedError` is passed to `onError` (or suppressed for skip- unaware callers), then its `message` matches `/Nothing to compact|Already compacted|nothing to summarize|no valid cut point/i`.
**Source:** `specs/batch/batch-context.md` §3.4; `specs/batch/resolution.md` R19, R28

## Traceability

- **Realises:** `REQ-COMPACTION`
- **Depends on ADRs:** `ADR-0005`
- **Referenced by:** `IMPL-COMPACTION`
