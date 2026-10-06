# Context

What crosses the boundary from child to parent, and how much of it there is.

Source: `subagent-tool.ts:90`, `types.ts:150-181`, `packages/agent/src/harness/compaction/`.

---

## 1. The two channels

| Channel | Consumer | Contents |
|---|---|---|
| `finalOutput` | **the model** | Child's final summary, capped at `PER_TASK_OUTPUT_CAP` (50 KiB), marker included |
| `messages` | **the human** | Full child transcript, via tool details. NOT model-facing |
| `usage` | both | Per-child tokens, aggregated for display |

`SubagentResult` — `types.ts:150-181`.

---

## 2. Truncation

| Layer | Limit | Location |
|---|---|---|
| Per shell call | 2000 lines / 50 KiB | `packages/agent/.../utils/truncate.ts:19-20` |
| Per task result | 50 KiB, marked | `subagent-tool.ts:90` |
| Tool results in a long session | 8192 threshold / 4096 head / 1024 tail, no API cost | `packages/agent/.../compaction/tool-result-pruner.ts:42-48` |

All three MUST mark what was cut. Unmarked truncation is silent data loss that the model will
reason over as if it were complete.

---

## 3. Compaction interaction

### 3.1 What we already have that is good

**Explicit, durable compaction boundary.** Compaction appends a session entry carrying
`summary`, `tokensBefore`, `firstKeptEntryId` and `retainedMessages`, and advances the leaf
(`session-manager.ts:1147-1157`). `buildActiveContext` (`:434-475`) projects "the latest
compaction followed by entries retained from `firstKeptEntryId`", omitting older summarised
entries.

This is **semantically identical** to the best available pattern: a boundary marker plus a
"messages after boundary" read path, with recent messages preserved at full fidelity. Recent
tool-call/tool-result pairs stay intact after the boundary, which naive summarisation breaks.

Differences are cosmetic: we lack a named accessor and a marker string.

**A real no-API-cost snip layer.** `tool-result-pruner.ts` is pure string surgery — head +
marker + tail per text block, replay-safe and non-mutating (`:3-7`, `:62-86`, `:95-150`). The
session log retains original events; only the surface projection is rewritten.

> Worth noting: the reviewed alternative presents `snipCompact` as one of three *live*
> compaction strategies. It is compiled out of that bundle entirely. We already own a better
> version of the concept.

### 3.2 The gap

Our snip layer trims characters *inside* individual oversized tool results. It never removes
**whole messages** and never removes **stale markers**.

| Capability | We have |
|---|---|
| Trim oversized tool result bodies | yes |
| Drop whole dead/zombie messages | **no** |
| Drop stale markers | **no** |

> **P3, unscoped.** Low value while compaction is not the observed bottleneck. Record it; do not
> build it speculatively.

---

## 4. Result propagation — EXISTING, deliberate

The parent receives only the child's final summary. Transcript, intermediate reasoning and
per-turn tool calls are not model-facing.

**This is the correct trade.** A transcript dump would dominate the parent's context — the
exact problem subagents exist to solve. The reviewed alternative does the same (last text part
only) and admits the same loss, mitigated there by a resume handle we also have.

Requirement:

| ID | Requirement |
|---|---|
| **REQ-CXT01** | The tool description MUST tell the model that it will receive only the child's final summary (see REQ-D05.2). A model that expects a transcript will under-use the tool. |

---

## 5. Usage accounting

Per-child `usage` is accumulated from `message_end` events
(`bun-process-runner.ts:417-421`) and aggregated for display. Grandchildren are **not** counted —
they never surface to the parent.

> This is precisely why the REQ-D01 fork bomb is invisible in cost terms. After REQ-D01 lands,
> verify that a depth-2 run's usage aggregates through its parent; if it does not, the budget
> reporting is incomplete and should say so rather than under-report.

---

## 6. Acceptance criteria (existing behaviour, pinned)

```gherkin
Scenario: Oversized child output is truncated and marked
  Given a child whose final output exceeds 50 KiB
  When the result is returned to the model
  Then the result MUST contain a truncation marker
  And the retained portion MUST not silently appear complete

Scenario: Transcript never reaches the model
  Given a child that ran 20 tool calls
  When the result is returned
  Then finalOutput MUST contain only the child's final summary
  And the full transcript MUST remain available in tool details only
```