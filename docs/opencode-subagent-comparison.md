# OpenCode vs pi — Subagent Architecture Review

Reference: `sst/opencode` cloned to `C:\dev\opencode` at `f03046d`.
Ours: branch `feat/native-subagents`, `packages/coding-agent/src/core/subagent/` (18 files, ~7.4k lines).

Method: 4 read-only agents mapped OpenCode (agent defs, task lifecycle, session/context) and our
subsystem; 3 more ran cross-repo gap analysis. Every claim below carries a citation; the headline
findings were verified by direct read after the agents reported.

---

## Bottom line

**OpenCode is not the better system. We are.** On operational safety OpenCode is roughly 3-4x
behind us: we have concurrency caps, a spawn budget, a tool timeout, kill escalation
(SIGTERM -> 5s -> SIGKILL tree), and a durable on-disk background registry. OpenCode has
**none** of these — its job registry is a plain `Map` (`core/src/background-job.ts:120-124`),
its foreground wait has no timeout (`tool/task.ts:335`), and its own source comments admit the
registry is intentionally non-durable (`core/src/background-job.ts:113-119`).

The one thing OpenCode has that we lack is **delegation safety semantics**. Reading its
700-line `tool/task.ts` exposed a real hole in ours, and it is not theoretical — see below.

**Take three things from OpenCode. Ignore the rest.** Its elegance is a *consequence* of being
in-process (one Effect runtime, one event bus, shared durable Session rows). We deliberately
rejected that in favour of real subprocesses, and most of its patterns are unavailable or
actively misleading across a process boundary.

---

## P0 — We are missing a depth guard, and the spawn budget does not contain recursion

This is the finding that justifies the whole review.

OpenCode guards recursion two independent ways:

- depth computed by walking the `parentID` chain, rejected at `depth >= (cfg.subagent_depth ?? 1)`
  (`tool/task.ts:104-117`; config key documented at `web/src/content/docs/config.mdx:548-559`, default 1)
- `task` auto-denied on children unless the subagent opts in (`tool/task.ts:143-155`)

We have **neither**. Verified by direct read:

- No `depth` / `maxDepth` / nesting guard exists anywhere in the subagent subsystem.
- `let totalSpawnCount = 0;` at `subagent-tool.ts:674`, documented in-place as "one definition
  owns one counter... **in this process**". Each child is a *separate `pi` process*
  (`bun-process-runner.ts:547`), so **every child starts a fresh counter at 0**.
  `maxTotalSpawns: 64` therefore bounds one process, not the tree.
- The child's default tool set is `["read", "bash", "edit", "write", "subagent"]`
  (`core/sdk.ts:272-274`), and `--tools` is only passed when explicitly set
  (`bun-process-runner.ts:101-103`). So **a child inherits `subagent` itself.**

Consequence: one child that delegates two, each of which delegates two. Depth 1 = 64 processes,
depth 2 = 4,096, depth 3 = 262,144. `maxConcurrent: 4` is also per-process. Each grandchild
holds `bash` + `edit` + `write` against **the same working tree** — `spec.cwd ?? cwd`
(`subagent-tool.ts:1352-1353`). `harness/tools/file-mutation-queue.ts:4` is a module-level `Map`,
so it serialises writes within one process and provides zero cross-process protection.
Per-subagent worktree isolation exists but is reachable only from `experiment-tools.ts:347`,
behind `enableExperiments: false`.

This is a fork bomb with write access to the repo. Cost is invisible because `usage` is
reported per-child (`types.ts:173`) and grandchildren never surface to the parent.

**Fix (M, ~5 files).** Add `--subagent-depth N` to `buildChildArgs` (`bun-process-runner.ts:83-106`).
Refuse dispatch when `depth + 1 > maxDepth` beside the existing check at `subagent-tool.ts:1321-1335`.
The load-bearing half: in the child's `sdk.ts:272-274`, drop `"subagent"` from
`defaultActiveToolNames` once depth is exhausted, so the model never sees the tool. Default
`subagent.maxDepth: 1`. This is the one OpenCode mechanism that gets *cheaper* across the
process boundary, not harder.

---

## Take these three

### 1. `stop` on a background task does not stop the child

Not an OpenCode idea — a bug the comparison exposed.

