# Budgets and Limits

Every numeric bound in the subagent subsystem, its default, and — critically — its **scope**.

Defaults source: `packages/coding-agent/src/core/defaults.ts:26-34`.

---

## The scope trap

`mapWithConcurrencyLimit` is called at `subagent-tool.ts:1548-1550` with `maxConcurrent`. It is
a closure over the runner's in-memory map, so it bounds *this process*.

`totalSpawnCount` is declared at `subagent-tool.ts:674`:

```ts
// Session-wide spawn counter: one definition owns one counter, so a single
// tool registration tracks all spawns in this process.
let totalSpawnCount = 0;
```

The comment is accurate and that is exactly the problem. Because every child is a separate
`pi` process, each child gets its own counter starting at zero. `maxTotalSpawns` therefore
bounds **one process**, not a delegation tree.

> **This is the enabling condition for REQ-D01.** No budget below bounds tree depth. Nothing in
> the current design prevents depth-2 expansion (4,096 processes at the default 64), because
> every grandchild starts from scratch.

---

## Limits

| Setting | Default | Scope | Enforced at | Verdict |
|---|---|---|---|---|
| `subagent.maxConcurrent` | 4 | **per process, AND per-mode** | background queue `subagent-tool.ts:693`/`:717`; inline pool `:1665-1667` | **DEFECT — REQ-C02/C03/C04. Two independent budgets; inline `single`/`chain` count against neither.** |
| `subagent.maxParallelTasks` | 8 | per call | `subagent-tool.ts:1515-1518` | OK |
| `subagent.maxTotalSpawns` | 64 | **per process** | `subagent-tool.ts:674`, checked `:823-826` and `:1321-1335` | Bounds one process, not a tree — `subagent.maxDepth` is what bounds the tree |
| `subagent.toolTimeoutMs` | 300000 | **per tool call** | `bun-process-runner.ts:235-267` | Correct per call; a 200-cycle turn loop never trips it |
| `subagent.maxDepth` | 1 | **per process, inherited across the boundary** | `subagent-tool.ts` (refusal); `sdk.ts` (tool-set removal) | **IMPLEMENTED 2026-10-06.** Root is 0, children are 1. `0` forbids delegation. |
| `subagent.researchModeTriggerCount` | 3 | per child | `research-mode.ts` | — |
| `subagent.worktreeBase` | `.worktrees` | n/a | `worktree.ts:18-21` | Gated behind `enableExperiments` |
| `subagent.enableExperiments` | `false` | n/a | `defaults.ts:29`, registered `sdk.ts:272-273` | See [`vendor-policy.md §4`](../vendor-policy.md) |

### 0.1 `maxConcurrent` is not one budget (REQ-C02)

Correction, 2026-10-06. An earlier revision of this table described `maxConcurrent` as a single
per-process budget. It is not:

- The **background queue** reads it live (`subagent-tool.ts:693`) and gates on
  `queue.slots.size` (`background.ts:1310`).
- The **inline pool** reads a snapshot (`:1667`) and gates per tool call. Inline `single` (`:1715`)
  and `chain` (`:1603`) bypass it entirely.
- `mapWithConcurrencyLimit` is a fresh `nextIndex` + `workers` array per invocation (`:565-583`) —
  a pool, not a counter. `toolExecution` defaults to `"parallel"`
  (`packages/agent/src/types.ts:275`), so two concurrent tool calls each get their own pool.

Realistic peak with the default 4: **8 inline + 4 background = 12**, with inline `single` calls
unbounded. See [`../features/concurrency/spec.md §2.4`](../features/concurrency/spec.md).

> By contrast `totalSpawnCount` (`:674`) **is** genuinely shared across both paths — which is why
> the lifetime budget is sound and the concurrency budget is not.

### 0.2 Per-process scope of the background budget

Definitive: `dispatchQueues` is a `WeakMap` keyed by registry *instance* (`background.ts:1079`)
and `getBackgroundRegistry()` is a process-wide singleton (`:810-816`). Two pi sessions on one
machine each get their own budget of 4.

This is a **documented limitation, not a requirement** — see
[`../features/concurrency/spec.md §2.6.3`](../features/concurrency/spec.md) for the
re-evaluation trigger.

---

## Non-settings (hardcoded)

| Constant | Value | Location | Note |
|---|---|---|---|
| `PER_TASK_OUTPUT_CAP` | 50 KiB | `subagent-tool.ts:90` | Truncation is marked. |
| `HARD_KILL_EXIT_CODE` | 137 | `shell.ts` | SIGKILL. |
| SIGTERM grace period | 5 s | `shell.ts:153-231` | Then SIGKILL the process tree. |
| Crash evidence length | 2048 chars | `background.ts:553-559` | Truncated into `errorMessage`. |
| Background registry prune | 7 days / 200 rows | `background.ts:542-548` | |
| Status injection budget | 2400 chars | `status-injector.ts:20-22` | Unwired — see REQ-O01. |
| Status injection rows | 8 running / 5 terminal | `status-injector.ts:72-83` | |
| Approve-deadline (steer) | 10 s | `subagent-tool.ts:282` | Then poll every 50 ms. |
| Tool-result prune | 8192 threshold / 4096 head / 1024 tail | `packages/agent/.../tool-result-pruner.ts:42-48` | No API cost. |
| Per-call truncation | 2000 lines / 50 KiB | `packages/agent/.../utils/truncate.ts:19-20` | |

---

## Required additions

> **GAP (REQ-D01).** `subagent.maxDepth`, default `1`.
> **GAP (REQ-D03).** `subagent.maxTurns`, default `30`.

Both must be threaded to the child (`--subagent-depth`) so the child can remove `subagent`
from its own tool set once the depth is exhausted. The load-bearing half of the depth guard is
in the child, not the parent: a parent-side check alone is advisory, because the model composes
the child's tool list and the child resolves its own defaults.

> **GAP (REQ-I01).** `isolation: "none" | "worktree"` per dispatch. See
> [`../features/isolation/spec.md`](../features/isolation/spec.md).