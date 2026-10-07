# Requirements Register

Atomic requirements for the subagent subsystem. Each row links to the feature spec that owns
its detail and to the evidence that justifies it.

Status vocabulary is defined in [`../README.md`](../README.md).

---

## Summary

| ID | Requirement | Prio | Status | Owner spec |
|---|---|---|---|---|
| **REQ-D01** | Depth guard — refuse dispatch past `maxDepth` | **P0** | **IMPLEMENTED** | [delegation](features/delegation/spec.md) §1 |
| **REQ-D02** | Child must not inherit `subagent` beyond `maxDepth` | **P0** | **IMPLEMENTED** | [delegation](features/delegation/spec.md) §1.3 |
| **REQ-X01** | `stop` MUST signal the child | **P1** | **IMPLEMENTED** | [cancellation](features/cancellation/spec.md) §2 |
| **REQ-X02** | Orphan reconciliation MUST kill surviving children | **P1** | **IMPLEMENTED** | [cancellation](features/cancellation/spec.md) §3 |
| **REQ-X00** | Prerequisite: record the child's pid from `spawned` | **P1** | **IMPLEMENTED** | [cancellation](features/cancellation/spec.md) §2.3 |
| **REQ-L02** | Lease MUST record the child it writes with | **P1** | DEFECT | [durability](features/durability/spec.md) §2 |
| **REQ-C02** | One shared concurrency budget across all modes | **P1** | DEFECT | [concurrency](features/concurrency/spec.md) §2.4 |
| **REQ-C03** | Inline admission MUST be session-scoped | **P1** | DEFECT | [concurrency](features/concurrency/spec.md) §2.5 |
| **REQ-I04** | Repo-scoped lock for composite worktree mutations | **P1** | DEFECT | [isolation](features/isolation/spec.md) §2.6 |
| **REQ-I01** | `isolation: "none" \| "worktree"` per dispatch | P1 | GAP | [isolation](features/isolation/spec.md) §2 |
| **REQ-I02** | Per-tool `concurrentSafe` declaration | P1 | GAP | [isolation](features/isolation/spec.md) §4 |
| **REQ-I03** | Cross-process write safety for `bash` children | P2 | GAP | [isolation](features/isolation/spec.md) §5 |
| **REQ-P02** | Detached-child admission check | P1 | GAP | [permissions](features/permissions/spec.md) §3 |
| **REQ-D03** | Per-child turn cap (`maxTurns`) | P2 | GAP | [delegation](features/delegation/spec.md) §2 |
| **REQ-D04** | Saved specs carry a `description`; rendered into the tool description | P2 | GAP | [delegation](features/delegation/spec.md) §3 |
| **REQ-D05** | Tool description states when-not-to-delegate and the output contract | P2 | GAP | [delegation](features/delegation/spec.md) §4 |
| **REQ-O01** | Decide `buildStatusInjection`: wire or delete | P2 | GAP | [observability](features/observability/spec.md) §2 |
| **REQ-O02** | Inline runs inspectable while running | P2 | GAP | [observability](features/observability/spec.md) §3 |
| **REQ-O03** | Decide durable completion records: wire or delete | P2 | GAP | [durability](features/durability/spec.md) §3 |
| **REQ-C04** | Documented concurrency scope matches enforcement | P2 | GAP | [concurrency](features/concurrency/spec.md) §2.6 |
| **REQ-L01** | Session lease needs a time-based expiry | P2 | GAP | [lifecycle](features/lifecycle/spec.md) §6 |
| **REQ-C01** | Parallel admission gates on `concurrentSafe` | P2 | GAP | [concurrency](features/concurrency/spec.md) §2.3 |
| **REQ-CXT01** | Model is told it receives only the child's final summary | P2 | GAP | [context](features/context/spec.md) §4 |
| **REQ-IP01** | Candidate in-process read-only child mode | P3 | CANDIDATE | [isolation](features/isolation/inprocess-candidate.md) |
| **REQ-P01** | Decision: no full permission pipeline | — | RECORD | [permissions](features/permissions/spec.md) §2 |
| **REQ-POL01** | No vendored-source code in this codebase | — | POLICY | [vendor-policy](vendor-policy.md) §1 |
| **REQ-POL02** | `enableExperiments` is semi-permanent | — | POLICY | [vendor-policy](vendor-policy.md) §4 |
| **REQ-POL03** | External implementations are references, not templates | — | POLICY | [vendor-policy](vendor-policy.md) §5 |
| **REQ-POL04** | The three lock implementations stay separate | — | POLICY | [durability](features/durability/spec.md) §5 |

---

## Critical path

REQ-D01 and REQ-D02 are one fix: a depth guard whose child-side half removes the tool. Nothing
else in this register makes delegation safe.

