# Subagents Requirements

## Scope

This document specifies the process-level requirements for making the native subagent subsystem self-sufficient, severing external subagent package or extension ties, and closing every actionable defect and gap in the subagent requirements register before release. Candidate in-process execution modes remain out of scope for this release cycle.

## Requirements

### R-SUBAG-001: Native subagent subsystem exclusivity

**Priority:** MUST
**Statement:** The system must provide subagent delegation exclusively through the native coding-agent subagent subsystem without placing subagent orchestration code in the core agent runtime library.
**Rationale:** `packages/agent/src` currently contains zero subagent code (`specs/batch/batch-context.md` §3.3), while the native subprocess orchestration lives in `packages/coding-agent/src/core/subagent/`. Enforcing a single implementation site prevents architectural drift and honours decision D5 and `ADR-0004`.
**Acceptance criteria:**
- AC1: Given the core agent runtime library source tree, when the source files are inspected for subagent orchestration modules or exports, then zero subagent symbols or files exist in that library.
- AC2: Given an active coding-agent session with subagents enabled, when subagent delegation is invoked, then the native coding-agent subagent subsystem executes the request.
**Source:** Decision D5 (`specs/batch/batch-context.md` §1, §3.3), `ADR-0004`

### R-SUBAG-002: Removal of external subagent package and legacy extension references

**Priority:** MUST
**Statement:** The system documentation and bundled examples must omit references to external subagent packages or legacy extension-based subagent implementations.
**Rationale:** `packages/coding-agent/docs/subagents.md:222-224` recommends the external npm `pi-subagents` package, and `packages/coding-agent/docs/subagents.md:251-253` plus `packages/coding-agent/examples/extensions/subagent/` retain an upstream-era extension example that also duplicates an unlocked copy of the worktree substrate (`specs/subagent/features/isolation/spec.md` §2.6).
**Acceptance criteria:**
- AC1: Given the subagent documentation, when searched for external subagent package comparisons or extension coexistence sections, then zero references exist.
- AC2: Given the bundled extension examples directory, when inspected on disk, then the legacy subagent example extension directory is absent.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `ADR-0004`

### R-SUBAG-003: Local-only agent definition loading

**Priority:** MUST
**Statement:** The system must load reusable subagent definitions exclusively from local project or user configuration directories without fetching remote definitions over the network.
**Rationale:** `packages/coding-agent/src/core/subagent/agents.ts:12-14,69` resolves `.qi/agents/*.md` (formerly `.pi/agents/*.md`) from the local project and user agent directories (`specs/batch/batch-context.md` §3.3). Preserving strictly local loading guarantees offline determinism and prevents untrusted remote prompt injection.
**Acceptance criteria:**
- AC1: Given a subagent dispatch referencing a named agent definition, when definitions are resolved, then the resolver reads only the local project agent directory and the local user agent directory.
- AC2: Given an unknown agent definition name, when resolution fails, then the system returns a local diagnostic listing searched directories without initiating any network request.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `ADR-0004`

### R-SUBAG-004: Pre-implementation verification of durable completion records

