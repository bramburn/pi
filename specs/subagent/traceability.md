# Traceability

Every finding from the two architecture reviews, mapped to a requirement, with the evidence that
established it.

**Evidence rule.** Rows marked `VERIFIED` were confirmed by direct read of the source tree, not
inferred from a review agent's report. Rows marked `AGENT` rest on a single agent's reading and
should be re-verified before implementation.

Line numbers drift. Trust the path and symbol over the line number.

---

## 1. VERIFIED findings — ours

| # | Finding | Evidence | Req |
|---|---|---|---|
| V01 | `totalSpawnCount` is a process-local closure variable, documented in place as "one definition owns one counter... **in this process**" | `subagent-tool.ts:669-674` | REQ-D01 |
| V02 | Child default tool set contains `subagent` | `core/sdk.ts:272-274` | REQ-D02 |
| V03 | `--tools` only passed when explicitly set, so an unset `tools` inherits the full default set | `bun-process-runner.ts:101-103` | REQ-D02 |
| V04 | No depth / maxDepth / nesting guard exists anywhere in the subsystem | grep of `src/core/subagent/**` | REQ-D01 |
| V05 | **FIXED 2026-10-06 (V52-V55).** `stop` marks the row and returns text stating the child keeps running; the path later overwrites its own status | `subagent-tool.ts`, `stop` action | REQ-X01 |
| V06 | **FIXED 2026-10-06 (V56).** `markAllRunningAsCrashed` decides orphanhood from `ownerPid` liveness and only rewrites rows — never signals `t.pid` | `background.ts`, `markAllRunningAsCrashed` | REQ-X02 |
| V07 | **CORRECTED 2026-10-06 — this row was wrong.** `BackgroundTask.pid` is declared optional (`background.ts`, "Pid of the spawned child process, when known") but **never assigned anywhere**. `isProcessAlive` exists but is used only for the *lock* record, never for a task row. The pid is emitted by the runner and discarded. **Fixed 2026-10-06 (V52)** — the pid is now recorded and acted on. | `background.ts`; `bun-process-runner.ts` (`spawned` emit) | REQ-X01, REQ-X02, REQ-L02 |
| V08 | No `isolation` field in `subagentSchema` or `SubagentSpec` | `subagent-tool.ts:92-210`; `types.ts:66-84` | REQ-I01 |
| V09 | `createWorktree` is called from exactly one site, behind `enableExperiments: false` | `experiment-tools.ts:347`; `defaults.ts:29`; `sdk.ts:272-273` | REQ-I01 |
| V10 | File-mutation queue is a module-level `Map` — no cross-process coordination | `packages/agent/src/harness/tools/file-mutation-queue.ts:4` | REQ-I02 |
| V11 | No `alwaysAllow` / `alwaysDeny` / `alwaysAsk` / `permissionMode` / `PreToolUse` anywhere | grep of `packages/coding-agent/src` | REQ-P01, REQ-P02 |
| V12 | `confirm()` exists only as an extension UI dialog, never for tool execution | `core/extensions/types.ts:138` | REQ-P01 |
| V13 | `buildStatusInjection` exported but zero call sites under `src/core/` | `core/subagent/index.ts:94`, `core/index.ts:134` | REQ-O01 |
| V14 | `SavedSpecFile` has no `description` field | `saved-specs.ts:38-44` | REQ-D04 |
| V15 | Compaction appends a boundary entry with `firstKeptEntryId`; `buildActiveContext` reads back from it | `session-manager.ts:1147-1157`, `:434-475` | already correct |
| V16 | `tool-result-pruner.ts` is a genuine no-API snip layer, replay-safe and non-mutating | `packages/agent/.../compaction/tool-result-pruner.ts:3-7`, `:42-48` | already correct |
| V17 | `packages/tui/src` contains zero occurrences of "subagent" | grep | REQ-O02 |
| V18 | Subagent dashboard and log overlay read only the background registry | `interactive-mode.ts:3214`, `:4475-4494`, `:4484-4490` | REQ-O02 |
| V19 | Background settle injects child output into the parent session and wakes a turn | `agent-session.ts:3031-3048` | already correct |
| V20 | `acquireSessionLease` IS called in the dispatch path — the lease is not dead code | `subagent-tool.ts:420`; `subagent-resume-lease.test.ts` | REQ-L01 |
| V21 | Session lease has no time-based expiry; Windows cannot prove process death | `session-lease.ts:36-40`, `:40-46` | REQ-L01 |
| V22 | `resolveSteerTarget` refuses a background row with no `sessionFile` because resuming mid-write corrupts the JSONL | `subagent-tool.ts:737-745` | basis for rejecting promotion |
| V23 | Turns are counted free: `liveUsage.turns += 1` | `subagent-tool.ts:513` | REQ-D03 |
| V24 | `toolTimeoutMs` is enforced per tool call, not per turn | `defaults.ts:34`; `bun-process-runner.ts:235-267` | REQ-D03 |
| V25 | Child stdin is `"ignore"`; JSONL is one-way outbound | `bun-process-runner.ts:539`, `:6-11` | blocks graceful turn-cap wrap-up |
| V26 | Context files and skills go into the system prompt; skill bodies load on demand via `read` | `core/system-prompt.ts:51-192`; `core/skills.ts:348-365` | already correct |
| V27 | No GrowthBook / A-B flag equivalent exists | grep of `packages/coding-agent/src` | REQ-POL02 |
| V28 | Non-mutating tool set is exactly `read`, `grep`, `find`, `ls`; mutating tools are `bash`, `powershell`, `edit`, `write` | `core/tools/index.ts:124-146` | REQ-IP01.1 |
| V29 | The `SubagentRunner` seam explicitly anticipates an in-process `AgentSession` runner; no implementation ships | `types.ts:9-11` | REQ-IP01 |
| V30 | Shipped runner is a subprocess: `bun.spawn([child.command, ...child.args], ...)` with argv `["--mode","json","-p", ...]` | `bun-process-runner.ts:83-84`, `:547` | basis for [in-process candidate](features/isolation/inprocess-candidate.md) |

