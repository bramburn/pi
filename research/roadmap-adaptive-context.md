# Roadmap — Adaptive Context Management for `pi` (TUI + pi.dev)

A plan to bring the `pi` agent's context handling to parity with MiniMax Code (desktop) and DeepSeek AI, behind a single opt-in **adaptive context** mode. Designed to be shipped incrementally without breaking existing users.

- **Scope:** `pi` TUI + `pi.dev` server (web product) + MiniMax provider.
- **Excludes:** subagent redesign (the user confirmed `pi` does not need subagents). Items 14 and 5 (subagent context) from the prior report are dropped; the "consider subagents later" thread is captured as a deferred item.
- **Default behaviour:** unchanged for users who do not opt in.
- **Date:** 2026-08-26.

> Companion to `research/report-context-window-management.md`. Every phase
> below references the numbered gap list in section 6 of that report.

---

## 0. Strategy in one paragraph

Ship a single top-level feature, **`adaptiveContext`**, that bundles the
four highest-leverage changes from the gap list (overflow recovery, tool-result
re-pruning, replay-prefix summarisation, byte-budgeted AGENTS.md). Gate
*all* of them behind one user-facing toggle in `/settings` so the rollout is
coherent, observable, and reversible. Use per-model overrides so MiniMax
gets a tuned profile out of the box, while Anthropic/OpenAI users get a
separate profile that does not pay the overhead. Default the toggle **off**
in the first release, turn it **on by default for the MiniMax provider
profile** in the second release after measurement, then **on for all
providers** in the third. pi.dev (server) can flip the same toggle
*server-side* for hosted sessions and use canary %s for the rollout.

The four engineering changes are independent, but they share a single
**token meter** and a single **settings schema**; building the meter
first makes the rest mechanical.

---

## 1. The user-facing surface

A single top-level setting, with sub-toggles that all default to the
recommended profile when the parent is on.

### 1.1 Settings schema (additive, non-breaking)

`packages/coding-agent/src/core/settings-manager.ts`:

```ts
export interface AdaptiveContextSettings {
  /** Master toggle. When true, the agent uses the adaptive context pipeline. */
  enabled?: boolean;
  /** Compact when context > contextWindow × thresholdRatio. Default 0.8. */
  thresholdRatio?: number;
  /** Keep the most recent contextWindow × retainRatio verbatim. Default 0.16. */
  retainRatio?: number;
  /** Max overflow recovery attempts before surfacing an error. Default 2. */
  maxOverflowRetries?: number;
  /** Re-prune tool results in place after every N turns. Default 5. */
  toolResultPruneEveryN?: number;
  /** Head chars kept when pruning tool results. Default 4096. */
  toolResultHeadChars?: number;
  /** Tail chars kept when pruning tool results. Default 1024. */
  toolResultTailChars?: number;
  /** Threshold (chars) at which a tool result is eligible for pruning. Default 8192. */
  toolResultThresholdChars?: number;
  /** Send the live conversation as the prefix of the summarisation call (KV-cache reuse). */
  replayPrefixSummarisation?: boolean;
  /** Render workspace AGENTS.md inside a byte-budgeted <system-reminder>. */
  budgetedInstructions?: boolean;
  /** Per-model overrides keyed by "provider/model" (longest-prefix match). */
  modelPolicies?: Record<string, Partial<AdaptiveContextSettings>>;
}

export interface Settings {
  // ... existing fields ...
  adaptiveContext?: AdaptiveContextSettings;
  /** Convenience flag for pi.dev host-level rollouts. Server-side only. */
  adaptiveContextServerDefault?: "off" | "on" | "canary";
}
```

Defaults applied when `adaptiveContext` is undefined or a sub-field is
omitted (in `settings-manager.ts:getAdaptiveContextSettings()`):

```ts
const DEFAULTS: Required<Omit<AdaptiveContextSettings, "modelPolicies">> = {
  enabled: false,                 // opt-in
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  maxOverflowRetries: 2,          // was 1; the gap is the one-shot recovery
  toolResultPruneEveryN: 5,
  toolResultHeadChars: 4096,      // matches deepseek-harness pruner
  toolResultTailChars: 1024,
  toolResultThresholdChars: 8192,
  replayPrefixSummarisation: true,
  budgetedInstructions: true,
};
```

### 1.2 `/settings` UI (additive)