**Priority:** MUST
**Statement:** The system maintainers must verify the implementation state of durable background completion records against the current source tree before modifying completion-record code.
**Rationale:** Cross-references `REQ-O03` (`specs/subagent/requirements.md`, `specs/subagent/features/durability/spec.md` §3). Although `REQ-O03` was originally logged as having zero call sites (`V33`), `specs/batch/batch-context.md` §3.3 verifies that `packages/coding-agent/src/core/subagent/background.ts:1212-1307`, `packages/coding-agent/src/core/agent-session.ts:569,590`, and `packages/coding-agent/test/subagent-bg-replay.test.ts` already wire and test durable completion replay. `REQ-O03` is already fully wired and tested in `background.ts:1212-1307`, `agent-session.ts:569,590`, and `test/subagent-bg-replay.test.ts`; `specs/batch/batch-context.md` §3.3 confirms the call sites exist and the replay test passes, so closure is a verify-and-flip under R-SUBAG-004 AC1, not a rewrite.
**Acceptance criteria:**
- AC1: Given the durable completion-record module and background registry settle path, when audited against `REQ-O03.1` through `REQ-O03.3` acceptance scenarios, then either all settle, claim, startup-replay, and prune call sites are confirmed covered by passing tests and `REQ-O03` is marked `IMPLEMENTED` in the register, or any missing call site is wired before P1 defect work proceeds.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-O03`)

### R-SUBAG-005: Session lease writer state tracking

**Priority:** MUST
**Statement:** The system must update the writer state on every held session lease at dispatch and upon child process creation so a lease held by a live child process cannot be broken when its parent process terminates.
**Rationale:** Cross-references `REQ-L02` (`REQ-L02.1`–`REQ-L02.3`, P1 DEFECT in `specs/subagent/requirements.md` and `specs/subagent/features/durability/spec.md` §2). `SessionLeaseHandle.updateWriter` is declared at `packages/coding-agent/src/core/subagent/session-lease.ts:107` and implemented at `:455` with zero call sites (`V31`), leaving `writerState` at `"none"` (`:408`). On Windows (`defaultGetProcessStartIdentity` at `:284-296`, `V32`), process start identity is unprovable, so an unpopulated writer field allows a contender to break the lease after parent death while the detached child still writes to the session file.
**Acceptance criteria:**
- AC1: Given a session lease acquired for a subagent dispatch, when the dispatch is initiated prior to child process creation, then the lease record transitions to writer state `spawning`.
- AC2: Given a held session lease in `spawning` state, when the child process emits a spawn event with a valid process identifier, then the lease record transitions to writer state `running` with that process identifier recorded.
- AC3: Given a held session lease in `spawning` state, when the child process emits a spawn event without a process identifier, then the lease record remains in `spawning` state rather than writing an invalid `running` record.
- AC4: Given a session lease in `spawning` state or in `running` state with a live child writer process, when the lease holder parent process is dead and a second process attempts to acquire the lease, then acquisition fails with a session lease conflict error.
- AC5: Given a session lease that was already released before a delayed spawn event is processed, when the writer update fails, then the caller logs a warning without failing the task settlement path.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-L02`)

### R-SUBAG-006: Unified session-scoped concurrency budget