### Audit round 2 — 2026-10-06

Findings from the review of uncommitted work (873 lines changed, 5 new source files, 4 new test
files). `AGENT` rows are single-reader; re-verify before implementing.

| # | Finding | Evidence | Req |
|---|---|---|---|
| V31 | `updateWriter` declared (`:107`) and implemented (`:455`) with **zero call sites**; `writerState` permanently `none` | `session-lease.ts:107`, `:455` | REQ-L02 |
| V32 | `defaultGetProcessStartIdentity` returns `undefined` unconditionally on win32, so start identity is unprovable and `writer` is the only proof | `session-lease.ts:284-296` | REQ-L02 |
| V33 | `result-record.ts`: 27 symbols imported at `background.ts:53-77`, **zero call sites**; replay protocol documented as shipped | `background.ts:9-13`, `:20-26`, `:53-77` | REQ-O03 |
| V34 | `runDetached` writes the terminal row then notifies; `isOrphanCandidate` admits only `running`/`pending`, so a parent killed in that window loses the notification permanently | `background.ts:585-588`, `:1012-1029` | REQ-O03 |
| V35 | Two independent `maxConcurrent` budgets with no shared counter: background queue vs inline pool | `subagent-tool.ts:693`, `:717`, `:1665-1667` | REQ-C02 |
| V36 | Inline `single` (`:1715`) and `chain` (`:1603`) bypass `mapWithConcurrencyLimit` entirely — counted against neither budget | `subagent-tool.ts:1603`, `:1715` | REQ-C02 |
| V37 | `mapWithConcurrencyLimit` is a per-invocation pool with no cross-call state; `toolExecution` defaults to `"parallel"` so two concurrent calls each get their own pool | `subagent-tool.ts:565-583`; `packages/agent/src/types.ts:275` | REQ-C02, REQ-C03 |
| V38 | `dispatchQueues` is a `WeakMap` keyed by registry instance; `getBackgroundRegistry()` is a process-wide singleton → background budget is **per-process** | `background.ts:810-816`, `:1079` | REQ-C02, REQ-C04 |
| V39 | `normalizeDispatchCap` clamps `<1` to 1; with a full inline set the correct effective cap is 0 | `background.ts:1091-1093` | REQ-C02.2 |
| V40 | `experiment-tools.ts:297-301` bare `catch {}` around `removeWorktree`; `:302` still writes `status: "merged", merged: true` | `experiment-tools.ts:297-302` | REQ-I04.2 |
| V41 | `keep_branch` is dead: `removeWorktreeLocked` deletes `exp/<basename>` before the `:623` check. Tool advertises branch-preserving "archaeology" at `:588` | `worktree.ts:163-164`, `:216-219`; `experiment-tools.ts:613`, `:623` | REQ-I04.5 |
| V42 | `WorktreeLockError` thrown with `lockPath: ""` when `git rev-parse` fails | `worktree-lock.ts:112-115` | REQ-I04.3 |
| V43 | Three copies of the pid/token `wx` lock with load-bearing divergence (`createdAt` vs `startedAt`, sync vs async, age-rule and parse-grace selectively present) | `background.ts:344-390`; `experiment-registry.ts:218-297`; `worktree-lock.ts:212-271` | REQ-POL04 |
| V44 | `runDetached`'s listener handles `message_end`/`tool_result_end`/`stderr` and **ignores `spawned`** — the root of V07's correction | `background.ts:987-1007` | REQ-X00 |
| V45 | `runner.listRunning()` already counts inline and background runs via one per-runner `inFlight` map — the shared count already exists | `bun-process-runner.ts:262`, `:343-346`; `background.ts:974` | REQ-C02.1 |