`packages/coding-agent/src/modes/interactive/components/settings-selector.ts` —
add a new section after the existing "Auto-compact" item, gated on
`adaptiveContext.enabled`:

```ts
{
  id: "adaptive-context",
  label: "Adaptive context",
  description:
    "Active context management: retry on overflow, re-prune old tool " +
    "results mid-session, replay-prefix summarisation, byte-budgeted " +
    "AGENTS.md. Recommended for long sessions.",
  currentValue: config.adaptiveContext.enabled ? "true" : "false",
  values: ["true", "false"],
},
// Sub-settings appear only when the master toggle is on:
{
  id: "adaptive-threshold-ratio",
  label: "  ↳ Compact at (×contextWindow)",
  description: "0.5 = aggressive, 0.95 = last-minute only.",
  currentValue: String(config.adaptiveContext.thresholdRatio),
  values: ["0.5", "0.6", "0.7", "0.8", "0.9", "0.95"],
},
{
  id: "adaptive-max-overflow-retries",
  label: "  ↳ Overflow recovery attempts",
  description: "How many compact-and-retry cycles before surfacing an error.",
  currentValue: String(config.adaptiveContext.maxOverflowRetries),
  values: ["1", "2", "3", "4"],
},
{
  id: "adaptive-tool-result-prune",
  label: "  ↳ Tool result re-pruning",
  description: "Re-prune old tool results mid-session to free input space.",
  currentValue: config.adaptiveContext.toolResultPruneEveryN > 0 ? "true" : "false",
  values: ["true", "false"],
},
{
  id: "adaptive-replay-prefix",
  label: "  ↳ Replay-prefix summarisation",
  description: "Reuse the provider's KV cache when summarising (recommended).",
  currentValue: config.adaptiveContext.replayPrefixSummarisation ? "true" : "false",
  values: ["true", "false"],
},
{
  id: "adaptive-budgeted-instructions",
  label: "  ↳ Byte-budgeted AGENTS.md",
  description:
    "Render workspace instructions inside a byte-budgeted " +
    "<system-reminder> envelope with omission diagnostics.",
  currentValue: config.adaptiveContext.budgetedInstructions ? "true" : "false",
  values: ["true", "false"],
},
```

The `InteractiveMode` callback chain gets four new entries
(`onAdaptiveContextChange`, `onAdaptiveThresholdRatioChange`,
`onAdaptiveMaxOverflowRetriesChange`, `onAdaptiveReplayPrefixChange`,
`onAdaptiveBudgetedInstructionsChange`) wired the same way as the existing
`onAutoCompactChange` (`interactive-mode.ts:4288` and surrounding).

### 1.3 CLI flags (additive)

`packages/coding-agent/src/cli/args.ts`:

```
--adaptive-context                       Enable adaptive context mode
--adaptive-threshold-ratio <0..1>       Override the default 0.8
--adaptive-retain-ratio <0..1>           Override the default 0.16
--adaptive-max-overflow-retries <int>    Override the default 2
--adaptive-tool-result-prune-every <n>   0 disables; default 5
--adaptive-replay-prefix <bool>          Default true
--adaptive-budgeted-instructions <bool>  Default true
```

`--adaptive-context` is the umbrella; the others override the
corresponding sub-setting on the same invocation.

### 1.4 pi.dev (server) surface

`packages/coding-agent/src/server/create-harness.ts` —
add an `adaptiveContextServerDefault` field on
`CreateCodingAgentHarnessOptions` (server-side only, never written to
user settings.json):

```ts
export interface CreateCodingAgentHarnessOptions {
  // ... existing fields ...
  /** Host-level default. "canary" hashes a per-session toggle. */
  adaptiveContextServerDefault?: "off" | "on" | "canary";
}
```

When the value is `"on"`, every session is created with
`adaptiveContext.enabled = true` and the user can still opt out
individually. When `"canary"`, a per-session hash decides
(`hash(sessionId) % 100 < 25` for a 25% canary). When `"off"`, the
host leaves the user's choice alone.

This is the *only* field that lives outside `~/.pi/settings.json` — it
is host configuration, not user preference. Document it in
`docs/environment-variables.md` and `docs/server.md`.

### 1.5 Per-model profile (MiniMax)

`packages/coding-agent/src/core/settings-manager.ts` —
ship a built-in profile for MiniMax so the canary phase has known-good
defaults. The profile lives in code, not in user settings:

```ts
// packages/coding-agent/src/core/context-profiles.ts
export const MINIMAX_PROFILE: Partial<AdaptiveContextSettings> = {
  enabled: true,                       // for the canary cohort only
  thresholdRatio: 0.75,                // compact earlier (cache hits cheaper)
  retainRatio: 0.18,                   // slightly more verbatim tail
  maxOverflowRetries: 3,               // MiniMax is cache-friendly, retries are cheap
  toolResultPruneEveryN: 3,            // MiniMax sessions are long; prune more often
  replayPrefixSummarisation: true,     // cache reuse is the win
  budgetedInstructions: true,
};
```

The profile is merged into the resolved settings when
`model.provider === "minimax" || model.provider === "minimax-cn"`. The
user's own `adaptiveContext.modelPolicies["minimax/MiniMax-M2.7"]` (or
the catch-all `"minimax/*"`) wins over the built-in.

---

## 2. Phased delivery

Four phases, each independently shippable and reversible behind a flag.
Each phase adds one observable improvement and one measurement hook so
the next phase's go/no-go is data-driven.

### Phase 1 — Overflow recovery + adaptive context master toggle

**Goal:** fix the most visible symptom (truncated output, single-shot
overflow recovery fails) and ship the user-facing toggle.

**Gap items addressed:** 1, 6 (partial), 7 (partial), 10, 15 (UI), 11 (settings).

**Files touched:**

- `packages/coding-agent/src/core/settings-manager.ts` — add `AdaptiveContextSettings`, the `MINIMAX_PROFILE` constant, `getAdaptiveContextSettings()`, `setAdaptiveContextEnabled()`, `setAdaptiveContextField()`.
- `packages/coding-agent/src/core/agent-session.ts:2001-2052` — replace the one-shot overflow path with a loop driven by `getAdaptiveContextSettings().maxOverflowRetries`. On retry, the failed message is removed from the agent state (already done at `:2017-2020`); on each retry, `_runAutoCompaction` is called with `reason: "overflow"`. The retry counter resets when the next successful turn starts.
- `packages/coding-agent/src/core/agent-session.ts:1077-1104` — emit a new event `adaptive_recovery` with `{ attempt, contextTokens, result }` so the UI can show "recovery attempt 1/2...".
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts:484-490` — add the master toggle and sub-toggles described in §1.2.
- `packages/coding-agent/src/modes/interactive/components/footer.ts` — extend the auto-compact footer line to also show "AC" when `adaptiveContext.enabled` is true, so users can see the mode at a glance.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4284-4310` — wire the new callbacks.
- `packages/coding-agent/src/cli/args.ts:92-98` — add the new CLI flags.
- `packages/coding-agent/src/server/create-harness.ts:46-` — accept `adaptiveContextServerDefault`.
- `packages/coding-agent/test/suite/regressions/<issue>-adaptive-context-recovery.test.ts` — regression test: simulate an overflow on turn 1, verify recovery runs twice, succeeds, the user prompt gets a successful answer.

**Acceptance criteria:**

1. With `adaptiveContext.enabled: false`, behaviour is byte-identical to current.
2. With `adaptiveContext.enabled: true` and an overflow on turn 1, the session recovers without surfacing the "Context overflow recovery failed" error (the existing test at `agent-session.ts:2008` flips from "error" to "recovered" or "retried").
3. With `adaptiveContext.maxOverflowRetries: 2`, two consecutive overflows are tolerated; the third surfaces the existing error.
4. The TUI `/settings` selector shows the new entries and writes them to `~/.pi/settings.json` under the `adaptiveContext` key.
5. CLI flag `--adaptive-context` produces the same settings key on a one-shot invocation.
6. `pi.dev` host can pass `adaptiveContextServerDefault: "canary"` and observe the per-session hash rollout.

**Measurement hooks:**

- `telemetry/adaptive-context.jsonl` event, one per session: `{ sessionId, enabled, thresholdRatio, retainRatio, profileHits, recoveryAttempts, recoverySuccess, recoveryFailed, meanRecoveryMs }`.
- `agent-session` emits `adaptive_recovery` events with attempt numbers.
- Footer shows `AC: 1/2` (attempt 1 of 2) while recovery is in flight.

**Rollout:** default off. Announce the toggle in `CHANGELOG.md` under
`[Unreleased] > Added`. Document in `docs/settings.md`. MiniMax users in
the pi.dev canary get `adaptiveContextServerDefault: "canary"` at 25%.

