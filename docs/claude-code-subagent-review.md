# Claude Code Architecture Review — What To Take

Companion to [`opencode-subagent-comparison.md`](./opencode-subagent-comparison.md). Read that first;
it establishes our architecture, our verified P0, and the portability rule used here
(**OpenCode is in-process, we are subprocess — judge every idea on whether it survives a process boundary**).

Source: third-party analysis at `C:\dev\cc-analysis` (repo `chauncygu/collection-claude-code-source-code`),
specifically `claude-code-source-code/README.md` — "Claude Code v2.1.88 — Source Code Analysis".

**Provenance.** This is a third-party decompile of Anthropic's closed-source CLI, not vendor
documentation. We worked from its analysis prose; nothing was copied, and no code from it
should enter our codebase. Three agents independently classified its claims and two
cross-checked them against our code. Treat the *design ideas* as fair game; treat the
*analysis's accuracy* as medium at best (see "How much to trust this source" below).

---

## Bottom line

The eye-catching parts of this architecture — agent teams, swarm mode, coordinator
auto-claim, `<tick>` autonomy — **do not ship**. Not "off by default": compiled out of the
bundle, or behind an experimental env var plus a remotely-revocable A/B flag. Building our
subagent roadmap on them would mean building against a different company's unpublished
internal bet.

The genuinely shipped, transferable idea is much smaller and much better:

> **Declare capabilities on tools, not in a scheduler.**
> Claude Code tags every tool with `isConcurrencySafe`, `isReadOnly`, `isDestructive`,
> `interruptBehavior`. The scheduler then parallelises reads and serialises edits without
> knowing what any tool does.

That one idea answers a real hole we have. Everything else is either already ours, already
gated at the source, or disproportionate to a 7.4k-line subsystem.

---

## Take these

### 1. Per-tool capability metadata (shipped — highest value)

Claude Code's tool interface carries behavioural flags on the tool definition itself
(`README:486-519`): `isConcurrencySafe`, `isReadOnly`, `isDestructive`, `interruptBehavior`.
A `StreamingToolExecutor` partitions concurrency-safe tools to run in parallel and serial
tools one at a time, deriving the schedule from declarations rather than a hardcoded list.

We have the problem this solves but solved it locally. `packages/agent/src/harness/tools/file-mutation-queue.ts`
(49 lines) is a **module-level `Map`** — it serialises writes within one process and provides
zero protection across processes. Since our children are separate `pi` processes, parallel
tasks writing the same tree have no coordination at all. That is the enabling condition for
the P0 fork-bomb in the OpenCode doc: every grandchild holds `bash`+`edit`+`write` against
one working tree.

