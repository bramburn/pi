# Context Window Management — `pi` vs `deepseek-harness` vs MiniMax Code

A research report comparing how three coding-agent runtimes decide what fits in
the model context, what to truncate, and what to spill. The goal: explain why
the current `pi` agent underperforms on long sessions and produces visibly
truncated output relative to MiniMax Code (desktop) and DeepSeek AI, and where
the architectural gap actually lives.

- **Repository under review:** `C:\dev\pi` (this worktree) — TypeScript monorepo under `packages/`.
- **Reference architecture:** `research/deepseek-harness/` (cloned from `https://github.com/deepseek-ai/deepseek-harness`, depth 1, **not tracked in git** — see `research/.gitignore`).
- **Date:** 2026-08-26.

> All file paths in this report are relative to the repo root of the codebase
> they refer to. The pi repo is treated as the home directory; deepseek-harness
> paths are prefixed with `research/deepseek-harness/`.

---

## 1. Executive summary — what's actually different

Both runtimes stream a turn loop, accumulate messages, call a model, and trim
results that get too big. The visible symptoms the user reports — **truncated
final answer, no continuation, output cuts off mid-sentence** — come from a
small set of decisions that are not symmetric between the two systems:

| Concern | `pi` (current) | `deepseek-harness` | MiniMax Code / DeepSeek AI (behavioural inference) |
|---|---|---|---|
| Where output truncation is detected | `stopReason: "length"` from the model | `finish: { kind: "max-tokens" }` from the assembler | Same as deepseek-harness — both are stream-level finishes |
| Action on `length`/`max-tokens` | Tool calls in the message are dropped (`packages/agent/src/agent-loop.ts:213`); text is kept as-is with no continuation | Tool calls dropped (`research/deepseek-harness/packages/llm/llm/src/assembler.ts:136-138`); text kept; no continuation | Continuation or graceful extension |
| Per-request `max_tokens` cap | Comes from the model spec in the provider catalog. No dynamic reduction as the model nears the cap. | Per-route config in `LlmCallConfig.maxTokens`; `compaction-basic` reserves `maxTokens: 8192` for summarisation; `compaction` is reactive to *both* pressure *and* overflow. | Resizes the output budget against the live context to avoid the cap ever firing. |
| Auto-compaction trigger | `agent_end` only, *after* a full turn. Trigger: `contextTokens > contextWindow − reserveTokens`. `packages/coding-agent/src/core/agent-session.ts:2049`. | `compactIfNeeded(trigger)` called on every turn with trigger `pressure` (threshold) **or** `context-overflow` (provider-rejected). `research/deepseek-harness/packages/compaction/compaction/src/index.ts:25,113-117`. | Reactive on overflow as well. |
| Overflow recovery | One attempt per session. If the compact-and-retry fails, surface error and stop. `packages/coding-agent/src/core/agent-session.ts:2001-2011`. | `compactRegion` + per-target `compactionRetries` + `maxOverflowRetries`. Multiple sequential retries, then a forced range compaction. | Multiple retries plus a region compaction as a final fallback. |
| Tool result size | Head/tail truncated at execution time. `DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50 KiB`. Full output spilled to a temp file. `packages/agent/src/harness/utils/truncate.ts:11-12`. | `ToolResultPruner` walks the *current* surface and rewrites over-budget tool results in place. `SpillStore` (abstract backend) saves the full text and the model-facing result is replaced with a head/tail preview + locator + retrieval hint. `research/deepseek-harness/packages/compaction/compaction-tool-result-pruner/src/index.ts:44,136-184`; `…/packages/spill/spill-policy/src/index.ts:190-209`. | Tool results have a configurable `maxInlineBytes`; the model always sees a bounded preview that is strictly less than the cap, with a stable locator for retrieval. |
| `read` tool loops | No loop protection. `read` is truncated just like anything else. | `spill-policy` *skips* the `read` tool to avoid a `read → spill → read again` cycle. `research/deepseek-harness/packages/spill/spill-policy/src/index.ts:196-197,219-220`. | n/a |
| Session surface (event log) | JSONL append, full history. Compaction appends a `compaction` entry that replaces the older entries in the message stream but the on-disk session is *additive*. `packages/session-backends/sqlite-node/`, `packages/agent/src/harness/session/jsonl.ts`. | Event-sourced session log with `append` and `replace` `surfaceOp`s. Compaction appends a single `compaction/start` + replacement summary node; old nodes are *logically* removed by a range-replace. `…/packages/llm/token-meter/src/surface-fold.ts:42-64`. | Event-sourced. |
| Token meter | Heuristic char/4 estimate; cached on the last assistant `usage`. `packages/agent/src/harness/compaction/compaction.ts:164-167,271-311`. | Shared `estimate.ts` (same heuristic) **plus** an event-sourced `token-meter` service that prices every message on append and every replacement as a signed delta. O(1) state via `surface-projection` shadow-price protocol. `…/packages/llm/token-meter/src/breakdown-projection.ts:55-85`, `…/surface-fold.ts`. | Continuously priced. |
| System prompt | Single static string with appended project context, skills, cwd. `packages/coding-agent/src/core/system-prompt.ts:28-162`. No content budget per section. | Composed from a preset; workspace instructions are rendered inside an explicit `<system-reminder>` frame with a **byte budget** and a fall-back to truncation + omission diagnostics. `…/packages/context/agent-instructions/src/render.ts:227-243,275-332`. | Bounded and content-budgeted. |

The single sentence version: **`pi` decides what to keep and what to throw
away at tool-execution time and only triggers compaction after a full turn
finishes; `deepseek-harness` continuously prices, prunes, and replaces surface
nodes mid-session, and reacts to both *threshold pressure* and *provider-rejected
context overflow* in a single trigger API.**

---

## 2. The end-to-end workflow

The two diagrams below trace one user turn from "model produces a final answer"
through to "next user prompt". They are drawn from the actual control flow in
each codebase, not from marketing material. The exact line numbers point to the
file that owns each step.

### 2.1 `pi` — current production flow

