# Delegation

How a subagent is *chosen*, *bounded*, and *chosen well*.

Source: `subagent-tool.ts`, `bun-process-runner.ts:83-106`, `saved-specs.ts`, `core/skills.ts`.

---

## 1. Recursion depth — REQ-D01 (P0, VERIFIED DEFECT)

### 1.1 The defect

Three facts, each verified by direct read:

1. **No depth guard exists.** No `depth`, `maxDepth`, or nesting check appears anywhere in the
   subagent subsystem.
2. **`totalSpawnCount` is process-local.** `subagent-tool.ts:674`:
   ```ts
   // Session-wide spawn counter: one definition owns one counter, so a single
   // tool registration tracks all spawns in this process.
   let totalSpawnCount = 0;
   ```
   Because every child is a separate `pi` process, each child starts its own counter at zero.
   `maxTotalSpawns: 64` bounds one process, not a tree.
3. **A child inherits `subagent`.** The default tool set is
   `["read","bash","edit","write","subagent"]` (`core/sdk.ts:272-274`), and `--tools` is only
   passed when explicitly set (`bun-process-runner.ts:101-103`).

### 1.2 Blast radius

| Depth | Processes (at default 64) | Note |
|---|---|---|
| 1 | 64 | Already a lot of concurrent token spend |
| 2 | 4,096 | Each grandchild independent of every budget |
| 3 | 262,144 | — |

Every grandchild holds `bash` + `edit` + `write` against **the same working tree**:
`spec.cwd ?? cwd` (`subagent-tool.ts:1352-1353`). There is no cross-process write
serialisation — `packages/agent/src/harness/tools/file-mutation-queue.ts` is a module-level
`Map`, useful within one process and irrelevant across them.

Cost is invisible because `usage` is reported per-child (`types.ts:173`) and grandchildren
never surface to the parent's context.

### 1.3 Requirements

| ID | Requirement |
|---|---|
| **REQ-D01.1** | The parent MUST refuse dispatch when `depth + 1 > subagent.maxDepth`, beside the existing budget check at `subagent-tool.ts:1321-1335`. Default `maxDepth: 1`. |
| **REQ-D01.2** | `buildChildArgs` MUST pass the child's own depth to the child (`bun-process-runner.ts:83-106`). |
| **REQ-D01.3** | In the child, `core/sdk.ts:272-274` MUST drop `"subagent"` from `defaultActiveToolNames` when depth is exhausted. **This is the load-bearing half.** |
| **REQ-D01.4** | The refusal MUST follow the split in [`errors.md` §E2](../../components/errors.md): remove the tool inside the child, return an error at the parent. |

### 1.4 Why the child half is the load-bearing one

A parent-side check alone is advisory. The child resolves its own tool defaults from
`sdk.ts:272-274`; if that list still contains `subagent`, the grandchild's model sees a working
delegation tool. REQ-D01.3 is what actually terminates the tree.

> **This is the one borrowed mechanism that gets *cheaper* across the process boundary.**
> OpenCode computes depth by walking the parent's `parentID` chain, which requires shared
> session state. We must *ship* the depth to the child, which the subprocess boundary forces us
> to do anyway — so the guard is not more expensive here, it is differently shaped.

### 1.5 Acceptance criteria

```gherkin
Scenario: Depth limit blocks expansion
  Given subagent.maxDepth is 1
  And a child is running at depth 1
  When the child calls the subagent tool
  Then the tool MUST NOT be present in the child's tool list
  And no grandchild process MUST be spawned

Scenario: Parent receives an explanatory refusal
  Given subagent.maxDepth is 1
  When the parent attempts a delegation that would exceed the limit
  Then the tool result MUST name the depth limit
  And the tool result MUST state the work must be completed in the current session

Scenario: Budgets remain per-process but are no longer load-bearing for depth
  Given a parent spawns a child
  When the child reaches its own maxTotalSpawns
  Then the grandchild tree MUST still be bounded by maxDepth
```

---

## 2. Per-child turn cap — REQ-D03 (P2)

### 2.1 Gap

There is **no turn bound** anywhere in `packages/coding-agent` or `packages/agent`.

`toolTimeoutMs: 300000` is **per tool call** (`defaults.ts:34`, enforced
`bun-process-runner.ts:235-267`). A child running a fast
`edit -> test -> fail -> edit` cycle never trips it. Only a genuinely slow call times out.

### 2.2 Requirements

