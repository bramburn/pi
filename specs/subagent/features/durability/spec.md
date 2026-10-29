# Durability

Keeping state honest across process death: the session lease, the completion-record store, and
lock discipline.

This domain exists because the audit found three correctness problems that share one root —
**mechanisms that were built to survive a crash but are not actually wired to run.**

Source: `session-lease.ts`, `result-record.ts`, `background.ts`, `worktree-lock.ts`,
`experiment-registry.ts`.

---

## 1. What already works

Do not regress these. They are the reason this subsystem is ahead of both reviewed systems.

| Property | Implementation |
|---|---|
| Background registry is durable | `registry.json` + per-task `log.jsonl`, atomic `*.tmp` rename, corrupt file renamed aside rather than overwritten (`background.ts:17-19`) |
| Lock records its owner | `{ pid, createdAt, token }` — token checked before unlink, so a process cannot remove a lock it no longer owns (`:210-222`) |
| Stale-lock breaking is bounded and loud | One break per acquisition (`:404-409`), then a 10s timeout and `RegistryLockError` |
| Corrupt registry is not silently overwritten | Renamed to `registry.json.corrupt-<ts>` (`:17-19`) |
| Row removal precedes dir deletion | A failed dir delete leaks, never orphans a log the registry still references (`:779-783`) |
| Crash evidence is preserved | 2048-char clamp, preserved across reconciliation rather than overwritten (`:742-745`) |

---

## 2. Lease writer state — REQ-L02 (P1, DEFECT)

### 2.1 The defect

`SessionLeaseHandle.updateWriter` is declared (`session-lease.ts:107`) and implemented (`:455`)
with **zero call sites** in `src/` or `test/`. Every lease therefore carries
`writerState: "none"` forever (`:408`).

Its own doc comment (`:102-106`) states the purpose: record the child this lease writes with,
"so a later contender can prove the child is gone before breaking the lease."

### 2.2 Why that is a safety hole, not a cosmetic gap

`demonstrablyStale` (`:317-330`) returns `true` for a `none` writer as soon as the **holder** pid
is proven dead, with no question asked about the child that holder spawned.

On win32 `defaultGetProcessStartIdentity` returns `undefined` unconditionally (`:284-296`), so
process start identity is unprovable and the pid-recurrence arm of `processDemonstrablyGone`
(`:304-315`) is dead there. The `writer` field was the **only remaining proof**.

Concrete trace:

```text
parent pi takes a redirect lease for action="steer"     subagent-tool.ts:1018
parent pi is SIGKILLed
detached child survives and keeps appending the session JSONL
second pi acquires the same session file
  holder pid dead          -> counts as stale
  writerState "none"       -> no question asked about the child
  lease renamed to tombstone and broken
=> two live writers on one session JSONL
```

That is exactly what `session-lease.ts:1-41` exists to prevent.

### 2.3 Requirements

| ID | Requirement |
|---|---|
| **REQ-L02.1** | A held lease MUST record whether it has a child: `spawning` at the dispatch call site, `running` + pid on the child's `spawned` event. |
| **REQ-L02.2** | A lease in `spawning`, or `running` with a live `writerPid`, MUST NOT be breakable on holder death alone. |
| **REQ-L02.3** | `updateWriter` throws when the record is gone. Callers MUST catch and warn, never let it reject the settle path. |

### 2.4 State machine

| State | Set when | Breakable if holder dead? |
|---|---|---|
| `none` | acquisition (`:408`) | yes |
| `spawning` | dispatch call site, pre-child | **never** (`:324`) |
| `running` | `spawned` with a defined pid | only if `writerPid` also proven gone (`:326-329`) |

### 2.5 Two traps the fix must respect

1. **pid may be undefined.** `bun-process-runner.ts:549` emits `pid: proc.pid`, typed
   `number | undefined` (`types.ts:193`). Writing `running` without a pid makes `parseOwner`
   reject the record at `:219` as *malformed* — the lease then reads `unreadable` and blocks
   `steer`/`swap-model`/`resume` **forever**. Guard on `pid !== undefined`, else stay `spawning`.
2. **Ordering: the lease is taken before the child exists.** `spawning` closes the pre-spawn
   window in the safe direction rather than leaving it at `none`.

### 2.6 Test impact

No existing test needs to change. Tests hand-write lease records via `writeStaleLease` and
exercise only the acquire side; the wiring is on the dispatch side. Critically,
`subagent-resume-lease.test.ts:236` asserts `owner.writerState === "none"` *immediately after*
`acquireSessionLease` — so setting `spawning` **inside** `acquireSessionLease` would break it.
Set it at the call site and all 27 stay green.

The gap is coverage: `stubRunner` emits no `spawned` event, so nothing exercises the new path.
Add three tests — `spawning` written at dispatch; `running` + pid on `spawned`; a `spawned`
arriving after `release()` warns and does not throw.

### 2.7 Acceptance criteria

```gherkin
Scenario: Redirect lease records its child
  Given a lease acquired for action="steer" on a child session file
  When the replacement child spawns
  Then the lease record MUST read writerState "running" and carry writerPid
  And a pid-less spawned event MUST leave the record at "spawning"

Scenario: Live writer keeps a lease unbreakable
  Given a lease whose holder pid is dead
  And whose recorded writerPid is alive
  When another pi acquires the same session file
  Then acquisition MUST raise SessionLeaseConflictError

Scenario: Spawn window is never breakable
  Given a lease in writerState "spawning" whose holder pid is dead
  When another pi acquires the same session file
  Then acquisition MUST raise SessionLeaseConflictError

Scenario: Writer update after release is a warning, not a crash
  Given a lease released before the child's spawned event arrives
  When the spawned event is folded in
  Then the task MUST NOT be rewritten to crashed
```