Add `concurrentSafe: boolean` to our `ToolDef`. Parallel dispatch admits
`spec.tools`-named tools whose definition is `concurrentSafe`; anything else serialises on a
cross-process queue (the registry's lock already solves cross-process locking). This makes
"parallel mode is safe to use" a property of the tool set rather than a promise in a prompt,
and it gives `interruptBehavior` a natural home for the kill-escalation policy in
`shell.ts:153-231`.

**S/M. Tool definition sites + `subagent-tool.ts` dispatch. Ours already has the tool
registry, so this is metadata plus a gate, not a new subsystem.**

### 2. Stop gating worktree isolation behind the experiments flag

Claude Code ships `EnterWorktreeTool`/`ExitWorktreeTool`; worktrees are bound by task ID
(`README:887-889`, on disk, ungated).

We already own this primitive — `worktree.ts` (323 lines) + `worktree-lock.ts` (280 lines),
tested, with a documented `worktreeBase` setting. It is reachable from exactly **one** call
site: `experiment-tools.ts:347`, behind `enableExperiments: false` (`defaults.ts:29`), which
also gates registration in `sdk.ts:272-273`. Verified: there is **no `isolation` field**
anywhere in `subagentSchema` (`subagent-tool.ts:92-210`) or `SubagentSpec`
(`types.ts:66-84`). The model cannot request isolation on a normal call.

That framing is backwards. Worktree isolation is not an experiment; it is the **containment
story for unbounded delegation**. Expose it as a per-dispatch parameter —
`isolation: "none" | "worktree"` — creating and releasing the worktree around the child's
lifetime. It is the natural companion to the depth guard in the OpenCode doc: depth bounds
how many children exist, isolation bounds how much damage one can do.

**M. Schema + dispatch + a release-on-settle path. The hard parts are already written.**

### 3. A gate on *detached* children specifically — not a full permission system

Claude Code ships a five-stage permission pipeline (`README:553-591`):
`validateInput()` → PreToolUse hooks (which may approve, deny, **or rewrite input**) →
`alwaysAllow`/`alwaysDeny`/`alwaysAsk` rules matched by tool-name pattern → interactive
Allow Once / Allow Always / Deny → `checkPermissions()` tool-specific (e.g. path sandboxing).

**We have none of the five.** Verified: no `alwaysAllow`/`alwaysDeny`/`alwaysAsk`, no
`permissionMode`, no `PreToolUse` anywhere in `packages/coding-agent/src`. Our only related
primitive is the extension `confirm()` dialog (`core/extensions/types.ts:138`), used for
things like session import — never for tool execution. What we have instead is
**session-scoped capability restriction**: the default tool set (`sdk.ts:272-274`), the
per-child `--tools` allowlist (`bun-process-runner.ts:101-103`), and a once-per-directory
project trust gate (`core/project-trust.ts:25`) that gates project *resources*, not tool
execution.

**Do not build the full pipeline.** It is a large product decision — a UX philosophy, not a
patch — and our capability-grant model is a defensible choice, not a defect. The prior review
already rejected the lighter OpenCode version for good reason.

But there is one narrow hole worth closing, and this comparison is what exposes it: **a
detached background child runs `bash` with no gate, and the user is not watching.** Claude
Code's per-invocation rules mean a subagent asking for something outside its grant stops
and asks. Ours cannot. Before promoting a child to `background: true`, require an explicit
`allowDetachedShell: true` (or require the child's `tools` to be a narrowed set) — a
single-field admission check at `subagent-tool.ts`, reusing the existing master-switch
pattern at `subagent-tool.ts:238`.

**S. One field, one check.**

---

## Already ours — do not "adopt" these

Worth stating so nobody re-litigates them:

- **`compact_boundary`.** Claude Code appends a boundary marker and reads back with
  `getMessagesAfterCompactBoundary()` so recent messages stay at full fidelity
  (`README:650-674`). We are semantically identical: compaction appends a session entry
  carrying `firstKeptEntryId` and advances the leaf (`session-manager.ts:1147-1157`), and
  `buildActiveContext` projects "latest compaction followed by entries retained from
  `firstKeptEntryId`" (`:434-475`). We differ only in lacking the named accessor and the
  marker string.
- **A no-API-cost snip layer.** Claude Code's `snipCompact` is **compiled out**
  (`HISTORY_SNIP`; no snip module exists). We already have the concept and it is real:
  `tool-result-pruner.ts` does pure string surgery at `thresholdChars: 8192`,
  `headChars: 4096`, `tailChars: 1024`, replay-safe and non-mutating (`:3-7`, `:95-150`).
  Ours is narrower — it trims characters *inside* oversized tool results, never whole
  messages or stale markers — so "zombie message" pruning is the only genuine gap, and it
  is minor.
- **Knowledge on demand.** They inject skills via `tool_result` and load CLAUDE.md lazily per
  directory (`README:859-861`). We inject context files eagerly into the system prompt
  (`buildSystemPrompt`, `core/system-prompt.ts:51-192`) but put **skill metadata in the prompt
  and the body on demand** (`core/skills.ts:348-365`: "Use the read tool to load a skill's
  file when the task matches its description"). Same idea, no dedicated tool needed.
- **Fresh context per child, per-child sessions, resume.** We have all three plus
  cross-process session leases.

---

## Do not build against

| Idea | Why not |
|---|---|
| **Agent swarm + coordinator auto-claim** | The single most eye-catching item, and it does not ship. Coordinator is behind a **double** gate: `feature('COORDINATOR_MODE')` (compile-time DCE) **and** an env var. With DCE false the module is null and the env var is inert — it does not exist for users. Swarm needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` **or** `--agent-teams`, plus a remotely-revocable GrowthBook flag (`tengu_amber_flint`), and the flag is *"only shown in help for ant users"*. |
| **Persistent teammates + async mailboxes** | Disproportionate and in-process-only. Their `utils/swarm/` alone is **6,812 lines across 22 files — 92% of our entire 7,389-line subagent subsystem**. With `coordinator/` and the Team\*/Task\* tools the bundle is ~9.4k lines: bigger than what we'd bolt it onto. Worse, its backends are tmux panes and in-process tasks that sync against the parent's *live* permission object (`permissionSync.ts`, `leaderPermissionBridge.ts`) — precisely the permission-derivation pattern we already rejected from OpenCode. It cannot survive a process boundary. |
| **Task graph with dependency edges** | Treat as part of the teams bundle (gated with it). A shared file DAG with claim semantics is a concurrency subsystem. The one transferable primitive is the **file-locked claim** — locking is the hard part, autonomy is the easy part. ~30 lines if we ever want a board. |
| **`snipCompact` / `contextCollapse`** | **Compiled out.** `HISTORY_SNIP` and `CONTEXT_COLLAPSE` resolve false and Bun strips the branches; `contextCollapse/` is absent entirely. The analysis presents these as two of three *live* compaction strategies — it is simply wrong. We already own a better version. |
| **`<tick>` autonomy (KAIROS)** | Five-plus modules and four tools stripped. Treat as speculation. |
| **Agent nesting** | Listed as an **ant-only** capability difference. Anthropic gates recursive delegation internally; we ship it ungated and unbounded. That asymmetry is the P0. |
| **Remote spawn mode** | Requires their bridge layer, JWT work-secret exchange, capacity-wake, 5-transport MCP. We have no remote surface to reach. |

**Sequencing:** all of the above make the P0 *worse*, not better. Autonomous claim is a
fan-out amplifier layered on unbounded depth with write-capable children. A task board adds
state that outlives a crash and then argues with you. **Nothing above substitutes for a depth
guard — all of it assumes one exists.** Re-evaluate only after `maxDepth` lands *and* we can
measure delegation quality at all (we currently have no eval harness for whether the model
chooses well between modes).

---

## How much to trust this source

**Medium as an inventory of Anthropic's internal design. Low as a reference for what reaches
ordinary users.** The author is unusually candid about the 108 missing modules (~70
"Anthropic Internal, never published", ~20 DCE'd), and spot-checks of `daemon/`,
`contextCollapse/`, `skillSearch/` and `snipCompact` all confirmed the missing-module claims.
That is real verification discipline, and it is what makes the gated/shipped split usable.

But the prose **systematically presents gated features alongside shipped ones with no gate
labels**, and it contradicts itself:

- The "Complete Tool Inventory" (`README:521-549`) lists `SleepTool` and `TungstenTool` as
  built-ins while the same document's missing-modules table says both were DCE'd.
- s11 attributes idle-cycle auto-claim to `coordinator/coordinatorMode.ts`; that file is 276
  lines and contains **no** match for `idle` or `claim`. The real worker logic
  (`coordinator/workerAgent.js`) is listed as never-published — so the analysis is describing
  code it says it cannot see.
- The flag list is incomplete: at least 11 further gates appear only in the missing-modules
  table (`BRIDGE_MODE`, `FORK_SUBAGENT`, `CACHED_MICROCOMPACT`, …). A filter built from the
  flag list alone will miss them.

Consequence for us: the ~20 shipped items in this architecture are worth reading. The
"12 Progressive Harness Mechanisms" list is **not** a statement of shipping state and should
not be used as a roadmap backlog.

---

## Vendor posture (revised)

The OpenCode doc concluded "reference, not a template". This source reinforces that and adds
a sharper rule:

> **Absent from the bundle is a stronger statement than off by default.**

We have no A/B flag system — no GrowthBook equivalent anywhere in `packages/coding-agent/src`.
That means anything behind `enableExperiments: false` is **permanently** on for whoever enables
it, with no remote off switch. Two consequences:

1. Keep experiments off by default, and treat each one as semi-permanent once shipped.
2. Worktree isolation (#2 above) should **not** be an experiment — it is safety, and safety
   should not live behind a flag with no kill switch.

Claude Code's published frontier is autonomy (swarm, coordinator, voice, remote, pets).
Ours is operational correctness — bounded delegation, inspectability, cancellation. Those are
different products, and the code that wins ours is largely the code they have not built.

> **CORRECTION 2026-10-06 — one claim above was wrong.** A third implementation,
> `tintinweb/pi-subagents` (MIT, 32.6K downloads/mo), states at `docs/workflows.md:412` that it is
> *"a port of Claude Code's `Workflow` tool down to its state model"* and ships real parity for the
> language (`agent()`, `pipeline()`, `parallel()`, `phase()`, `workflow()`), executed in a
> sandboxed `worker_thread`. So **Claude Code's `Workflow` tool does ship**, and this review was
> wrong to read a decompile as implying otherwise.
>
> **The verdict that survives** is the one about the coordinator: that repo's parallel fan-out is
> `Promise.all` plus a `min(16, cpus-2)` semaphore — a bounded fan-out, not a swarm/coordinator.
> No readable implementation of the coordinator layer has been found, and a serious popular one
> chose not to build it. See [`pi-subagents-review.md`](pi-subagents-review.md) §3.

## Suggested order

1. **Depth guard** (from the OpenCode doc) — the P0.
2. **Stop signalling the child / kill orphans** (from the OpenCode doc) — two process leaks.
3. **Per-tool `concurrentSafe`** (#1) — makes parallel mode safe by construction.
4. **`isolation: "worktree"` as a spawn parameter** (#2) — contains what 1 cannot prevent.
5. **Detached-shell admission check** (#3) — S, do with the others.
6. Revisit swarm/task-board only when a depth guard exists and delegation quality is
   measurable.

## Unverified

- Whether a `pi -p` child self-compacts (carried over from the OpenCode review).
- Whether `maxParallelTasks` is enforced per-process or via the shared registry.
- Whether background children reach the `trackedDetachedChildPids` set that shutdown kills.
- Whether the parent system prompt already carries OpenCode's "do not poll" instruction —
  check before wiring `buildStatusInjection` so the two do not contradict.
- `TaskCreateTool`'s own enablement gate (only `TeamCreateTool` was checked) — does not change
  any verdict above, since the teams bundle is rejected wholesale on proportionality.