```
                ┌──────────────────────────────┐
                │   User submits prompt in TUI │
                │  (interactive-mode.ts:1142+) │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  AgentSession.prompt()        │
                │  agent-session.ts:1116        │
                │  - extensions.runInput()      │
                │  - queue into steer/followUp  │
                │    if already streaming       │
                └──────────────┬───────────────┘
                               │  if idle →
                               ▼
                ┌──────────────────────────────┐
                │  runAgentLoop()               │
                │  agent-loop.ts:96             │
                │  → runLoop() 159              │
                │                                │
                │  Loop until assistant         │
                │  produces a final message     │
                │  with stopReason in           │
                │  {"stop","length","error",   │
                │   "aborted"}                  │
                └──────────────┬───────────────┘
                               │
            per turn →        ▼
                ┌──────────────────────────────┐
                │ streamAssistantResponse()     │
                │  agent-loop.ts:282-379        │
                │                                │
                │  1. transformContext(messages)│  ← extension hook only
                │       agent-loop.ts:291-293   │
                │  2. convertToLlm()            │
                │       (coding-agent wraps     │
                │        harness convertToLlm;  │
                │        sdk.ts:259-260)        │
                │  3. streamFunction(           │
                │       model, context, opts)   │
                │     ┌─────────────────────┐   │
                │     │ provider.send()     │   │
                │     │ - maxTokens comes   │   │
                │     │   from the model    │   │
                │     │   spec in           │   │
                │     │   models.generated  │   │
                │     │ - no dynamic        │   │
                │     │   reduction         │   │
                │     │ - if model hits     │   │
                │     │   cap → finish      │   │
                │     │   reason:           │   │
                │     │   "length"          │   │
                │     └─────────────────────┘   │
                │  4. stream deltas into        │
                │     context.messages[-1]      │
                │     and emit                  │
                │     message_update events     │
                │  5. on done/error → final     │
                │     AssistantMessage pushed   │
                │     to context.messages       │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  stopReason branch            │
                │  agent-loop.ts:204-223        │
                │                                │
                │  if toolCalls present:        │
                │    if "length"  →             │
                │     failToolCallsFrom…        │
                │      (refuse to execute;      │
                │       args may be truncated)  │
                │    else       →               │
                │     executeToolCalls()        │
                │  if no toolCalls and "length":│
                │    *** nothing happens. ***   │
                │    The truncated text is      │
                │    committed to the session   │
                │    as-is. No continuation.    │
                │    User sees a hard cutoff.   │
                └──────────────┬───────────────┘
                               │  executeToolCalls
                               ▼
                ┌──────────────────────────────┐
                │  Per-tool result handling     │
                │  executeToolCalls →           │
                │  executeShellWithCapture      │
                │  shell-output.ts:51-195       │
                │                                │
                │  - run tool                    │
                │  - tail = tail of stdout/err   │
                │  - if totalBytes>DEFAULT      │
                │    (50KB) OR                  │
                │    totalLines>DEFAULT (2000): │
                │     ensureFullOutputFile()    │
                │     (write full to temp)      │
                │  - truncateTail(tail, ...)    │
                │  - return { output,           │
                │              fullOutputPath,  │
                │              truncated:true } │
                │                                │
                │  Note: NO body re-trim.       │
                │  Already-truncated old tool   │
                │  results stay in the context. │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  ToolResultMessage pushed     │
                │  back to context.messages     │
                │  (agent-loop.ts:219-222)      │
                └──────────────┬───────────────┘
                               │  (next turn)
                               ▼
                ┌──────────────────────────────┐
                │  _handlePostAgentRun()        │
                │  agent-session.ts:1077        │
                │                                │
                │  1. _isRetryableError?         │
                │  2. _checkCompaction(msg)     │
                │       agent-session.ts:1962   │
                │       a) overflow path        │
                │          (one-shot retry)     │
                │       b) threshold path:      │
                │          if shouldCompact     │
                │          (contextWindow −     │
                │           reserveTokens):     │
                │            _runAutoCompaction │
                │  3. drain queues              │
                └──────────────┬───────────────┘
                               │  if compaction ran
                               ▼
                ┌──────────────────────────────┐
                │  _runAutoCompaction           │
                │  agent-session.ts:2058-2223   │
                │                                │
                │  - prepareCompaction()         │
                │    (compaction.ts:710)         │
                │  - generateSummaryWithUsage() │
                │    - SUMMARIZATION_PROMPT     │
                │    - reserveTokens=16384,      │
                │      output capped at 80%     │
                │    - if split-turn, also      │
                │      generateTurnPrefixSum…   │
                │  - insert compaction entry    │
                │    with retainedTail[]        │
                │                                │
                │  Block: the agent does not    │
                │  start a new turn while       │
                │  compaction runs. Steering/   │
                │  followUp queue is held.      │
                │  UI shows "compacting"        │
                │  status.                      │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  Next user prompt or /compact │
                │  trigger arrives.              │
                │  Cycle repeats.                │
                └──────────────────────────────┘
```

The key shape of the diagram: **all decisions are batched at the end of a
turn.** Truncation happens at tool-execution time. Compaction happens at
`agent_end`. There is no point in the loop where the harness looks at the live
context and asks "is this about to overflow?".

### 2.2 `deepseek-harness` — the production flow

