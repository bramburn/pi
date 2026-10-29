# Subagent Tool Contract

Root entry point for the subagent subsystem specification. Every other document in
`specs/subagent/` refines a section defined here.

Implements: `packages/coding-agent/src/core/subagent/subagent-tool.ts:92-210` (`subagentSchema`)
and `packages/coding-agent/src/core/subagent/types.ts` (`SubagentSpec`, `SubagentEvent`).

---

## 1. Execution model

A subagent is **an out-of-process `pi` CLI subprocess**. This is the single most important
architectural fact in this specification: it is the filter every borrowed idea must pass.

```
parent `pi` process
   └── Bun.spawn(["--mode","json","-p", task, "--session|--session-parent|--no-session", ...])
          └── child `pi` process  ──► stdout JSONL ──► parent parses incrementally
```

- Spawn argv is constructed in one place: `buildChildArgs`, `bun-process-runner.ts:83-106`.
- `subagent.enabled` is the master registration switch, read at dispatch time
  (`subagent-tool.ts:238`). Registration additionally requires the Bun runtime (`runtime.ts`).
- `SubagentRunner` (`types.ts:216-234`) is a seam. No in-process runner ships.

### 1.1 Consequences that MUST hold

| # | Requirement |
|---|---|
| 1.1.1 | No mechanism may assume a shared in-process event bus. Child progress reaches the parent over the child's stdout JSONL only. |
| 1.1.2 | No mechanism may require bidirectional IPC. The child's stdin is `"ignore"` (`bun-process-runner.ts:539`); the file header states IPC is deliberately not used (`:6-11`). |
| 1.1.3 | Anything requiring shared mutable state must use the on-disk registry (`background.ts`) or the session store, never process memory. |
| 1.1.4 | Cross-process mutual exclusion MUST use an exclusive-create file lock, never an in-process mutex. |
| 1.1.5 | An in-process read-only mode is a **candidate**, not a shipped mode — see [`features/isolation/inprocess-candidate.md`](features/isolation/inprocess-candidate.md). It is gated behind REQ-D01 and MUST remain leaf-only (`subagent` excluded). |

---

## 2. Tool surface

Tool name: `subagent`. Registered into the default tool set at `core/sdk.ts:272-274`:
`["read", "bash", "edit", "write", "subagent"]` (plus `experiment_*` when
`subagent.enableExperiments` is on).

> **DEFECT (REQ-D02).** The default set contains `subagent`. A child that does not receive an
> explicit `tools` list inherits the ability to spawn further children. Combined with the absent
> depth guard this is a fork bomb. See [`features/delegation/spec.md`](features/delegation/spec.md).

### 2.1 Input

Normative shape is `subagentSchema` (`subagent-tool.ts:92-210`). Fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `description` | string | yes | 3-5 word hint. **Weak** — see REQ-D05. |
| `instructions` | string | yes | The full task prompt, appended to the child system prompt. |
| `role` | string | no | Free-text label. No roster resolves it — see REQ-D04. |
| `tools` | string[] | no | Maps to `--tools a,b`. Omitted => child gets pi's full default set. |
| `cwd` | string | no | Defaults to parent cwd. |
| `model` | string | no | Pinned model id. Parent thinking level is dropped when set. |
| `background` | boolean | no | Detach from the foreground wait. |
| `mode` | `"single" \| "parallel" \| "chain"` | no | See [`features/concurrency/spec.md`](features/concurrency/spec.md). |
| `tasks` | array | conditional | Required for `parallel` and `chain`. |
| `action` | enum | no | Control plane — see [`features/lifecycle/spec.md`](features/lifecycle/spec.md). |

Notably absent, and required later: `isolation` (REQ-I01), `maxDepth` propagation (REQ-D01).

### 2.2 Output

`SubagentResult` (`types.ts:150-181`). Two channels:

| Channel | Consumer | Contents |
|---|---|---|
| `finalOutput` | **the model** | The child's final summary text, capped at `PER_TASK_OUTPUT_CAP` (50 KiB, `subagent-tool.ts:90`) with a truncation marker. |
| `messages` | **the human**, via tool details | Full child transcript. NOT model-facing. |
| `usage` | model + human | Per-child token usage, aggregated for display. |

This asymmetry is deliberate and is the correct trade: the parent's context is a scarce
resource, and a transcript dump would dominate it. See
[`features/context/spec.md §4`](features/context/spec.md).

---

## 3. Budgets

All limits live in [`components/budgets.md`](components/budgets.md) with defaults from
`core/defaults.ts`. **Every budget is per-process unless stated otherwise.** Per-process scope
is the root cause of REQ-D01: `totalSpawnCount` is a closure variable
(`subagent-tool.ts:674`, documented in place as "one definition owns one counter... in this
process"), so each child process starts its own counter at zero and the budget does not bound
a delegation tree.

---

## 4. Feature domains

| Domain | Spec | Covers |
|---|---|---|
| Delegation | [`features/delegation/spec.md`](features/delegation/spec.md) | depth guard, recursion, roster, turn caps, delegation prompts |
| Isolation | [`features/isolation/spec.md`](features/isolation/spec.md) | worktrees, tool-set narrowing, cwd, `concurrentSafe` |
| Concurrency | [`features/concurrency/spec.md`](features/concurrency/spec.md) | parallel admission, `mapWithConcurrencyLimit`, chain |
| Lifecycle | [`features/lifecycle/spec.md`](features/lifecycle/spec.md) | background registry, control plane, resume |
| Cancellation | [`features/cancellation/spec.md`](features/cancellation/spec.md) | kill escalation, orphan reaping, Windows |
| Durability | [`features/durability/spec.md`](features/durability/spec.md) | session lease, completion records, lock discipline |
| Context | [`features/context/spec.md`](features/context/spec.md) | truncation, result propagation, compaction interaction |
| Permissions | [`features/permissions/spec.md`](features/permissions/spec.md) | capability grants, detached admission, trust |
| Observability | [`features/observability/spec.md`](features/observability/spec.md) | status injection, inspection surfaces, TUI |

## 5. Non-goals

The following are explicitly **out of scope** for this subsystem. They are recorded so a later
change does not reintroduce them by accident. Full reasoning in
[`rejected.md`](rejected.md).

1. Agent-to-agent messaging (child to parent, child to sibling). No bidirectional transport
   exists. `steer` is kill-and-re-dispatch, not a channel.
2. A persistent task graph with dependency edges.
3. An in-process child **sharing the parent's conversation**. (Distinct from the in-process
   *isolated* read-only mode proposed as a P3 candidate in
   [`features/isolation/inprocess-candidate.md`](features/isolation/inprocess-candidate.md) —
   that one still gets fresh context. Only the shared-conversation variant is out of scope.)
4. A per-tool-call permission pipeline with interactive approval.
5. Remote/container spawn targets.