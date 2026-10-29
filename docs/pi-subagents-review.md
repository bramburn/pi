# Review: `tintinweb/pi-subagents`

Third reference in the subagent-architecture comparison, after
[`opencode-subagent-comparison.md`](opencode-subagent-comparison.md) (OpenCode, in-process) and
[`claude-code-subagent-review.md`](claude-code-subagent-review.md) (Claude Code decompile, unreliable).

- **Source**: `github.com/tintinweb/pi-subagents`, v0.19.0, `e955e29`
- **Licence**: MIT
- **Scale**: ~19,300 lines of `src`, ~33,300 lines of tests
- **Adoption**: 1.3k stars, **32.6K downloads/month** on pi.dev — larger than any other extension in this space
- **Review date**: 2026-10-06, clone at `C:\dev\pi-subagents`

This is the most consequential of the three, because unlike the Claude Code decompile it is
**readable, MIT, test-covered source that is demonstrably in production use**. It is also the first
implementation that competes with pi's *own* built-in `subagent` tool rather than with OpenCode.

---

## 0. Verdict

**Its architecture is in-process. Every "child" is an `AgentSession` in the parent's own JS heap.
There is not one child OS process anywhere in the codebase.**

That single fact determines every other conclusion in this review, so it is stated once here and
then assumed throughout:

```text
agent-runner.ts:1008
  const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts));
```

Verified three ways, because the whole review rests on it:

1. `createAgentSession` (pi's in-process session factory) is the only spawn primitive. Call sites:
   `agent-runner.ts:1008`, `mention-clone.ts:150`.
2. Repo-wide grep for `Bun.spawn` / `node:child_process` / `execFile` / `spawnSync` across `src/`
   returns **zero call sites** — three hits, all prose in comments in `worktree.ts` and
   `agent-runner.ts`.
3. `agent-runner.ts` (the only file that starts agents) contains no spawn primitive at all.

The only OS processes it ever starts are `git` (worktrees) and workflow *gate* commands, both via
pi's `pi.exec`.

**Consequence for us:** almost none of its safety machinery is portable, because it does not have
the problems we have. Killing a child is `AbortController.abort()` on an object you already hold.
There is no pid, no signal, no process tree, no orphan, no escalation — because there is nothing
to orphan. Every mechanism we spent the last two sessions building answers a question this codebase
never had to ask.

**Consequence for it:** the same design has a ceiling we do not have, and its own source says so.

---

## 1. What it gets right that validates our work

### 1.1 The depth guard is the same shape as ours — REQ-D01/D02 confirmed

They enforce delegation depth at **two independent points**, and so do we:

| Point | pi-subagents | ours (REQ-D01) |
|---|---|---|
| At/past the cap, the tools are never built | `agent-runner.ts:852` — `nestedRuntime` is `undefined`, so `nestedTools = []` | child drops `subagent` from its tool set (`core/sdk.ts`) |
| Defence in depth at call time | `nested-tools.ts:195` — returns a blocked result | parent refuses the dispatch (`subagent-tool.ts`) |

Two independent reviews of three different implementations have now converged on the same answer:
**the child-side half is the one that actually stops the tree**, because a parent-side check can
always be routed around by a tool call the parent never sees. Our REQ-D01.3 stands.

Differences worth noting:

- **Default depth is 2, ours is 1.** With in-process children a runaway nest is heap pressure, not a
  process storm, so they can afford one more level. Our default 1 is the right call for subprocesses.
- **Nesting is opt-in per agent** via `allowed_subagents` frontmatter. A plain agent gets no nested
  tools at all — a sharper default than a global cap.
- **Their depth rides a JS closure.** `nestedRuntime.depth` is passed to the child in-memory
  (`agent-manager.ts:801` — the child receives the *same manager instance*). Ours has to ride
  `--subagent-depth` on argv. That is the process-boundary tax, and it is why our V50 finding
  (single source of depth) was worth the care.

### 1.2 Strict, fail-loud worktree creation

`agent-manager.ts:713-720` refuses to run rather than silently degrading:

```ts
if (!wt) { releaseSlot(); throw new Error('Cannot run with isolation: "worktree" ...'); }
```

A silent fallback to no-isolation would be the dangerous failure — a model believes it has a
contained worktree and is actually editing the user's working tree. Ours reports the failure on the
record instead of throwing, which is a defensible variant, but theirs is stricter and simpler.

### 1.3 `group-join` — batch completion notifications

`group-join.ts` batches N background completion notifications into one, with a 30s timeout and
straggler re-batching. This is a genuinely good idea we do not have: today N background subagents
produce N `subagent-background-result` messages landing in the model's context, each one a chance
to derail the next turn. It is cheap to build on our existing settle callback and survives a process
boundary (it only needs the notification layer, not the execution model).

**Worth taking.** It is the single best idea in this codebase for us.

### 1.4 Journal-as-prefix-replay for resume

`journal.ts` appends each settled call to a JSONL journal; `resumeFromRunId` replays the prefix to
reconstruct a run. Durable across restart, unlike their own in-memory resume-by-label
(`runtime.ts:598`, valid ~10 min). Our REQ-L02 gap is the mirror image of this: we persist state
but record nothing about which child wrote it. Their journal answers that question in ~150 lines.

---

## 2. Where it is worse than us

### 2.1 Concurrency is bounded by nothing that matters — REQ-C02, worse than we thought

We documented (REQ-C02) that we have two independent budgets and a realistic peak of 12. Theirs:

- Two pools: background default `10`, **foreground default `0` = unlimited** (`agent-manager.ts:55,67`).
- Counters are per-`AgentManager` **instance fields** — per process, not shared.
- **Nested and workflow children take no slot in either pool**, deliberately, as anti-deadlock
  (`agent-manager.ts:107-111`). So the depth-2 grandchild fan-out that we bounded is *entirely
  unbounded* for them.
- `bypassQueue` skips the queue check (`agent-manager.ts:212`).

And their source states the consequence without flinching:

> `Note this bounds nothing horizontally — the depth cap limits how DEEP nesting goes, not how WIDE`
> — `agent-manager.ts:103-105`

That is a fork bomb with a documented fuse and no firebreak. It is safe only because the children
share a heap with the parent, so they cannot outlive it.

### 2.2 Cancellation: two real gaps, one of them ours

- **`abort()` does not stop grandchildren.** `abortOwnedChildren` is only called from *settle* paths
  and resume (`agent-manager.ts:905,934,1262`). So after a `stop`, descendants keep running until
  the stopped child's promise settles. `abortAll()` does not call it either.
- **Esc on `get_subagent_result {wait:true}` detaches the waiter, not the work** — `abortable()`
  is documented as rejecting "without aborting the underlying work" (`abortable.ts:2-9`, used at
  `nested-tools.ts:382-387`). The child keeps billing and its result is never consumed.

The second is the same defect class we just closed in REQ-X01: a cancellation surface that does not
cancel. We fixed it for background children; they have it in the nested wait path.

### 2.3 Nothing survives a restart

`private agents = new Map<string, AgentRecord>()` (`agent-manager.ts:364`). No run state is written
to disk. So:

- No orphan-reconciliation problem (nothing outlives the heap) — the mirror of our pain.
- **But also no durability at all**: a background run in progress when the parent exits is simply
  gone. No row, no result, no resumption path.
- Worktrees live in `tmpdir()` (`worktree.ts:108`) and are pruned **only on clean dispose**
  (`agent-manager.ts:1566-1574`). A SIGKILL mid-run leaves the directory behind permanently.

We have a file-backed, lock-guarded registry and REQ-L02 says our rows don't record which child
wrote them. They have no rows at all. On durability we are strictly ahead, and it is the clearest
case in this review where the subprocess model pays for itself.

---

## 3. The Claude Code question, re-opened

Our decompile review concluded Claude Code's swarm/coordinator/teams machinery **does not ship** —
compile-time DCE plus remotely-revocable flags. This repo forces a qualification:

`docs/workflows.md:412` states it is *"a port of Claude Code's `Workflow` tool down to its state
model"*, and it ships real parity for the language: `agent()`, `pipeline()`, `parallel()`,
`phase()`, `workflow()`, `log()`, `args`, `budget`, one-level nesting, determinism throws.

So the accurate revised position is:

- **Claude Code's `Workflow` tool does ship.** It is a JS DSL interpreted in a `worker_thread`
  (`runtime.ts:719` `new Worker(WORKER_SOURCE, { eval: true })`) — a real, sandboxed, cancellable
  execution environment for the *script*.
- **The swarm/coordinator/teams layer still does not.** This repo — a serious, popular
  implementation — has no equivalent. Parallel fan-out is `Promise.all` plus a host-side semaphore
  at `min(16, cpus-2)` (`runtime.ts:48-50,394-425`). That is a bounded fan-out, not a coordinator.

Our original verdict stands for the coordinator. It was wrong only about the Workflow tool, and we
were reading a decompile.

**A workflow here is a JS script, not a declarative DAG.** There is no graph, no topological sort,
no step list; ordering is plain `await` plus `pipeline()` stage chaining (`worker-source.ts:586-608`).
That matters for us: a DAG would be durable and inspectable, a script is neither.

Honest gaps in its own feature set, worth recording because the marketing oversells:

- **Steering mid-run is absent** from workflows. `WorkflowControl` is exactly
  pause/resume/isPaused/skip/retry (`runtime.ts:240-269`). `steer_subagent` exists elsewhere, but
  workflow children are refused by the RPC stop path (`cross-extension-rpc.ts:178`).
- **Scheduled workflows do not exist**: *"No scheduled workflows. The scheduler runs agents, not
  workflows."* (`docs/workflows.md:404`).
- **A closed TUI means nothing fires.** Schedules are re-armed from disk at session start
  (`schedule.ts:65-67`), but re-arming only re-creates the interval; missed cron fires are lost.
- `const UNSUPPORTED_AGENT_OPTIONS = {};` (`worker-source.ts:337`) is an empty mechanism kept for
  shape, and `budget.total` is permanently `null` (`runtime.ts:711-716`) — both honestly documented.

---

## 4. Two real bugs found

Not presentational. Both are process-boundary failures.

**4.1 Cross-process `rpc:spawn` hangs forever.** The RPC surface is a synchronous in-process event
bus: `events.emit(\`${channel}:reply:${params.requestId}\`, reply)` (`cross-extension-rpc.ts:84`),
with a registry at `Symbol.for("pi-subagents:manager")` (`index.ts:659`). The docs are admirably
honest that this is in-process (`docs/rpc.md:5`: *"none of this survives a real process boundary"*).

But the failure mode is not an error — it is a **silent hang**. Two pi OS processes have separate
`globalThis` *and* separate buses, so a cross-process `rpc:spawn` has no subscriber and no reply.
`handleRpc` only replies from inside a handler, so there is no timeout and no sender-side expiry.
The caller's promise never settles. A documented limitation that hangs instead of rejecting is a
defect worth naming.

**4.2 The schedule store has no leader election.** The PID lock (`schedule-store.ts:24-46`) is an
admission ticket for the file, not leader election. Two live pi processes on the same `cwd` +
`sessionId` each arm the same cron and **both fire**, duplicating spawns, with `runCount` racing.

A narrower one: the `Symbol.for` registry is first-writer-wins (`index.ts:747-750`), while each
factory invocation constructs its own manager unconditionally (`index.ts:568`). Two loads in one
process get two managers, two independent 10-slot budgets, and only the first is visible on
`globalThis`.

---

## 5. What to take, and what to refuse

| Idea | Verdict | Why |
|---|---|---|
| `group-join` — batch N completions into one message | **Take** | Cheap, notification-layer only, survives our process boundary. Best idea here. |
| Journal-as-prefix-replay for resume | **Take** | Directly addresses REQ-L02. Durable, and we already have a file-backed store to hang it on. |
| Strict fail-loud worktree creation | **Take** | Tighter than ours; a silent no-isolation fallback is the dangerous failure mode. |
| Two-point depth enforcement | **Already have** | Their independent implementation confirms REQ-D01.3. |
| Live transcript / fleet UI (~1,600 lines) | **Defer** | Real capability gap, but in-process sessions are what make it cheap for them. Owed to us only via our JSONL stream. |
| Workflow DSL in a worker_thread | **Refuse** | The whole point of subprocess children is that a wedged or hostile child cannot wedge the parent's event loop. A `worker_thread` orchestrator re-introduces exactly that coupling. |
| In-process children | **Refuse (REQ-IP01.2 stands)** | A child that OOMs, calls `process.exit`, or throws uncaught takes the parent with it. We get crash isolation for free; they pay for it in the fork-bomb. |
| Their concurrency model | **Refuse** | Per-instance heaps and a documented unbounded width. Ours must stay file-backed precisely because it crosses processes. |
| Cross-extension RPC surface | **Refuse as-is** | In-process bus with a no-timeout hang across processes. If we ever want this, it needs a real transport. |

---

## 6. The uncomfortable part

32.6K downloads/month, against a built-in tool that ships in the box. That is a real signal about
what users value, and it is worth being honest about what it says:

- **No orphan risk, no pid bookkeeping, no leaked processes.** Every hard safety problem we spent
  two sessions on is absent by construction.
- **Live conversation transcripts.** `conversation-viewer.ts` + `agent-widget.ts` +
  `fleet-list.ts` is ~1,600 lines of UI showing a child's turn-by-turn conversation. We expose
  JSONL on disk but render none of it. In-process sessions hand this to you; across a process
  boundary it is a real project.
- **Lower latency.** No `pi` process start-up, no JSONL parse, no IPC.
- **The Claude Code look and feel.** Agent *types* with frontmatter, not per-call specs. Familiar to
  anyone coming from Claude Code — which is the whole positioning.

None of that argues for switching pi's native tool in-process. It argues that our subprocess design
is paying a real, permanent tax in ergonomics, and that the honest response is to pay it
deliberately on the two axes where it buys isolation, and to close the gap on the axes where it buys
nothing:

- **Buy with subprocesses**: crash isolation, resource limits, killability, a durable registry that
  survives restart.
- **Stop paying with subprocesses**: notification batching (group-join), resumption (journal),
  observable child state.

The first is a security property. The second is pure ergonomics, and there is no excuse for it.

---

## 7. Method and limits

- Cloned `--depth 50` at `e955e29`; read-only, nothing built or run.
- Primary evidence: `agent-manager.ts`, `agent-runner.ts`, `nested-tools.ts`, `workflow/*`,
  `schedule*.ts`, `cross-extension-rpc.ts`, plus `docs/workflows.md` and `docs/rpc.md`.
- All 32.6K/mo adoption and 1.3k star figures come from search results (pi.dev package catalog,
  GitHub) as of 2026-10-06 and were not independently verified against npm.
- Not verified: whether a *grandchild* can somehow escape to a subprocess through a user's own
  extension calling `pi.exec`. That would not change the verdict — the default path is in-process.
- Not run: the project's own test suite (33k lines) was not executed.