**Priority:** MUST
**Statement:** The system must enforce the maximum concurrent subagent limit across all inline and background dispatch modes through a single session-scoped live-child counter per process.
**Rationale:** Cross-references `REQ-C02` (`REQ-C02.1`–`REQ-C02.2`) and `REQ-C03` (`REQ-C03.1`–`REQ-C03.3`, P1 DEFECTs in `specs/subagent/requirements.md` and `specs/subagent/features/concurrency/spec.md` §2.4–§2.5). Currently `packages/coding-agent/src/core/subagent/subagent-tool.ts:693,717` (background queue) and `:1665-1667` (inline `mapWithConcurrencyLimit` pool at `:565-583`) are independent (`V35`), inline `chain` (`:1603`) and `single` (`:1715`) bypass both (`V36`), parallel tool calls each instantiate a separate pool (`V37`), and `normalizeDispatchCap` (`packages/coding-agent/src/core/subagent/background.ts:1091-1093`) clamps `<1` to `1` (`V39`).
**Acceptance criteria:**
- AC1: Given the maximum concurrent limit is reached by running inline subagent tasks, when a background dispatch is requested, then the background task is recorded as a `pending` queued row with zero new child processes started.
- AC2: Given four subagent children are running across any combination of inline `single`, `chain`, `parallel`, or background modes under a concurrency limit of four, when another inline task is dispatched, then it waits for an active slot to free before spawning a fifth child.
- AC3: Given a queued background task waiting behind running inline children, when any inline child settles, then the queued background task is promoted in first-in-first-out order.
- AC4: Given two concurrent parallel subagent tool calls in the same session, when both execute simultaneously, then the total number of concurrently running child processes across both calls never exceeds the session concurrency limit.
- AC5: Given an active session, when the maximum concurrent subagent setting is changed mid-session, then subsequent inline and background admissions honour the updated limit.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-C02`, `REQ-C03`)

### R-SUBAG-007: Atomic repository locking and branch retention for worktree mutations

**Priority:** MUST
**Statement:** The system must execute composite worktree mutations within a single repository lock critical section while surfacing lock errors without false merge status writes and preserving branches when requested.
**Rationale:** Cross-references `REQ-I04` (`REQ-I04.1`–`REQ-I04.5`, P1 DEFECT in `specs/subagent/requirements.md` and `specs/subagent/features/isolation/spec.md` §2.6). `packages/coding-agent/src/core/subagent/experiment-tools.ts:297-302` catches `removeWorktree` failures in a bare `catch {}` and still marks the experiment `"merged"` (`V40`); `:613` and `:622` acquire the repo lock twice; `packages/coding-agent/src/core/subagent/worktree.ts:216-219` unconditionally deletes `exp/<slug>` before `experiment-tools.ts:623` checks `keep_branch` (`V41`); and `packages/coding-agent/src/core/subagent/worktree-lock.ts:112-115` throws `WorktreeLockError` with `lockPath: ""` (`V42`).
**Acceptance criteria:**
- AC1: Given an experiment discard operation, when the worktree is removed, pruned, and its branch is conditionally deleted, then all three steps execute inside a single repository lock acquisition.
- AC2: Given worktree removal fails during an experiment merge operation due to lock contention or removal error, when the error is raised, then the experiment registry row is not marked `merged` and the typed error is surfaced.
- AC3: Given repository root resolution fails before a worktree lock path can be constructed, when the lock error is raised, then the error carries reason `unresolved` with a null lock path and the attempted repository root path rather than an empty string.
- AC4: Given an experiment discard operation invoked with branch retention enabled, when the worktree directory is removed, then the experiment branch remains present in the repository.
- AC5: Given a worktree lock acquisition that already broke one stale lock and times out waiting on a second stale lock, when the lock error is raised, then the error message states that the stale-lock break budget was exhausted.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-I04`)

### R-SUBAG-008: Per-dispatch worktree isolation without silent downgrade

**Priority:** MUST
**Statement:** The system must expose a per-dispatch worktree isolation parameter on standard subagent calls that runs the child in a dedicated worktree, releases the worktree on settlement, and fails loudly if worktree creation fails.
**Rationale:** Cross-references `REQ-I01` (`REQ-I01.1`–`REQ-I01.5`, P1 GAP in `specs/subagent/requirements.md` and `specs/subagent/features/isolation/spec.md` §2). Currently `createWorktree` is only reachable via `packages/coding-agent/src/core/subagent/experiment-tools.ts:347` behind `subagent.enableExperiments` (`packages/coding-agent/src/core/defaults.ts:29`, `V08`, `V09`), leaving standard subagent dispatches with no worktree containment option.
**Acceptance criteria:**
- AC1: Given a subagent dispatch with `isolation` set to `worktree`, when the child process is spawned, then its working directory is set to the newly created worktree path and the base working tree remains unmodified by the child.
- AC2: Given a subagent dispatch with `isolation` set to `worktree`, when worktree creation fails, then the dispatch fails with a spawn-refused error naming the creation failure and zero child processes are spawned in the base working tree.
- AC3: Given an isolated subagent run that completes, fails, is cancelled, or is reaped as an orphan, when settlement or reconciliation finishes, then the worktree transitions to a released terminal state and the model-facing output records the worktree path used.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-I01`)

### R-SUBAG-009: Tool concurrency safety metadata and parallel admission gating

**Priority:** MUST
**Statement:** The system must declare concurrency safety metadata on every tool definition and serialise parallel subagent tasks that include any mutating tool unless each task runs in an isolated worktree.
**Rationale:** Cross-references `REQ-I02` (P1 GAP), `REQ-C01` (P2 GAP), and `REQ-I03` (P2 GAP) in `specs/subagent/requirements.md`, `specs/subagent/features/isolation/spec.md` §4–§5, and `specs/subagent/features/concurrency/spec.md` §2.3. `packages/agent/src/harness/tools/file-mutation-queue.ts:4` (`V10`) is an in-process `Map` that cannot coordinate file writes across child `Bun.spawn` processes. Marking `read`, `grep`, `find`, and `ls` as `concurrentSafe: true` and `bash`, `powershell`, `edit`, `write`, and `subagent` as `concurrentSafe: false` (`V28`) allows `parallel` mode to serialise unisolated mutating tasks. Parallel tasks that specify `isolation: "worktree"` run concurrently even when their tool set includes mutating tools, because each child mutates a disjoint worktree directory (`specs/subagent/features/isolation/spec.md` §2.4 and §5 make worktree isolation the containment mechanism for concurrent mutating children).
**Acceptance criteria:**
- AC1: Given every built-in tool definition, when inspected at registration time, then read-only inspection tools declare `concurrentSafe` as true and mutating or delegation tools declare `concurrentSafe` as false.
- AC2: Given a parallel subagent dispatch without worktree isolation whose tasks include any tool with `concurrentSafe` set to false, when the batch is admitted, then the mutating tasks execute sequentially rather than concurrently.
- AC3: Given a parallel subagent dispatch whose tasks use only tools with `concurrentSafe` set to true, or whose tasks run with `isolation` set to `worktree`, when the batch is admitted, then the tasks execute concurrently up to the shared concurrency limit.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-I02`, `REQ-C01`, `REQ-I03`)

