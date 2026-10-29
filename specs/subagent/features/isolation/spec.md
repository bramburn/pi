# Isolation

How much of the parent's world a child inherits, and what a child is allowed to touch.

Source: `worktree.ts`, `worktree-lock.ts`, `bun-process-runner.ts:83-106`,
`packages/agent/src/harness/tools/file-mutation-queue.ts`.

---

## 1. The isolation spectrum

The whole spawn surface is one argv builder: `buildChildArgs`
(`bun-process-runner.ts:83-106`). There is exactly **one** spawn mode: subprocess.

| # | Level | Knob | Mechanism | Model-facing? |
|---|---|---|---|---|
| 0 | Shared process | in-process `AgentSession` runner | `types.ts:9-11` names the seam; **no implementation ships** | No — CANDIDATE, see [`inprocess-candidate.md`](inprocess-candidate.md) |
| 1 | Child inherits parent session tree | `--session-parent <file>` | `bun-process-runner.ts:89-90` | Implicit |
| 2 | Fresh persistent child session | `--session <file>` | `bun-process-runner.ts:87-88`, `spec.sessionFile` (`types.ts:81-82`) | Via `action: "resume"` only |
| 3 | Ephemeral child, no store | `--no-session` | `bun-process-runner.ts:91-93` | Implicit fallback |
| 4 | Prompt-only append | `--append-system-prompt` from a 0600 temp file | `bun-process-runner.ts:114-151` | Yes |
| 5 | Reduced tool surface | `spec.tools` -> `--tools a,b` | `bun-process-runner.ts:101-103` | Yes |
| 6 | Different cwd | `spec.cwd` | `subagent-tool.ts:1352-1353` | Yes |
| 7 | Pinned model | `spec.model` (drops parent thinking level) | `bun-process-runner.ts:94-100` | Yes |
| 8 | **Isolated git worktree** | `createWorktree` | `experiment-tools.ts:347` only, behind `enableExperiments: false` | **No — experiments only** |
| 9 | Remote / container | — | none anywhere | No — absent |

Context is always fresh. A child never sees the parent conversation
(`types.ts:70-74`, `subagent-tool.ts:99`).

---

## 2. Worktree isolation — REQ-I01 (P1)

### 2.1 The gap

The primitive **exists, is tested, and has a documented setting** —
`worktree.ts` (323 lines), `worktree-lock.ts` (280 lines), `subagent.worktreeBase` default
`.worktrees`.

It is reachable from exactly **one** call site: `experiment-tools.ts:347`, behind
`subagent.enableExperiments` (default `false`, `defaults.ts:29`), which also gates registration
in `sdk.ts:272-273`.

Verified: there is **no `isolation` field** in `subagentSchema`
(`subagent-tool.ts:92-210`) or `SubagentSpec` (`types.ts:66-84`). The model cannot request
isolation on a normal call.

### 2.2 Why the current framing is wrong

Worktree isolation is not an experiment. It is the **containment story for unbounded
delegation**. Gating it means the only mechanism that could contain a runaway tree is off by
default.

This is also the safest available answer to a cheap structural risk: a worktree is deletable. A
model that loops `edit -> test -> fail` inside its own worktree exhausts its turns and leaves a
reclaimable directory; the same loop in the user's tree leaves a mess that must be diagnosed by
hand.

### 2.3 Requirements

| ID | Requirement |
|---|---|
| **REQ-I01.1** | `SubagentSpec` and `subagentSchema` gain `isolation: "none" \| "worktree"`, default `"none"`. |
| **REQ-I01.2** | On `"worktree"`, create the worktree before spawn and pass its path as the child's `cwd`. |
| **REQ-I01.3** | The worktree MUST be released on settle (success, failure, cancel, crash) — including on parent crash, via orphan reconciliation. |
| **REQ-I01.4** | Creation failure MUST surface as E1-class error, never as a silent fallback to `isolation: "none"`. A silent downgrade would be worse than no isolation requested. |
| **REQ-I01.5** | The returned `finalOutput` MUST tell the parent which worktree was used and its path, so a human can find the work. |

### 2.4 Pairing with depth

| Control | Bounds |
|---|---|
| `maxDepth` (REQ-D01) | how many children can exist |
| `isolation` (REQ-I01) | how much damage one child can do |

Ship both. A depth guard alone still permits four concurrent children editing one tree — a
plausible everyday workload, not an adversarial one.