```text
REQ-D01 + REQ-D02   bounded delegation     (P0)
        │
        ├── REQ-X01 + REQ-X02             stoppable children  (P1)
        │
        ├── REQ-I01                       contained children  (P1)
        │       └── REQ-P02               admitted detachment (P1)
        │
        └── REQ-I02 + REQ-C01             safe parallelism    (P1/P2)
```

**Minimum defensible configuration for detached execution** is REQ-D01/D02 + REQ-X01/X02 +
REQ-I01 + REQ-P02 together. Any one alone is thin:

| Alone | Why insufficient |
|---|---|
| Depth guard alone | Four siblings editing one tree is an *everyday* workload, not an attack |
| Isolation alone | A depth-3 tree is still 262,144 processes |
| Cancellation alone | Nothing stops a live child from doing damage first |

---

## REQ-D01 — Depth guard (P0, IMPLEMENTED 2026-10-06)

Detail: [delegation §1](features/delegation/spec.md). Sub-requirements REQ-D01.1 – REQ-D01.4.

> Shipped. `subagent.maxDepth`, default `1`. `--subagent-depth <n>` rides to the child on argv.

**Where it lives:**

| Half | Location |
|---|---|
| Setting + clamping | `core/defaults.ts` (`maxDepth: 1`), `settings-manager.ts` (`getSubagentMaxDepth`) |
| Child argv | `subagent/bun-process-runner.ts` `buildChildArgs` — always emits `--subagent-depth` |
| Flag parse | `cli/args.ts`, threaded through `main.ts` -> `agent-session-services.ts` -> `sdk.ts` -> `AgentSessionConfig` |
| Parent refusal | `subagent/subagent-tool.ts`, beside the `maxTotalSpawns` check |
| Child tool-set removal | `core/sdk.ts` — filters `subagent` out of `initialActiveToolNames` |

**Two decisions worth remembering.**

1. The child-side removal filters `initialActiveToolNames` **after** the active set is
   resolved, not `defaultActiveToolNames`. Filtering the default list would miss a configured
   `defaultTools` setting *and* an explicit `--tools subagent` — and at max depth there is no
   delegation to make, so the tool must not exist rather than be refused.
2. Depth is read from `SubagentToolOptions.depth` only. It is deliberately **not** sourced from
   `getParentContext()`: an earlier draft threaded it through both, and a test caught the
   divergence (the guard saw one depth, the child argv another).

## REQ-D02 — Child must not inherit `subagent` (P0, IMPLEMENTED 2026-10-06)

Detail: [delegation §1.3](features/delegation/spec.md). Implemented by `core/sdk.ts:272-274`.

> A child that receives no explicit `tools` inherits `["read","bash","edit","write","subagent"]`.
> Beyond `maxDepth` the child MUST resolve a default set without `subagent`.

## REQ-X01 — `stop` must signal the child (P1)

Detail: [cancellation §2](features/cancellation/spec.md). Sub-requirements REQ-X01.1 – REQ-X01.5.

> `stop` currently marks a row `cancelled` while the child keeps running, and later overwrites
> its own status. Use the already-persisted `pid`, gated on `isProcessAlive`.

## REQ-X02 — Reap orphans (P1)

Detail: [cancellation §3](features/cancellation/spec.md). Sub-requirements REQ-X02.1 – REQ-X02.3.

> `markAllRunningAsCrashed` rewrites rows but never signals `t.pid`. ~15 lines in one file.

## REQ-I01 — Worktree isolation as a spawn parameter (P1)

Detail: [isolation §2](features/isolation/spec.md). Sub-requirements REQ-I01.1 – REQ-I01.5.

> Promote the existing, tested worktree primitive out of `enableExperiments` and expose it to the
> model as `isolation`. Never silently downgrade to `"none"` on creation failure.

## REQ-I02 — Per-tool `concurrentSafe` (P1)

Detail: [isolation §4](features/isolation/spec.md).

> Declare `concurrentSafe` on `ToolDef`; gate parallel admission on it. Makes "parallel is safe"
> a property of the tool set instead of a promise in a prompt.

## REQ-P02 — Detached-child admission (P1)

Detail: [permissions §3](features/permissions/spec.md). Sub-requirements REQ-P02.1 – REQ-P02.4.

> Before `background: true`, require explicit admission — an opt-in field or a narrowed tool
> set. One field, one check. **Not** a first step toward a full permission pipeline (REQ-P01).

## REQ-D03 — Per-child turn cap (P2)

Detail: [delegation §2](features/delegation/spec.md). Sub-requirements REQ-D03.1 – REQ-D03.4.

> `toolTimeoutMs` is per *tool call*, so a fast `edit -> test -> fail` loop never trips it.
> Turns are already counted free at `subagent-tool.ts:513`.

## REQ-D04 — Saved spec discoverability (P2)