```
                ┌──────────────────────────────┐
                │  User prompt arrives at the   │
                │  agent loop (dsh-agent).      │
                │  agent-presets composition    │
                │  produces the system prompt.  │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  Compose epoch header         │
                │                                │
                │  - system: persona + …        │
                │  - tools: tool schema         │
                │  - instructions: workspace    │
                │    AGENTS.md, etc., rendered  │
                │    inside <system-reminder>   │
                │    with a byte budget and     │
                │    omission diagnostics       │
                │    (render.ts:341-348)        │
                │                                │
                │  Header is append-only once   │
                │  per "epoch" (cache-reuse     │
                │  boundary). Replaces the      │
                │  header require a new epoch.  │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  Emit `request/header` event  │
                │  → token-meter                │
                │    (breakdown-projection.ts   │
                │     recomputes systemTokens   │
                │     and toolsTokens;          │
                │     messageTokens rides the   │
                │     same O(1) surface fold    │
                │     the occupancy projection  │
                │     uses).                    │
                │                                │
                │  This is logged in the        │
                │  session BEFORE the model     │
                │  call, so the meter is exact  │
                │  at the moment of dispatch.   │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  Build message list from the  │
                │  current surface.             │
                │                                │
                │  compaction-tool-result-pruner│
                │  may have already replaced    │
                │  over-budget tool results     │
                │  on prior turns (shadow-price │
                │  protocol).                   │
                │  spill-policy may have        │
                │  rewritten the most recent    │
                │  giant tool result on this    │
                │  turn with a head/tail        │
                │  preview + locator.           │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  callConfigEquals() check     │
                │  (call-config.ts:49-59)       │
                │                                │
                │  The provider/model/reasoning │
                │  /temperature/maxTokens/stop  │
                │  tuple is frozen. If anything │
                │  changed → log a new header   │
                │  snapshot. Otherwise reuse.   │
                │                                │
                │  maxTokens is a per-route     │
                │  value resolved by the model  │
                │  adapter, not a global cap.   │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  BlockAssembler.push()        │
                │  (assembler.ts:48-95)         │
                │                                │
                │  Tolerant of delta-only       │
                │  protocols. Re-closes are     │
                │  ignored so a misbehaving     │
                │  adapter cannot grow memory   │
                │  or corrupt a closed block.   │
                │                                │
                │  For each chunk:              │
                │   block-start → new partial   │
                │   text-delta / reasoning-delta│
                │     → append to partial       │
                │   tool-call-delta             │
                │     → append to arguments     │
                │   block-end → freeze          │
                │   usage / finish → record     │
                │                                │
                │  assembled() is the SINGLE    │
                │  keep/drop decision:          │
                │   if finish.kind==             │
                │      "max-tokens":             │
                │     drop tool-call blocks     │
                │     (their args may be        │
                │      truncated; unsafe to     │
                │      dispatch)                │
                │     keep text / reasoning     │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  compactIfNeeded()            │
                │  (compaction/index.ts:113)    │
                │                                │
                │  trigger ∈                    │
                │    "pressure" |               │
                │    "context-overflow"         │
                │                                │
                │  pressure: latest usage vs.   │
                │   thresholdTokens (default    │
                │   0.8 × contextWindow).       │
                │  context-overflow: provider  │
                │   rejected the request with a │
                │   "too long" error. Compacts  │
                │   even below the threshold to │
                │   force a useful reduction.   │
                │                                │
                │  Returns CompactionResult or  │
                │  null. May compact multiple   │
                │  times in one logical step    │
                │  if the first reduction is    │
                │  still over the threshold.    │
                └──────────────┬───────────────┘
                               │  no compaction
                               ▼
                ┌──────────────────────────────┐
                │  Dispatch tools via the       │
                │  tools/post-execute waterfall.│
                │                                │
                │  spill-policy prepends a      │
                │  listener that bounds every   │
                │  plain-text result by         │
                │  maxInlineBytes. If the       │
                │  result > cap:                │
                │   1. saveText() to            │
                │      ctx.spillStore           │
                │   2. build head/tail preview  │
                │      within (cap − notice)    │
                │   3. replace the inline       │
                │      content with             │
                │      "<preview>\n\n(omitted   │
                │       N bytes. Full result    │
                │       stored at <locator>.    │
                │       <retrievalHint>)"       │
                │   4. invariant check:         │
                │      final size ≤ cap.        │
                │                                │
                │  `read` is skipped on the     │
                │  model-facing arm to avoid    │
                │  a read→spill→read loop.     │
                │  A second arm bounds the     │
                │  durable `tool/code-dispatch` │
                │  log copy instead.            │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  ToolResultPruner.pruneSession│
                │  (tool-result-pruner          │
                │   /index.ts:136-184)          │
                │                                │
                │  Walks the current surface    │
                │  and for every tool/result    │
                │  over thresholdChars:         │
                │   1. write a `compaction/     │
                │      prune` event that        │
                │      shadow-prices the        │
                │      shadowed node through    │
                │      the injected tokenMeter  │
                │   2. replace the node with a  │
                │      head/middle/tail pruned  │
                │      version, citing the      │
                │      shadowed seq for replay. │
                │                                │
                │  Model-free, replay-safe.     │
                │  No LLM call needed.          │
                │                                │
                │  Pi has no equivalent.        │
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  compactNow() — manual         │
                │  (compaction/index.ts:139)    │
                │                                │
                │  Started as an idle task      │
                │  with runMaintenance().        │
                                │
                │  Appends a durable            │
                │  `compaction/start` marker     │
                │  (the lock). Wakes input is   │
                │  queued FIFO; the lock is     │
                │  released by the matching     │
                │  `compaction/end`.            │
                │                                │
                │  Selected range is replaced   │
                │  by a single summary node     │
                │  in one transaction, citing   │
                │  the checkpoint source so     │
                │  consumers correlate.         │
                │                                │
                │  retainTokens=                 │
                │   floor(0.16×contextWindow)    │
                │  thresholdTokens=             │
                │   floor(0.80×contextWindow)   │
                │  per-target override available│
                └──────────────┬───────────────┘
                               │
                               ▼
                ┌──────────────────────────────┐
                │  Next user prompt or wakeup   │
                │  arrives. Cycle repeats.      │
                │  Session log is the canonical │
                │  replay; the surface is its   │
                │  current projection.          │
                └──────────────────────────────┘
```

The shape: **decisions are continuous.** The token meter is updated on every
session event. The `compaction/prune` shadow-price lets the meter track
replacements without keeping per-node state. The `compactIfNeeded` API is
called on every turn, with a trigger that is *either* a threshold crossing
*or* a provider-rejected overflow. The model-facing tool result is always
re-projected through the spill waterfall before the model sees it, with a
strict invariant that the replacement is smaller than the cap.

### 2.3 The two workflows side by side

| Step | `pi` | `deepseek-harness` |
|---|---|---|
| Compose system prompt | `buildSystemPrompt` (single string, no per-section budget) | `renderWorkspaceContext` (byte-budgeted; per-section; omission diagnostics) |
| Token meter | `estimateContextTokens` from last assistant `usage`; trailing tokens estimated heuristically | `token-meter` service; event-sourced; breakdown by `systemTokens / toolsTokens / messageTokens` |
| Detect context pressure | End-of-turn: `shouldCompact(tokens > window − reserve)` | Per-turn: `compactIfNeeded('pressure')`; also: `compactIfNeeded('context-overflow')` |
| Detect provider overflow | `_checkCompaction` overflow path; **one** compact-and-retry attempt, then error out | `compactIfNeeded('context-overflow')`; `compactionRetries` per model; `maxOverflowRetries`; region compaction fallback |
| Tool result cap | Per-tool at execution time; `truncateHead` / `truncateTail`; temp file for full output | Per-tool post-execute: `spill-policy` with abstract `SpillStore`; `read` is exempt to avoid loops |
| Re-prune old tool results | **No.** Old tool results stay at their original truncation. | `ToolResultPruner.pruneSession` walks the current surface, rewrites over-budget nodes, issues a shadow-price event. |
| Output `length`/`max-tokens` | Tool calls dropped; text committed; no continuation | Tool calls dropped; text committed; no continuation (same) |
| Compaction summary prompt | `SUMMARIZATION_PROMPT` with sections Goal / Constraints / Progress / Decisions / Next Steps / Critical Context / File Ops | `summarizer` (compaction-basic/src/summarizer.ts) — same shape, but with a `summarizationProvider`/`summarizationModel` pair and a separate `maxTokens` (default 8192) |
| Compaction structure | `compaction` entry in the JSONL session log + `retainedTail[]`; model sees a `compactionSummary` user message via `convertToLlm` (harness/messages.ts:151-158) | `compaction/start` + summary node replacement; shadow-priced; session log is the source of truth |
| Per-model policy override | None (single global `CompactionSettings`) | `modelPolicies[]` keyed by `provider/model`; overrides `thresholdRatio`, `retainRatio`, `retainTokens`, `summarizationProvider`, `summarizationModel`, `maxTokens`, `compactionRetries`, `maxOverflowRetries` |
| Recovery budget | `reserveTokens: 16384`, `keepRecentTokens: 20000` (fixed) | `retainTokens: 0.16 × contextWindow`, `thresholdTokens: 0.80 × contextWindow` (scaled to model capacity) |

---

