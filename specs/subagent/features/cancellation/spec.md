# Cancellation and Process Safety

Making a child actually stop, and reaping the ones that escape.

Source: `shell.ts:153-231`, `bun-process-runner.ts:525-567`, `background.ts:548-559`,
`stream.ts:18-19`.

This domain contains the two process leaks found in the OpenCode review.

---

## 1. Kill escalation — EXISTING

`createKillController` (`shell.ts:153-231`):

```text
stop requested
   └── SIGTERM to the child
        └── 5 s grace
             └── SIGKILL to the process tree
                  └── HARD_KILL_EXIT_CODE 137
```

Partial output is retained with `complete: false` (`stream.ts:18-19`, `:158-167`).
`timedOut` / `cancelled` flags say *why* the exit code is synthetic (`shell.ts:103`).

> **Correct, and better than both reviewed systems.** Keep it.

---

## 2. `stop` did not stop — REQ-X01 (P1, FIXED 2026-10-06)

### 2.1 The defect

`subagent-tool.ts`, the `stop` action on a background row:

1. Marked the registry row `cancelled`.
2. Returned text stating *"This does not signal the detached child — it keeps running"*.
3. **Later overwrote the row's own status** — so the persisted state contradicted the message.

The child continued to burn tokens and edit files.

### 2.2 Why this ranked above a missing feature

A cancellation that does not cancel is **worse than no cancellation**: it invites a retry loop
against a process the operator believes is dead, while that process competes for tokens and
mutates the tree.

The string in step 2 was also the most consequential text in the subsystem — it told the model
the truth and told the operator the opposite.

### 2.3 The pid was NOT recorded — prerequisite work

> **CORRECTED 2026-10-06.** An earlier revision of this spec claimed "the fix is already in the
> data" because `BackgroundTask.pid` was documented as persisted. That was **wrong**.
>
> `pid?: number` was declared but **never assigned**. The pid was emitted by the runner on the
> `spawned` event and dropped; `runDetached`'s listener handled `message_end` /
> `tool_result_end` / `stderr` and ignored `spawned`. `isProcessAlive` existed but was used only
> for the *lock* record.
>
> REQ-X01 and REQ-X02 were therefore blocked on a prerequisite, not ~20 lines each.

### 2.4 What shipped

| ID | Requirement | Status |
|---|---|---|
| **REQ-X00.1** | `runDetached` records the child's pid from the `spawned` event into the registry row. | IMPLEMENTED |
| **REQ-X01.1** | `stop` on a running background row signals the recorded pid before the terminal write. | IMPLEMENTED |
| **REQ-X01.2** | Escalation reuses the `createKillController` contract (SIGTERM -> 5 s -> SIGKILL tree), not a bare signal. | IMPLEMENTED |
| **REQ-X01.3** | Signalling is gated on ownership plus `isProcessAlive`, so a recycled pid is never killed. | IMPLEMENTED |
| **REQ-X01.4** | The row is not overwritten after the terminal write. | IMPLEMENTED |
| **REQ-X01.5** | A child that could not be stopped is never reported `cancelled`; the tool text says so. | IMPLEMENTED |

`killPidTree` (`shell.ts`) is the pid-addressed twin of `createKillController`. It cannot reuse
the existing controller: that one needs the `BunSubprocess` handle, which only the spawning
call site holds, and `stop` may be issued by a **different session process** than the one that
spawned the child. The registry persists a pid and nothing else, so a pid-addressed kill is the
only form available on that path.

Three design points are load-bearing:

1. **The kill happens outside the registry lock.** A wedged `taskkill` must not hold the lock
   against every other session's writes.
2. **Ownership is the recycled-pid guard, not liveness.** Pid liveness alone cannot distinguish
   our child from an unrelated process that inherited the number. The trustworthy fact is that
   this session recorded the pid and is still the row's owner. A foreign row is refused
   outright — including the harmless "mark an already-dead child cancelled" path — because
   `stop` on someone else's row must not write state for it.
3. **The spawn window is real and is handled.** The row exists *before* the runner has resolved
   its invocation, so a `stop` issued immediately lands with no pid to signal. Rather than
   refusing, the row is cancelled and the `spawned` handler kills the child the moment its pid
   arrives. A cancelled background child therefore cannot survive.

REQ-X01.4 required changing a pre-existing test: `subagent-bg-concurrency-cap.test.ts` asserted
that a cancelled task's row went back to `completed` when its (already-released) child settled.
That assertion encoded the contradiction this requirement forbids, so it was inverted.

### 2.5 Acceptance criteria