### Phase 2 — Tool-result re-pruning

**Goal:** stop the input side from filling up with already-truncated
tool results that have been sitting in the session for the whole run.

**Gap items addressed:** 2, 3 (partial — the post-execute spill is
deferred), 4 (partial).

**Files touched:**

- `packages/agent/src/harness/compaction/tool-result-pruner.ts` — new
  file. Port the body of `…/research/deepseek-harness/packages/compaction/compaction-tool-result-pruner/src/index.ts:44-186`,
  adapted to pi's `BashExecutionMessage` and `ToolResultMessage` types.
  Defaults: `thresholdChars: 8192, headChars: 4096, tailChars: 1024,
  PRUNE_MARKER: "\n\n[… tool result middle pruned …]\n\n"`.
- `packages/agent/src/harness/compaction/index.ts` — add the export.
- `packages/coding-agent/src/core/agent-session.ts` — add a new private
  method `_maybePruneToolResults()` and call it on `agent_end` and on
  every Nth turn where N = `adaptiveContext.toolResultPruneEveryN`. The
  call is a no-op when `adaptiveContext.enabled` is false or
  `toolResultPruneEveryN === 0`.
- `packages/coding-agent/src/core/agent-session.ts:2000-2010` — prune
  before the overflow recovery compaction (cheaper than a full summary
  when the cause is bloated tool results).
- `packages/agent/src/types.ts` — add `excludeFromPrune?: boolean` to
  `ToolResultMessage` so an extension can opt out (e.g. for a tool that
  needs its full output for the next prompt).
- `packages/agent/src/agent.ts` — wire the pruner into the agent
  state, behind a `pruneToolResults(surface)` method on the agent.
- `packages/agent/test/tool-result-pruner.test.ts` — unit test: a
  100K-char tool result gets replaced with head + marker + tail, the
  session entry list length is unchanged, the `ToolResultMessage.content`
  is shorter, and the original event is preserved for replay.

**Acceptance criteria:**

1. After 10 bash calls each producing a 60 KiB output, an N=5 pruner
   run produces 5 `compaction/prune` events and the agent's `messages`
   contain a pruned copy of the oldest 5 results.
2. The user can still scroll back and see the full output in the
   session log file (replay fidelity).
3. With `adaptiveContext.enabled: false`, no pruning happens.
4. The pruner is a no-op for tool results below the threshold.

**Measurement hooks:**

- Telemetry event `tool_result_pruned` per prune:
  `{ sessionId, seq, originalChars, newChars, headChars, tailChars, toolName }`.
- Footer status shows "AC pruning: 3 results (-47 KB)" briefly after
  each pruner run.

**Rollout:** still opt-in via the master toggle. Pruner failures
(JSON parse error on a stored tool result, etc.) log a warning and
skip; never throw.

### Phase 3 — Replay-prefix summarisation

**Goal:** cut compaction wall time and cost by reusing the provider's
KV cache. Largest visible improvement on MiniMax because the provider
charges a different rate for cache hits.

**Gap items addressed:** 11.

**Files touched:**

- `packages/coding-agent/src/core/compaction/compaction.ts:817-` — change
  the summarisation message construction. Instead of serialising the
  conversation into a single `<conversation>` text block
  (`packages/agent/src/harness/compaction/compaction.ts:549-555`),
  send the **live session messages** as the prefix of the summarisation
  call, with the `SUMMARIZATION_PROMPT` appended as the final user
  message. The system prompt and tool schemas are reused from the live
  request envelope.
- `packages/agent/src/harness/compaction/compaction.ts:529-593` — refactor
  `generateSummaryWithUsage` to accept the full message list rather
  than serialise it. The call shape becomes:

  ```ts
  const summarizationMessages = [
    ...currentMessages,
    { role: "user", content: [{ type: "text", text: SUMMARIZATION_PROMPT }], timestamp: Date.now() },
  ];
  const response = await completeSimpleWithRetries(
    models, model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    { maxTokens, signal, purpose: "compaction" },
    retry, callbacks,
  );
  ```

  The `purpose: "compaction"` tag tells the Anthropic / OpenAI adapters
  to mark the request as a maintenance call (skip cache write, never
  reuse in a user-facing call).
- `packages/ai/src/api/anthropic-messages.ts` — accept a new optional
  `purpose` field on `SimpleStreamOptions`; when set to `"compaction"`,
  add `x-purpose: compaction` to the request header (Anthropic-specific)
  and skip any prompt-cache write attempts.