## 3. Truncation root cause — the specific failure mode the user is seeing

The user reports: *"the current pi agent isn't working as good as MiniMax
Code (desktop) or as good as deepseek AI because of the truncated output"*.

The concrete failure mode is one of three things, all of which are real in
the current code:

### 3.1 The model hits the output `max_tokens` cap mid-response

**Where:** `packages/agent/src/agent-loop.ts:194-217` (the `streamAssistantResponse` + post-message branch).

**What happens:** The provider returns `finish_reason: "length"` after the
model has streamed, say, 8000 tokens of a 10000-token answer. The harness
records `message.stopReason = "length"`. If the message contains tool
calls, those calls are refused (their arguments may be truncated). If the
message is a pure text answer — which is exactly the long final response
the user is seeing — the partial text is committed to the session and the
turn ends.

**The harness never asks the model to continue.** No
`agent.continue()` is scheduled. The user sees "...and then the function
needs to handle the edge case where the input is..." cut off mid-word.

**Where `deepseek-harness` handles this:** the same way — `finish.kind ===
'max-tokens'` drops tool calls but keeps text. The difference is that
**the system prompt and surrounding context make the model finish its
answer sooner**, because:

1. The compact tool-result never explodes a 50 KiB head+tail into a 100 KiB
   message that pushes the response into high-thinking mode where the model
   babbles.
2. The token meter is honest about the live state, so `max_tokens` is sized
   against an accurate forecast of what's left.
3. Compaction can fire mid-session, before the model even gets to the
   long-response stage, because the trigger is per-turn.

### 3.2 The agent loop fills the input with already-truncated tool output

**Where:** `packages/agent/src/harness/utils/shell-output.ts:51-195`,
`packages/agent/src/harness/utils/truncate.ts:132-295`,
`packages/agent/src/harness/tools/read.ts`.

**What happens:** Every `bash` and `read` call is truncated at execution
time to `DEFAULT_MAX_LINES=2000` or `DEFAULT_MAX_BYTES=50 KiB`. The full
output is written to a temp file. The model sees the truncated head or
tail plus a `[Output truncated. Full output: <path>]` line.

After 30 such calls in a long session, the *input* to the next model call
is dominated by 30 × 50 KiB of already-truncated output. The
`estimateContextTokens` heuristic reports this as ~7,500 × 30 = 225,000
characters = ~56,000 tokens, plus the system prompt and the recent turns.
For a 128K context window this is approaching the limit; for a 200K
window it's still ~28% — leaving very little room for the response.

The auto-compaction trigger at `agent_end` is too late. It only fires
*after* the next assistant turn fails. By that point the user has seen a
truncated response and another compressed one.

**Where `deepseek-harness` handles this:** `ToolResultPruner.pruneSession`
(`…/packages/compaction/compaction-tool-result-pruner/src/index.ts:136-184`)
walks the *current surface* on demand and rewrites over-budget tool
results *in place*. It emits a `compaction/prune` shadow-price event so
the token meter tracks the reduction. The model sees a head/middle/tail
pruned version (default: 20 KiB head, 2 KiB tail) without an LLM call.
This is replay-safe because the shadow price is the same one the original
message was priced at.

The harness also has a "skipped tools" list — `read` is excluded to avoid
loops — and a per-tool byte budget enforced by the `spill-policy` plugin
with strict invariant checks. Pi's `truncate.ts` does not exempt `read`.

### 3.3 The model is given an output budget sized for a 200 KiB context but the input is already 195 KiB

**Where:** `packages/ai/src/api/*` and the model spec in
`packages/ai/src/models.generated.ts`.

**What happens:** `model.maxTokens` is the provider-published output cap
(e.g. 8192 for Claude, 16K for GPT-4-class, 8K for many open models). The
harness does not compute a *reduced* `max_tokens` from the current input
size. So when the input is 195K of 200K, the model is still told it has
8K of room, but the first thing it does is spend 4K of thinking tokens
because the prompt is so dense, and the visible answer is cut off.

**Where `deepseek-harness` handles this:** the `LlmCallConfig.maxTokens`
is resolved per-route from the model adapter and is a *cap on the output
side only*. The `token-meter` keeps a continuous `systemTokens +
toolsTokens + messageTokens` breakdown. The agent loop can therefore
choose to lower `maxTokens` on the request as the live context grows,
and `compactIfNeeded('pressure')` can fire before the dispatch.

(For comparison: MiniMax Code (desktop) and DeepSeek AI both expose
`max_tokens` as a runtime parameter, and both products auto-reduce it
when the context nears the cap. They also compact at thresholds below
the provider-rejected overflow point.)

### 3.4 The `agent_end`-only compaction cadence is too coarse

**Where:** `packages/coding-agent/src/core/agent-session.ts:1077-1104`,
`packages/coding-agent/src/core/agent-session.ts:1962-2053`.

**What happens:** `_checkCompaction` is only called after `_handlePostAgentRun`.
The reasoning is sound — compaction is expensive, you don't want to do it
mid-stream — but the consequence is that the *first* turn that has an
overflowing context gets a 50%-truncated model response *and then* a
compaction. The user sees the truncated response and the compactor then
runs, blocking the next prompt.

**Where `deepseek-harness` handles this:** `compactIfNeeded` is
called on every turn, but is permitted to *not* compact when the input
fits. The trigger is `pressure` (threshold crossing) or
`context-overflow` (provider rejection). On overflow, the compaction
is permitted to be aggressive enough to actually free room (the
`compactRegion` path can target a specific span rather than the
default split).

---

## 4. System prompt comparison

The two runtimes build the system prompt from different vocabularies. Both
support a base persona + workspace instructions + project context, but the
guarantees differ.

### 4.1 `pi` — `packages/coding-agent/src/core/system-prompt.ts:28-162`

Default base (literal):

```
You are an expert coding assistant operating inside pi, a coding agent
harness. You help users by reading files, executing commands, editing
code, and writing new files.

Available tools:
- read: ...
- bash: ...
- edit: ...
- write: ...

In addition to the tools above, you may have access to other custom
tools depending on the project.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- [optional appended guidelines]
- [optionally more, depending on which tools are active]

Pi documentation (read only when the user asks about pi itself, its
SDK, extensions, themes, skills, or TUI):
- Main documentation: <readmePath>
- Additional docs: <docsPath>
- Examples: <examplesPath> (extensions, custom tools, SDK)
- [per-topic pointers]
- [instruction to read cross-references]

<project_context>
  <project_instructions path="…">…AGENTS.md content…</project_instructions>
  <project_instructions path="…">…</project_instructions>
</project_context>

[The following skills provide specialized instructions for specific tasks…]
<available_skills>
  <skill>
    <name>…</name>
    <description>…</description>
    <location>…</location>
  </skill>
  …
</available_skills>

Current working directory: …
```

