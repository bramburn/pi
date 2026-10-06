# Lifecycle States

State machines for the background registry, the run record, worktrees, and leases.

---

## 1. BackgroundTaskStatus

Source: `background.ts:156-175`.

```text
                   ┌──────────────────────────────┐
                   ▼                              │
  (register) ──► pending ──► running ──► completed
                   │             │  ├──► failed
                   │             │  ├──► cancelled
                   │             │  └──► crashed
                   │             │
                   │             └──── (child exited) ──► row removed
                   │
                   └──► cancelled   (cancelled before spawn)
```

| State | Meaning | Terminal |
|---|---|---|
| `pending` | Registered, not yet spawned. | no |
| `running` | Child process live. | no |
| `completed` | Child exited 0. | yes |
| `failed` | Child exited non-zero. | yes |
| `cancelled` | Cancellation was requested and honoured. | **only if the child was signalled** |
| `crashed` | Owner died, or the child vanished without settling. | yes |

### 1.1 `cancelled` is not trustworthy

> **DEFECT (REQ-X01).** `stop` on a background row sets `cancelled` but does **not** signal the
> child. The tool's own return text admits it: *"This does not signal the detached child — it
> keeps running"* (`subagent-tool.ts:1186-1197`). Worse, that path later **overwrites the row's
> own status**.
>
> A `cancelled` row therefore asserts something untrue: the child is still burning tokens and
> editing files. This is worse than no cancellation at all, because it invites a retry loop
> against a live process while the operator reads "cancelled".

### 1.2 `crashed` orphans

> **DEFECT (REQ-X02).** `markAllRunningAsCrashed` decides orphanhood from `ownerPid` liveness
> (`background.ts:548-551`, `:684-715`) and then **only rewrites rows** — it never inspects or
> signals `t.pid`. A parent `SIGKILL` therefore leaves a live, write-capable child with no killer
> and a row claiming it crashed.

---

## 2. RunRecord status (inline)

Inline runs are tracked in the runner's in-memory map only
(`bun-process-runner.ts:287-345`). Not durable. Not inspectable from any UI.

```text
running ──► completed | failed | cancelled | killed
```

`killed` distinguishes a SIGKILL tree teardown (`HARD_KILL_EXIT_CODE` 137) from a clean cancel.

---

## 3. WorktreeState

`worktree.ts:91-96`.

| State | Meaning |
|---|---|
| `active` | Created, child may be running in it. |
| `merged` | Merged into the base branch cleanly. |
| `merged-dirty` | Merged with `--strategy=ours`, or the merge hit an in-progress operation. |
| `pruned` | Branch and directory removed. |

> **Reachability.** Nothing in the dispatch path transitions these. Worktrees are created only
> by `experiment-tools.ts:347`, behind `enableExperiments: false`. See REQ-I01.

---

## 4. SessionLeaseState

`session-lease.ts:40-46`.

| State | Meaning |
|---|---|
| `none` | No lease. Safe to acquire. |
| `spawning` | Lease taken, child not yet live. |
| `running` | Lease held by a live child. |

**Acquisition rule.** Break an existing lease only on *proof of death*. Off Linux,
process-start identity is unprovable, so acquisition prefers a false conflict over a false
takeover (`session-lease.ts:36-40`).

> **KNOWN GAP.** There is no time-based expiry. A crashed `pi` on Windows can leave a lease in
> `running` that nothing can break, permanently blocking `steer` / `swap-model` / `resume`
> against that session. See [`../features/lifecycle/spec.md §6`](../features/lifecycle/spec.md).

---

## 5. Result settlement

```text
child exits
    └── parse trailing JSONL
         ├── output present ─────► finalOutput, complete = true
         ├── output absent ──────► finalOutput = "", complete = false
         └── killed mid-stream ──► partial output, complete = false
                                        (stream.ts:18-19, :158-167)
    └── background rows only: settle() injects the result into the parent session
        (agent-session.ts:3031-3048) and wakes a fresh parent turn
```

> **NOTE.** OpenCode reports an empty child body as `state="completed"` with empty text. We are
> stricter: `complete = false`. Keep that — a parent that cannot distinguish "child finished
> with nothing" from "child was cut off" will misattribute its next move.