### 2.5 Acceptance criteria

```gherkin
Scenario: Model-requested worktree isolation
  Given isolation is "worktree"
  When a subagent is dispatched
  Then the child MUST be spawned with cwd set to the created worktree path
  And the base repository working tree MUST be untouched by the child

Scenario: Isolation is never silently downgraded
  Given isolation is "worktree"
  And worktree creation fails
  Then the dispatch MUST fail with an error naming the creation failure
  And the child MUST NOT be spawned in the base tree

Scenario: Worktree is released on every terminal path
  When a child completes, fails, is cancelled, or is orphaned
  Then its worktree MUST transition to merged, merged-dirty, or pruned
```

---

## 2.6 Composite worktree mutations — REQ-I04 (P1, DEFECT)

Added 2026-10-06 after the lock audit. Five findings; the urgent one is **not** the one the first
audit flagged.

### REQ-I04.2 — swallowed failure marks the row merged (urgent)

`experiment-tools.ts:297-301` wraps `removeWorktree` in a **bare `catch {}`**. A
`WorktreeLockError` there means the worktree was **not** removed — yet `:302` still writes
`status: "merged", merged: true`.

The row claims merged. The worktree leaks. Nothing records that it exists. The failure is
invisible by construction.

### REQ-I04.1 — two critical sections where one is required

`experiment-tools.ts:613` (`removeWorktree`) and `:622` (`pruneWorktrees`) take and release the
repo lock **twice** inside one tool body. Between the release and the re-acquisition another
session can run `createWorktree`, re-exposing the exact window the lock exists to close. The
second acquisition re-validates nothing: `withWorktreeLock` re-resolves the path and takes a
fresh token (`worktree-lock.ts:290-291`).

Two further unlocked mutations sit in the same body: `:624` `git branch -D`, and `:606` the
in-worktree commit.

Fix: export `discardWorktree(repoRoot, worktreePath, { force, keepBranch })` running remove +
prune + conditional branch delete inside **one** acquisition. Effort M, risk low (additive
export, one caller rewritten).

### REQ-I04.3 — empty `lockPath` on one failure path

`worktree-lock.ts:112-115` throws `WorktreeLockError` with `lockPath: ""`, so the class's own
diagnostic field is empty when the failure originates from `git rev-parse`. Reachable from plain
user error — slug sanitising precedes the lock (`worktree.ts:147-153`), so a valid slug with a
wrong cwd hits it.

Fix: add `reason: "unresolved" | "contended"` and make `lockPath` `string | null`, always passing
`repoRoot`. Gives callers the branch they need for REQ-I04.2.

### REQ-I04.4 — one stale break per acquisition (RECORD, not a defect)

`worktree-lock.ts:214`/`:241-246` is **deliberate** and identical to `experiment-registry.ts:331`
and `background.ts:404`. Bounding breaks to one stops a waiter out-pacing holders into a
livelock, and the failure is a loud `WorktreeLockError` after 10s, not corruption.

The real gap is diagnostic: after the budget is spent, `heldMessage` (`:203-206`) reports
`pid N` even when that pid is provably dead — it names a phantom live holder. Fix: track
`brokeStaleLock` and pass it to `heldMessage`.

### REQ-I04.5 — `keep_branch` is dead (new finding, the audit missed it)

`removeWorktreeLocked` (`worktree.ts:216-219`) unconditionally deletes `exp/<basename>`, and
`row.worktreePath` is `…/<slug>` with `row.branch` = `exp/<slug>` (`worktree.ts:163-164`) — an
exact match. `experiment_discard` calls it at `:613` **before** the `keep_branch` check at `:623`.

So the branch is always deleted. The tool advertises *"The branch is kept by default with
WHY_IT_FAILED.md for archaeology"* (`:588`) — archaeology is impossible.

Fix: add `deleteBranch` (default `true`) to `removeWorktree`; `discardWorktree` passes
`!keepBranch`. Effort S, **risk medium** — changes behaviour the 7 passing tests do not cover.

### Call sites affected

Four production sites in `experiment-tools.ts` (`:298`, `:347`, `:613`, `:622`) plus two test
files.

> **Note.** `packages/coding-agent/examples/extensions/subagent/` holds an **independent older
> copy** of the worktree substrate with no lock at all. It will not break, but it is a third
> unlocked implementation of the same substrate and should be flagged.