| ID | Requirement |
|---|---|
| **REQ-D03.1** | A per-child turn cap `subagent.maxTurns`, default `30`. |
| **REQ-D03.2** | Enforced parent-side in the JSONL stream handler. Turns are already counted free: `liveUsage.turns += 1` (`subagent-tool.ts:513`). |
| **REQ-D03.3** | On trip, kill the child via the existing tree-kill path (`detached: true` + `kill(-pid)`, `bun-process-runner.ts:545`) and return the partial output **plus an explicit "stopped at turn cap"**. |
| **REQ-D03.4** | The parent MUST be able to `resume` the child after a turn-cap trip. |

### 2.3 Turn cap, not token cap

We already report per-child token usage but cannot *stop* on it, because a price table is not
available at dispatch time. Turn count is free, monotonic, and already accumulated. It is also
the better signal: it measures behaviour (thrashing) rather than spend.

### 2.4 Why not a graceful wrap-up

OpenCode injects a synthetic `MAX_STEPS_PROMPT` on a child's final step, so the model wraps up
cleanly. **This does not port.** The child's stdin is `"ignore"`
(`bun-process-runner.ts:539`) and the JSONL channel is one-way outbound, so there is no way to
inject anything into a running child. Only a hard kill works.

This is a permanent capability loss of the subprocess architecture, not an oversight. Record it
so a future reader does not "fix" it by adding a half-working injection.

---

## 3. Discovery — REQ-D04 (P2)

### 3.1 Gap

`save-spec` persists to `~/.pi/agent/subagent-specs/<name>.json` (`saved-specs.ts:8`). But
`SavedSpecFile` (`saved-specs.ts:38-44`) has **no `description` field**.

Without a description there is nothing to put in a tool description, so the model cannot
learn a saved specialist exists. Reuse therefore rarely happens — the specialist is written,
never recalled.

### 3.2 Requirements

| ID | Requirement |
|---|---|
| **REQ-D04.1** | `SavedSpecFile` gains a required one-line `description`. |
| **REQ-D04.2** | Saved specs MUST be rendered into the `subagent` tool description so the model can select them. |
| **REQ-D04.3** | The rendered list MUST be capped, and the cap disclosed. |

### 3.3 Explicitly NOT a roster

A reference implementation ships a fixed built-in roster (general / explore / scout) because its
model must **select** from a finite set. We author each child inline via `role` + `instructions`,
so we have no selection problem and no need for a fixed roster.

> **Do not reintroduce the markdown agent roster** that existed in
> `examples/extensions/subagent/agents/*.md` (planner, reviewer, scout, worker) and was dropped
> when core was written. A second declaration format alongside JSON specs splits the user's
> mental model for no gain. **One format only: the JSON spec store.**

### 3.4 Acceptance criteria

```gherkin
Scenario: Saved spec is discoverable
  Given a saved spec "db-auditor" with a description
  When the subagent tool description is rendered
  Then "db-auditor" and its description MUST appear

Scenario: A spec saved without a description is rejected
  When a spec is saved with an empty description
  Then the save MUST fail with a message naming the missing field
```

---

## 4. Delegation quality — REQ-D05 (P2)

### 4.1 Gap

The tool description (`subagent-tool.ts:1212-1218`) explains *how* to call the tool well and
says nothing about *when*. The only guidance is `promptSnippet`, a single clause: "Delegate
work to a subagent with a fresh context."

Reference implementations treat the *description* as a first-class artifact — one even
generates `whenToUse` prose from example dialogue.

### 4.2 Requirements

| ID | Requirement |
|---|---|
| **REQ-D05.1** | The tool description MUST include an explicit **when-not-to-delegate** rule: single-file edits, known-location lookups, and anything needing conversation history the child cannot see. |
| **REQ-D05.2** | It MUST state the **output contract** — the parent receives only the child's final summary, not its transcript. |
| **REQ-D05.3** | It MUST state that a child cannot see this conversation. |

### 4.3 Effort and risk

Highest leverage per line in this entire spec, and also the one with the widest blast radius: it
changes delegation behaviour for every session.

> **MUST be A/B'd before shipping.** There is no delegation-quality eval harness in the repo.
> Build a fixed task set and measure before/after, or ship blind and accept the regression risk.
> See [`../isolation/spec.md §4`](../isolation/spec.md) — capability metadata
> is the cheap part of the eval problem; prompt shape is the expensive part.

---

## 5. Cross-domain

- REQ-D01 and REQ-I01 are a pair: depth bounds how many children exist, isolation bounds what
  one can do. Ship both; neither substitutes for the other.
- REQ-D03 interacts with the unresolved E10 (does a child self-compact?). Resolve E10 first.