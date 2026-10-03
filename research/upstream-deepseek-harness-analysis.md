# Upstream `deepseek-harness` — verified algorithm, `pi` delta, and next steps

- **Author:** research pass, 2026-10-03
- **Scope:** read-only analysis. No `packages/`, `scripts/`, `lab/`, `docs/`, or test file was
  modified. This file is the only artefact written.
- **Concurrency note:** `packages/coding-agent/src/core/compaction/compaction.ts`,
  `packages/coding-agent/src/core/settings-manager.ts`, and
  `packages/coding-agent/src/core/agent-session.ts` were being edited by another agent
  while this pass ran (wiring `thresholdRatio`, `retainRatio`, and the pruner char budgets).
  Everything below about those three files is based on the **algorithm and design**, and
  line numbers there are a snapshot, not a contract. I did not attempt to reconcile or
  complete those edits.

## Evidence legend

| Tag | Meaning |
|---|---|
| **[SRC]** | Read the actual file in this repo or fetched the upstream file over HTTP. |
| **[WEB]** | Verified via a web page I actually fetched. |
| **[INF]** | My inference. Not directly asserted by any source I read. |

---

## 1. Upstream discovery: **FOUND**

The project is real, public, and matches the in-repo report's package layout exactly.

- **Repository:** `https://github.com/deepseek-ai/deepseek-harness` (branch `master`)
- **Docs site (bilingual):** `https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/compaction`
- npm scope is `@deepseek-ai/dsh-*`; the backend package is `@deepseek-ai/dsh-compaction-basic`.

Files I fetched and read in full from `raw.githubusercontent.com`:

| URL fetched | What it gave |
|---|---|
| `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/compaction/compaction-basic/src/index.ts` | `BasicCompactionEngine`, both trigger waterfalls |
| `…/packages/compaction/compaction-basic/src/region.ts` | `selectCompactableRange`, `compactSurfaceRegion`, `buildSummarizationInput` |
| `…/packages/compaction/compaction-basic/src/summarizer.ts` | replay-prefix summarisation, `COMPACTION_INSTRUCTION`, `frameSummary` |
| `…/packages/compaction/compaction-basic/src/config.ts` | `thresholdRatio=0.8`, `retainRatio=0.16`, `headroomTokens=65536`, `resolveCompactSpec` |
| `…/packages/compaction/compaction-tool-result-pruner/src/index.ts` | `pruneContent`, `pruneSession` |
| `…/packages/compaction/compaction-tool-result-pruner/src/config.ts` | pruner defaults `8192 / 4096 / 1024` |
| `…/packages/compaction/compaction/src/tool-pairing.ts` | `toolPairingBalancedBefore` / `After` |
| `…/packages/spill/spill-policy/src/index.ts` | spill waterfall, `read` exemption, `SpillStore.saveText` |

Two README pages corroborate the design at the package level:
`https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md`
and `…/packages/compaction/README.md`.

**A caveat on the in-repo report.** `research/report-context-window-management.md:10` says the
reference was "cloned from `https://github.com/deepseek-ai/deepseek-harness`, depth 1, not
tracked in git — see `research/.gitignore`". That clone is **not present** in the working
tree now (`research/` holds only the two `.md` reports plus `decisions/`). So the report's
line numbers are from a snapshot of upstream that I could not diff against. Treat the report's
`…/deepseek-harness/...:NNN` line citations as unverified; the algorithm descriptions it makes
are, however, accurate against the current source — see the corrections in §4.

### 1a. One important correction to the report's cost claim

`report-context-window-management.md:841-843` and `:1015-1016` claim replay-prefix turns
"150K of cache-miss tokens" into "1K of cache-hit + 149K of cache-write". That framing is
wrong on the economics. In the upstream design the replayed prefix is **already resident in
the provider's cache** because the agent has been streaming that exact prefix on every prior
request of the same session. The summarisation call is therefore almost entirely **cache
reads** (typically priced at ~10% of base input on Anthropic-shaped APIs), not cache writes.
The saving is real and large; the write/read split quoted in the report is not. **[INF]**

---

## 2. The upstream algorithm, precisely

### 2.1 `selectCompactableRange` — head-anchored, priced-tail, tool-pair balanced

`region.ts`, `selectCompactableRange(session, measurement, retainTokens)`. **[SRC]**

```ts
const firstIdx = systemHead(session, surfaceNodes[0]!) === undefined ? 0 : 1

let accumulated = 0
let keepFromIdx = pricedNodes.length
for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
  accumulated += pricedNodes[index]!.tokens
  keepFromIdx = index
  if (accumulated >= retainTokens) break
}
if (keepFromIdx <= firstIdx) return null

while (keepFromIdx > firstIdx) {
  if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break
  keepFromIdx -= 1
}
if (keepFromIdx <= firstIdx) return null

return { start: surfaceNodes[firstIdx]!, end: surfaceNodes[keepFromIdx - 1]! }
```