### Depth guard — implemented 2026-10-06

| # | Finding | Evidence | Req |
|---|---|---|---|
| V46 | `subagent.maxDepth` defaults to 1; `getSubagentMaxDepth()` clamps to a non-negative integer and falls back on non-numeric | `core/defaults.ts`; `settings-manager.ts` | REQ-D01.1 |
| V47 | `buildChildArgs` always emits `--subagent-depth <n>` (even at 0, so flag and child agree) | `subagent/bun-process-runner.ts` | REQ-D01.2 |
| V48 | Parent refuses when `depth + 1 > maxDepth`, for single, parallel **and** chain, before any spawn | `subagent/subagent-tool.ts` | REQ-D01.1 |
| V49 | Child-side: `initialActiveToolNames` filters `subagent` **after** resolution, so it also overrides a configured `defaultTools` or an explicit `--tools subagent` | `core/sdk.ts` | REQ-D01.3, REQ-D02 |
| V50 | Depth has a single source: `SubagentToolOptions.depth`. An earlier draft also threaded it via `getParentContext()`; a test caught the divergence and the redundant path was removed | `subagent/subagent-tool.ts` | REQ-D01 |
| V51 | Covered by `test/subagent-depth-guard.test.ts` (7 cases: child depth, refusal text, all three modes, `maxDepth 0`, raised limit, absent option) plus clamping cases in `subagent-settings.test.ts` | `test/subagent-depth-guard.test.ts` | REQ-D01, REQ-D02 |

### Process reaping — implemented 2026-10-06

| # | Finding | Evidence | Req |
|---|---|---|---|
| V52 | `runDetached`'s listener now records `event.pid` from `spawned` into the row, and kills the child immediately if the row was already cancelled (the spawn window) | `subagent/background.ts` (`runDetached`) | REQ-X00.1, REQ-X01.1 |
| V53 | `killPidTree` (`shell.ts`) is the pid-addressed twin of `createKillController`. It CANNOT reuse the existing controller: that needs the `BunSubprocess` handle, which only the spawning call site holds, and `stop` may be issued by a different session process than the one that spawned the child | `subagent/shell.ts`; `subagent/background.ts` (`cancel`) | REQ-X01.2 |
| V54 | Ownership, not liveness, is the recycled-pid guard. A foreign row is refused before anything acts on its pid — including the harmless "mark a dead child cancelled" path | `subagent/background.ts` (`cancel`) | REQ-X01.3 |
| V55 | `runDetached` no longer overwrites an already-terminal row, so a `stop` is not undone when the child settles. This required inverting a pre-existing assertion in `subagent-bg-concurrency-cap.test.ts` that encoded the contradiction REQ-X01.4 forbids | `subagent/background.ts`; `test/subagent-bg-concurrency-cap.test.ts` | REQ-X01.4, REQ-X01.5 |
| V56 | Orphan reconciliation kills the surviving child **before** rewriting the row (crash between the two is idempotent — the next session reaps again), outside the registry lock, and records the outcome in `errorMessage` | `subagent/background.ts` (`reapOrphanChild`, `markAllRunningAsCrashed`) | REQ-X02.1-.3 |
| V57 | **Q03 RESOLVED.** Background children DO reach `trackedDetachedChildPids`: `runDetached` uses the same `createBunProcessRunner` as every other mode, and `runChild` tracks the pid at spawn. So REQ-X01/X02 were the only real leaks | `subagent/background.ts` (`dispatchBackgroundRow`); `subagent/bun-process-runner.ts` (`runChild`); `interactive-mode.ts`, `print-mode.ts`, `rpc-mode.ts` | — |
| V58 | Covered by `test/subagent-process-reap.test.ts` (9 cases), including two safety-critical negatives: a foreign row with a LIVE pid is refused, and reconciliation never signals `process.pid` | `test/subagent-process-reap.test.ts` | REQ-X00, REQ-X01, REQ-X02 |