- `packages/ai/src/api/openai-*.ts` — accept the same field; when set to
  `"compaction"`, set `prompt_cache_key` to a dedicated compaction key.
- `packages/coding-agent/test/suite/regressions/<issue>-replay-prefix-compaction.test.ts` — assert that the wire request to the
  provider contains the live conversation as the prefix and a new
  user message with `SUMMARIZATION_PROMPT` at the end.

**Acceptance criteria:**

1. On a 150K-token session, compaction wall time drops from "X" to "X/N"
   (target: 5x for Anthropic, 10x for MiniMax where the cache write
   rate is higher).
2. Provider cost on a compaction call drops to the cache-read rate for
   the prefix portion, observable in `usage.cacheRead`.
3. Summarisation quality is not measurably worse (compare summaries
   between replay-prefix and old text-block modes on a fixed fixture
   set).
4. Without `adaptiveContext.replayPrefixSummarisation`, falls back to
   the existing text-block summarisation (regression-safe default).

**Measurement hooks:**

- Telemetry event `compaction_run`: `{ sessionId, method: "replay"|"text-block", contextTokensBefore, contextTokensAfter, wallMs, promptTokens, cacheReadTokens, cacheWriteTokens, summaryChars }`.

**Rollout:** opt-in via `adaptiveContext.replayPrefixSummarisation`
(default true when the master toggle is on). For the pi.dev canary
cohort, default true. For self-hosted users on non-Anthropic-compatible
APIs (which lack the prompt-cache field), the setter detects
`!providerSupportsCache` and falls back automatically.

### Phase 4 — Byte-budgeted AGENTS.md + max-tokens shaping

**Goal:** cap the system-prompt contribution from the project context
files and make the per-request `maxTokens` shape to live context so the
output cap is never hit just because the input is full.

**Gap items addressed:** 6 (full), 4 (full), 12 (desync invariant — see deferred).

**Files touched:**

- `packages/coding-agent/src/core/system-prompt.ts:28-162` — wrap the
  `contextFiles` block in a `<system-reminder>` envelope. Apply a
  byte budget driven by `maxBytes = floor(0.05 × contextWindow × 4)` —
  i.e. ~5% of the model context, default 20 KiB for a 100K model.
  Truncation uses `truncateUtf8` from
  `…/research/deepseek-harness/packages/context/agent-instructions/src/render.ts:69-79`
  with diagnostics in a marker line.
- `packages/coding-agent/src/core/system-prompt.ts:144-152` — replace
  the unbounded `<project_context>` block with the budgeted envelope.
- `packages/agent/src/agent.ts:101-` — extend `AgentOptions` with an
  optional `systemPromptBudgetBytes`; the runtime cap is computed
  dynamically from the live model spec and the live `messages.length × 4`
  estimate.
- `packages/agent/src/agent-loop.ts:282-319` — in `streamAssistantResponse`,
  compute `availableTokens = contextWindow - estimatedInputTokens` and
  shape the outgoing `maxTokens` down to `min(model.maxTokens, availableTokens - 1024)`.
  The 1024 safety margin is for provider-side framing overhead.
- `packages/ai/src/api/anthropic-messages.ts` — pass the shaped
  `max_tokens` to the wire.
- `packages/ai/src/api/openai-completions.ts`,
  `packages/ai/src/api/openai-responses.ts` — same.
- `packages/ai/src/utils/overflow.ts` — the existing
  `isContextOverflow(error, contextWindow)` helper already exists; wire
  it into the overflow detection in `agent-session.ts:2001-2052` (this
  is partly Phase 1 but the heuristic lives in `packages/ai/src/utils/overflow.ts`).

**Acceptance criteria:**

1. A 5 MiB `AGENTS.md` is truncated to fit the budget with a
   `[truncated AGENTS.md from 5000000 to 20480 bytes]` marker.
2. The system prompt contains a `<system-reminder>` envelope and the
   project_context block is no longer free-form XML.
3. On a near-full session (input > 90% of `contextWindow`), the
   outgoing `maxTokens` is at most 10% of `contextWindow`; the model's
   output is shaped accordingly and `length`-finish is rare.
4. Without `adaptiveContext.budgetedInstructions`, the original
   inline behaviour is preserved.

**Measurement hooks:**