`subagent-tool.ts:1186-1197` marks the registry row and returns text admitting the leak: *"This
does not signal the detached child — it keeps running"* and it later **overwrites the row's own
status**. A `stop` that does not stop is worse than no `stop`: it invites a retry loop against a
child that is still burning tokens and editing files, while the human reads `cancelled`.

The fix is already in the data. `BackgroundTask.pid` is persisted (`background.ts:91-92`) and
`isProcessAlive` exists (`background.ts:202-209`). OpenCode reaches the same result via a
transitive metadata walk (`session/run-state.ts:111-143`) — our analogue is signal the recorded pid,
gated on `ownerPid` + liveness probe to avoid a recycled-pid kill. Escalation already exists in
`createKillController` (`shell.ts:153-231`).

**S/M. `background.ts` + `subagent-tool.ts`.**

### 2. Orphan reconciliation declares children crashed but leaves them running

`markAllRunningAsCrashed` decides an orphan from `ownerPid` liveness
(`background.ts:548-551, 684-715`) and then only rewrites rows — it never touches `t.pid`.
Parent `SIGKILL` or crash leaves a live child with no killer and a row that says `crashed`.

In the same pass, `killProcessTree(t.pid)` for candidates with a live pid and record it in
`errorMessage`. ~15 lines, one file, and it only fires where the row is already being declared
crashed.

**S. `background.ts`.**

### 3. Per-child turn cap

OpenCode bounds a child with `maxSteps = agent.steps ?? Infinity`
(`session/prompt.ts:1178`) and injects a synthetic wrap-up prompt on the final step
(`prompt.ts:1281`). We have no turn bound anywhere in `packages/coding-agent` or `packages/agent`.
`toolTimeoutMs: 300000` is **per tool call** (`defaults.ts:34`), so a child running 200 fast
`edit -> test -> fail -> edit` cycles never trips it.

Turn cap, not token cap: we already count turns for free (`liveUsage.turns += 1`,
`subagent-tool.ts:513`) and the parent can kill the tree (`detached: true` + `kill(-pid)`,
`bun-process-runner.ts:545`). A token cap needs a price table we do not have at dispatch time.

Default `subagent.maxTurns: 30`, enforced parent-side in the stream handler. On trip, return the
partial output plus an explicit "stopped at turn cap" so the parent can re-dispatch with `resume`
rather than silently receiving a truncated answer.

**S. One file + `defaults.ts`.**

---

## Worth doing, lower priority

### 4. Saved specs are invisible unless the model already knows the name

We have `save-spec` persisting to `~/.pi/agent/subagent-specs/<name>.json` (`saved-specs.ts:8`),
but `SavedSpecFile` (`saved-specs.ts:38-44`) has **no `description` field**, so the parent model
has no way to learn a saved specialist exists. Reuse rarely happens as a result.

OpenCode appends a permission-filtered agent catalogue to the task tool's description on every
request (`tool/registry.ts:265-278`), and its generator builds `whenToUse` from example dialogue
(`agent/generate.txt:34-57`) — delegation quality is treated as a first-class artifact.

**Recommendation: extend the existing JSON spec store, add a required one-line `description`,
render specs into the tool description. One format only.** Do not reintroduce the markdown roster
that core dropped from `examples/extensions/subagent/agents/*.md` — a second declaration format
splits the user's mental model. Do not add built-in agents: OpenCode has a fixed roster because
the model must *select* from it; we author each child inline and have no selection problem.
Cap the rendered count — a user with 30 specs otherwise pays tokens on every turn.

**M. `saved-specs.ts`, `subagent-tool.ts`.**

### 5. The tool description teaches mechanics but not judgement

`subagent-tool.ts:1212-1218` explains *how* to call the tool well and says nothing about *when*.
`promptSnippet` is one clause: "Delegate work to a subagent with a fresh context."

Add (a) an explicit **when-not-to-delegate** rule — single-file edits, known-location lookups,
anything that needs conversation history the child cannot see; and (b) an **output contract** line,
since the parent receives only the child's final summary and has no other signal about what came
back.

Highest leverage per line here, but it shifts model behaviour globally, so A/B against a fixed
delegation task set before shipping.

**S. One file, ~10 lines.**

### 6. Inline runs are not inspectable