Detail: [delegation §3](features/delegation/spec.md). Sub-requirements REQ-D04.1 – REQ-D04.3.

> `SavedSpecFile` has no `description`, so the model cannot learn a saved specialist exists.

## REQ-D05 — Delegation guidance (P2)

Detail: [delegation §4](features/delegation/spec.md). Sub-requirements REQ-D05.1 – REQ-D05.3.

> Add when-*not*-to-delegate and the output contract. Highest leverage per line here, widest
> blast radius. **Must be A/B'd** — no delegation-quality eval harness exists.

## REQ-O01 — Decide status injection (P2)

Detail: [observability §2](features/observability/spec.md). Sub-requirements REQ-O01.1 – REQ-O01.3.

> `buildStatusInjection` is exported and never called. Wire into the parent once per turn, or
> delete. Mid-run and child injection are both rejected in that spec.

## REQ-O02 — Inspectable inline runs (P2)

Detail: [observability §3](features/observability/spec.md). Sub-requirements REQ-O02.1 – REQ-O02.3.

> The dashboard is background-only; inline is the default mode, so the common case has no live
> view. Reuse the existing log layout and renderer.

## REQ-L01 — Session lease expiry (P2)

Detail: [lifecycle §6](features/lifecycle/spec.md).

> A crashed `pi` on Windows can leave a lease nothing can break, blocking `steer` / `swap-model` /
> `resume` permanently. Add ~5 lines of expiry, or delete those actions and the lease.

## REQ-C01 — Parallel gates on `concurrentSafe` (P2)

Detail: [concurrency §2.3](features/concurrency/spec.md).

> The consuming side of REQ-I02.

## REQ-CXT01 — Output contract in the tool description (P2)

Detail: [context §4](features/context/spec.md).

> Pairs with REQ-D05.2.

---

## REQ-X00 — Record the child's pid (P1, GAP, prerequisite)

Detail: [cancellation §2.3](features/cancellation/spec.md).

> **This blocks REQ-X01 and REQ-X02.** `BackgroundTask.pid` is declared but never assigned
> (`background.ts:128-129`); the runner emits it on `spawned`
> (`bun-process-runner.ts:549`) and `runDetached` discards it. `runDetached` MUST record it into
> the registry row before anything can signal a background child.

Earlier revisions of this spec claimed the pid was already persisted. It is not — see
[traceability V07](traceability.md), corrected 2026-10-06.

## REQ-L02 — Lease MUST record the child it writes with (P1, DEFECT)

Detail: [durability §2](features/durability/spec.md). Sub-requirements REQ-L02.1 – REQ-L02.3.

> `SessionLeaseHandle.updateWriter` is declared (`session-lease.ts:107`) and implemented
> (`:455`) with **zero call sites**, so `writerState` is permanently `none`. On win32 process
> start identity is unprovable (`defaultGetProcessStartIdentity` returns `undefined`
> unconditionally, `:284-296`), making the writer field the *only* remaining proof of death.
> Unpopulated, a lease whose detached child outlived its parent is breakable — two live writers
> on one session JSONL.

## REQ-O03 — Decide durable completion records: wire or delete (P2, GAP)

Detail: [durability §3](features/durability/spec.md).

> `result-record.ts` (453 lines, 27 exports) implements a claim-gated durable completion-record
> store with **zero call sites**, while `background.ts:9-13` and `:20-26` document the replay
> protocol, claim lock, attempt cap and escalation as shipped.

**Audit recommendation: WIRE.** `runDetached` writes the terminal row before it notifies, and
`isOrphanCandidate` admits only `running`/`pending`, so a parent killed in that window loses the
notification permanently — reachable by closing a laptop mid-turn. Wiring costs M and needs its
own test suite. Deleting is the user's call; if taken, the two doc comments must go with it.

## REQ-C02 — One shared concurrency budget (P1, DEFECT)

Detail: [concurrency §2.4](features/concurrency/spec.md). Sub-requirements REQ-C02.1 – REQ-C02.2.

> `maxConcurrent` is read independently by the inline pool (`subagent-tool.ts:1665-1667`) and the
> background queue (`:693`, `:717`) with no shared counter. Worse than a simple 2x: inline
> `single` and `chain` bypass the pool entirely (`:1715`, `:1603`), and `toolExecution` defaults
> to `"parallel"` so two concurrent tool calls each get their own pool of 4.

**Audit recommendation: cross-accounting on one shared number.** The single-counter alternative
was rejected because inline is *blocking* — parking it means failing the call or converting it to
background, and making it wait would stall the model's turn with no progress signal.

## REQ-C03 — Inline admission MUST be session-scoped (P1, DEFECT)

Detail: [concurrency §2.5](features/concurrency/spec.md).