Concretely, three things are happening:

1. **Head-anchored.** The start of the compacted range is always the *first* non-system
   surface node. Upstream never compacts a middle window. The summary always replaces a
   prefix of the conversation, and the verbatim tail sits after it. This is what makes the
   summary a genuine prefix of the next request rather than a splice.
2. **Priced tail.** The walk goes *backwards* from the newest node, accumulating each node's
   `tokens` (route price, not the char/4 heuristic) until it has banked `retainTokens`. The
   index it lands on is the first node to keep. Retention is therefore expressed in real
   tokens priced by the same meter that decides the threshold, not in a chars/4 guess.
3. **Tool-pair balance backs the boundary up.** After pricing, if the cut point is not a
   balanced boundary the walk moves *earlier* (`keepFromIdx -= 1`) until it is.

**Why the tool-pair balance matters.** `tool-pairing.ts` maintains, for every cut position in
the current surface, whether zero tool calls are outstanding there: `assistant/message` adds
`+1` per `tool-call` block, `tool/result` adds `-1`, and a cut is balanced exactly when the
running count is zero. **[SRC]** Splitting a step means compacting an assistant message that
made two tool calls while retaining only one of its two tool results, or retaining a
`tool_result` whose originating `tool_call` was just replaced by a summary. Every mainstream
provider rejects both shapes as a malformed message sequence — a 400, not a degraded answer.
So the invariant is: **the compaction boundary must fall between steps, never inside one.**
Backing the boundary *up* (retaining slightly more than `retainTokens` asked for) is the
cheap fix; the alternative, cutting at an assistant tool-call message and hoping, is the bug.

Upstream enforces the same invariant on the way in: `validateSurfaceRegion` rejects a
requested range whose start fails `toolPairingBalancedBefore` or whose end fails
`toolPairingBalancedAfter`, and the pruner uses the same vocabulary. **[SRC]**

Note the asymmetry worth copying: `keepFromIdx` is bounded by `firstIdx`, so the walk can
never consume the system head, and `null` is returned rather than an over-eager range.

### 2.2 Why two triggers, and what each one prevents

Both live in `_registerAutomaticCompaction()` in `compaction-basic/src/index.ts`. **[SRC]**

- **`pressure` — an `agent/pre-step` waterfall listener.** Runs `compactIfNeeded(agent,
  'pressure', signal)` *before every step*. Failures are caught and logged; the turn
  continues. It resolves the routed model's `contextWindow` from the adapter, computes
  `spec.thresholdTokens`, and returns `null` when under it. This is **proactive**: it keeps
  the session away from the wall so the user never sees a rejected request.
- **`context-overflow` — an `agent/request-error` waterfall listener.** Fires only when
  `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE`, i.e. the provider actively rejected the
  request as too long. It bypasses the threshold check, compacts, and returns
  `{ kind: 'retry' }` to redispatch. This is **reactive**: it is the safety net for every case
  the estimate got wrong.

What each one prevents:

| Trigger | Failure it prevents |
|---|---|
| `pressure` | The request being rejected at all. Also the case where the meter under-reports and the session creeps up unnoticed. |
| `context-overflow` | A hard turn failure on the first sign of trouble. A session that overflows during a *single* step — one enormous tool result, or a model whose real limit is below its advertised window — can never be caught by a pre-step threshold, because at pre-step time it had not overflowed yet. |

They are not redundant. The threshold is a prediction; the provider's rejection is ground
truth. `[INF]`

Two details in the upstream overflow path are worth stealing directly:

- **Retry budget is per-model and counted per agent.** `overflowRetries` is a
  `WeakMap<Agent, number>`, reset when the agent goes `idle` **and** on every
  `session/event` of type `assistant/message` — the comment is explicit that a successful
  response starts a fresh recovery sequence "even when tool calls continue the same turn".
  So retries reset on *progress*, not only on idleness. **[SRC]**
- **Partial progress is honoured.** If compaction throws but
  `agent.session.surface.replaceGeneration` advanced, upstream still returns `{ kind: 'retry' }`
  and logs it. A model-free prune that landed before a later summary call failed is real
  durable reduction, so the request is retried from the reduced surface rather than
  re-failing on the same bytes. **[SRC]**

### 2.3 `compactionRetries` vs `maxOverflowRetries`, and per-model overrides

- **`compactionRetries`** (default `1`) is the *inner* loop inside a single
  `compactIfNeeded('pressure')` call. After each region compaction it remeasures; if still
  above threshold it selects and compacts again. Exhausting the loop **throws**
  (`"compaction still above threshold after N attempts"`). It answers: "one summarisation
  round wasn't enough — try harder, now, in this call." **[SRC]**
- **`maxOverflowRetries`** (default `1`) is the *outer* budget on how many times an
  agent-request-error may be recovered. It is enforced in the `agent/request-error` listener
  before compaction is even attempted; at the limit the original error propagates. It
  answers: "how many redispatch cycles will I fund before surfacing the failure." **[SRC]**

