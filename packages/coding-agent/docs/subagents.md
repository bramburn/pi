# Subagents

Pi ships a built-in `subagent` tool: the model delegates work to a child pi process with a fresh context and gets back a summary. There are no agent files, discovery, scopes, or trust prompts — every subagent is defined inline in the tool call.

The child is a real `pi --mode json` subprocess spawned with `Bun.spawn`, so the tool is registered only under the Bun runtime. Set `subagent.enabled: false` to leave it out entirely. When the tool is active, the system prompt gains a short orchestration guide (`SUBAGENT_USAGE`) describing the three modes below.

## Modes

A call must use exactly one of the three shapes.

### Single

```json
{
  "role": "scout",
  "instructions": "Find where retry backoff is computed and report the file and line."
}
```

Runs one subagent and returns its final output as the tool result.

### Parallel

```json
{
  "tasks": [
    { "role": "scout", "instructions": "Map the settings module." },
    { "role": "reviewer", "instructions": "List risky diffs in src/core." }
  ]
}
```

Independent tasks dispatched together. At most `subagent.maxParallelTasks` tasks per call (default 8), with at most `subagent.maxConcurrent` running at once (default 4). The tool result carries one `[role] completed` / `[role] failed` line per task and marks the call as an error if any task failed; full per-task outputs stay in the result `details` for the UI.

### Chain

```json
{
  "chain": [
    { "role": "scout", "instructions": "Produce a file-and-line map of the parser." },
    { "role": "reviewer", "instructions": "Review this map for gaps: {previous}" }
  ]
}
```

Sequential steps. Every occurrence of `{previous}` in a step's `instructions` is replaced with the previous step's output. The chain stops at the first failing step (the error names the step number and role) and otherwise returns the last step's output.

## Spec fields

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | Short specialist label (e.g. `scout`), used in the UI and analytics |
| `instructions` | string | The complete task. The child never sees this conversation, so include all context it needs. `{previous}` is substituted in chain mode |
| `model` | string | Optional model id (`provider/model`). Omitted inherits the session's model and thinking level. An unknown id fails the call with an error naming the model and role |
| `tools` | string[] | Optional allowlist of built-in tool names (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Omitted gives the full coding set |
| `cwd` | string | Optional working directory. Omitted inherits the session's working directory |

## Background results

Pass `"background": true` with any mode to detach: the call returns task ids immediately instead of waiting. Background chain steps still run sequentially so `{previous}` keeps working. When a task settles, pi posts a `subagent-background-result` custom message with the outcome and output, queued for the next turn (`deliverAs: "nextTurn"`, `triggerTurn: true`). Background task state lives in an on-disk registry; check it after a restart before assuming a task is still running.

## Output and limits

Each subagent's output is capped at 50 KB in the tool result text (`Output truncated: ...` when hit); the `details` object keeps the full output for renderers. Child transcripts stream as JSONL to a per-run artifact, and aborting the call kills the child's whole process tree.

## Analytics

With `enableAnalytics` on, each dispatched run records one `pi_subagent_tasks` row (`agent_name` = role, `task_label` = first 200 characters of the instructions, duration, success). Nested spans record parent/child relationships when a subagent dispatches further subagents.

## Orchestration tips

- **Self-contained instructions win.** The child starts with a fresh context and never sees this conversation. Name exact files, symbols, and expected outputs in `instructions` instead of "the function we discussed".
- **Parallelize independent lookups.** Use `tasks: [...]` when tasks do not read each other's output (e.g. scouting several modules at once). Keep each task narrow enough that its 50 KB output cap is not hit.
- **Chain when each step builds on the last.** Use `chain: [...]` for generate-then-review or map-then-summarize flows; `{previous}` carries the earlier output forward.
- **Match the role to the job.** The `role` is a short specialist label — it shapes the child's system prompt fragment, so `code-reviewer` and `scout` produce different stances.

## Comparison with the npm `pi-subagents` package

The native tool covers inline, ad-hoc subagents: every call defines its own `role` and `instructions`, runs, and returns. The npm [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) package builds on the same extension API for named, persisted agents with watchdog loops and mission-style task orchestration. Use the native tool for one-shot and short-chain delegation; use the package when you need long-lived named agents or scheduled mission loops.

## Experiments surface

Gated behind `subagent.enableExperiments` (default off). When enabled, eight tools appear for running experiments in isolated git worktrees:

| Tool | Purpose |
|------|---------|
| `experiment_start` | Register a new experiment (id `exp-<timestamp>-<slug>`) |
| `experiment_run` | Run a command inside the experiment's worktree |
| `experiment_test` | Run the detected test runner (bun/vitest/jest/npm) with an optional filter |
| `experiment_diff` | Show the worktree diff against the base |
| `experiment_merge` | Merge the experiment back, guarded against dirty bases |
| `experiment_discard` | Remove the worktree and mark the experiment discarded |
| `experiment_list` | List experiments from the registry |
| `experiment_compare` | Compare two experiments (logs and diffs) |

The registry lives at `<repo>/.pi-experiments/registry.json` (format version 1). Worktrees live at `<repo>/<worktreeBase>/<slug>`, defaulting to `.worktrees/`. Per-experiment logs stay in `.pi-experiments/`.

### Research Mode

Research Mode is a suggestion, never an automatic action: when the same tool error (normalised to ignore line numbers and timestamps) repeats `subagent.researchModeTriggerCount` times in a row (default 3), the tracker notifies that a minimal repro in a fresh scratch worktree may be worth trying and appends a `RESEARCH_MODE_TRIGGERED` event to the active experiment's log. It never spawns worktrees on its own.

> **Interactive wiring:** with `subagent.enableExperiments` on, `Ctrl+E` (`app.subagent.experimentsDashboard`) toggles the dashboard below the editor (`Esc` closes it), and the footer shows an experiments pill and a background-task pill as related tools run. The research-mode watcher runs in every session with the flag on: the suggestion is a warning notification plus the `RESEARCH_MODE_TRIGGERED` log event.

## Coexistence with the example extension

`examples/extensions/subagent/` remains a reference implementation. If a user-symlinked extension registers a tool named `subagent` while the built-in one is enabled, the extension's tool takes precedence and pi logs a one-line warning suggesting removal of the symlink. Nothing is disabled automatically.