---

## 2. AGENT-sourced findings — re-verify before implementing

| # | Finding | Evidence | Req |
|---|---|---|---|
| A01 | `maxConcurrent` enforced via `mapWithConcurrencyLimit`, cap 4 | `subagent-tool.ts:1548-1550` | [concurrency §2](features/concurrency/spec.md) |
| A02 | `maxParallelTasks` cap 8, all-or-nothing admission | `subagent-tool.ts:1515-1518`, `:669-673` | [concurrency §2](features/concurrency/spec.md) |
| A03 | `stop` path overwrites the row's own status (part of V05) | `subagent-tool.ts:1186-1197` | REQ-X01 |
| A04 | Inline runs carry bare-UUID `runId`, background rows `bg_`-prefixed | `subagent-tool.ts:681-684` | [lifecycle §1.1](features/lifecycle/spec.md) |
| A05 | Registry prune is 7 days / 200 rows; crash evidence 2048 chars | `background.ts:542-548`, `:553-559` | [components/states.md](components/states.md) |
| A06 | `resolveResumeTarget` admits a crashed row with a surviving `sessionFile` | `subagent-tool.ts:374-404` | [lifecycle §4](features/lifecycle/spec.md) |
| A07 | Status-injection budget: 2400 chars, 8 running / 5 terminal rows | `status-injector.ts:20-22`, `:72-83` | REQ-O01 |

---

## 3. Open questions

| ID | Question | Blocks | Why it matters |
|---|---|---|---|
| Q01 | Does a `pi -p` child self-compact? | REQ-D03 | Turn cap and compaction interact; a self-compacting child changes what "30 turns" means |
| Q02 | Is `maxParallelTasks` per-process or registry-shared? | figure only | Changes the depth-2 concurrency estimate, not any fix |
| Q03 | Do background children reach the shutdown kill set? | — | **RESOLVED 2026-10-06 — yes, they do (V57).** X00/X01/X02 were the only leaks and are now closed. |
| Q04 | Does the parent prompt already say "do not poll"? | REQ-O01.1 | Status injection must not contradict it |

---

## 4. Source assessment

| Source | Trust as design reference | Basis |
|---|---|---|
| **OpenCode** (`sst/opencode`, MIT) | **High** | Readable, small, structured. `tool/task.ts` is 344 lines with real structure, so findings could be checked against the code rather than trusted. |
| **Claude Code analysis** (third-party decompile) | **Medium for internal design, LOW for shipped features** | Third-party decompile of a 12 MB bundle; author states `src/` is incomplete (108 missing modules). Spot-checks confirmed the missing-module claims, which is real discipline. But the prose presents gated features beside shipped ones with no gate labels, and contradicts itself in at least three places. |
| **`tintinweb/pi-subagents`** (MIT, v0.19.0) | **High for architecture, HIGH for safety comparison** | The only readable, MIT, test-covered, production-scale implementation (1.3k stars, 32.6K downloads/mo, ~19.3k src / ~33.3k test lines) that competes with our own built-in tool. Full review: [`../../docs/pi-subagents-review.md`](../../docs/pi-subagents-review.md). |

### pi-subagents — verified 2026-10-06