They are independent axes: retries *within* a compaction, versus redispatches *across*
overflow errors.

Per-model overrides live in `BasicCompactionConfig.modelPolicies[]`, an array of
`{ provider, model, ... }` records merged by `resolveTargetPolicy`. It can override
`thresholdRatio`, `headroomTokens`, `retainRatio`, `retainTokens`, `summarizationProvider`,
`summarizationModel`, `maxTokens`, `compactionRetries`, `maxOverflowRetries`. Matching is
**exact** `provider` + `model`; duplicate targets fail plugin load. **[SRC]**

`resolveCompactSpec` is where ratios become token budgets, and it is stricter than it looks:

```ts
const messageBudgetTokens  = contextWindow - reservedCompletionTokens
const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens
const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))
const retainTokens    = policy.retainTokens === undefined
  ? Math.floor(messageBudgetTokens * policy.retainRatio)
  : policy.retainTokens
```

Defaults: `thresholdRatio = 0.8`, `retainRatio = 0.16`, `headroomTokens = 65_536`,
`compactionRetries = 1`, `maxOverflowRetries = 1`. `maxTokens` defaults to `headroomTokens`. **[SRC]**

Three invariants are enforced at load, and they are the reason a 1M-context model and a
32K-context model cannot share one `reserveTokens`:

- threshold is the **min** of the ratio and the post-headroom budget, so headroom always wins;
- `retainTokens` must be `< thresholdTokens`, else load fails;
- both budgets must be positive, with an actionable message naming the offending field. **[SRC]**

### 2.4 Replay-prefix summarisation

The report's §5.2 description is **accurate in substance**, and this is the real upstream
shape from `summarizer.ts` + `region.ts`: **[SRC]**

`buildSummarizationInput` reconstructs the shadowed region's *own request prefix*:

```ts
const header  = session.requestHeader()
const head    = systemHead(session, session.surface.nodes[0]!)
const system  = head === undefined ? null : session.deriveEventMessage(head)
const regionMessages = shadowedSeqs
  .map(seq => session.deriveEventMessage(session.eventAt(seq)!))
  .filter((message): message is Message => message !== null)
return {
  ...header?.tools === undefined ? {} : { tools: header.tools },
  messages: system === null ? regionMessages : [system, ...regionMessages],
}
```

`summaryWithLlm` then appends **only** the instruction and dispatches:

```ts
const messages = [
  ...input.messages,
  deepFreeze({ role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] }),
]
const options = {
  provider: target.provider, model: target.model,
  messages,
  toolHistory: agent.session.toolHistory(),
  ...input.tools === undefined ? {} : { tools: [...input.tools] },
  maxTokens: config.maxTokens, sessionId: agent.session.id, purpose: 'compaction',
}
```

The load-bearing detail, stated in upstream's own comment: the directive is "delivered as
the FINAL user message after the replayed conversation **rather than as a distinct
summarizer system prompt**. Keeping the conversation's own system prompt, tools, and message
prefix in front of it makes the auxiliary call a genuine prefix of the last routed request,
so the provider's KV cache is reused instead of invalidated." **[SRC]**

So the contrast is not "structured messages vs one text blob" in the abstract — it is
**byte-identity with the prefix the provider already cached.** The moment you prepend a
summariser-specific system prompt, or re-serialise the transcript into a `<conversation>`
block, you have changed every byte of the prefix and the cache read becomes a fresh write.
The rest of the machinery is secondary: `tools` are replayed to keep the tool-schema block
in the cache, and `toolHistory` is passed so tool-pair validation still holds.

Two more upstream behaviours around the summary are worth noting:

- **The summary must be smaller than what it replaces.** `summarizeCompaction` prices the
  framed checkpoint and throws if `framedSummaryTokenCount >= shadowedRouteTokenCount`. A
  compaction that does not free space is a failed compaction, not a no-op. **[SRC]**
- **The replacement is a `user/message` with a range `surfaceOp`.** The session log is
  append-only; compaction is `surfaceOp: { op: 'replace', startSeq, endSeq }`. The log
  keeps everything; the surface is the projection. This is why upstream can fold a prune or
  a compaction without rewriting history. **[SRC]**

### 2.5 `spill-policy` and the pruner

**`spill-policy`** (`packages/spill/spill-policy/src/index.ts`) is a `tools/post-execute`
waterfall with `prepend: true`. For an accepted result over `maxInlineTokens`: **[SRC]**

1. `spillStore.saveText({ owner: { sessionId }, source: { kind: 'tool', toolName, callId, label }, suggestedName, content })`;
2. build a bounded head/tail preview via `retainContent`, reserving room for the notice;
3. replace the model-facing content with `[...head, GAP, ...tail, notice]`, where the notice
   carries the exact omitted byte count and the spill locator;
4. **fail-open**: any error logs a warning and returns the original content;
5. **`read` is skipped on the model-facing arm** — `if (... || exec.name === 'read') return decision`.