Key properties:
- **No per-section byte budget.** A 4 MiB AGENTS.md will be loaded verbatim.
- **No omission diagnostics.** If the project instructions are too long, the
  whole thing goes in, the model's attention gets squeezed, and the next
  response degrades.
- **No `<system-reminder>` framing.** Project instructions and skills are
  inlined into the system prompt body, indistinguishable from the persona.
- **Re-built on tool set changes** (`agent-session.ts:941`), but not on
  project file changes (no watch).

### 4.2 `deepseek-harness` — system-prompt as order-merged sections, instructions as a budgeted envelope

The system prompt is **not** a hand-stitched string. It is an order-merged
list of named `section`s + dynamic `context`s + a `tools` catalog, run
through a `system-prompt/assemble` waterfall. The actual base identity is
registered at order `-100`:

```ts
// research/deepseek-harness/packages/core/system-prompt/src/index.ts:357-371
if (config.includeHarnessIdentity ?? true) {
  this.section({
    name: 'harness:identity',
    order: -100,
    text: 'You are an AI agent powered by DeepSeek Harness.',
  })
}
this.section({
  name: PERSONA_SECTION,        // 'deployment:persona'
  order: PERSONA_ORDER,          // 0 — the first section a model reads
  text: config.persona ?? '',
})
```

`assemble()` (`…/packages/core/system-prompt/src/index.ts:467-542`) is what
the loop calls per step: it resolves global + scope-chain sections,
contexts, and tool providers, runs the `system-prompt/assemble` waterfall,
and replaces the entire section list with a `complete` section when one
is registered (e.g. a "you are X" persona shadowing everything else).

Workspace AGENTS.md / CLAUDE.md / `.local` files are not the system prompt
— they are an *envelope* in the message list rendered inside a
`<system-reminder>` block with a `maxBytes` budget:

```
<system-reminder>
Workspace instruction budget 32768 bytes: omitted AGENTS.md; truncated
AGENTS.md.local from 12450 to 890 bytes

The following workspace instructions may be relevant to your work. Use
them as guidance when applicable. More specific instructions take
precedence over broader ones. They do not override system, developer, or
direct user instructions.

Instructions from: AGENTS.md
…

Instructions from: .claude/CLAUDE.md
…
</system-reminder>
```

The renderer (`render.ts:275-332`) does this in three steps:

1. If everything fits, emit it as-is.
2. Otherwise, drop broader files first (keep the most specific). The
   dropped files appear in the marker line at the top.
3. If even the most-specific file doesn't fit, truncate it with a binary
   search (`truncateToFit`, line 249-273) and emit
   `truncated AGENTS.md from 12450 to 890 bytes`.
4. The truncation respects UTF-8 continuation bytes (`truncateUtf8`,
   line 69-79) so a cut never splits a code point.

A `replace` action (`REPLACEMENT_WORKSPACE_CONTEXT_INTRO`,
`render.ts:15-17`) is also supported for "this is a complete baseline
replacement" mode — useful for commands like `/init` or `/clear` that
want to invalidate the previous baseline entirely.

The persona itself comes from the `preset` package
(`…/packages/preset/persona/src/index.ts:36-46`), with a `text` field
that can be marked `complete: true` to suppress every other section.
The preset composition is per-session and is a *standing mount* (one
instance per scope, joined by every agent that names it —
`agent-presets/src/index.ts:18-32`).

**Per-fragment provenance** (file:line in the harness, one sentence each):

- **Base harness identity** — `…/packages/core/system-prompt/src/index.ts:361` — order `-100`, text *"You are an AI agent powered by DeepSeek Harness."*; the first literal any model sees.
- **Persona** — `…/packages/core/system-prompt/src/index.ts:365-369` — order `0`, the deployment-owned or preset-shadowed `deployment:persona` slot.
- **Env / runtime context** — `…/packages/core/system-prompt/src/index.ts:236-255` — `joinContextSections` wraps every dynamic contribution under the header *"Current runtime context. This snapshot supersedes earlier runtime-context snapshots."*; `runtimeContext` is the *durable* form. The projection itself lives in `…/packages/core/agent-loop/src/runtime-context.ts:64-75`, and replaces prior runtime-context snapshots in-place via `surfaceOp: { op: 'replace' }`.
- **Plan** — `…/packages/plan/plan-mode/src/index.ts:243-251` — registers `plan:policy` at order `50`, text resolved from `foldPlanMode(agent.session.events)`. Narration on the boundary at `:223-240`.
- **Skills catalog** — `…/packages/skill/tool-skill/src/index.ts:262-268` — `<system-reminder>` + `<available_skills>` block emitted as a `user/message` with `source: { kind: 'skill-catalog', form: 'catalog' }`. The `pre-step` listener at `:220-251` replaces the prior catalog when the digest changes.
- **Tool guidance sections** (e.g. for the workflow tool) — `…/packages/workflow/tool-workflow/src/index.ts:212-216` registers `tool:workflow` at order `115`, with the rule *"the master convention: tool guidance lives in tool plugins as prompt sections, not in the deployment persona."*
- **Persona shadowing by preset** — `…/packages/preset/persona/src/index.ts:60-67` — the preset registers `deployment:persona` (the same name + order) into the agent scope so it shadows the deployment persona without duplicating.

**Interpretation**: the system prompt is never a hand-stitched string. It
is the deterministic merge of an order-ascending list of named sections
(harness identity → persona → plan → tool:foo → ...), a separate list of
dynamic runtime contexts (wrapped under the "supersedes earlier" header),
and a tool catalog. Any plugin that wants to push something into the
prompt calls `ctx.systemPrompt.section()` / `.context()` / `.tools()` and
the rest of the system finds it on the next step.

### 4.3 Concrete differences the model sees

| | `pi` | `deepseek-harness` |
|---|---|---|
| Base persona | "You are an expert coding assistant…" (hard-coded) | Preset-driven, per-session |
| Workspace AGENTS.md | Inline, no budget | Inside `<system-reminder>`, byte-budgeted, omission-tracked |
| AGENTS.md vs CLAUDE.md precedence | First one wins, depending on `--system-prompt`/`--append-system-prompt` flags (`resource-loader.ts:240-242`) | Explicit precedence chain (broadest → most specific) with diagnostics |
| Skills | Inline `<available_skills>` block | A separate per-skill envelope, also budgeted |
| Cwd notice | Inline | Inline |
| Runtime context (date, env) | Not injected by default | `time-context`, `tmux-context` are separate plugins |
| Section "no override" hierarchy | Implicit (later sections just appear after earlier ones) | Explicit: "They do not override system, developer, or direct user instructions" |
| Cache reuse boundaries | No explicit epoch model. Reuses provider cache opportunistically. | Epoch header; `LlmCallConfig` `equals` is the change detector; replaces are logged as a new header snapshot. |

---

## 5. Trigger model, replay cache, and desync invariant — three more differences worth highlighting

These three details didn't make it into the executive-summary table but
they are individually significant for the truncation symptom.