```gherkin
Scenario: stop actually terminates a background child
  Given a running background task
  When action is "stop"
  Then the recorded pid MUST receive SIGTERM and then SIGKILL after the grace period
  And the row MUST end in cancelled

Scenario: stop never reports cancelled for a live child
  Given a running background task whose pid cannot be signalled
  When action is "stop"
  Then the row MUST NOT read cancelled
  And the tool text MUST state the child is still running

Scenario: stop does not touch another session's row
  Given a running background task owned by a different session
  When action is "stop"
  Then no signal MUST be sent to its pid
```

Pinned by `test/subagent-process-reap.test.ts` (9 cases).

---

## 3. Orphan reconciliation leaked children — REQ-X02 (P1, FIXED 2026-10-06)

### 3.1 The defect

`markAllRunningAsCrashed` decided orphanhood from `ownerPid` liveness and then **only rewrote
rows**. It never inspected or signalled `t.pid`.

A parent `SIGKILL` or crash left a live, write-capable child with no killer and a row claiming
it crashed.

### 3.2 What shipped

| ID | Requirement | Status |
|---|---|---|
| **REQ-X02.1** | Orphan reconciliation kills the recorded pid when it is still alive. | IMPLEMENTED |
| **REQ-X02.2** | The kill is gated on `isProcessAlive` and recorded in `errorMessage` so the reap is auditable. | IMPLEMENTED |
| **REQ-X02.3** | It runs in the same pass that rewrites rows, so no window exists where a row says `crashed` while the child is untouched. | IMPLEMENTED |

Ordering is chosen deliberately: **the child is killed before the row is rewritten**, and the
kill happens outside the lock (same reason as `cancel`). Killing first means a crash between the
two leaves the row still `running` with a dead owner, so the *next* session reaps it again —
idempotent. The reverse order would leave a window that is exactly the leak this fixes.

### 3.3 Residual (accepted, documented not hidden)

Windows offers no portable process start time, so a pid recycled within the same reconcile pass
cannot be distinguished from the original child. The window is one startup pass wide and only
ever follows a parent crash, where the alternative — leaving a live orphan — is strictly worse.

### 3.4 Acceptance criteria

```gherkin
Scenario: Parent crash reaps the child
  Given a background task whose ownerPid is dead
  And whose own pid is alive
  When orphan reconciliation runs
  Then the child MUST be terminated
  And the row MUST read crashed with the reap outcome in errorMessage

Scenario: A live owner's child is never reaped
  Given a background task whose ownerPid is alive
  When orphan reconciliation runs
  Then neither the row nor its pid MUST be touched
```

---

## 4. Windows constraints — EXISTING, documented

The development host is Windows. Documented realities:

| Constraint | Location |
|---|---|
| Grandchildren are orphaned when the direct child dies; grandchildren inherit the stdout handle | `shell.ts:37-39` |
| No POSIX process-group signals on win32 | `shell.ts:166-168` |
| Shell lines run through `cmd.exe /c` | `shell.ts:203-209`, `:303` |
| Process-start identity is unprovable, so leases prefer a false conflict over a false takeover | `session-lease.ts:36-40` |

> **Neither reviewed system has a Windows story.** This is a genuine asset and must not be
> traded away.

---

## 5. Orphan states beyond parent death

| Scenario | Current behaviour | Verdict |
|---|---|---|
| Parent `SIGKILL` | Row -> `crashed`, child killed in the same pass | **FIXED** (REQ-X02) |
| Parent crash | Same as above | **FIXED** (REQ-X02) |
| User closes the TUI | `killTrackedDetachedChildren` on shutdown | **VERIFIED** (Q03, below) |
| `stop` on a background row | Pid signalled, row cancelled, never falsely so | **FIXED** (REQ-X01) |

> **Q03 RESOLVED 2026-10-06 — background children DO reach the shutdown kill set.** Traced end
> to end: `requestBackgroundDispatch` -> `dispatchBackgroundRow` -> `runDetached` calls
> `options.runner.run(...)`, which is the same `createBunProcessRunner` every other mode uses;
> `runChild` calls `trackDetachedChildPid(proc.pid)` immediately after spawn, for every child
> regardless of mode. Every exit path (`interactive-mode`, `print-mode`, `rpc-mode`) calls
> `killTrackedDetachedChildren()`.
>
> Consequence: **REQ-X01 and REQ-X02 were the only real leaks**, and both are now closed. The
> remaining exposure is not the tracking set but the cases no signal handler reaches at all —
> SIGKILL of the parent, or a crash — which is precisely what REQ-X02 covers.