The `read` exemption is the loop-breaker. Without it: model reads a file, result is spilled to
a preview, model cannot find what it wanted in the preview, reads again. The pruner in `pi`
mirrors this via `skipToolNames: ["read"]`.

**`ToolResultPruner`** is model-free and runs *before* range selection, then the meter
remeasures — pruning alone can bring a session under threshold with no LLM call at all. **[SRC]**
Defaults `thresholdChars: 8192, headChars: 4096, tailChars: 1024`, marker
`"\n\n[... tool result middle pruned ...]\n\n"`, with a load-time check that
`headChars + marker + tailChars <= thresholdChars`. `pruneContent` slices by **Unicode code
point** (`Array.from(block.text)`), so a retained boundary cannot split a surrogate pair.
Each replacement is preceded by a `compaction/prune` shadow-price event so the O(1) meter fold
tracks the reduction without per-node state.

---

## 3. What `pi` already has (verified)

Several items the report lists as missing **are already implemented** in this repo. The
report predates them. Correcting this matters because it changes what is worth building.

| Report §6 item | Actual state in `pi` | Evidence |
|---|---|---|
| (1) Multi-attempt overflow recovery | **Done.** `maxOverflowRetries` drives a loop, gated on bundle `enabled`. | `agent-session.ts:2293-2324` **[SRC]** |
| (2) Tool-result re-pruning | **Done**, with a `read` exemption and an every-N-turns cadence. | `agent-session.ts:1234-1250`; `compaction/tool-result-pruner.ts:42-48` **[SRC]** |
| (10) Graceful truncation notice | **Done**, gated on the bundle. | `agent-loop.ts:225-236` **[SRC]** |
| (11) Replay-prefix summarisation | **Done**, `replayPrefix` parameter, wired from the bundle flag. | `compaction.ts:666,698-709,898,933,970`; `agent-session.ts:2439-2452` **[SRC]** |
| (6) Byte-budgeted instructions | **Done**, `budgetedInstructions` + `maxBytesForInstructions`. | `agent-session.ts:1183-1186`; `settings-manager.ts:51-56` **[SRC]** |
| (5) Per-model policy overrides | **Partially done.** `modelPolicies` with exact + `provider/*` wildcard match. | `settings-manager.ts:54,989-1015` **[SRC]** |

The `deepseekHarness` bundle is coherent and the settings genuinely resolve. The problem the
briefing describes is narrower and more specific than "several settings are never consumed".

---

## 4. Corrections to the in-repo report, and the real remaining gaps

### 4.1 Corrections

1. **Report §6 item (1) is stale.** Multi-attempt overflow recovery ships. `agent-session.ts:2297-2298`
   reads `maxOverflowRetries` and `2299-2316` loops. The report's claim of "one compact-and-retry
   attempt" describes the pre-bundle legacy path, which is still what runs when the bundle is off
   (`settings.enabled ? ... : 1`). **[SRC]**
2. **Report §6 items (2), (10), (11), (6) are stale.** All shipped, as tabled above.
3. **Report §5.1's "pressure-only trigger" framing is wrong.** It says the `pressure`-only
   model lets a session grow until the provider rejects. `pi` has had both paths; the overflow
   path at `agent-session.ts:2286` is the `context-overflow` equivalent. **[SRC]**
4. **Report §5.2's cache economics are wrong** (see §1a above). Direction right, numbers wrong.
5. **Report §1's `pi` column for token meter is right**: `estimateContextTokens`
   (`compaction.ts:216-244`) is last-assistant-usage plus a chars/4 tail estimate. Still no
   event-sourced per-section breakdown. **[SRC]**

### 4.2 Gap A — the auto-compaction path does not apply the ratio settings (highest value)

`compact()` (manual, `/compact`) layers the ratios at `agent-session.ts:2084-2095`:
`settings.thresholdRatio ??= dh.thresholdRatio`, and `keepRecentTokens = floor(contextWindow *
retainRatio)`.

`_runAutoCompaction` — the **automatic** path, the one that actually fires during normal long
sessions — reads `getCompactionSettings()` at `agent-session.ts:2368` and passes it straight to
`prepareCompaction` at `:2381`, with **no `dh` overlay**. And `getCompactionSettings()`
(`settings-manager.ts:969-981`) does not even return `thresholdRatio` or `retainRatio`; it
returns only `enabled`, `reserveTokens`, `keepRecentTokens`. **[SRC]**

The consequence is concrete: with the bundle on and a MiniMax profile of
`thresholdRatio: 0.75` / `retainRatio: 0.18`, **automatic compaction still uses
`reserveTokens: 16384` and `keepRecentTokens: 20000`.** On a 1M-token MiniMax model that
triggers at ~98% of the window instead of 75%, and retains 20K instead of 180K. The setting is
live enough to pass `settings-manager` tests and dead enough to never reach the hot path.