- Telemetry event `system_prompt_rendered`: `{ sessionId, modelProvider, modelId, originalBytes, budgetBytes, includedBytes, omittedFiles, truncatedFiles }`.
- Telemetry event `max_tokens_shaped`: `{ sessionId, modelProvider, modelId, originalMaxTokens, shapedMaxTokens, inputTokens, contextWindow }`.

**Rollout:** opt-in via `adaptiveContext.budgetedInstructions` (default
true). The system prompt envelope change is observable in `/export` HTML
output; document the change in `CHANGELOG.md`.

---

## 3. Deferred (do not ship in the first four phases)

These are in the gap list but they require either user demand or a
separate feature scaffold. Each gets a `CHANGELOG.md` note + a tracking
issue.

- **Subagent redesign** (item 14 in the prior report, dropped at user
  request). If/when pi grows a `subagent` package, document the fork
  vs spawn convention; the seed model should be the parent's
  completed-turn prefix.
- **Abstract `SpillStore` + spill-policy plugin** (item 3). The
  re-pruner from Phase 2 is enough to fix the worst symptom; the full
  spill abstraction is a bigger redesign of how tool outputs are
  stored. Defer until we have a user demand for "show me the original
  tool output that the model didn't see".
- **Per-model `maxTokens` resolution at the route level** (item 4
  full). Phase 4 implements the runtime shaping; the static
  `LlmCallConfig` abstraction from deepseek-harness is more invasive
  than pi needs today. Defer.
- **Replay-cache-aware retry on `length` finish** (item 10 full). The
  current "refuse tool calls on length" is the safety floor; an
  auto-continuation that asks the model to "continue from where you
  stopped" with the prefix would be the next step. Defer.
- **"Model-visible ⟺ logged" desync invariant** (item 12). Power
  user / debugging feature, not a user-visible improvement. Defer.
- **Plan mode as a logged section toggle** (item 13). Independent
  feature; defer to a separate plan-mode overhaul.
- **`/settings` UI sub-setting grid** (item 15 partial — done for
  the master toggle only). The 5 sub-toggles in §1.2 are enough; a
  full per-model policy editor is a future feature.

---

## 4. Measurement plan

The whole point of the master toggle is that we can **measure**. Every
phase emits telemetry, and the go/no-go for the next phase is data.

### 4.1 Telemetry schema

Append to `packages/coding-agent/src/core/telemetry.ts` (or a new
`telemetry/adaptive-context.ts`). Every event includes `sessionId`,
`timestamp`, `modelProvider`, `modelId`, and the resolved
`AdaptiveContextSettings` for the session so a single query can
attribute behaviour to configuration.

| Event | Fields | When |
|---|---|---|
| `adaptive_context_session_start` | `sessionId, enabled, profile, settings` | session start |
| `adaptive_recovery` | `sessionId, attempt, maxAttempts, reason, result, wallMs` | on overflow recovery attempt |
| `tool_result_pruned` | `sessionId, seq, toolName, originalChars, newChars` | on each tool result prune |
| `compaction_run` | `sessionId, method, contextTokensBefore, contextTokensAfter, wallMs, promptTokens, cacheReadTokens, cacheWriteTokens, summaryChars, errorCode?` | on each compaction |
| `system_prompt_rendered` | `sessionId, modelProvider, modelId, originalBytes, budgetBytes, includedBytes, omittedFiles, truncatedFiles` | on each system prompt rebuild |
| `max_tokens_shaped` | `sessionId, modelProvider, modelId, originalMaxTokens, shapedMaxTokens, inputTokens, contextWindow` | on each LLM call |
| `length_finish` | `sessionId, modelProvider, modelId, stopReason, outputTokens` | on every `length` finish |
| `adaptive_context_session_end` | `sessionId, turnCount, recoveryCount, pruneCount, compactionCount, lengthFinishCount, totalWallMs` | session end |

All events respect the existing `enableAnalytics` flag — no telemetry
fires unless the user has opted in.

### 4.2 Dashboard (out of scope but spec'd for the next iteration)

A single SQL view per metric so the team can answer questions
without writing reports. The minimum useful queries:

```sql
-- "Did the canary cohort finish longer sessions without overflowing?"
SELECT
  cohort,
  AVG(turn_count)            AS mean_turns,
  SUM(recovery_count)        AS total_recoveries,
  SUM(recovery_failed)       AS total_failures,
  SUM(length_finish_count)   AS total_truncations
FROM adaptive_context_session_end
GROUP BY cohort;  -- 'control' | 'canary'

-- "How much did replay-prefix summarisation save on MiniMax?"
SELECT
  method,
  AVG(wall_ms)         AS mean_wall_ms,
  AVG(cache_read_tokens) AS mean_cache_read,
  AVG(prompt_tokens)   AS mean_prompt,
  COUNT(*)             AS n
FROM compaction_run
WHERE model_provider = 'minimax'
GROUP BY method;
```

### 4.3 Go/no-go criteria per phase

| Phase | Ship-criteria | Block-criteria |
|---|---|---|
| 1 | Recovery succeeds in ≥90% of overflow cases for the canary cohort on sessions with ≥30 turns. | Recovery success rate <60% on the canary cohort. |
| 2 | Mean session turns for the canary cohort increases by ≥30% before the first length-finish. | Tool-result pruning breaks any existing replay test. |
| 3 | Mean compaction wall time on MiniMax drops by ≥4x with no drop in summary quality (LLM-graded, scale 1-5, ≥4.0 mean). | Compaction cost increases. |
| 4 | Mean turns before first length-finish on the canary cohort ≥ 2x control. | System prompt envelope breaks a documented export path. |

---

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Replay-prefix summarisation breaks provider rate-limit / cache semantics | Medium | High (slower compaction) | Default the feature on only for providers that have been validated in CI; keep the text-block fallback as the non-adaptive path. |
| Re-pruning a tool result breaks a later prompt that needed the full output | Low | High (user-visible regression) | The marker is visible in the truncated result; extensions can mark results with `excludeFromPrune`; Phase 2 emits a `tool_result_pruned` event so the user can audit. |
| Byte-budgeted AGENTS.md drops a section the user relied on | Medium | Medium (one-time surprise) | Diagnostics in the marker line; the budget is 5% of context by default, well above typical AGENTS.md sizes; the user's own `promptGuidelines` are unaffected. |
| Master toggle defaults to ON in a future release and changes user behaviour silently | Low | High (trust) | The default for the first two minor releases is OFF; the on-by-default flip is a separate, telegraphed change with a CHANGELOG note. |
| `adaptiveContextServerDefault: "canary"` is rolled out without a kill switch | Low | High (pi.dev) | The field is read on every session start; rolling the host config back to `"off"` is a config push, no code change. The canary hash is a per-session bucket so a small cohort can be opted in or out. |
| Per-model profile in code is stale after a MiniMax model spec change | Medium | Low (sub-optimal defaults) | Phase 1 emits `model_spec_drift` telemetry if `contextWindow` or `maxTokens` returned by the model spec is outside the profile's expectations. |
| TUI settings selector grows too long to navigate | Low | Low (UX) | The master toggle and 4 sub-toggles fit in one page; the existing `SettingsList` already has search (`{ enableSearch: true }` at `:840`). |

---

## 6. Cross-cutting implementation notes

### 6.1 Profile resolution algorithm

`settings-manager.ts:getAdaptiveContextSettings(model)`:

```ts
export function getAdaptiveContextSettings(model?: Model<Api>): Required<
  Omit<AdaptiveContextSettings, "modelPolicies">
> & { profile: string; modelPolicies: Record<string, Partial<AdaptiveContextSettings>> } {
  const user = this.settings.adaptiveContext ?? {};
  const userDefaults = { ...DEFAULTS, ...user };
  if (model === undefined) {
    return { ...userDefaults, profile: "user", modelPolicies: user.modelPolicies ?? {} };
  }
  // 1. built-in profile by provider
  if (model.provider === "minimax" || model.provider === "minimax-cn") {
    Object.assign(userDefaults, MINIMAX_PROFILE, user);
    // 2. exact-match user override
    const exact = user.modelPolicies?.[`${model.provider}/${model.id}`];
    if (exact) Object.assign(userDefaults, exact);
    // 3. provider-wildcard user override
    const wild = user.modelPolicies?.[`${model.provider}/*`];
    if (wild) Object.assign(userDefaults, wild);
    return { ...userDefaults, profile: "minimax", modelPolicies: user.modelPolicies ?? {} };
  }
  return { ...userDefaults, profile: "user", modelPolicies: user.modelPolicies ?? {} };
}
```

### 6.2 Footer render

`packages/coding-agent/src/modes/interactive/components/footer.ts:64-` —
add `setAdaptiveContext(settings)`:

```ts
setAdaptiveContext(settings: Required<Omit<AdaptiveContextSettings, "modelPolicies">> & { profile: string }) {
  this.adaptiveContext = settings;
  // status text:
  //   "AC"                 master off
  //   "AC 80%"             master on, threshold 0.8
  //   "AC 80% M"           master on, MiniMax profile
  //   "AC 80% 2/3"         master on, recovery attempt 2 of 3 in flight
}
```

### 6.3 Settings export/import

`packages/coding-agent/src/core/settings-manager.ts` — the existing
`Settings` interface is JSON-serialised to `~/.pi/settings.json`. The
new `adaptiveContext` key is added to the type and the existing
serialisation code paths pick it up automatically. No additional
export work is required.

### 6.4 Extension compatibility

The `transformContext` hook
(`packages/agent/src/agent-loop.ts:291-293`) is preserved. Extensions
that already use it are unaffected. The new pipeline layers the
*adaptive context* transforms *before* `transformContext`, so any
extension that wants to see the un-pruned transcript can read the
session log instead.

### 6.5 Backwards compatibility

- Default `adaptiveContext.enabled: false` keeps the existing behaviour byte-identical for the first two minor versions.
- The existing `compaction.enabled: boolean` setting continues to work as a master switch; the adaptive context layers on top of it.
- A user with `compaction.enabled: false` and `adaptiveContext.enabled: true` will get adaptive context *minus* the auto-compaction. The Phase 1 recovery loop only runs when `compaction.enabled` is also true.
- All new fields in `AdaptiveContextSettings` are optional; existing user settings.json files load unchanged.

### 6.6 Test fixtures

- `packages/agent/test/fixtures/long-session.jsonl` — a 50-turn fixture
  used by every phase. Generated from a real session, anonymised.
- `packages/agent/test/fixtures/overflow-turn-30.jsonl` — a 30-turn
  fixture that ends with an overflow error from the provider.
- `packages/agent/test/fixtures/tool-result-zoo.jsonl` — a fixture
  with 20 tool calls of varying sizes, used for the pruner tests.
- `packages/coding-agent/test/suite/regressions/` — a new file per
  gap item, named `<issue>-<short-slug>.test.ts` per the existing
  convention.

---

## 7. The decision matrix — what to ship, when, in what order

| Phase | Goal | Visible improvement | Toggle state | MiniMax cohort | Days (estimate) |
|---|---|---|---|---|---|
| 1 | Overflow recovery + master toggle | Long sessions no longer die on first overflow | Master toggle off by default; canary 25% on pi.dev | Adaptive context on via `MINIMAX_PROFILE` | 5-7 |
| 2 | Tool-result re-pruning | Sessions last 30%+ longer before length-finish | Sub-toggle | canary + on | 4-6 |
| 3 | Replay-prefix summarisation | Compaction is 5-10x faster on MiniMax | Sub-toggle | canary + on | 5-7 |
| 4 | Byte-budgeted AGENTS.md + max-tokens shaping | Long sessions no longer hit the output cap on near-full input | Sub-toggle | canary + on | 4-5 |
| — | Master toggle ON by default for all | — | Master toggle on | everyone | Phase 5+ after measurement |

Total scope for the four phases: ~22-30 engineering days. Each phase is
independently shippable and reversible. The pi.dev canary cohort gets
the on-profile for the whole four-phase window so the measurement is
continuous.

---

## 8. The single most important design decision

**Bundle all four changes under one master toggle.** The alternative
— exposing four unrelated flags — would let users turn on the
"dangerous" ones (overflow recovery with no recovery counter, replay
prefix on a provider that doesn't support it) and turn off the
"safe" ones (pruning, byte-budgeted instructions) in confusing
combinations. The bundled toggle gives us a coherent experiment, a
coherent rollback, and a coherent narrative for the changelog.

The `MINIMAX_PROFILE` in code is the second most important decision.
Shipping a known-good default for the user's specific provider is
what turns "we have an option" into "it just works for me on
pi.dev". Without the profile, the user has to discover the right
combination of threshold, retain ratio, and retry count from
documentation — and they will not.

The third most important decision is **telemetry first, not last**.
Every phase ships with the measurement hooks from §4.1 enabled by
default (subject to `enableAnalytics`). The go/no-go for the next
phase is a SQL query, not a Slack thread.
