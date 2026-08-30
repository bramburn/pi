# Subagent Extension

Delegate tasks to specialized subagents with isolated context windows, and run
hypothesis-driven parallel experiments in git worktrees.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes
- **Experimental mode**: 8 sibling tools (`experiment_start`, `experiment_run`,
  `experiment_test`, `experiment_diff`, `experiment_merge`, `experiment_discard`,
  `experiment_list`, `experiment_compare`) for hypothesis-driven worktree
  exploration, plus a registry, status pill, and Research Mode auto-trigger.

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents in untrusted projects. Trusted projects skip the additional prompt. Set `confirmProjectAgents: false` to disable confirmation.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

When `model` is omitted, the subagent inherits the dispatching session's active model and thinking level.

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Experimental mode

When the implementation approach is uncertain, turn on experimental mode to fork
worktrees per candidate, run each, measure, and pick a winner with evidence.

```
/experimental on          # injects the E.D.I.T. loop fragment into the system prompt
```

Then the agent has 8 new tools:

| Tool | When |
|---|---|
| `experiment_start` | Fork a worktree + branch for one approach. One per candidate. |
| `experiment_run` | Run a shell command inside the worktree. Output goes to `log.jsonl`. |
| `experiment_test` | Auto-detect bun / vitest / jest / npm test, run, record pass/fail. |
| `experiment_diff` | files changed / insertions / deletions / commits vs parent. |
| `experiment_merge` | cherry-pick / squash / merge the winner back to main. |
| `experiment_discard` | Remove the worktree; keep the branch + `WHY_IT_FAILED.md`. |
| `experiment_list` | Filter by status. |
| `experiment_compare` | Side-by-side benchmark + test comparison. |

The footer shows a status pill (`● N running`). `Ctrl+E` (or `/experiments`)
opens the dashboard overlay with the full registry.

### The E.D.I.T. loop

For every non-trivial implementation, the agent runs through:

**E**xplore — generate 2–4 candidate approaches. State the workload-mix
assumption (I/O-bound vs CPU-bound) up front. Write the one-sentence
falsification condition for the eventual winner.

**D**eploy — for the top 2 candidates, call `experiment_start` to fork a
worktree per approach. Write the smallest possible implementation that could
answer the question. Throwaway is fine.

**I**nvestigate — call `experiment_run` and `experiment_test` for each
worktree. Record the result. If the same tool-call error appears 3 times in
a row, Research Mode fires a `notify()` and appends a log event.

**T**ransfer — write `decisions.md` with the winner, then call
`experiment_merge` on the winner and `experiment_discard` on the losers with a
one-line reason. The branch and `WHY_IT_FAILED.md` stay on disk for
archaeology.

### Worktree substrate

Every worktree lives at `<repo>/.pi-experiments/<approach-slug>/`. One
branch per approach: `exp/<approach-slug>`. The registry at
`.pi-experiments/registry.json` is the single source of truth. Per-experiment
output streams to `.pi-experiments/<id>/log.jsonl` (append-only, one JSON
event per line, 1 MB cap per line).

### Composing subagent with experiments

The two capabilities compose at the tool-call level. After `experiment_start`,
call the existing `subagent` tool with `cwd: experiment.worktreePath` to
dispatch a specialized agent in that worktree:

```
experiment_start(hypothesis: "Bun IPC vs ALS for subagent primitive", approach_name: "bun-ipc")
subagent({ agent: "worker", task: "implement + benchmark", cwd: "<worktreePath>" })
experiment_test(experiment_id)
experiment_diff(experiment_id)
experiment_merge(experiment_id, "cherry-pick")
```

### Security model

- Worktrees don't escape the project — every worktree is at
  `<repo>/.pi-experiments/`, no remote, no containers.
- `.pi-experiments/` is gitignored. Add it to your repo's `.gitignore` to
  keep the agent's scratch space out of git.
- `registry.lock` is a file lock with 5-second retry; a second pi process
  opening the same repo gets a clear "registry locked" error and falls back
  to read-only.
- The branch is kept after merge/discard. The worktree directory is removed
  once the merge commit lands.

### Failure handling

| Failure | Behaviour |
|---|---|
| `git` not on PATH | `experiment_start` fails with "experimental mode requires git" |
| Worktree path already exists | `experiment_start` returns the offending path; run `experiment_discard` first |
| `git worktree remove` fails (Windows MAX_PATH, handle lock) | Error message includes the `Move-Item` command to move the build dir aside |
| Lock contention (another pi process) | After 5s, surface a `notify()` and fall back to read-only |
| `experiment_run` hangs >10 min | `SIGTERM` at 10 min, `SIGKILL` at 10:05 min; registry marks `cancelled` |
| Same tool fails 3x | Research Mode `notify()` + log event |
| Pi crashes mid-experiment | On `session_start`, `running` rows whose pid is gone are flipped to `failed` |

### Worked example

```
/experimental on
```

User: *"We're not sure how to structure the subagent primitive — try Bun IPC vs in-process AsyncLocalStorage."*

Agent (E — Explore):

| Approach | Conf | Risk | Hypothesis | Disconfirming evidence |
|---|---|---|---|---|
| `bun-ipc-worker` | 7 | M | `Bun.spawn({ ipc: true })` gives sub-ms IPC, clean process isolation | spawn p95 > 50 ms; structuredClone cost > 1 ms at 100 KB |
| `als-teammate` | 5 | L | In-process teammates via `AsyncLocalStorage` avoid IPC entirely | Context leak between teammates; memory > 200 MB at 4 teammates |

Workload assumption: assumed I/O-bound. Falsification condition: if a single
concrete teammate workload has p95 latency dominated by CPU (not I/O) and the
TUI visibly stutters, move to Bun workers.

Agent (D — Deploy):
```
experiment_start(hypothesis="...", approach_name="bun-ipc")
experiment_start(hypothesis="...", approach_name="als-teammate")
```

Agent (I — Investigate):
```
experiment_run(bun-ipc, "bun bench/spawn.ts 1000")
experiment_run(als-teammate, "bun bench/als-ctx.ts 1000")
experiment_test(bun-ipc)
experiment_test(als-teammate)
```

Agent (T — Transfer):
```
experiment_compare(bun-ipc, als-teammate)
experiment_merge(bun-ipc, "cherry-pick")
experiment_discard(als-teammate, keep_branch=true, reason="...")
```

Result: a clean audit trail (runlog rows, `decisions.md`, `WHY_IT_FAILED.md`
on the discarded branch), one `merged` registry entry, and a `● 0 running`
status pill.

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
