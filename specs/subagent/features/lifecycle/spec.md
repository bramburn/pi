# Lifecycle

Background runs, the control plane, and resuming interrupted work.

Source: `background.ts`, `subagent-tool.ts:167-185`, `agent-session.ts:3031-3048`,
`session-lease.ts`.

---

## 1. Control plane

`action` is an alternative to a task dispatch (`subagent-tool.ts:167-185`).

| Action | Purpose | Status |
|---|---|---|
| `status` | Report a run's state | EXISTING |
| `stop` | Terminate a run | **DEFECT — REQ-X01** |
| `interrupt` | Interrupt and re-dispatch | EXISTING |
| `steer` | Inject direction into a running child | EXISTING |
| `swap-model` | Change a child's model mid-run | EXISTING |
| `resume` | Re-open a settled or crashed run | EXISTING |
| `save-spec` | Persist a reusable specialist | EXISTING (but see REQ-D04) |
| `list-specs` | List saved specialists | EXISTING |
| `delete-spec` | Remove a saved specialist | EXISTING |

### 1.1 Two namespaces, deliberately

Inline runs live only in the process runner and carry bare-UUID `runId`s. Background rows live
in the on-disk registry and carry `bg_`-prefixed ids. They are reported side by side rather
than merged (`subagent-tool.ts:680-684`), so an id copied out of a listing is always aimed at
the right place.

> **Do not unify these namespaces.** The distinction is what lets a listing be unambiguous.

---

## 2. Background registry — EXISTING

Durable: `registry.json` + per-task `log.jsonl` under `~/.pi/agent/subagent-bg/`.

| Property | Implementation |
|---|---|
| Lock | Exclusive-create, with stale-holder breaking |
| Orphan reconciliation | `markAllRunningAsCrashed` — **defective, REQ-X02** |
| Prune | 7 days / 200 rows (`background.ts:542-548`) |
| Crash evidence | 2048 chars into `errorMessage` (`background.ts:553-559`) |
| Retention on crash | Row **and** log retained; session file survives (`background.ts:106-115`) |

> **A deliberate asset.** The reviewed alternative is an in-memory `Map` documented by its own
> authors as intentionally non-durable. Ours survives restart and keeps the evidence.

### 2.1 Result delivery

Background settle injects the child's `finalOutput` into the parent session and wakes a fresh
parent turn (`agent-session.ts:3031-3048`).

> **Already matches the best available pattern.** The reference implementation does the same
> thing: a completed background task synthesises a prompt into the parent carrying a
> `<task id state><task_result>` envelope. We are aligned here — no work to do.

---

## 3. Steering — EXISTING, and how it works

`steer` settles within 10 s (`subagent-tool.ts:282`), then polls every 50 ms.

> **Important design consequence.** `steer` is **kill and re-dispatch**, not a live channel.
> It interrupts the run and opens a replacement against the child's *own session file*, carrying
> the message in the replacement prompt, under a cross-process lease.

This is why `session-lease.ts` (465 lines) exists at all: a second `pi` process is about to open
a JSONL that a child may still be writing.

> **Do not** try to add a live steering channel. It is impossible across a one-way stdout pipe
> with `stdin: "ignore"` (`bun-process-runner.ts:539`).

---

## 4. Resume — EXISTING

`resolveResumeTarget` (`subagent-tool.ts:374-404`) admits a **crashed** row when its
`sessionFile` survives. The child's JSONL is on disk, so the work is recoverable even though the
process is gone.

> **This is the right model for a subprocess design** and is better than the reviewed
> alternative, which re-bootstraps *live* children off a shared event bus. We cannot reattach —
> a dead OS process cannot be reattached to. We *can* resume, and we do.

---

## 5. Foreground to background promotion — REJECTED

> **Rejected.** See [`../../rejected.md`](../../rejected.md) §1. Summary: promotion hands a live
> execution to a registry; we cannot detach a running OS process from a foreground wait without
> a new IPC protocol. Our own code argues against it — `resolveSteerTarget` refuses a background
> row with no `sessionFile` because *"resuming its session while it writes would corrupt the
> JSONL"* (`subagent-tool.ts:737-745`). Promotion would hit exactly that window.

---

## 6. Session lease has no time-based expiry — REQ-L01 (P2, OPEN)

### 6.1 Problem

`SessionLease` states are `none | spawning | running` (`session-lease.ts:40-46`). Breaking a
lease requires **proof of death**, and on Windows process-start identity is unprovable
(`:36-40`).

Result: a crashed `pi` on Windows can leave a lease in `running` that **nothing can ever
break**, permanently blocking `steer`, `swap-model` and `resume` against that session.

### 6.2 Two options — pick one, do not leave open

| Option | Effort | Consequence |
|---|---|---|
| **A.** Add ~5 lines of time-based expiry (lease older than N minutes with a dead owner pid is breakable) | S | Small window of false takeover on a slow-but-live child |
| **B.** Delete `steer`, `swap-model`, `resume` and the lease with them | L | Removes three control-plane actions users may rely on |

**Recommendation: A.** The conservative design is right for the common case; it only fails in a
rare terminal state, and a bounded expiry is proportionate.

> **Not dead code.** `acquireSessionLease` is called in the dispatch path
> (`subagent-tool.ts:420`) and covered by `subagent-resume-lease.test.ts`. The choice is
> "expiry or deletion", not "used or unused".

---

## 7. Acceptance criteria (existing behaviour, pinned)

```gherkin
Scenario: Crashed background run is resumable
  Given a background task that crashed with a surviving sessionFile
  When action is "resume"
  Then the child MUST be re-dispatched against that session file
  And prior messages MUST be preserved

Scenario: Settled background run wakes the parent
  When a background task completes
  Then its finalOutput MUST be injected into the parent session
  And a fresh parent turn MUST begin
```