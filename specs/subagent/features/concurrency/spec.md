# Concurrency

How many children run at once, and in what order.

Source: `subagent-tool.ts:1473-1564`, `core/defaults.ts:26-34`.

---

## 1. Modes

| Mode | Semantics | Spec |
|---|---|---|
| `single` | One child. | — |
| `parallel` | N children concurrently, `maxParallelTasks` cap. | §2 |
| `chain` | Sequential; each task may reference `{previous}`. Stops at first failure. | §3 |

`mode` defaults to `single`. `tasks` is required for `parallel` and `chain`.

---

## 2. Parallel

### 2.1 Existing behaviour

| Control | Default | Where |
|---|---|---|
| `maxConcurrent` | 4 | `mapWithConcurrencyLimit`, `subagent-tool.ts:1548-1550` |
| `maxParallelTasks` | 8 | `subagent-tool.ts:1515-1518` |

Admission is **all-or-nothing** per call (`:669-673`): the proposed count is compared against the
counter before anything starts, so a batch is admitted in full or rejected in full. No partial
admission, and two parallel calls cannot slip through the same hole.

### 2.2 Gap

> **Both limits are per-process.** See [`../../components/budgets.md`](../../components/budgets.md).
> `maxConcurrent` bounds this process's runner map; grandchildren are invisible to it.

REQ-D01 (depth guard) is the mitigation. Parallel mode itself is correctly bounded at depth 1.

### 2.3 New requirement

| ID | Requirement |
|---|---|
| **REQ-C01** | Parallel admission MUST additionally gate on per-tool `concurrentSafe` (REQ-I02 in [`isolation/spec.md`](../isolation/spec.md)). A batch containing mutating tools MUST serialise rather than run concurrently. |

---

## 2.4 The budget is not one budget — REQ-C02 (P1, DEFECT)

Added 2026-10-06 after the audit of the background dispatch queue.

### 2.4.1 Confirmed behaviour

`subagent.maxConcurrent` is read by **two independent mechanisms** with no shared counter:

| Budget | Where | Governs |
|---|---|---|
| Background queue | `subagent-tool.ts:693` → `:717`, live slots at `background.ts:1310` | Detached dispatches only |
| Inline pool | `subagent-tool.ts:1665-1667` | `parallel` batches within **one tool call** |

Scope is **per-process**: `dispatchQueues` is a `WeakMap` keyed by registry *instance*
(`background.ts:1079`) and `getBackgroundRegistry()` is a process-wide singleton (`:810-816`).

### 2.4.2 It is worse than a 2x overshoot

- Inline `single` (`:1715`) and inline `chain` (`:1603`) call `runOne` directly, **bypassing the
  pool entirely** — they are counted against neither budget.
- `mapWithConcurrencyLimit` is a fresh `nextIndex` + `workers` array per invocation
  (`:565-583`). It holds no cross-call state. It is a pool, not a counter.
- `toolExecution` defaults to `"parallel"` and the subagent tool declares no override, so two
  concurrent tool calls each get their own pool of 4.

Realistic peak: 8 inline + 4 background = **12**, and N inline `single` calls are unbounded.
`settings.md:249`'s "per session" claim can be off by 3x.

> Contrast: the *lifetime* budget `totalSpawnCount` (`:770`) **is** genuinely shared across both
> paths (`:1449-1460`). Only concurrency is split.

### 2.4.3 Decision: cross-accounting on one shared number

Rejected **(a) one shared counter**: inline is *blocking* — the parent's tool call awaits the
result, with no task id to return and no queue position to report. Parking it means failing the
call or converting it to background; making it wait means a 10-minute background task stalls the
model's turn with no progress signal. That is structural starvation.

Rejected **(b) two settings**: it documents the lie instead of fixing the budget. A user wanting 4
total still gets 8, now with authoritative wording.

Chosen: one shared quantity — **children actually running** — consulted by both paths, each
keeping its own admission discipline. Background overflow still parks FIFO; inline still gets a
pool. A background task parked because 4 children are live is promoted the moment *any* child
settles, inline or background.

| ID | Requirement |
|---|---|
| **REQ-C02.1** | Inline and background admission MUST consult one shared live-children count. |
| **REQ-C02.2** | Overflow MUST be recorded as a `pending` queued row with no process spawned. |

### 2.4.4 Implementation shape

- `runner.listRunning()` **already counts both** — `runDetached` calls the same memoised runner
  (`subagent-tool.ts:1360`) that `runOne` uses, and `inFlight` is per-runner
  (`bun-process-runner.ts:262`). The shared number already exists; no new counter is needed.
- `subagent-tool.ts:681-724` — derive the background cap as
  `maxConcurrent - liveInlineChildren`.
- `background.ts:1182-1216`, `:1298-1358` — accept the live-children source, not a bare number.
- Unify the read: inline uses a snapshot (`:1667`), background a live getter (`:693`). Pick the
  getter.

> **Trap.** `normalizeDispatchCap` (`background.ts:1091-1093`) clamps `<1` to 1. With 4 inline
> children live the effective cap is legitimately **0** — park everything. The clamp would wrongly
> admit one. It must not apply to the shared path.