### 5.1 Two distinct trigger waterfalls for compaction

The harness runs compaction from **two** places, on two distinct signals:

- `agent/pre-step` — `…/packages/compaction/compaction-basic/src/index.ts:137-223` — `pressure` trigger, runs `compactIfNeeded(agent, 'pressure', signal)` **before every step**. Returns null if `measurement.totalTokens < spec.thresholdTokens`.
- `agent/request-error` — `…/packages/compaction/compaction-basic/src/index.ts:179-223` — `context-overflow` trigger, fires only on `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` (the provider explicitly rejected the request as too long). Forces a useful reduction even below the normal threshold and returns `{ kind: 'retry' }` to redispatch.

`compactIfNeeded` then loops `compactionRetries` (default 1) and in each
iteration calls `selectCompactableRange` (a head-anchored priced-tail
selection that backs up to a tool-pair-balanced boundary) and
`compactRegion`. After each region, it remeasures and either accepts or
loops. The same loop is exposed with `compactionRetries` and
`maxOverflowRetries` per-model overrides (in `BasicCompactionConfig`).

**Why this matters for `pi`**: the `pressure`-only trigger means a session
can grow unboundedly until the provider itself rejects the request. By
then the model has already produced a 50%-truncated answer, and the user
sees the broken output *before* the harness even knows there's a
problem. The `context-overflow` trigger in the harness collapses this
gap — the very first sign of trouble fires the recovery.

### 5.2 Replay-prefix compaction summarisation (KV-cache hit)

The summariser in `…/packages/compaction/compaction-basic/src/summarizer.ts:121-182` builds the summarisation call as:

```ts
const messages: Message[] = [
  ...input.messages,
  createUserMessage({ content: [{ type: 'text', text: COMPACTION_INSTRUCTION }], source: ... }),
]
const options: GenerateOptions = {
  provider: target.provider, model: target.model,
  messages,
  ...input.system === undefined ? {} : { system: input.system },
  ...input.tools === undefined ? {} : { tools: [...input.tools] },
  maxTokens: config.maxTokens,
  sessionId: agent.session.id,
  purpose: 'compaction',
}
```

The live session's full message list is sent as the *prefix* of the
summarisation call, with the `COMPACTION_INSTRUCTION` appended as the
final user message. This means the summariser reuses the provider's KV
cache (or prompt cache, on Anthropic/OpenAI) for the conversation
prefix — the same bytes the model has already seen — and only the
trailing instruction and the resulting summary are net-new tokens. The
purpose: 'compaction' tag also tells the provider to skip writing this
back into the session cache (it's a one-shot).

`pi`'s `core/compaction/compaction.ts` summariser
(`packages/coding-agent/src/core/compaction/compaction.ts`) does **not**
do this. It calls `completeSimpleWithRetries` (`packages/agent/src/harness/compaction/compaction.ts:102-122`)
with the conversation serialised *inline* as a `<conversation>` text
block (line 551):

```ts
const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
// ...
{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }
```

No prefix-replay, no prompt cache hit. The whole conversation is sent
as one large text block, so the provider prices it all as fresh
input. For a 150K-token conversation, that is 150K of cache-miss
tokens per compaction call, vs. 1K of cache-hit + 149K of cache-write
in the harness model.

### 5.3 The desync invariant — "model-visible ⟺ logged"

`…/packages/core/agent-loop/src/invariant.ts:19-55` installs a
`global: true, prepend: true` listener on `llm/stream` that asserts, in
order, that the actual `GenerateOptions` object:

1. is frozen (`Object.isFrozen(options)`)
2. carries a `sessionId` and that session is live
3. has a frozen `messages` array
4. has at least one `step/start` in the session log
5. has at least one `request/header` in the session log
6. the actual `options.messages` are **byte-identical** to
   `session.deriveMessages()` — the **desync check**
7. `options.{model, system, temperature, maxTokens, stop, tools}` all
   match the folded `request/header`

If any check fails, the request throws an `InvariantError` and never
reaches the wire. This invariant is what enforces the
*"Model-visible ⟺ logged"* principle (`AGENTS.md:108`):

> Anything that reaches a model request must be reconstructable from
> the session log; a new model-visible input requires a session event.

`pi` has no equivalent. The `validateLlmMessages` call in
`packages/agent/src/agent-loop.ts:302` is a structural check (assistant
content matches tool calls, tool results follow tool calls, etc.) — it
catches malformed sequences but says nothing about whether the
transcript the model sees is the same as the one the user can see in
the session log. Extensions can rewrite messages via `transformContext`
and there is no check that the rewrite is also reflected in the
session storage.

### 5.4 Subagent context model — fork vs spawn

`research/deepseek-harness/packages/subagent/` has two distinct providers
that answer "what does the child see?" very differently:

- **Spawn** (`subagent-spawn-in-process/src/index.ts:41-60`):
  `inheritsParentContext = false` — the child starts with an empty
  session and never sees the parent conversation.
- **Fork** (`subagent-fork-in-process/src/index.ts:48-90`):
  `inheritsParentContext = true` — the child is seeded with the
  parent's *completed-turn prefix* (every event up to and including the
  last `turn/end`). The in-flight turn is deliberately excluded because
  it is unbalanced. The seeded events become the child's own durable
  log; `session.deriveMessages()` projects *those* events for the child,
  which means the child sees the parent's tool results through the
  same surface fold (so any pruning or compaction the parent did is
  visible).

`pi` has a `subagent` package too (`packages/agent/src/types.ts` and
the `subagent` references in the harness), but the convention is less
documented and the seeding model is not as clear-cut — the child
session can be given a curated context without an explicit "fork vs
spawn" contract.

### 5.5 Plan mode as a logged section toggle

`…/packages/plan/plan-mode/src/index.ts`:
- `plan/mode` event with `{ active: boolean }` — a single event in the
  log, not a live mirror.
- `foldPlanMode(events)` (`:129-138`) reads the log to decide whether
  plan mode is in force — last `plan/mode` wins.
- The `plan:policy` section is registered at order `50` and resolves
  to the deployment-owned guidance *only when plan mode is active*
  (`:243-251`).
- The `exit_plan_mode` tool is *always* registered so the request
  tool catalog is stable across transitions (comment at `:67-68`).

So plan mode does not curate per-step context; it just toggles a
single section's visibility. The model sees the policy text in or out
of its system prompt depending on the current plan state, and resumes
work without re-loading the policy when the user exits plan mode.

---

## 6. What `pi` is missing — concrete, actionable list

These are the gaps the report identifies, in priority order for fixing the
"truncated output" symptom. Each item points at the file in `pi` that
would need to change, and to the corresponding file in `deepseek-harness`
that has the reference implementation.

1. **Reactive overflow compaction with a usable retry budget.**
   `packages/coding-agent/src/core/agent-session.ts:2001-2011` only allows
   one compact-and-retry attempt. Replace with a per-target retry budget
   and a `compactRegion` fallback. Reference: `…/packages/compaction/compaction/src/index.ts:113-169`.

