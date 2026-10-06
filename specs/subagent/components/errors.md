# Error Catalogue

Error conditions, their internal identity, and the text the model sees.

> **Design rule.** Every model-facing message MUST state (a) what was refused or lost, and
> (b) what the model can do next. A refusal that offers no recovery trains the model to retry
> blindly or to abandon the task.

---

## E1 — Spawn refused

| | |
|---|---|
| Raised | `subagent-tool.ts:1321-1335` (spawn budget), and the master switch at `:238` |
| Model text | Names the limit hit, the observed value, and the remedy |

Rules:

1. MUST NOT silently drop a task. In `parallel` and `chain` modes a batch is admitted in full or
   rejected in full — never partially (`:669-673`).
2. MUST name the specific limit (`maxConcurrent`, `maxTotalSpawns`, `toolTimeoutMs`), not a
   generic "too many subagents".

---

## E2 — Depth exceeded (REQ-D01, new)

| | |
|---|---|
| Raised | Dispatch, when `depth + 1 > subagent.maxDepth` |
| Model text | MUST state the depth limit and that the work must be done in this session |

> **Design note — error vs invisible tool.** OpenCode *removes* a denied agent from the task
> tool's description so the model never attempts it. The clawspring clean-room implementation
> chose the opposite: return an error so the model can adapt.
>
> **Our decision: do both, at different layers.**
> - Inside a child at max depth, **remove `subagent` from the child's tool set.** The tool should
>   not exist where it cannot be used; there is no decision for the model to make.
> - At the parent boundary, **return an error.** The parent legitimately needs to know it
>   cannot delegate further, and may re-plan instead.
>
> Rationale: removal prevents wasted turns and wasted context on an impossible call; the error
> preserves the information the parent needs. Doing only one is strictly worse than both.

---

## E3 — Child exited non-zero

| | |
|---|---|
| Raised | Result settlement |
| Model text | Exit code, last 2000 chars of output, and the truncation marker if applied |

Retained even when output exists, so the model can distinguish "failed loudly" from
"succeeded quietly".

---

## E4 — Kill escalation

| | |
|---|---|
| Raised | `shell.ts:153-231` |
| Distinction | `timedOut` / `cancelled` flags say why the exit code is synthetic |

`HARD_KILL_EXIT_CODE` 137 MUST be distinguishable from a child that genuinely exited 137.

---

## E5 — Partial result

| | |
|---|---|
| Raised | Stream closed before the child's final message |
| Model text | MUST contain the partial output **and** say it was cut short |

`complete: false` (`stream.ts:18-19`). A partial answer presented as final is worse than an
error: the parent cannot tell it is acting on half a result.

---

## E6 — Cancellation that did not cancel (REQ-X01)

| | |
|---|---|
| Current text | *"This does not signal the detached child — it keeps running"* |

**DEFECT.** The message is honest but the row then reports `cancelled` anyway
(`subagent-tool.ts:1186-1197`). Fixing X01 makes this message unnecessary — `cancelled` will
mean cancelled. Until then this is the most consequential string in the subsystem: it tells the
model the truth while telling the operator the opposite.

---

## E7 — Output truncated

| | |
|---|---|
| Raised | `PER_TASK_OUTPUT_CAP`, 50 KiB (`subagent-tool.ts:90`) |
| Model text | Retained marker plus the retained portion |

Truncation MUST be marked. An unmarked truncation is silent data loss that the model will
reason over as if it were complete.

---

## E8 — Truncated *shell output* inside a child

| | |
|---|---|
| Raised | `packages/agent/.../utils/truncate.ts:19-20` — 2000 lines / 50 KiB |
| Model text | `"...N bytes truncated..."` |

> **Reference contrast.** OpenCode's truncation marker additionally *hints the model to delegate
> reading to an explore subagent*. That is a good prompt-engineering move, but it presumes a
> delegation budget this subsystem does not expose to the child. Do not copy it before
> REQ-D01 lands — it would advertise delegation to a model that cannot perform it.

---

## E9 — Lease conflict

| | |
|---|---|
| Raised | `session-lease.ts`, `WorktreeLockError` |
| Rule | Contention is **not** a git outcome. It MUST NOT be rendered as repo state |

Off Linux, proof of death is unavailable, so the system prefers a false conflict to a false
takeover. The message MUST say the lease looks live rather than claiming it is.

---

## E10 — Child self-compaction unknown

> **UNVERIFIED.** Whether a `pi -p` child performs its own auto-compaction is unconfirmed. It
> does not affect any requirement above, but it does affect what a long-running child should be
> told about its own context. Resolve before REQ-D03 sets a turn cap, since the two interact.