Note the two `shouldCompact` implementations differ, which compounds this:
`packages/agent/src/harness/compaction/compaction.ts:260-270` **does** honour
`thresholdRatio`; `packages/coding-agent/src/core/compaction/compaction.ts:249-252` **does
not** — it is `contextTokens > contextWindow - settings.reserveTokens`, full stop. The
production copy ignores the field entirely. **[SRC]**

Also in the manual path, the overlay **mutates the object returned by
`getCompactionSettings()`** rather than a copy. That is safe today only because the method
returns a fresh literal on every call; it is a fragile invariant to rely on. **[INF]**

### 4.3 Gap B — the pruner char budgets are not read from settings

`agent-session.ts:1245` calls `pruneSession(this.agent.state.messages, DEFAULT_PRUNER_CONFIG)`
— the imported constant, not a config built from `dh.toolResultHeadChars` /
`dh.toolResultTailChars` / `dh.toolResultThresholdChars`. Those three settings resolve
(`settings-manager.ts:44-48,66-68`), are documented, and are ignored. **[SRC]**

`DEFAULT_PRUNER_CONFIG` happens to equal the upstream defaults, so behaviour is correct today
and divergence is invisible — the exact failure mode that let this go unnoticed. A user who
sets `toolResultThresholdChars: 40000` gets 8192 with no error.

### 4.4 Gap C — `pruneSession`'s change detection is broken

```ts
const before = this.agent.state.messages.length;
const pruned = pruneSession(this.agent.state.messages, DEFAULT_PRUNER_CONFIG);
if (pruned.length === before) {
    this.agent.state.messages = pruned;
}
```

`pruneSession` preserves message count exactly — it only rewrites `content` in place
(`tool-result-pruner.ts:133`, `{ ...tr, content: newContent }`). So `pruned.length === before`
is **always true** and the guard is a no-op. It reads like a "did anything change?" check but
tests the wrong invariant. Harmless today; misleading, and it will silently swallow a future
correctness guard written in the same shape. **[SRC]**

### 4.5 Gap D — the pruner rewrites live state but not the durable session

`pruneSession` returns a new array that is assigned to `this.agent.state.messages`. The
session log (`sessionManager.getBranch()`) is untouched, so a pruned tool result is un-pruned
again on the next reload or branch rebuild. Upstream solves this with `surfaceOp: { op:
'replace' }` plus a `compaction/prune` shadow-price event, so the reduction is durable *and*
metered. `pi` has neither. **[SRC]** for `pi`; **[SRC]** for upstream semantics.

Practical effect: pruner savings are transient within a session, and re-pruning repeats work
that the log still believes is necessary. Lower value than A–C, but it is why pruner savings
do not compound the way they do upstream.

### 4.6 Gap E — no tool-pair balance check on the cut point

`pi`'s `findCutPoint` (`compaction.ts:417-475`) uses `findValidCutPoints`, which allows a cut
at any user/assistant/bash/custom message and rejects only `toolResult` rows
(`isCutPointMessage`, `:322-335`). Its doc comment claims "When we cut at an assistant message
with tool calls, its tool results follow it and will be kept" — true for the *forward* walk,
but the walk accumulates backwards from `endIndex` and can land `cutIndex` on an assistant
message whose tool results then fall **before** it in the retained window. There is no
equivalent of `toolPairingBalancedBefore` / `After`. **[SRC]**

I have not reproduced a malformed-message 400 from this, and `convertToLlm` plus
`validateLlmMessages` may absorb it downstream. I am flagging it as an unproven invariant
gap, not a confirmed bug. **[INF]** It is worth a targeted test that compacts a session whose
cut lands mid-step and asserts the retained window is provider-acceptable.

### 4.7 Gap F — `maxTokens` for the summariser is derived from `reserveTokens`, not the summariser model

`generateSummaryWithUsage` computes `maxTokens = min(floor(0.8 * reserveTokens),
model.maxTokens)` (`compaction.ts:668-671`). `model` here is `requestModel`, which is the
**override** model when `PI_SUMMARIZER_*` is set (`agent-session.ts:503-521`). With the
override's `maxTokens: 8192` and `reserveTokens: 16384`, the cap lands at 8192. That happens
to be fine, but it is coincidence: the intent in `reserveTokens` is "budget for the main
model's response", and it is being used to size a different model's output. Upstream keeps
`maxTokens` in the compaction config proper (defaulting from `headroomTokens`) and pairs it
with `summarizationProvider` / `summarizationModel` in one record. **[SRC]** both sides.

---

## 5. Replay-prefix vs the `PI_SUMMARIZER_*` override

**Verdict: replay-prefix and the override interact badly as currently wired, and replay-prefix
should be gated on the summariser's real context window. Keep it off by default while the
override is active.**

### What I verified

The override is built in `resolveSummariserModel()` (`packages/ai/src/summariser-model.ts:87-115`): **[SRC]**