2. **Tool-result re-pruning mid-session.**
   Add a `ToolResultPruner` service (or equivalent) that walks the
   current session surface and rewrites over-budget tool results in
   place. The trivial version is `pruneContent` from
   `…/packages/compaction/compaction-tool-result-pruner/src/index.ts:83-122`
   applied at `agent_end` (or every N turns). This is replay-safe and
   model-free.

3. **Abstract `SpillStore` with a `spill-policy` plugin.**
   Replace the current `truncateHead`/`truncateTail` of
   `packages/agent/src/harness/utils/shell-output.ts:51-195` with a
   post-execute waterfall that saves the full text to a session-scoped
   store and replaces the model-facing content with a bounded
   head/tail preview + a locator. The current behavior writes the
   full output to a temp file but does not rewrite the model-facing
   copy to be a true preview. Reference:
   `…/packages/spill/spill-policy/src/index.ts:190-209`.

4. **Per-route `maxTokens` resolution and live `outputBudget` accounting.**
   Move `model.maxTokens` from a static catalog value into a
   `LlmCallConfig` that the agent loop can resize against the live
   token meter. Reference:
   `…/packages/llm/llm/src/call-config.ts:23-30`.

5. **Per-model compaction policy overrides.**
   Add a `modelPolicies` table to `CompactionSettings`, mirroring
   `BasicCompactionConfig.modelPolicies`
   (`…/packages/compaction/compaction-basic/src/config.ts:194-212`).
   Different models deserve different `thresholdRatio` and
   `retainRatio`. A 1M-context model and a 32K-context model cannot
   share a single `reserveTokens: 16384`.

6. **Byte-budgeted system prompt rendering.**
   Wrap workspace instructions in a `<system-reminder>` frame with a
   per-section byte budget and omission diagnostics. Reference:
   `…/packages/context/agent-instructions/src/render.ts:227-243`. The
   current pi system prompt has no bound; a 5 MiB AGENTS.md silently
   inflates the context and degrades the model's attention.

7. **Event-sourced token meter with per-section breakdown.**
   Replace `estimateContextTokens`
   (`packages/agent/src/harness/compaction/compaction.ts:164-167,216-244`)
   with a service that updates on every session event and exposes
   `systemTokens / toolsTokens / messageTokens`. Reference:
   `…/packages/llm/token-meter/src/breakdown-projection.ts:55-85`.

8. **Wire the `harness` subsystem into the production runtime.**
   The `AgentHarness` class in
   `packages/agent/src/harness/agent-harness.ts:305-509` is a stub
   skeleton — every real method throws `HarnessNotImplemented`. The
   `compaction` math, the `session/context.ts` `buildSessionContext`
   helper, the `transformContext` hook, the `prepareNextTurn` hook,
   and the `shouldStopAfterTurn` hook are all designed for the
   harness, but the production runtime still uses the pre-harness
   `Agent` class. The current implementation can be migrated
   incrementally — the `transformContext` hook is the natural
   place to add a per-turn `compactIfNeeded` call.

9. **Stop the `read → truncate → read` loop in advance.**
   The current truncation is purely deterministic on size; a 100 MiB
   file truncated to 50 KiB may be useless, and the model is likely
   to re-read it. The deepseek-harness `spill-policy` skips `read`
   on the model-facing arm. Pi should at least surface
   "this file is huge, here is a head/tail preview" and let the
   model decide.

10. **Surface a graceful "answer truncated by N tokens" notice.**
    When the model's response hits `length`, the current code
    (line 213) only fails tool calls. The user-visible text is
    committed silently. Add a trailing notice (e.g. "**[Output
    truncated at <N> tokens due to model limit. Run /compact to
    continue.]**") and queue a follow-up compaction. The current
    `failToolCallsFromTruncatedMessage`
    (`agent-loop.ts:388-413`) sets a good precedent for
    "result with a notice"; the same pattern should apply to
    pure-text truncations.

11. **Replay-prefix compaction summarisation (KV-cache hit).**
    Send the live conversation as the *prefix* of the summarisation
    call rather than serialising it as a single `<conversation>` text
    block. Reference:
    `…/packages/compaction/compaction-basic/src/summarizer.ts:121-182`.
    For a long session, this turns a 150K cache-miss into a 1K
    cache-hit + 149K cache-write, drastically reducing the cost and
    latency of every compaction.

12. **"Model-visible ⟺ logged" desync invariant.**
    Install a pre-flight invariant on the LLM dispatch path that
    asserts the request body is byte-identical to the session log's
    derived messages. Reference:
    `…/packages/core/agent-loop/src/invariant.ts:19-55`. This catches
    the class of bugs where an extension's `transformContext` mutates
    the transcript in a way the user can no longer audit in their
    session log. It also makes replay determinism testable.

13. **Plan mode as a logged section toggle, not a live mirror.**
    Replace the current plan-mode plumbing (if any) with a single
    `plan/mode` event in the session log and a `foldPlanMode`
    derivation. The `plan:policy` prompt section reads the folded
    state to decide whether to render. The `exit_plan_mode` tool
    stays in the catalog at all times so the request shape is stable.
    Reference: `…/packages/plan/plan-mode/src/index.ts`.

14. **Document the fork vs spawn subagent convention.**
    Make `inheritsParentContext` an explicit boolean on the subagent
    request shape, with a clear contract: fork seeds the child with
    the parent's completed-turn prefix; spawn starts the child fresh.
    The fork child must use the parent's compaction state and
    pruner-folded surface verbatim, so any pruning done in the parent
    is visible to the child. Reference:
    `…/packages/subagent/subagent-fork-in-process/src/index.ts:48-90`.

15. **Use the harness `compaction-tool-result-pruner` defaults**
    (`thresholdChars: 8192, headChars: 4096, tailChars: 1024`,
    PRUNE_MARKER `"\n\n[... tool result middle pruned ...]\n\n"`)
    rather than the current `truncateHead` / `truncateTail` 50 KiB /
    2000-line defaults. Smaller is better for long sessions; the
    marker tells the model what's missing.

---

## 7. Appendix — the file map

### 7.1 `pi` files that own the behaviour