> `listRunning` is **optional** (`types.ts:210-223`). Read "reports nothing" as never "no runs
> exist".

---

## 2.5 Inline admission must be session-scoped — REQ-C03 (P1, DEFECT)

Follows from §2.4.2: a per-call worker pool cannot reserve against siblings.

| ID | Requirement |
|---|---|
| **REQ-C03.1** | Inline `single`, `chain` and `parallel` MUST all acquire from the shared budget. |
| **REQ-C03.2** | The mechanism MUST be session-scoped — a semaphore closed over by `createSubagentToolDefinition`, mirroring the existing `totalSpawnCount` closure (`:770`). |
| **REQ-C03.3** | A mid-session `maxConcurrent` change MUST apply to both paths. |

---

## 2.6 Documentation must match enforcement — REQ-C04 (P2, GAP)

`packages/coding-agent/docs/settings.md:249` and `docs/subagents.md:64` are both wrong today.

### 2.6.1 Exact replacement for `settings.md:249`

```
| `subagent.maxConcurrent` | number | `4` | Max subagent children running at once in this pi process, counted
across every mode — inline `single`, `chain` and `parallel` batches, plus background dispatches.
Inline calls beyond the limit wait; background dispatches beyond it are queued as `pending` rows
and start in FIFO order as slots free. Two pi processes each get their own budget of 4 |
```

### 2.6.2 Exact replacement for `subagents.md:64`

```
Background dispatch is capped by the same `subagent.maxConcurrent` budget (default 4) that bounds
inline runs — the limit counts every subagent child this pi process has running, not just detached
ones, so the worst case is 4 concurrent children in total, not 4 per mode. A detached call starts
up to that many children itself and queues the rest. Overflow is recorded as a `pending` row in the
registry — labelled `<role> (queued)`, no process spawned — and promoted in FIFO order whenever a
running task settles or is cancelled, whether that task was started in the background or inline.
Inline runs draw from the same budget, so a full set of inline children holds every background
dispatch in the queue until one of them finishes.
```

### 2.6.3 Per-process scope: a documented limitation, not a requirement

`maxConcurrent` and `maxTotalSpawns` have always been per-process; `budgets.md` already frames
per-process as a known property mitigated by REQ-D01. Closing it needs cross-process coordination
on an already lock-contended on-disk registry with a 30s stale-lock breaker — large, risky, and
with no user-visible harm today. Two pi sessions are two user intents, not one overflow.

**Named re-evaluation trigger:** a machine-shared deployment running several agents at once. At
that point it becomes a requirement.

### 2.6.4 Acceptance criteria

```gherkin
Scenario: Inline and background runs share one budget
  Given maxConcurrent is 4
  And 4 inline parallel children are running
  When a background dispatch is requested
  Then the task MUST be recorded as a pending queued row
  And NO child MUST be spawned

Scenario: A settled inline child frees a background slot
  Given maxConcurrent is 4
  And 4 inline children are running and 1 background task is queued
  When one inline child settles
  Then the queued background task MUST be promoted and started

Scenario: No uncounted run
  Given 4 subagent children are already running in any combination of modes
  When a single, chain or parallel inline call is dispatched
  Then it MUST NOT start a 5th child concurrently

Scenario: Concurrent inline calls do not each get the full budget
  Given maxConcurrent is 4
  When two parallel calls of 4 tasks execute concurrently in one turn
  Then at most 4 children MUST run at once across both calls
```

---

## 3. Chain

`{previous}` in a task's instructions is substituted with the prior child's final output.
Stops at first failure.

**This is the closest thing we have to a dependency edge**, and it is strictly weaker than a
task graph:

| Property | Chain | A real task graph |
|---|---|---|
| Edges | linear, implicit | arbitrary DAG |
| Ordering | sequential only | topological |
| Failure | halts everything | per-node policy |
| Persistence | none | durable |

> A real task graph was considered and rejected — see [`../../rejected.md`](../../rejected.md) §2.

Chain is nonetheless a good primitive and should be documented to the model as the way to build
a pipeline. It is currently undocumented at the tool-description level (see REQ-D05).

---

## 4. Relative position

For calibration against the two reviewed systems:

| | pi | OpenCode | Claude Code |
|---|---|---|---|
| Concurrency cap | **4, all-or-nothing** | none (plain `Map`) | none found |
| Parallel-task cap | 8 | none | n/a |
| Spawn budget | 64, per process | none | n/a |
| Chain sequencing | yes | no | no |
| Multi-task single call | yes | no (multiple tool calls) | no |

We are ahead here. Do not regress this while adopting anything from
[`../../rejected.md`](../../rejected.md).

---

## 5. Acceptance criteria (existing behaviour, pinned)

```gherkin
Scenario: Parallel batch is admitted atomically
  Given maxParallelTasks is 8
  And 6 tasks are requested
  Then all 6 MUST be admitted

Scenario: Oversized batch is rejected wholesale
  Given maxParallelTasks is 8
  And 9 tasks are requested
  Then NO task MUST start
  And the error MUST name maxParallelTasks and the requested count

Scenario: Chain halts on first failure
  Given a chain of 3 tasks
  And the second task fails
  Then the third task MUST NOT start
  And the result MUST identify which chain position failed
```