```ts
id: override.model,
api: "openai-completions",
provider: SUMMARISER_DEFAULT_PROVIDER,
baseUrl: override.baseUrl,
reasoning: false,
input: ["text"],
cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
contextWindow: SUMMARISER_DEFAULT_CONTEXT_WINDOW,  // 128_000
maxTokens: SUMMARISER_DEFAULT_MAX_TOKENS,          // 8_192
```

`reasoning: false` and `cost: all zero` are deliberate (comments at `:102-112`). It is
registered as a transient provider and swapped in for every summarisation call
(`agent-session.ts:503-521`, consumed at `:2079`, `:2377`, `:3337`). **[SRC]**

### The four problems

1. **The cache is per-provider, and the override is a different provider.** Replay-prefix wins
   only because the summarisation call is byte-identical to the prefix the provider already
   cached. The main session streams MiniMax on the Anthropic-shaped API
   (`api: "anthropic-messages"`, with real cache-control breakpoints). The override is
   `api: "openai-completions"` against a different `baseUrl` — a different vendor, a different
   cache. **The prefix the main model warmed is not in the override's cache.** The entire
   premise of replay-prefix does not hold across that boundary. **[INF]** — the provider split
   is **[SRC]**; the cache conclusion follows from how prompt caching works and is inference.