### R-SUBAG-010: Detached background child admission check

**Priority:** MUST
**Statement:** The system must refuse a detached background subagent dispatch that includes unrestricted shell execution unless the caller sets an explicit detached-shell admission flag or narrows the child tool allowlist to non-shell tools.
**Rationale:** Cross-references `REQ-P02` (`REQ-P02.1`–`REQ-P02.4`, P1 GAP in `specs/subagent/requirements.md` and `specs/subagent/features/permissions/spec.md` §3). Detached children (`background: true`) run unattended; requiring `allowDetachedShell: true` or a narrowed non-shell `tools` list at dispatch (`packages/coding-agent/src/core/subagent/subagent-tool.ts:238`) prevents silent unattended shell execution without building a full interactive permission pipeline (`REQ-P01`).
**Acceptance criteria:**
- AC1: Given a subagent call with `background` set to true, the default tool set, and `allowDetachedShell` omitted or false, when the call is dispatched, then the system refuses the call with an error naming the admission requirement and its remedy.
- AC2: Given a subagent call with `background` set to true and either `allowDetachedShell` set to true or `tools` narrowed to exclude shell execution tools, when the call is dispatched, then the call passes admission.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-P02`, `REQ-P01`)

### R-SUBAG-011: Per-child turn cap enforcement

**Priority:** MUST
**Statement:** The system must enforce a configurable per-child maximum turn count that terminates the child process upon reaching the limit and returns the partial output marked with the turn-cap termination notice while preserving session resumability.
**Rationale:** Cross-references `REQ-D03` (`REQ-D03.1`–`REQ-D03.4`, P2 GAP in `specs/subagent/requirements.md` and `specs/subagent/features/delegation/spec.md` §2). `toolTimeoutMs` (`packages/coding-agent/src/core/defaults.ts:34`, `V24`) bounds only individual tool calls, whereas turns are already counted in the stream handler at `packages/coding-agent/src/core/subagent/subagent-tool.ts:513` (`liveUsage.turns += 1`, `V23`). Because child `stdin` is `"ignore"` (`bun-process-runner.ts:539`, `V25`), graceful wrap-up injection is impossible (`specs/subagent/rejected.md` §5), so tree-kill plus a partial-output marker and `resume` support is required. Verification task: during implementation, verify `print-mode.ts` / `agent-session.ts` auto-compaction behaviour for `-p` runs and document whether child context compacts before the 30-turn cap (Q01 in `specs/subagent/traceability.md`) alongside `subagent.maxTurns: 30`; the documentation satisfies REQ-C04's budgets registration either way and the cap semantics are unchanged.
**Acceptance criteria:**
- AC1: Given `subagent.maxTurns` is configured (defaulting to 30), when a running child reaches that turn count in the parent stream handler, then the parent terminates the child process tree and returns the accumulated partial output with an explicit turn-cap stop notice.
- AC2: Given a child run that was terminated at the turn cap with a persisted session file, when the parent invokes `action: "resume"` on that run, then the child session resumes from its saved transcript.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-D03`)