---

## 3. Durable completion records — REQ-O03 (P2, GAP)

### 3.1 The defect

`result-record.ts` — 453 lines, 27 exported symbols — has **zero call sites**. Its symbols appear
only in `background.ts:53-77` (an import block) and their own definitions. Meanwhile
`background.ts:9-13` and `:20-26` document the replay protocol, claim lock, attempt cap and
escalation as shipped behaviour.

This is the `buildStatusInjection` anti-pattern (REQ-O01) repeated at three times the scale.

### 3.2 What the module implements

A durable, claim-gated completion-record store:

- write-before-notify: at settle, build and durably write `replay/<encoded taskId>.json`
- claim it with a fresh token (`claimRecord`, incrementing `attempts`)
- hand the notification to the consumer
- delete **only** after delivery succeeded
- startup replay: skip fresh claims (`isClaimFresh`, 60s window + live `claimPid`), collect
  corrupt / expired (`REPLAY_MAX_AGE_MS` 24h) / attempt-capped (`REPLAY_MAX_ATTEMPTS` 3),
  deliver at most `REPLAY_MAX_RECORDS` 50 oldest-first, delete on success
- delivery is at-most-once per claim
- plus a `failure-counters.json` streak table (`applySettleToStreaks`) escalating after 3
  identical failure signatures

### 3.3 The failure mode it closes is real

`runDetached` writes the terminal row (`background.ts:1012-1025`) and **then** notifies (`:1029`).
Kill the parent in between and the row is already terminal — so `isOrphanCandidate` (`:585-588`,
which admits only `running`/`pending`) skips it forever, and `markAllRunningAsCrashed`
(`:721-752`) only rewrites rows and never calls `onBackgroundSettled`.

Today the child's output sits in `registry.json` and is **permanently undelivered**: no
notification, no replay, no escalation. Reachable by ordinary means — closing a laptop mid-turn.

### 3.4 Recommendation: WIRE

Effort M, risk Medium (new durability path, new on-disk state, no tests today). Missing
integration points:

| # | Where | What it needs |
|---|---|---|
| 1 | `background.ts:1012-1029` (`runDetached` settle) | Under `withLock`: fold streaks, build, claim, write the record — before notifying |
| 2 | `background.ts:951` (crash-synthesis catch) | Same write-before-notify |
| 3 | `background.ts:1262` (parked/failed dispatch) | Same |
| 4 | `agent-session.ts:455-457` | Startup replay pass beside the existing two, feeding `onBackgroundSettled`, deleting on success |
| 5 | `background.ts:754-786` (`prune`) | Collect over-age / attempt-capped records |
| 6 | `background.ts:788-806` (`cancel`) | Write a `cancelled` record |
| 7 | `test/` | Any coverage at all — zero matches today |

> **Deleting is the user's call**, not ours — 453 lines of another session's deliberate work. If
> it is deleted, `background.ts:9-13` and `:20-26` must go with it, or the file becomes an
> actively misleading claim about behaviour that does not exist.

### 3.5 Acceptance criteria

```gherkin
Scenario: Settle notification survives parent death
  Given a background task that exits 0
  And the parent dies between the row write and the notification
  When a later session starts
  Then the child's finalOutput MUST be delivered once from the replay record
  And the record MUST be deleted after that delivery

Scenario: A live claim is not replayed
  Given a replay record claimed by a live pid within the claim window
  When a startup replay pass runs
  Then that record MUST be left on disk untouched

Scenario: Repeated delivery failures stop escalating
  Given a record whose delivery failed REPLAY_MAX_ATTEMPTS times
  When the next replay pass runs
  Then the record MUST be collected without delivery
```

---

## 4. Relation to REQ-X00

The pid plumbing ([REQ-X00](../../requirements.md)) is a prerequisite for REQ-L02 *and* REQ-X01/X02.
Both need `spawned` folded into the registry row. Implement them together — the call site is the
same.

---

## 5. Lock triplication — REQ-POL04 (POLICY)

Three implementations of the same pid/token exclusive-create lock:

| Module | Record field | Loop | Age rule | Parse grace |
|---|---|---|---|---|
| `background.ts:344-390` | `createdAt` | async | yes (30s) | yes (25ms) |
| `experiment-registry.ts:218-297` | `createdAt` | async | yes | yes |
| `worktree-lock.ts:212-271` | `startedAt` | sync | **no** (deliberate) | **no** |

The age rule is deliberately absent from the worktree lock: a slow `worktree add` must not lose
its lock (`worktree-lock.ts:32-38`). That divergence alone defeats a naive merge.

**Decision: keep separate.** A unified acquisition loop would parameterise on all four axes —
erasing most of the value — while touching three modules with pinned `breakLockIfUnchanged`
exports. Extract later only `breakLockIfUnchanged` and `releaseLock`: pure, sync, policy-free.

**Action now:** cross-reference comments in all three headers so a reader knows the others exist.

---

## 6. Acceptance criteria (existing behaviour, pinned)

```gherkin
Scenario: A process cannot remove a lock it no longer owns
  Given a lock file recorded with token A
  When process B attempts release
  Then the lock file MUST NOT be unlinked

Scenario: Corrupt registry is preserved, not overwritten
  Given registry.json contains invalid JSON
  When the registry is next written
  Then the file MUST be renamed aside as registry.json.corrupt-<ts>
  And the new registry MUST be written fresh

Scenario: Row removal precedes directory deletion
  Given a terminal row over the retention limit
  When prune runs and the directory delete fails
  Then the row MUST already be gone from the registry
  And the leaked directory MUST NOT be referenced
```