Correction to a common assumption: we are **not** blind here. `/subagents` opens a task dashboard
and `Enter` opens a per-task log-tail overlay (`interactive-mode.ts:3214, 4475-4494`;
`experiments-dashboard.ts:190-228, 272-379`). Background settle also already injects a synthetic
result into the parent (`agent-session.ts:3031-3048`), matching OpenCode's `<task_result>` pattern.

The real gap: the overlay reads `getBackgroundRegistry().snapshot().tasks`
(`interactive-mode.ts:4484-4490`), so it is **background-only**. A long inline run is inspectable
only after it settles, by expanding the tool result. And the overlay shows raw JSON
(`formatLogLine`, `experiments-dashboard.ts:330-340`), not a rendered transcript.

Minimal fix: write inline JSONL to the same `<taskId>/log.jsonl` layout, add inline rows from
`runner.listRunning()` (`bun-process-runner.ts:345`), render via `getDisplayItems`/`formatToolCall`
(`render.ts:122-149`).

**M. `interactive-mode.ts`, `experiments-dashboard.ts`, `bun-process-runner.ts`.**

### 7. `buildStatusInjection` is dead code

Exported at `subagent/index.ts:94` and `core/index.ts:134`, **zero call sites under `src/core/`**.
The only real caller is `examples/extensions/subagent/index.ts:1442`, using its own separate copy.

If kept: wire it into the **parent** system prompt once per turn. Its own cost control is already
sane (2400 chars, 8 running rows, 5 terminal — `status-injector.ts:20-22, 61-68, 72-83`). Do not
inject mid-run: that forces a synthetic turn per update and re-arms the "is it done yet?" loop
OpenCode explicitly forbids in its task prompt. Do not inject into the child — it already knows
its own state and it would corrupt the task framing. Otherwise delete it; a dead injection helper
is a trap for the next reader.

**S either way. Decide and delete or wire.**

---

## Do not adopt