### Acceptance criteria

```gherkin
Scenario: A composite mutation is one critical section
  Given a discard of one experiment worktree
  When the tool runs
  Then remove, prune and branch delete MUST all execute under a single repo-lock acquisition

Scenario: Contention is visible, not silent
  Given another run holds the repo worktree lock
  When a tool call needs the lock past its wait budget
  Then the experiment row MUST NOT be marked merged or discarded

Scenario: The error carries its own diagnostics
  When the lock location cannot be resolved
  Then the error MUST carry reason "unresolved" and the repo root
  And it MUST NOT present an empty lock path as if it were known

Scenario: keep_branch is honoured
  Given experiment_discard is called with keep_branch true
  When the worktree is removed
  Then the exp/<slug> branch MUST still exist

Scenario: Stale-break budget is reported
  Given one stale lock has already been broken by this acquisition
  And a stale lock is still present past the wait budget
  Then the error MUST state the stale-break budget was spent
```

---

## 3. Tool-set narrowing — EXISTING

`spec.tools` maps to `--tools a,b` (`bun-process-runner.ts:101-103`). Omitting it means the
child inherits `core/sdk.ts:272-274`.

> **DEFECT, tracked as REQ-D02 in [`delegation/spec.md`](../delegation/spec.md) §1.** The inherited
> default includes `subagent`. Narrowing is the *mechanism*; the default is the *defect*.

---

## 4. Per-tool capability metadata — REQ-I02 (P1, NEW)

### 4.1 Gap

There is no declaration of which tools may run concurrently. The only coordination is
`packages/agent/src/harness/tools/file-mutation-queue.ts` — a **module-level `Map`** that
serialises writes within one process and provides **zero** protection across processes.

Since children are separate processes, parallel tasks writing the same tree are uncoordinated.
This is an everyday failure, not an adversarial one: two children editing overlapping files
interleave partial writes.

### 4.2 Requirement

Add a `concurrentSafe: boolean` field to `ToolDef`. Parallel admission then admits only tools
whose definition declares them safe; anything else serialises on a cross-process queue
(the registry's exclusive-create lock already solves cross-process locking).

Suggested initial values:

| Tool | `concurrentSafe` | Rationale |
|---|---|---|
| `read` | true | Pure. |
| `bash` | **false** | Can write, build, or run anything. |
| `edit` | **false** | Mutates the tree. |
| `write` | **false** | Mutates the tree. |
| `subagent` | **false** | Tree guard is `maxDepth` (REQ-D01), not this. |

> This makes "parallel mode is safe to use" a property of the tool set rather than a promise in
> a prompt. It also gives `interruptBehavior` a natural home alongside the existing kill
> escalation in `shell.ts:153-231`.

### 4.3 Acceptance criteria

```gherkin
Scenario: Mutating tools do not run concurrently
  Given a parallel dispatch whose tasks all include edit
  When the tasks are admitted
  Then they MUST be serialised, not run concurrently

Scenario: Read-only tasks run concurrently
  Given a parallel dispatch whose tasks include only read
  When the tasks are admitted
  Then they MUST run concurrently up to maxParallelTasks
```

---

## 5. Cross-process write safety — REQ-I03 (P2)

> **Known gap, not yet scoped.** Even with REQ-I02, two children running `bash` can still write
> to one tree. The only robust containment is worktree isolation (REQ-I01). REQ-I02 reduces
> accidental overlap; it does not prevent deliberate overlap.

---

## 6. Where isolation is NOT the answer

The `remote` rung (level 9) requires a bridge layer, auth, work-secret exchange, capacity-wake,
and a 5-transport MCP client. We have no remote surface to reach it. Recorded in
[`../../rejected.md`](../../rejected.md) §3.

---

## 7. Rung 0 — in-process read-only child (CANDIDATE, P3)

The seam at `types.ts:9-11` explicitly anticipates an in-process runner. That is a legitimate
*third* option rather than a replacement: an in-process child for pure research or text work,
where latency dominates and crash risk is low.

Fully scoped in [`inprocess-candidate.md`](inprocess-candidate.md). Summary: `execution:
"inprocess"`, tool set restricted to `{read, grep, find, ls}`, `subagent` excluded so the mode
is leaf-only by construction.

**Not scheduled.** It is gated behind REQ-D01 — adding a second execution path before the first
is bounded doubles the surface we are trying to make safe.