> The inline worker pool is a fresh `nextIndex` + `workers` array per invocation
> (`subagent-tool.ts:565-583`) holding **no cross-call state**. It is a pool, not a counter.
> Replace with a session-scoped semaphore mirroring the existing `totalSpawnCount` closure
> (`:770`), which is already genuinely shared across both paths.

## REQ-C04 — Documented scope matches enforcement (P2, GAP)

Detail: [concurrency §2.6](features/concurrency/spec.md).

> `packages/coding-agent/docs/settings.md:249` states *"Max subagent processes running at once
> per session"* and `docs/subagents.md:64` implies the limit is shared. Both are false today.
> Exact replacement wording is in the concurrency spec.

## REQ-I04 — Repo-scoped lock for composite worktree mutations (P1, DEFECT)

Detail: [isolation §2.6](features/isolation/spec.md). Sub-requirements REQ-I04.1 – REQ-I04.5.

> Five findings. REQ-I04.2 is the urgent one, and it is **not** the one the audit flagged:
> `experiment-tools.ts:297-301` wraps `removeWorktree` in a bare `catch {}`, so a lock failure
> still writes `status: "merged", merged: true` — the row claims merged while the worktree leaks
> with no record it exists.

| ID | Requirement | Prio |
|---|---|---|
| **REQ-I04.1** | Each composite worktree mutation holds the repo lock for its whole check-and-mutate body | P1 |
| **REQ-I04.2** | Contention MUST surface as a typed error; a swallowed failure MUST NOT mark the row merged | P1 |
| **REQ-I04.3** | `WorktreeLockError` MUST carry a reason and a resolvable location, or `null` with the repo root | P1 |
| **REQ-I04.4** | One stale break per acquisition is the documented cap; the error MUST say the cap was spent | P2 |
| **REQ-I04.5** | `removeWorktree` MUST NOT delete `exp/<slug>` when the caller asked to keep it | P1 |

> **REQ-I04.5 is a new finding the audit missed.** `removeWorktreeLocked`
> (`worktree.ts:216-219`) unconditionally deletes `exp/<basename>`, and `experiment_discard`
> calls it at `experiment-tools.ts:613` *before* the `keep_branch` check at `:623`. The tool
> advertises "the branch is kept by default with WHY_IT_FAILED.md for archaeology" (`:588`) —
> archaeology is impossible.

## REQ-POL04 — The three lock implementations stay separate

Detail: [durability §5](features/durability/spec.md).

> `background.ts:344-390`, `experiment-registry.ts:218-297` and `worktree-lock.ts:212-271`
> implement the same pid/token exclusive-create lock three times, with load-bearing divergence
> (`createdAt` vs `startedAt`, sync vs async loops, age-rule present in two and deliberately
> absent in the third, parse-grace in two and absent in the third).

**Keep separate.** A unified acquisition loop would need parameterising on all four axes, erasing
most of the value, while touching three modules with pinned `breakLockIfUnchanged` exports.
Extract later only `breakLockIfUnchanged` and `releaseLock` — pure, sync, policy-free.

---

## REQ-IP01 — In-process read-only child (P3, CANDIDATE, not scheduled)

Detail: [isolation / inprocess-candidate](features/isolation/inprocess-candidate.md).
Sub-requirements REQ-IP01.1 – REQ-IP01.5.

> `execution: "inprocess"`, tool set restricted to `{read, grep, find, ls}`, `subagent`
> excluded so the mode is **leaf-only by construction**.

**Why it is last.** Three independent reasons, any one sufficient:

1. REQ-D01 must land first — a second execution path before the first is bounded doubles the
   surface being made safe.
2. No observed problem it solves. Spawn latency has not been reported as a pain point; this is
   an optimisation against a hypothetical.
3. It trades away force-kill, crash containment and durable separation — the properties that
   put this subsystem ahead of both reviewed systems — in the one scenario where they matter
   least. Defensible, but it should be a deliberate trade made after the loud problems close.

**The load-bearing constraint is REQ-IP01.2.** Excluding `subagent` is what makes the mode safe
to consider: without a kernel underneath, nested in-process children cannot be bounded by a
per-process counter, so the mode must be structurally incapable of delegating rather than
merely configured not to.

---

## Open questions

| ID | Question | Blocks |
|---|---|---|
| **Q01** | Does a `pi -p` print-mode child perform its own auto-compaction? | REQ-D03 (they interact) |
| **Q02** | Is `maxParallelTasks` enforced per-process or via the shared registry? | Blast-radius figure only, not the fix |
| **Q03** | Do background children reach `trackedDetachedChildPids` for shutdown kill? | Whether REQ-X01/X02 are the only leaks |
| **Q04** | Does the parent system prompt already carry the "do not poll" instruction? | REQ-O01.1 (must not contradict) |