### R-SUBAG-012: Saved specialist description and discovery in tool description

**Priority:** MUST
**Statement:** The system must require a non-empty one-line description when saving a specialist specification and render a capped list of saved specialists with their descriptions into the subagent tool description.
**Rationale:** Cross-references `REQ-D04` (`REQ-D04.1`–`REQ-D04.3`, P2 GAP in `specs/subagent/requirements.md` and `specs/subagent/features/delegation/spec.md` §3). `SavedSpecFile` (`packages/coding-agent/src/core/subagent/saved-specs.ts:38-44`, `V14`) currently has no `description` field, so saved specs in `<agentDir>/subagent-specs/` cannot be advertised to the model. The rendered saved-spec list in the tool description is capped at 20 entries, sorted deterministically by name, with an explicit `...and N more (use action="list-specs")` disclosure when truncated, bounding system-prompt token growth while satisfying `REQ-D04.3` (the exact number remains a tunable constant registered in `budgets.md` per REQ-C04).
**Acceptance criteria:**
- AC1: Given a `save-spec` call with a missing or empty `description`, when invoked, then the save is refused with an error naming the missing `description` field.
- AC2: Given one or more saved specialist specifications on disk, when the subagent tool description is constructed, then up to 20 saved specialists sorted deterministically by name are rendered with their descriptions and any overflow count is disclosed via `...and N more (use action="list-specs")`.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-D04`)

### R-SUBAG-013: Delegation guidance and final-summary contract in tool description

**Priority:** MUST
**Statement:** The system must document in the subagent tool description when not to delegate, that the child cannot see the parent conversation, and that the parent receives only the child's final summary.
**Rationale:** Cross-references `REQ-D05` (`REQ-D05.1`–`REQ-D05.3`) and `REQ-CXT01` (P2 GAPs in `specs/subagent/requirements.md`, `specs/subagent/features/delegation/spec.md` §4, and `specs/subagent/features/context/spec.md` §4). Updating `packages/coding-agent/src/core/subagent/subagent-tool.ts:1212-1218` prevents unnecessary single-file delegations and informs the parent model that intermediate child tool calls are omitted from `finalOutput`. The `REQ-D05` prompt change is validated by a deterministic unit test asserting the required guidance clauses in `subagent-tool.ts` plus a smoke eval task set under `packages/evals`; automated LLM A/B gating is waived for this batch because no delegation-quality eval harness exists (`specs/subagent/features/delegation/spec.md` §4.3, `specs/batch/batch-context.md` §3.3).
**Acceptance criteria:**
- AC1: Given the rendered subagent tool description, when inspected, then it explicitly instructs the model not to delegate single-file edits, known-location lookups, or tasks requiring parent conversation history.
- AC2: Given the rendered subagent tool description, when inspected, then it explicitly states that the child starts with a fresh context and that only the child's final summary text is returned to the parent model.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-D05`, `REQ-CXT01`)

### R-SUBAG-014: Parent status injection disposition