| # | Finding | Evidence | Req |
|---|---|---|---|
| V59 | **IN-PROCESS.** Every "child" is a `createAgentSession` in the parent's JS heap. Zero `Bun.spawn` / `node:child_process` / `execFile` call sites in `src/` — the 3 grep hits are prose in comments. Verified three ways (spawn primitive, repo-wide grep, `agent-runner.ts` in isolation) | `pi-subagents/src/agent-runner.ts:1008` | REQ-IP01.2 |
| V60 | Depth guard has the **same two-point shape as ours** — tools are never built at the cap, plus a call-time rejection. Default 2 (ours 1); nesting opt-in per agent via `allowed_subagents`. Their depth rides a JS closure; ours rides `--subagent-depth` on argv | `agent-runner.ts:852`; `nested-tools.ts:195` | REQ-D01.3 — **confirmed** |
| V61 | Concurrency is bounded by nothing that matters: two per-instance pools (bg 10 / **fg unlimited**), nested + workflow children take **no slot in either** by design, `bypassQueue` skips the check. Source says so: *"this bounds nothing horizontally — the depth cap limits how DEEP nesting goes, not how WIDE"* | `agent-manager.ts:55,67,103-111,212` | REQ-C02 — **we are ahead** |
| V62 | Cancellation gap: `abortOwnedChildren` fires only from settle paths, so `abort()` does **not** stop grandchildren. Separately, Esc on `get_subagent_result {wait:true}` detaches the waiter but leaves the child billing — the same defect class as REQ-X01 | `agent-manager.ts:905,934,1262`; `abortable.ts:2-9` | REQ-X01 (class confirmed) |
| V63 | Nothing survives a restart: `private agents = new Map()` with no on-disk run state, so a background run dies with the parent and leaves no row. Worktrees in `tmpdir()` are pruned only on clean dispose, so SIGKILL leaves them forever | `agent-manager.ts:364`; `agent-manager.ts:1566-1574`; `worktree.ts:108` | REQ-L02 — **we are ahead** |
| V64 | **Claude Code's `Workflow` tool DOES ship.** This repo ports "down to its state model" (`docs/workflows.md:412`) and ships language parity. Our decompile-based verdict was wrong about this one and right about the coordinator: parallel fan-out here is `Promise.all` + a `min(16, cpus-2)` semaphore, not a coordinator | `pi-subagents/docs/workflows.md:412`; `runtime.ts:48-50,394-425` | corrects the CC review |
| V65 | A workflow is a **JS script in a `worker_thread`**, not a declarative DAG — no graph, no topological sort; ordering is plain `await` + `pipeline()`. Steering mid-run is absent from workflows (`WorkflowControl` = pause/resume/skip/retry only), and scheduled workflows do not exist | `runtime.ts:719`; `worker-source.ts:586-608`; `runtime.ts:240-269`; `docs/workflows.md:404` | — |
| V66 | Two real defects. (a) Cross-process `rpc:spawn` **hangs forever** — separate `globalThis` means no subscriber and no reply, and `handleRpc` only replies from inside a handler, so there is no timeout. (b) The schedule store has no leader election: two pi processes on the same `cwd`+`sessionId` each arm the same cron and both fire | `cross-extension-rpc.ts:84`; `index.ts:659`; `docs/rpc.md:5`; `schedule-store.ts:24-46` | — |
| V67 | Worth taking: `group-join` (batch N completion notifications into one), journal-as-prefix-replay for resume, strict fail-loud worktree creation. All three survive a process boundary; none need their execution model | `group-join.ts`; `journal.ts`; `agent-manager.ts:713-720` | REQ-L02, REQ-O01, REQ-I01 |
| V68 | Adoption signal, stated as such: **32.6K downloads/mo for an extension** against a built-in tool. Their in-process design gets orphan-safety, killability and live transcript UI for free; we pay a permanent ergonomics tax for crash isolation and a durable registry. The right response is to keep subprocesses and stop paying on the ergonomics axes | `docs/pi-subagents-review.md` §6 | REQ-IP01.2 |

Contradictions found in the Claude Code analysis, recorded so they are not inherited as fact:

1. Its "Complete Tool Inventory" lists `SleepTool` and `TungstenTool` as built-ins while the same
   document's missing-modules table says both were dead-code-eliminated.
2. Its s11 entry attributes idle-cycle auto-claim to `coordinator/coordinatorMode.ts`; that file
   contains no match for `idle` or `claim`, and the worker half is in the never-published set.
3. Its flag list is incomplete — at least 11 further gates appear only in the missing-modules
   table, so a filter built from the flag list alone misses them.

> **Consequence:** its "12 Progressive Harness Mechanisms" list is **not** a statement of
> shipping state and must not be used as a backlog.