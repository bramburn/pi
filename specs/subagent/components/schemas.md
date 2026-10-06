# Shared Schemas

Referenced by every feature spec. Source: `packages/coding-agent/src/core/subagent/types.ts`.

---

## SubagentSpec

The resolved, validated form of a tool call. Built by `specFromInput` in
`subagent-tool.ts`. `types.ts:66-84`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `description` | string | — | Required. |
| `instructions` | string | — | Required. Written to a 0600 temp file and passed via `--append-system-prompt` (`bun-process-runner.ts:114-151`). |
| `role` | string | — | Free text. **No roster resolves it.** |
| `tools` | string[] \| undefined | full default set | `undefined` means the child inherits `core/sdk.ts:272-274`. |
| `cwd` | string | parent cwd | `subagent-tool.ts:1352-1353`. |
| `model` | string \| undefined | parent model | Setting it drops the parent's thinking level (`bun-process-runner.ts:94-100`). |
| `background` | boolean | false | See [`../features/lifecycle/spec.md`](../features/lifecycle/spec.md). |
| `sessionFile` | string \| undefined | derived | `types.ts:81-82`. |
| `pid` | number \| undefined | — | Persisted once spawned. |

### Absent fields

> **GAP (REQ-I01).** There is no `isolation` field. No `maxTurns`. No `maxDepth`. Verified:
> `isolation` matches nowhere in `subagent-tool.ts:92-210` or `types.ts:66-84`.

---

## SubagentEvent

Streaming union emitted by the child as its JSONL is parsed.
`bun-process-runner.ts:575-604` (union), `types.ts:192-199`.

| Variant | Payload | Model-facing? |
|---|---|---|
| `message_start` | message id, role | no — display only |
| `message_end` | message id, usage | yes — accumulates into `aggregateUsage` |
| `tool_result_end` | tool name, truncated result | yes — feeds the live preview |
| `checkpoint_pending` | checkpoint id | no |

Only `message_end` contributes to reported token usage (`bun-process-runner.ts:417-421`).

---

## BackgroundTask

A durable row in the on-disk registry.
`background.ts:5-16`, `activeLogBytes` at `:52-67`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | `bg_`-prefixed, distinct from inline `runId` UUIDs (`subagent-tool.ts:681-684`). |
| `pid` | number \| undefined | **Declared, never assigned.** The runner emits `spawned` with a pid (`bun-process-runner.ts:549`) and it is discarded — see [traceability V07](../traceability.md). REQ-X01, REQ-X02 and REQ-L02 all depend on plumbing it. |
| `ownerPid` | number | The parent. Used for orphan detection. |
| `status` | `BackgroundStatus` | See [`states.md`](states.md). |
| `sessionFile` | string \| null | Enables `resume` after crash (`subagent-tool.ts:374-404`). |
| `logPath` | string | Per-task `log.jsonl`. |
| `createdAt` / `updatedAt` | epoch ms | Prune keys (`background.ts:542-548`). |
| `errorMessage` | string \| null | On crash, truncated to 2048 chars (`background.ts:553-559`). |

**Persistence.** `registry.json` + `~/.pi/agent/subagent-bg/log.jsonl`, written under an
exclusive-create lock with stale-holder breaking (`background.ts`). This is a deliberate
contrast with OpenCode, whose `BackgroundJob` registry is an in-memory `Map` and is
documented by its own authors as non-durable.

---

## RunRecord

Inline (foreground) run state. Lives only in the runner's in-memory map
(`bun-process-runner.ts:287-345`). Carries a bare UUID `runId`, not a `bg_` id.

> **GAP (REQ-O02).** Inline runs write no per-task log, so they are not inspectable while
> running. The `/subagents` overlay reads only `getBackgroundRegistry().snapshot().tasks`
> (`interactive-mode.ts:4484-4490`) and is therefore background-only.

---

## WorktreeRecord

`worktree.ts:81-98`. Reachable only via `experiment-tools.ts:347` behind
`subagent.enableExperiments` (default `false`, `core/defaults.ts:29`).

| Field | Notes |
|---|---|
| `slug` | Directory name under `<repo>/<worktreeBase>/<slug>` (`worktree.ts:18-21`). |
| `branch` | `exp/<slug>`. |
| `path` | Absolute path, passed as the child's `cwd`. |
| `state` | `active \| merged \| pruned \| merged-dirty` (`worktree.ts:91-96`). |
| `mergedWithConflicts` | Set when the merge needed `--strategy=ours` or hit an in-progress operation (`worktree.ts:98-106`). |

---

## SessionLease

Guards exactly one thing: a second `pi` process opening a child's session JSONL for append.
Not a general lock. `session-lease.ts`.

States: `none | spawning | running` (`session-lease.ts:40-46`). Keyed by a SHA-256 of the
session file's directory (`:50-52`).

> **Note.** The lease exists because `steer`, `swap-model` and `resume` all open the child's own
> session file from a different process. Interrupting a run and re-dispatching against the same
> JSONL is what makes it necessary.

**Defensible conservatism.** Breaking a lease requires *proof of death*. On Windows,
process-start identity is unprovable, so the lease prefers a false conflict over a false
takeover (`session-lease.ts:36-40`).