**Priority:** MUST
**Statement:** The system must eliminate the unwired status-injection export by either wiring once-per-turn read-only status injection into the parent prompt or deleting the unused status-injection module and exports.
**Rationale:** Cross-references `REQ-O01` (`REQ-O01.1`–`REQ-O01.3`, P2 GAP in `specs/subagent/requirements.md` and `specs/subagent/features/observability/spec.md` §2). `buildStatusInjection` (`packages/coding-agent/src/core/subagent/status-injector.ts:43`, exported at `core/subagent/index.ts:94` and `core/index.ts:134`, `V13`) has zero call sites in `src/core/`. Conditional decision: wire Option A — `buildStatusInjection` into `agent-session.ts` once per parent turn producing a read-only status block — if `SUBAGENT_USAGE` in `system-prompt.ts` has no conflicting "do not poll" instruction (Q04); otherwise execute Option B and delete `status-injector.ts` and its re-exports per `REQ-O01.3`.
**Acceptance criteria:**
- AC1: Given the coding-agent core exports and subagent subsystem, when inspected after implementation, then either `buildStatusInjection` is invoked at most once per parent turn producing a read-only status block, or `buildStatusInjection` and its source module are completely removed from the codebase and public exports.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-O01`)

### R-SUBAG-015: Live inspection of inline subagent runs

**Priority:** MUST
**Statement:** The system must record per-task event logs for inline subagent runs and display active inline runs alongside background runs in the interactive subagent inspection views using the structured display renderer.
**Rationale:** Cross-references `REQ-O02` (`REQ-O02.1`–`REQ-O02.3`, P2 GAP in `specs/subagent/requirements.md` and `specs/subagent/features/observability/spec.md` §3). The `/subagents` overlay in `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3214,4475-4494` currently reads only `getBackgroundRegistry().snapshot().tasks` (`V18`) and formats raw JSONL via `formatLogLine` (`packages/coding-agent/src/core/subagent/experiments-dashboard.ts:330-340`), leaving default inline runs invisible while running.
**Acceptance criteria:**
- AC1: Given a running inline subagent task, when the child emits stream events, then the runner writes the events to a per-task log file using the same `<taskId>/log.jsonl` layout as background tasks.
- AC2: Given one or more running inline subagent tasks, when the operator opens the `/subagents` dashboard, then the active inline tasks from `runner.listRunning()` appear as live selectable rows.
- AC3: Given a selected inline or background run in the log-tail overlay, when the log is rendered, then entries are formatted through the structured display-item and tool-call renderer rather than raw log lines.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-O02`)

### R-SUBAG-016: Session lease time-based expiry