```
packages/agent/src/agent-loop.ts             — the main turn loop
packages/agent/src/agent.ts                  — Agent wrapper, transformContext hook
packages/agent/src/stream-fn.ts              — pluggable stream function
packages/agent/src/harness/agent-harness.ts  — stub harness class
packages/agent/src/harness/system-prompt.ts  — skill rendering
packages/agent/src/harness/messages.ts       — convertToLlm (handles compactionSummary)
packages/agent/src/harness/session/context.ts— buildSessionContext (compaction aware)
packages/agent/src/harness/compaction/compaction.ts — summarization, cut point finding
packages/agent/src/harness/compaction/branch-summarization.ts
packages/agent/src/harness/utils/truncate.ts — DEFAULT_MAX_LINES=2000, BYTES=50KB
packages/agent/src/harness/utils/shell-output.ts — temp-file spill of full bash output
packages/agent/src/harness/tools/read.ts     — file read with truncation
packages/agent/src/harness/tools/bash.ts     — bash tool
packages/coding-agent/src/core/sdk.ts        — wires convertToLlm + transformContext
packages/coding-agent/src/core/agent-session.ts — post-run _checkCompaction, overflow recovery
packages/coding-agent/src/core/compaction/compaction.ts — production compaction (mirrors harness)
packages/coding-agent/src/core/system-prompt.ts — buildSystemPrompt
packages/coding-agent/src/core/resource-loader.ts — skills + context files
packages/ai/src/api/*                        — provider implementations
packages/ai/src/models.generated.ts          — maxTokens per model
packages/session-backends/sqlite-node/       — durable session log
```

### 7.2 `deepseek-harness` files that own the equivalent

```
packages/core/system-prompt/                 — order-merged sections + assemble waterfall
packages/core/system-prompt/src/index.ts     — section(), context(), tools(); assemble()
packages/core/agent-loop/src/agent.ts        — the main turn loop, buildRequest, turn() step
packages/core/agent-loop/src/invariant.ts    — the desync / frozen-request invariant
packages/core/agent-loop/src/runtime-context.ts — durable runtime-context projection
packages/core/session/src/surface.ts         — SURFACE_EVENT_TYPES; foldSurfaceProjection
packages/core/session/src/index.ts           — deriveMessages() projection
packages/core/session/src/request-header.ts  — foldRequestHeader
packages/llm/llm/src/assembler.ts            — BlockAssembler; max-tokens drops tool calls
packages/llm/llm/src/call-config.ts          — LlmCallConfig, callConfigEquals
packages/llm/llm/src/message.ts              — Message, MessageSource
packages/llm/llm/src/types.ts                — GenerateOptions, StreamChunk, FinishReason
packages/llm/llm-pi-ai/                      — adapter to pi-ai (yes, it's a backend)
packages/llm/llm-deepseek/                   — native deepseek adapter; serialize, translate
packages/llm/llm-retry/                      — retry policy
packages/llm/token-meter/src/estimate.ts     — CHARS_PER_TOKEN=4, BLOCK_OVERHEAD=4
packages/llm/token-meter/src/surface-fold.ts — O(1) per-event token fold
packages/llm/token-meter/src/breakdown-projection.ts — system / tools / message split
packages/llm/token-meter/src/surface-projection.ts   — shadow-price protocol
packages/llm/token-meter/src/index.ts        — measure() service
packages/compaction/compaction/src/index.ts  — CompactionEngine, compactIfNeeded, compactNow, compactRegion
packages/compaction/compaction/src/checkpoint.ts    — durable compaction markers
packages/compaction/compaction/src/tool-pairing.ts  — balanced span checks
packages/compaction/compaction-basic/src/index.ts    — pressure + overflow trigger waterfalls
packages/compaction/compaction-basic/src/config.ts  — thresholdRatio=0.8, retainRatio=0.16, per-model overrides
packages/compaction/compaction-basic/src/region.ts   — head-anchored priced-tail range selection
packages/compaction/compaction-basic/src/summarizer.ts — prefix-replay summarisation
packages/compaction/compaction-tool-result-pruner/src/index.ts — replay-safe pruner
packages/compaction/command-compact/         — manual /compact command
packages/spill/spill/src/index.ts            — abstract SpillStore
packages/spill/spill-local/src/              — local-FS backend
packages/spill/spill-policy/src/index.ts     — post-execute spill waterfall
packages/context/agent-instructions/src/render.ts — byte-budgeted system-reminder
packages/context/file-reference*/            — file path resolution
packages/context/session-reference/          — cross-session references
packages/context/time-context/               — runtime date/time injection
packages/context/tmux-context/               — tmux pane state
packages/plan/plan-mode/src/index.ts         — plan/mode event + plan:policy section
packages/subagent/subagent/                  — subagent manager, seedDescriptorTurn
packages/subagent/subagent-fork-in-process/  — fork: completed-turn prefix seed
packages/subagent/subagent-spawn-in-process/ — spawn: fresh session
packages/workflow/workflow*/                 — workflow engine + worker thread
packages/workflow/tool-workflow/             — model-facing workflow tool
packages/skill/tool-skill/                   — skill catalog pre-step listener
packages/preset/persona/                     — system-prompt persona fragments
packages/preset/agent-presets/               — preset composition
packages/guard/repeat-tool-reminder/         — advisory tool-loop detector
packages/guard/timeout-policy/               — per-tool timeout scoping
packages/runtime-diagnostics/                — runtime invariants
packages/util/output-retention/              — TextRetainer for head/tail previews
packages/session*/                           — event-sourced session log
```

---

## 8. Verdict

`pi` and `deepseek-harness` implement the same high-level idea — stream a
turn, accumulate messages, occasionally summarise, truncate tool results —
but the *granularity* of the decisions is different. `pi` makes one big
decision per turn (the post-run compaction). `deepseek-harness` makes a
continuous stream of small decisions on every event: a price update, a
shadow-price event, a spill decision, a region compaction if pressure is
high. The "truncated output" symptom the user reports is the natural
consequence of `pi`'s coarse cadence: by the time the harness knows the
context is too full, the model has already produced a 50% answer and the
turn has been committed.

The good news: the `pi` codebase already contains the design primitives for
the fix — `transformContext`, `prepareNextTurn`, `shouldStopAfterTurn`,
`harness/compaction/compaction.ts`, `DEFAULT_COMPACTION_SETTINGS`,
`harness/messages.ts:convertToLlm`, the `compactionSummary` role. The
`harness` subsystem was clearly designed against the deepseek-harness
vocabulary. The migration is a matter of wiring the existing pieces
together, not of inventing new ones.

The single most leveraged change is item (1) in section 6: making the
overflow path retry-compact until it fits, instead of giving up after one
attempt. That single change would address the most visible symptom
("truncated output") for users on long sessions, and it's a small
delta against the existing `_checkCompaction` code.

The single most leveraged change for "doesn't scale to a 200K context" is
item (2): re-prune old tool results mid-session. The current code is
shipping ~50 KiB per old tool result for the lifetime of the session,
which alone eats 25% of a 200K context after 10 calls. A re-prune service
shrinks that to a few KiB per result with no LLM call and no user-visible
behaviour change other than "long sessions work".

The single most leveraged change for "long sessions are slow" is item
(11): replay-prefix compaction summarisation. The current
`<conversation>` text-block serialisation pays cache-miss for the whole
transcript on every compaction. The harness model converts that to
cache-hit + cache-write, and the difference in wall time on a 150K-token
session is roughly an order of magnitude.