| OpenCode idea | Why not |
|---|---|
| Permission derivation from parent | Reads the parent's live in-process ruleset object (`subagent-permissions.ts:14-26`). We would serialise a ruleset onto argv and invent a wire format. Our `cwd` + `--tools` + process isolation already deliver scope restriction, explicit capability grant, and a user gate. Their own comments call their version partial — parent `ask` never propagates. |
| `extend` — append context to a running task | Appends to a live in-memory session bus. Not portable. Our `steer`/`swap-model` already pay this cost via interrupt + re-dispatch against the same child JSONL — which is *why* `session-lease.ts` exists. Their elegance here is the cost we already absorbed. |
| Foreground -> background promotion | OpenCode promotes by handing the same live Effect fiber to the registry (`task.ts:267`). We cannot detach a running OS process from a foreground wait without a new IPC protocol. Our own code argues against it: `resolveSteerTarget` refuses a background row with no `sessionFile` because *"resuming its session while it writes would corrupt the JSONL"* (`subagent-tool.ts:737-745`). Promotion hits exactly that window. Low value, L complexity — OpenCode needs it because its tool blocks in-process. |
| `agent.prompt` wholesale replacement | OpenCode replaces the vendor base system prompt (`session/llm/request.ts:60`); a one-line user agent loses all harness guidance. We **append** via `--append-system-prompt` (`bun-process-runner.ts:116`). Our model is correct — keep it. |
| `MAX_STEPS_PROMPT` mid-run injection | Does not port. The child's stdin is `"ignore"` (`bun-process-runner.ts:539`) and the JSONL channel is one-way outbound, so we cannot inject "wrap up now" into a running child. Only a hard kill works, which loses the graceful wrap-up. A real, permanent capability loss from the subprocess architecture. |
| TUI child-session tab cycling | Requires a session tree we do not have. OpenCode-shaped, not subprocess-shaped. The inline-row fix (#6) captures most of the value. |
| Re-bootstrapping live children after restart | No shared event bus to reattach to. Our model is better: orphans are marked `crashed` but keep their log (2048-char crash evidence, `background.ts:553-559`) and their session file (`background.ts:106-115`), and `resolveResumeTarget` admits a crashed row with a surviving `sessionFile` (`subagent-tool.ts:374-404`). Reattach is impossible; resume is possible. |
| In-session agent creation | OpenCode restricts it to a CLI command with no in-session tool. We already have the better equivalent via `action: "save-spec"`. |
| `mode: primary|subagent` distinction | Its documented hole is that `agent.get()` checks existence only (`task.ts:131-134`), so a primary agent can be launched if the model guesses its name. Structurally impossible for us: every child is a bare `pi -p` with an appended prompt. |

---

## Where we are already better — do not regress

- **Concurrency**: `maxConcurrent: 4` via `mapWithConcurrencyLimit` (`subagent-tool.ts:1548-1550`),
  batch cap `maxParallelTasks: 8` (`:1515-1518`). OpenCode has no cap.
- **Spawn budget** (per process — see P0), `toolTimeoutMs`, kill escalation with
  `HARD_KILL_EXIT_CODE=137`, partial results with `complete:false`.
- **Durable background registry**: `registry.json` + per-task `log.jsonl`, lock with stale-holder
  breaking, orphan reconciliation, 7-day/200-row prune (`background.ts:5-16, 52-67`).
  OpenCode documents its registry as non-durable by design.
- **Context management**: `harness/compaction/` is ~1300 lines (compaction 785 +
  branch-summarization 246 + tool-result-pruner 146) against OpenCode's single ~500-line
  `compaction.ts` — which is further undermined by a **second live implementation** at
  `core/src/session/compaction.ts` with different thresholds and keep-budgets, where which one
  applies per session path is unverified. Our `harness/utils/truncate.ts` (322 lines) beats their
  134. We also have a JSONL session store with a 946-line conformance suite.
- **Chain and parallel modes** in one call. OpenCode has neither — it requires multiple tool
  calls in a single assistant message.
- **Windows hardening**: grandchildren orphaned after direct child death, no POSIX group
  signals on win32, `cmd.exe /c` (`shell.ts:37-39, 166-168, 203-209, 303`);
  `session-lease.ts:36-40` prefers false conflicts over false takeovers because process-start
  identity is unprovable off Linux. OpenCode has no Windows story at all.

**Complexity we should not grow:** `session-lease.ts` (465 lines) guards one narrow path —
`steer`/`swap-model`/`resume` writing a second process into an existing child JSONL. Its rule is
"breaking a lease requires proof of death", and identity is unprovable off Linux, so the result is
conservative *and* unbounded: a crashed pi on Windows leaves a lease nothing can ever break. It is
**not** dead (called at `subagent-tool.ts:420`, tested in `subagent-resume-lease.test.ts`) — so the
choice is to add ~5 lines of time-based expiry or to delete steer/swap/resume and the lease with
them. `worktree-lock.ts` (280 lines) protects a feature that is off by default; freeze it.

---

## Suggested order

1. **Depth guard** — converts a fork bomb into a bounded, explainable failure.
2. **`stop` actually kills** + **orphan reconciliation kills** — two process leaks, both small.
3. **Turn cap** — one file.
4. Decide `buildStatusInjection`: wire or delete.
5. Spec descriptions in the tool description; tool-description judgement rules.
6. Inline inspection rows.
7. `session-lease.ts`: expiry or deletion.

## Vendor hygiene

Treat OpenCode as a **reference, not a template**. Licence is not the obstacle (MIT). Architecture
is: it is mid-migration to Effect with two live compaction paths, naive `length/4` token
estimation, a non-durable job registry, no concurrency cap, no foreground timeout, no retry, and
empty child output reported as `state="completed"` (`tool/task.ts:224, 344`). Mine it for the list
of problems a subagent system must solve. Do not converge on its shape and do not lift its code.

## Unverified

- Whether a `pi -p` print-mode child performs its own auto-compaction. Affects "does the child
  self-manage context" but not any recommendation above.
- Whether `maxParallelTasks` is enforced per-process or shared via the on-disk registry. Changes
  the depth-2 concurrency figure, not the exponential.
- Whether the parent system prompt already carries OpenCode's "DO NOT sleep, poll for progress"
  instruction. Check before wiring #7 so the two do not contradict.
- Whether background children reach the `trackedDetachedChildPids` set that shutdown kills. The
  same `trackDetachedChildPid` is used (`bun-process-runner.ts:548`) and every mode calls
  `killTrackedDetachedChildren` on shutdown, which would make #1 and #2 the only real leaks — but
  the background dispatch path was not traced end to end.