**Priority:** MUST
**Statement:** The system must allow breaking an existing session lease whose holder process is dead once the lease age exceeds a bounded expiry duration even when process-start identity cannot be verified.
**Rationale:** Cross-references `REQ-L01` (P2 GAP in `specs/subagent/requirements.md` and `specs/subagent/features/lifecycle/spec.md` §6). On Windows, `packages/coding-agent/src/core/subagent/session-lease.ts:36-46` (`V20`, `V21`) cannot prove process-start identity, so a lease left in `running` or `spawning` after a crash can never be broken, permanently wedging `steer`, `swap-model`, and `resume`. Implementing Option A (`specs/subagent/features/lifecycle/spec.md` §6.2) preserves all three control-plane actions. The session lease time-based expiry threshold is 30 minutes (`1_800_000` ms, six times the default 5-minute `toolTimeoutMs`) applied when the holder pid is dead and process-start identity is unavailable: long enough to avoid false takeover of a slow child while bounding recovery time after an uncatchable crash on Windows (registered in `budgets.md` per REQ-C04).
**Acceptance criteria:**
- AC1: Given a session lease on a platform without process-start identity whose recorded holder process is dead and whose timestamp age exceeds the 30-minute (`1_800_000` ms) lease expiry threshold, when another session attempts to acquire the lease, then the stale lease is broken and acquisition succeeds.
- AC2: Given a session lease whose recorded holder process is dead but whose age is within the 30-minute (`1_800_000` ms) lease expiry threshold and whose writer process cannot be proven dead, when another session attempts to acquire the lease, then acquisition raises a session lease conflict error.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-L01`)

### R-SUBAG-017: Concurrency documentation and budget specification alignment

**Priority:** MUST
**Statement:** The system documentation must state the exact per-process shared concurrency semantics in the settings and subagent guides and record every numeric bound in the subagent budgets specification.
**Rationale:** Cross-references `REQ-C04` (P2 GAP in `specs/subagent/requirements.md` and `specs/subagent/features/concurrency/spec.md` §2.6.1–§2.6.2). `packages/coding-agent/docs/settings.md:255` and `packages/coding-agent/docs/subagents.md:62` currently misstate how `subagent.maxConcurrent` applies across modes (`specs/batch/batch-context.md` §3.3). Additionally, `specs/subagent/components/budgets.md` must register `subagent.maxTurns` (`REQ-D03`), the saved-spec description cap (`REQ-D04`), and the session-lease expiry threshold (`REQ-L01`).
**Acceptance criteria:**
- AC1: Given `packages/coding-agent/docs/settings.md` and `packages/coding-agent/docs/subagents.md`, when inspected, then the `subagent.maxConcurrent` descriptions match the exact normative text in `specs/subagent/features/concurrency/spec.md` §2.6.1 and §2.6.2.
- AC2: Given `specs/subagent/components/budgets.md`, when inspected after implementation, then every numeric setting and hardcoded constant added by this requirement set is listed with its default value, scope, and enforcement location.
**Source:** Decision D5 (`specs/batch/batch-context.md` §3.3), `REQ-SUBAG-REGISTER` (`REQ-C04`)

### R-SUBAG-018: Complete test verification of actionable register items

**Priority:** MUST
**Statement:** The system test suite must include passing automated regression tests covering every closed defect and gap in the subagent requirements register while leaving candidate items unscheduled.
**Rationale:** `specs/batch/batch-context.md` §3.3 confirms that while 33 `test/subagent-*.ts` files exist, zero tests currently cover the open register rows. Decision D5 mandates closing all P1 defects (`REQ-L02`, `REQ-C02`, `REQ-C03`, `REQ-I04`), P1 gaps (`REQ-I01`, `REQ-I02`, `REQ-P02`), and P2 rows (`REQ-I03`, `REQ-D03`, `REQ-D04`, `REQ-D05`, `REQ-CXT01`, `REQ-O01`, `REQ-O02`, `REQ-O03`, `REQ-C04`, `REQ-L01`, `REQ-C01`) with tests, and excluding `REQ-IP01` (P3 CANDIDATE).
**Acceptance criteria:**
- AC1: Given each actionable requirement in `specs/subagent/requirements.md` (excluding `REQ-IP01`), when the coding-agent subagent test suite runs, then at least one dedicated test case verifies its acceptance criteria and passes.
- AC2: Given `specs/subagent/requirements.md` after implementation, when inspected, then all P1 and P2 rows are marked `IMPLEMENTED` (or `RECORD`/`POLICY` where applicable) and `REQ-IP01` remains `CANDIDATE`.
**Source:** Decision D5 (`specs/batch/batch-context.md` §1, §3.3), `REQ-SUBAG-REGISTER`

## Traceability

- **Realises:** `REQ-SUBAG` (manifest entry), cross-referencing `REQ-SUBAG-REGISTER` (`specs/subagent/requirements.md`: `REQ-L02`, `REQ-C02`, `REQ-C03`, `REQ-I04`, `REQ-I01`, `REQ-I02`, `REQ-I03`, `REQ-P02`, `REQ-D03`, `REQ-D04`, `REQ-D05`, `REQ-CXT01`, `REQ-O01`, `REQ-O02`, `REQ-O03`, `REQ-C04`, `REQ-L01`, `REQ-C01`; `REQ-IP01` excluded per D5).
- **Depends on ADRs:** `ADR-0004` (`specs/adr/0004-native-subagent-self-sufficiency.md`).
- **Referenced specs:** `specs/subagent/subagent.md`, `specs/subagent/components/budgets.md`, `specs/subagent/features/durability/spec.md`, `specs/subagent/features/concurrency/spec.md`, `specs/subagent/features/isolation/spec.md`, `specs/subagent/features/permissions/spec.md`, `specs/subagent/features/delegation/spec.md`, `specs/subagent/features/observability/spec.md`, `specs/subagent/features/lifecycle/spec.md`, `specs/subagent/features/context/spec.md`, `specs/impl/subagents-phase.md`.