2. **`cacheRetention: "none"` on the summarisation call disables cache writes anyway.**
   `completeSummarization` hard-sets `cacheRetention: "none"`
   (`compaction.ts:601-605`, "Summaries are standalone requests, so isolate routing and avoid
   cache writes that cannot be reused"). A regression test asserts it
   (`test/compaction-summary-reasoning.test.ts:111`). For Anthropic-style explicit
   `cache_control`, this means no breakpoint is emitted, so the replayed prefix is re-processed
   as fresh input. For OpenAI-style implicit caching, `prompt_cache_key` is dropped
   (`openai-responses.ts:308`) — the same effect. **[SRC]**
3. **The 128K assumption is wrong whenever the main model is larger.** The doc comment at
   `summariser-model.ts:33-36` says compaction "never consumes more than the agent's full
   context, which is usually 128k–1M" and chooses 128k as "a safe upper bound". That is
   self-contradictory: if the agent's context can be 1M, a summariser that will be handed up to
   1M is not safe at 128K. When `thresholdRatio: 0.75` on a 1M window, the region being
   summarised can approach ~750K tokens, and the override will reject it — the summarisation
   call fails, and compaction fails with it. **[SRC]** for the numbers, **[INF]** for the
   failure mode. Note `contextWindow` here is only *metadata*; nothing truncates to it before
   dispatch. It is a wrong comment, and it is load-bearing for how this is reasoned about.
4. **Zero cost reporting hides the damage.** `cost: { input: 0, ..., cacheRead: 0,
   cacheWrite: 0 }` means whichever path is taken, the spend is invisible in `/usage`. A
   regression that made compaction 10x more expensive would show up as "no change". **[SRC]**

### The recommendation

Gate `replayPrefixSummarisation` on whether the summariser can actually benefit:

- **Override active** → default `replayPrefixSummarisation: false`. Keep the text-block path.
  It is a single request, and the override is a cheap model where the absolute cost is small;
  the cache saving it forgoes is worth less than the 128K-overflow risk it creates.
- **No override** (summarisation runs on the main model) → `true`. Same provider, same
  session, warm prefix: the saving is real and large.
- If we want both, the fix is to raise the override's `contextWindow` to a value the endpoint
  actually supports, allow the replay path, **and** permit a `cacheRetention` other than
  `"none"` for that call so a breakpoint is emitted. That is three coordinated changes across
  `summariser-model.ts`, `compaction.ts`, and the provider layer — a project, not a flag.
- Independently: make `contextWindow` an env-tunable field
  (`PI_SUMMARIZER_CONTEXT_WINDOW`) rather than a hardcoded constant. **[INF]**

One thing I could **not** verify: whether the MiniMax "highspeed" endpoint actually enforces
a 128K cap. `summariser-model.ts` is a comment-level claim, and the value is a client-side
constant, not a negotiated limit. If the endpoint is in fact larger, problem 3 is latent rather
than active — but the constant should still be corrected, because it is the only number the
code has.

---

## 6. Ranked gaps

Ranked by benefit/effort for a deployment running MiniMax models through the summariser
override. Effort in rough engineer-days.

### 1. Apply `thresholdRatio` / `retainRatio` on the automatic compaction path — **do first**

- **Fixes:** Gap A. Automatic compaction ignores the ratio settings entirely; on a large
  MiniMax window it fires at ~98% instead of 75% and retains 20K instead of 180K.
- **Benefit:** High, and it is the one that makes the rest of the bundle real. Every other
  tuning value a user sets is currently ignored on the hot path. Also removes the
  `keepRecentTokens: 20000` fixed constant, which on a 1M model discards ~95% of the tail
  budget the user asked for.
- **Effort:** 0.5–1 day.
- **Risk:** Low. The change is to make the auto path apply the same overlay the manual path
  already applies, and to make `getCompactionSettings()` return the ratios. Guard: the
  bundle-off path must be byte-identical to today.
- **Files:** `settings-manager.ts` (`getCompactionSettings`, return the two optional ratios);
  `agent-session.ts` (`_runAutoCompaction`, factor the overlay out of `compact()` and call it
  from both, on a **copy**); `compaction.ts` (`shouldCompact`, honour `thresholdRatio` in the
  production copy as the harness copy already does at
  `packages/agent/src/harness/compaction/compaction.ts:266-268`).
- **Note:** another agent is in these three files right now. Sequence this after their change
  lands, or fold it into the same edit.

### 2. Read the pruner char budgets from settings, and fix the change guard

- **Fixes:** Gaps B and C. Three documented settings are ignored; the "did it change?" guard
  is a no-op.
- **Benefit:** Medium. Makes `toolResultThresholdChars` / `Head` / `Tail` real. Secondary
  benefit: removes a guard that will mislead the next person to touch it.
- **Effort:** 0.5 day.
- **Risk:** Low. Build a `PrunerConfig` from the resolved settings, defaulting to
  `DEFAULT_PRUNER_CONFIG`. For the guard, compare content or just assign unconditionally —
  `pruneSession` is pure and returns a new array.
- **Files:** `agent-session.ts:1234-1250`; `compaction/tool-result-pruner.ts` (optionally add
  a `changed` return so callers can test it honestly).

### 3. Gate `replayPrefixSummarisation` on the summariser override — **do with #1 or #2**

- **Fixes:** Gap in §5. A flag that is `true` by default in both `DEFAULT_DEEPSEEK_HARNESS`
  and `MINIMAX_PROFILE` while the override is configured gives a real 128K overflow risk and
  zero cache benefit, because the override is a different provider *and* the call hard-sets
  `cacheRetention: "none"`.
- **Benefit:** Medium-high, mostly risk avoidance. Prevents a compaction failure mode that
  is currently masked by cost being reported as zero.
- **Effort:** 0.5 day for the gate; 1–2 days more for the full fix (tunable window +
  cacheRetention exception).
- **Risk:** Low for the gate (it disables an optimisation that is not working). Medium for
  the full fix, because emitting a cache breakpoint on a one-shot summarisation call is
  exactly the "cache writes that cannot be reused" the current comment warns about.
- **Files:** `deepseek-harness-profile.ts` and/or `settings-manager.ts`
  (`getDeepseekHarnessSettings` consults `resolveSummariserModel()`); `compaction.ts:601-605`
  (per-call `cacheRetention`); `summariser-model.ts:37` (env-tunable `contextWindow`).
- **Also fix while in there:** `cost: { ...all zero }` on the override. Report at least
  input/output so compaction spend is visible, or add an explicit "unpriced" marker to
  `/usage` rather than showing a clean zero.

### 4. Give the cut point a tool-pair balance check

- **Fixes:** Gap E. No equivalent of `toolPairingBalancedBefore` / `After`.
- **Benefit:** Medium. Prevents a class of malformed-request failure that would be very hard
  to diagnose from a provider 400 in the middle of a long session.
- **Effort:** 1–2 days (walk the retained window, track outstanding tool calls, reject or walk
  back to a balanced cut).
- **Risk:** Medium — this touches the cut selection on the hot path. Land it behind the
  bundle toggle first.
- **Files:** `compaction.ts` (`findCutPoint` / `findValidCutPoints`); new helper, probably
  modelled on upstream's `tool-pairing.ts`.
- **Caveat:** unproven. I found no reproduction. Write the failing test first; if it does not
  fail, downgrade this and re-rank.

### 5. Make pruner reductions durable via a surface replace

- **Fixes:** Gap D. Pruned content is lost on the next session reload because only live
  message state is rewritten.
- **Benefit:** Low-medium. Makes pruner savings compound instead of repeating, and makes the
  token accounting agree with the log.
- **Effort:** 3–5 days. This is the event-sourced part, and it is the change that most wants
  the harness/session layer underneath it (report §6 item 8). It is structurally the largest
  item here and belongs after the cheap ones.
- **Risk:** High. Touches session persistence.
- **Files:** `session-manager.ts`, `agent-session.ts`, and a shadow-price event on the
  compaction entry.

**Deliberately not ranked:** the byte-budgeted system prompt, the event-sourced token meter
with per-section breakdown, the "model-visible ⟺ logged" invariant, and fork-vs-spawn
subagent seeding. All are real (items 6, 7, 12, 14 in the report) and all are large
architectural work with no cheap win. They belong in a later phase, not this one.

---

## 7. Recommended `MINIMAX_PROFILE` values

Current values, `deepseek-harness-profile.ts:21-31`: **[SRC]**

```ts
thresholdRatio: 0.75,
retainRatio: 0.18,
maxOverflowRetries: 3,
toolResultPruneEveryN: 3,
toolResultHeadChars: 4096,
toolResultTailChars: 1024,
toolResultThresholdChars: 8192,
replayPrefixSummarisation: true,
budgetedInstructions: true,
```

**Two of these are inert until gap #1 ships.** `thresholdRatio` and `retainRatio` are read
nowhere on the auto path; they only take effect for manual `/compact`. That is the headline
finding of this section: **tuning `MINIMAX_PROFILE` before #1 is a no-op for automatic
compaction.** Fix the wiring first, then tune.

With that caveat:

| Field | Current | Recommend | Reasoning |
|---|---|---|---|
| `thresholdRatio` | `0.75` | **Keep `0.75`** | Aggressive vs upstream's `0.8`, and correctly so: MiniMax is cache-friendly, so compacting earlier is cheap. Also `resolveCompactSpec` takes the *min* of the ratio and the post-headroom budget, so a low ratio cannot cause a premature trigger on a small-window model. Valid. |
| `retainRatio` | `0.18` | **Keep `0.18`** | Slightly above upstream's `0.16`, which is the right direction for a coding agent — the recent tool calls are the working state. Must stay `< thresholdRatio`; 0.18 < 0.75 holds with a wide margin. |
| `maxOverflowRetries` | `3` | **Keep `3`** | Above upstream's `1` and above pi's own default of `2`. Defensible: overflow recovery is rare and each retry is a genuine compaction. Note the reset semantics differ from upstream — pi resets on `agent/status` idle; upstream also resets on any successful `assistant/message`. If retries ever feel sticky, that is the reason, not the value. |
| `toolResultPruneEveryN` | `3` | **Keep `3`** | Below the default `5`. Pruning is model-free, so a tighter cadence is nearly free. Matches the profile's "compact earlier, more often" thesis. |
| `toolResultHeadChars` | `4096` | **Keep `4096`** | Upstream default. Tail-of-log errors and file heads are what the model actually needs. |
| `toolResultTailChars` | `1024` | **Keep `1024`** | Upstream default. **Caveat:** these are UTF-16 code units in `pi` (`text.slice(0, n)` at `tool-result-pruner.ts:81-82`), while upstream slices by Unicode code point. Harmless for ASCII shell output, but it can split a surrogate pair on emoji. Align with upstream rather than changing the value. |
| `toolResultThresholdChars` | `8192` | **Keep `8192`** | Upstream default, and `4096 + 1024 + marker < 8192` satisfies the budget check. |
| `replayPrefixSummarisation` | `true` | **Change to `false` while the override is active** | §5. Different provider and `cacheRetention: "none"` mean no cache benefit; the 128K mismatch is a live risk. Re-enable per-deployment once #3's full fix lands. This is the one value change I recommend. |
| `budgetedInstructions` | `true` | **Keep `true`** | `20 * 1024` bytes default (`settings-manager.ts:70`) is sane for a workspace `AGENTS.md` and the omission diagnostics are the point. |

**Net: one change** (`replayPrefixSummarisation`), and only because of the override
interaction. Everything else is already well-chosen — mostly because it mirrors upstream
defaults, which were themselves chosen for the same workload.

**One structural recommendation, independent of values.** `MINIMAX_PROFILE` is a flat object
layered *under* user settings (`settings-manager.ts:1004-1009`), so a user who sets any single
field silently keeps profile values for all the others. That is fine. But the profile sets
`replayPrefixSummarisation: true` unconditionally, which is a *deployment* fact (is an
override configured?) masquerading as a *model-family* fact (is this MiniMax?). It belongs in
the same gate as the override check in #3, not in the profile. **[INF]**

---

## 8. Summary

- Upstream is real and public at `https://github.com/deepseek-ai/deepseek-harness`; I fetched
  eight source files across `compaction-basic`, `compaction-tool-result-pruner`, `compaction`,
  and `spill-policy` and read them in full.
- The algorithm is: event-sourced token meter → optional model-free prune → pre-step pressure
  threshold **or** provider-confirmed overflow → head-anchored range selection with a priced
  tail walked back to a tool-pair-balanced boundary → replay-prefix summarisation → range
  replace on the surface.
- `pi` has shipped more of this than the in-repo report says. Multi-attempt overflow recovery,
  the pruner with its `read` exemption, replay-prefix summarisation, the truncation notice, and
  byte-budgeted instructions are all present and working.
- The real remaining defect is narrow and high-impact: **the automatic compaction path never
  receives `thresholdRatio` or `retainRatio`**, so on a large MiniMax window it triggers at
  ~98% of capacity and retains 20K tokens regardless of configuration. Three pruner char
  budgets are likewise resolved and ignored.
- Replay-prefix and the `PI_SUMMARIZER_*` override are on different providers, and the
  summarisation call hard-disables cache writes. Replay-prefix should be gated off while the
  override is active.
- `MINIMAX_PROFILE` is well-chosen; one change recommended
  (`replayPrefixSummarisation: false` under the override).
