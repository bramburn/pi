# Subagents

Pi ships a built-in `subagent` tool: the model delegates work to a child pi process with a fresh context and gets back a summary. A call defines the subagent inline — or names a reusable [agent definition file](#agent-definition-files) with `agent`. There is no discovery daemon and no trust prompt: definitions are ordinary files in the repo or in your agent dir, read at dispatch time.

The tool is active out of the box (`subagent.enabled` defaults to `true`): a fresh pi session's default tool set is `read`, `bash`, `edit`, `write`, `subagent`. Remove it with `subagent.enabled: false`, `--exclude-tools subagent`, or an explicit `defaultTools` / `tools` list that omits it. The `experiment_*` tools join the default set when `subagent.enableExperiments` is on.

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

Runs one subagent and returns its final output as the tool result. A failed run throws instead of resolving: the call surfaces as a tool error `Subagent <role> failed: <output>` (the embedded output is capped like any model-facing text).

### Parallel

```json
{
  "tasks": [
    { "role": "scout", "instructions": "Map the settings module." },
    { "role": "reviewer", "instructions": "List risky diffs in src/core." }
  ]
}
```

Independent tasks dispatched together. At most `subagent.maxParallelTasks` tasks per call (default 8), with at most `subagent.maxConcurrent` running at once (default 4). The tool result is a resolved outcome even when some tasks fail: a `Parallel: <succeeded>/<total> succeeded` summary followed by one `### [role] completed` or `### [role] failed (reason)` section per task with that task's capped output. Full per-task outputs stay in the result `details` for the UI. Only dispatch failures (invalid parameters, an unknown `model` id, or too many tasks) throw.

### Chain

```json
{
  "chain": [
    { "role": "scout", "instructions": "Produce a file-and-line map of the parser." },
    { "role": "reviewer", "instructions": "Review this map for gaps: {previous}" }
  ]
}
```

Sequential steps. Every occurrence of `{previous}` in a step's `instructions` is replaced with the previous step's output. A failing step throws instead of resolving: the chain stops and the call surfaces as a tool error `Chain stopped at step <n> (<role>): <output>`. Otherwise the call returns the last step's output.

### DAG

```json
{
 "dag": [
 { "role": "map", "instructions": "Produce a file-and-line map of the parser." },
 { "role": "style", "instructions": "Review src/core/parser for style drift.", "dependsOn": [] },
 { "role": "reviewer", "instructions": "Merge both findings: {{nodes.map.result}} / {{nodes.style.result}}", "dependsOn": ["map", "style"] }
 ]
}
```

Declarative dependencies. Each node names the roles it `dependsOn`; a node starts the moment its upstream nodes have settled successfully, so independent branches overlap and only the edges serialize — at most `subagent.maxConcurrent` children at once (default 4), and every node counts against `subagent.maxTotalSpawns` (default 64; a 12-node graph asks for 12 slots up front). `{{nodes.<role>.result}}` in a node's `instructions` is replaced with that dependency's output, capped at 8000 bytes per reference (`[... N bytes omitted from this node reference; the node's full output stays in the run's tool details]` says how much was dropped). Like parallel and unlike chain, the call resolves even when nodes fail: the text opens with `DAG: <completed>/<total> completed, <failed> failed, <skipped> skipped` and then carries one `### [<role>] <status>` section per node with that node's capped output. A failed node skips its transitive dependents (`Skipped: dependency "<role>" failed`) while unrelated branches keep running; there is no partial re-run — fix the cause and dispatch the graph again. Bad graphs are refused before anything spawns: an empty `dag`, a node with an empty `role` or empty `instructions`, a duplicate or whitespace-padded role, an empty `dependsOn` entry, a dependency on an unknown role, a self-dependency, a cycle, a `{{nodes.X.result}}` reference to a node X does not depend on, or more than 32 nodes.

The run mirrors its progress to `<agent dir>/subagent-dag/<runId>/dag-state.json` — statuses, timestamps, output character counts, errors, and the child task ids, never the output text — so a detached graph can be inspected after a restart. Background `dag` dispatch works like the other modes: every node gets its own task id in the immediate response, and each settle posts a `subagent-background-result`.

## Agent definition files

A definition file makes a delegation reusable: it records the *configuration* of a subagent — model, tool allowlist, thinking level, standing system prompt — once, and a tool call then names it. The task itself still comes from the call, because the orchestrator knows what needs doing and the file does not.

```markdown
---
name: scout
description: Map code paths and report file:line, nothing else
model: anthropic/claude-haiku-4-5
tools: read, grep, ls
thinking: low
---

You are a read-only scout. Report file paths and line numbers only, never a
proposed fix, and say plainly where something does not exist.
```

`tools` is a built-in allowlist (built-in names only: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; the comma list and YAML sequence forms are equivalent). The same field on an inline call works the same way, so the read-only delegate pattern is one frontmatter line — `tools: read, grep, ls` plus a system prompt that states the constraint, with the body beneath those fields carrying the prompt. Omitting `tools` gives the child every built-in, which is what an open-ended worker like `reviewer` wants.

The frontmatter is parsed by the same primitive that reads skills and prompt templates, so the subset is YAML, not JSON: `name` (required), `description`, `tools` (a comma list or a YAML sequence), `model`, `thinking`, `systemPrompt`. Unknown keys are ignored rather than rejected — a definition written for a newer pi keeps working on an older one. Without `systemPrompt`, the markdown body below the frontmatter is the standing prompt. `description` is never sent to the child; it is the human- and orchestrator-facing label.

Two scopes are read, in this order, first match wins:

| Scope | Path |
|-------|------|
| project | `<cwd>/.pi/agents/*.md` |
| user | `<agentDir>/agents/*.md` (`~/.pi/agent/agents/` by default, `PI_CODING_AGENT_DIR` honoured) |

The project scope resolves against the session's working directory, so a subdirectory's definitions are not merged into a parent's; a repo that wants one set of agents keeps them at the root. Project wins on a name collision, which is what lets a repo pin the agent its team actually runs over whatever a developer has in their own dir.

Dispatch by name in the single-task slot:

```json
{
 "agent": "scout",
 "instructions": "Find every place retry backoff is computed. Report file:line for each."
}
```

`agent` replaces `role` — the definition's `name` becomes the role — and is therefore mutually exclusive with `role`, `tasks`, `chain`, and `dag`; the call is refused up front rather than reinterpreted. `model` / `tools` / `thinking` / `cwd` passed on the call override the file for this dispatch only, and the standing prompt is prepended to `instructions` with a blank line between, so the per-call task always wins the last word. An unknown name does not fall back to anything: the error lists the definitions that were found (with their scope), the saved specs, and the directories that were searched, so the model can retry with a real name instead of guessing.

A file whose *known* keys are unusable — no `name`, a `thinking` value outside the CLI's enum, unreadable, invalid frontmatter — is skipped with a line on stderr prefixed `subagent-agents:`. Silently dropping it would read as "that agent does not exist", and silently dropping the bad key would run the child in a configuration nobody wrote.

Definitions are one of two name stores. A spec saved by `action: "save-spec"` (`<agentDir>/subagent-specs/`) is a whole inline spec, task included, so dispatching one by name rejects `instructions`; definition files win over a saved spec of the same name, because a hand-authored file is the deliberate artifact.

## Spec fields

| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Name of an [agent definition file](#agent-definition-files) or a saved spec to dispatch instead of defining one inline. Mutually exclusive with `role` / `tasks` / `chain` / `dag` |
| `role` | string | Short specialist label (e.g. `scout`), used in the UI and analytics |
| `instructions` | string | The complete task. The child never sees this conversation, so include all context it needs. `{previous}` is substituted in chain mode, `{{nodes.<role>.result}}` in dag mode |
| `model` | string | Optional model id (`provider/model`). Omitted inherits the session's model and thinking level. An unknown id fails the call with an error naming the model and role |
| `thinking` | string | Optional thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), applied whether or not the model is inherited. Omitted takes an `agent` definition's level, else this session's level (which then rides only when the model is inherited too) |
| `tools` | string[] | Optional allowlist of built-in tool names (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Omitted gives the full coding set |
| `cwd` | string | Optional working directory. Omitted inherits the session's working directory |
| `outputSchema` | object | Optional JSON Schema. The child is told to answer with JSON matching it, and the reply is parsed and validated by the parent (see [Output contracts](#output-contracts)) |
| `gate` | object | Optional verify command (`{ command, cwd?, timeoutMs? }`) the host runs after the child finishes; a failing gate fails the result |
| `dependsOn` | string[] | dag nodes only: the roles whose success gates this node. Omitted or `[]` starts the node immediately |

## Output contracts

A delegation can carry two independent guarantees on top of the child's prose. Both are enforced by the parent after the child settles, which is what makes them worth declaring: neither depends on the child being cooperative.

**`outputSchema`** — a JSON Schema (`type`, `properties`, `required`, `items`, `enum`, `additionalProperties` as `true`/`false`, `oneOf`, `anyOf`, `minimum`/`maximum`, `minLength`/`maxLength`, `pattern`; `type` may be a list). Any other keyword — `$ref`, `$defs`, `format`, `dependentRequired` — is rejected up front, before the child is spawned, rather than silently ignored after it has spent a run. A compact version of the schema is appended to the child's system prompt, so the instruction is present but a bloated schema cannot eat the context (it is clipped at 8 KB in the prompt, never in validation). After the child answers, the parent reads a JSON value out of the reply — the whole message first, then a fenced code block, then the widest brace/bracket span — and validates it. On success the parsed value is attached to the result as `structuredOutput`, so a downstream chain step or the parent session gets data rather than a paragraph to re-parse. On failure the run is reported as failed, the error names the JSON path (`$.files[1]: expected string, got number`), and the gate never runs — a build that cannot state its verdict is not worth verifying. An output that is not parseable JSON at all fails with the parse error and a fragment of the reply.

**`gate`** — `{ command, cwd?, timeoutMs? }`. `command` is one shell command line, run by the host through the platform shell (`/bin/sh -c` on POSIX, `cmd /c` on Windows) in `cwd`, which defaults to the directory the child ran in — its `cwd`, so a gate on a `cwd: "packages/ai"` delegation runs there rather than in the session root. A relative `gate.cwd` resolves against that same directory. It defaults to a 5 minute timeout and captures up to 64 KB of combined stdout/stderr as the tail, with the omitted byte count noted, because a failing build dumps more than it explains. `passed` is a clean exit 0: a non-zero exit fails the result and reports the code plus the excerpts; a timeout or a cancel does the same, named as such. A gate that never ran says why instead of pretending to have passed.

The gate is spawned by the parent process, in its own shell, after the child has exited — so the verdict is independent of anything the child said. That is the point: a `done, tests pass` claim costs the model nothing to write, while a gate that exits 1 makes the failure a fact in the parent session.

Both contracts apply to inline runs only: a `background: true` call that declares either is refused, because a detached run returns before the child has produced anything to check. The TUI shows the outcome beside each role (`json ✓`, `gate ✓ 1.2s`, `gate ✗ exit 1`) so a green tick cannot hide a failed contract.

## Background results

Pass `"background": true` with any mode to detach: the call returns task ids immediately instead of waiting. Background chain steps still run sequentially so `{previous}` keeps working. When a task settles, pi posts a `subagent-background-result` custom message with the outcome and output, queued for the next turn (`deliverAs: "nextTurn"`, `triggerTurn: true`). Background task state lives in an on-disk registry; check it after a restart before assuming a task is still running.

Background dispatch is capped by the same `subagent.maxConcurrent` limit (default 4): a detached call starts up to that many children at once and the rest queue. Overflow is recorded as a `pending` row in the registry — labelled `<role> (queued)`, no process spawned — and promoted in FIFO order whenever a running task settles or is cancelled. So a `background: true` call can no longer start an unbounded number of processes beside the ones already running.

A queued task reports its id and queue position in the dispatch result and in `action="status"`, and its result is delivered exactly like a started one: when it settles. Cancelling a queued task drops it from the line without spending a slot. The queue belongs to the session that filled it, so after a restart its `pending` rows are marked crashed alongside running ones — nothing is resumed from a dead session's backlog.

### Stopping a background task

`action="stop"` on a background task id signals the child process: a graceful signal first, escalating to a process-tree kill if it survives. The call reports what it actually did, so a task that could not be reached never reads as cancelled — it says so instead, and the row stays `running`.

Two cases have no process to signal: a task still in the queue never spawned anything, and a task stopped in the moment before its child spawns is killed as soon as the pid is known. Both are reported distinctly in the tool text.

A `stop` only touches tasks this session owns. A task row belonging to another session is left alone, because a pid outlives its row and the number may have been recycled by an unrelated process.

If a session dies outright while a background child is running, the next session's startup reconciliation terminates that child rather than leaving it running with a row that claims it crashed; the reap outcome is recorded in the row's `errorMessage`.

### Resuming a settled run

`action="resume"` reopens the child session file a run left behind and re-dispatches against it, with an optional `message` carried as the continuation instruction. It is the opposite of `stop`: nothing to kill, no live process to interrupt, and the child keeps the context it already accumulated instead of starting from scratch.

```json
{
 "action": "resume",
 "id": "<taskId from action=\"status\">",
 "message": "Now harden the validation paths you flagged."
}
```

The prior run must have settled cleanly — a still-running run is steered, not resumed, because two processes appending to one session file corrupts it. The resume itself holds a cross-process lease on the child session file for its whole duration (`session-lease.ts`), so a second pi process cannot revive the same session in the window between the old child settling and the replacement opening it; the lease is what makes "the previous run settled, but no one else picked it up yet" a safe moment to act. `outputSchema` and `gate` are refused on `resume` (a resumed task inherits the prior task text but never the contract — a contract a handler depends on was never established for the new task), and the new task counts against the spawn budget because the replacement path still spawns a child.

## Control plane

Every background run owns a control inbox at `<taskDir>/control/`, where `<taskDir>` is the run's directory in the background registry (`subagent-control-plane` output and `action="status"` both name it). The inbox is a directory, not a socket: a request is one JSON file written atomically, so the parent session can steer a child that has already detached — or whose parent session has exited — without either side holding a live handle.

```
<taskDir>/control/
  requests/   pending requests, one file per request
  applied/    requests a child has consumed, until they age out
  receipts.jsonl  append-only state ledger
```

Three actions are filed there: `steer` (carries the message, capped at 50 KB — the remainder is dropped and the request is marked `truncated`), `interrupt`, and `stop`. A child consumes its inbox with a watcher that polls `requests/`, moves what it took into `applied/`, and applies the request as a session operation; the watcher only runs while the child's environment names its inbox via `PI_SUBAGENT_CONTROL_DIR`, which the spawner sets from the run's `taskDir`.

The ledger records every state transition for a request id: `requested` when the parent files it, `scheduled` when a settle path has picked it up, `queued` once the child watcher has taken it, then `delivered` or `failed`. `action="status"` prints the inbox beside each run — one line per request with its action, latest state, and any note — so an unanswered steer is visible instead of silently lost. Filing a request against a run whose child is still attached takes the live path and settles the same receipt; both paths leave the same ledger, so the state does not depend on which one ran.

## Supervisor channel

The mirror of the control inbox lets a child ask its supervisor a question. When pi spawns a child it may set `PI_SUBAGENT_SUPERVISOR_DIR` to `<taskDir>/supervisor/`; the child then gets the `contact_supervisor` tool, which posts a question to `requests/` and blocks until an answer appears in `replies/` or the timeout expires (default 60 s, capped at 5 min). Without the env var the tool is not offered, so a plain child never sees it.

Questions are `open` until answered, and an unanswered question does not die with the run: when a background run settles, pi raises its open questions into the parent session as part of the `subagent-background-result` message, and json mode lists them in the exit-time handoff entry (see below). Answer one with `action="supervisor"` plus the run `id`, the question's `replyTo` id, and the `message` — the reply is written to the run's `replies/`, where a still-running child picks it up on its next poll. For a run that already settled the reply still closes the question, so `status` and any later session see it answered rather than open.

Both directories are pruned defensively: consumed requests and aged unanswered ones are dropped after 24 h, the ledger is capped at its last 500 lines, and the tool's own listings show at most three open questions per run so status output stays bounded.

### Handoff to a json-mode consumer

Background children outlive the session that started them, so a `--mode json` run that exits with runs still in flight emits one final `subagent-control-plane` custom message before the result event. It names each live run, its control inbox and supervisor outbox, the requests still sitting in each inbox with their receipt state, and the question ids still waiting for an answer. Consumers should treat it as advisory — the entry is emitted best-effort, and a session that exits with nothing running emits nothing.

## Output and limits

Each subagent's output is capped at 50 KB in the model-facing text (`Output truncated: ...` when hit), including the output embedded in thrown single/chain failure errors; the `details` object keeps the full output for renderers. Child transcripts stream as JSONL to a per-run artifact, and aborting the call kills the child's whole process tree.

### Delegation depth

A child is its own `pi` process with its own spawn counter, so per-process limits cannot bound a delegation tree. `subagent.maxDepth` (default `1`) is the bound that crosses the process boundary: the top-level session is depth `0`, so the default permits one level of subagents and refuses grandchildren.

At the limit, delegation fails two ways on purpose. The parent refuses the call with an error naming the limit and telling the model to finish the work in its own session — so the parent can re-plan. And the child drops `subagent` from its own tool set, so a grandchild is never offered the tool and there is nothing to refuse. The second is the one that actually stops the tree.

Set `subagent.maxDepth: 0` to remove delegation entirely, or raise it to allow nesting.

## Analytics

With `enableAnalytics` on, each dispatched run records one `pi_subagent_tasks` row (`agent_name` = role, `task_label` = first 200 characters of the instructions, duration, success). Nested parent/child spans for subagent-dispatches-subagent are planned but not yet recorded.

## Orchestration tips

- **Self-contained instructions win.** The child starts with a fresh context and never sees this conversation. Name exact files, symbols, and expected outputs in `instructions` instead of "the function we discussed".
- **Parallelize independent lookups.** Use `tasks: [...]` when tasks do not read each other's output (e.g. scouting several modules at once). Keep each task narrow enough that its 50 KB output cap is not hit.
- **Chain when each step builds on the last.** Use `chain: [...]` for generate-then-review or map-then-summarize flows; `{previous}` carries the earlier output forward.
- **DAG when the shape of the work is a graph, not a line.** Use `dag: [...]` when some branches are independent and others must wait — fan out research, join it at a synthesis node — `dependsOn` states the ordering instead of encoding it in array position.
- **Match the role to the job.** The `role` is a short specialist label — it labels the run in the UI, logs, and analytics and does not alter the child's prompt. Put any stance or persona differences (e.g. `code-reviewer` vs `scout`) in `instructions`.
- **Verify instead of trusting.** Give a write/fix step a `gate` pointing at the project's own check command, and give a research or triage step an `outputSchema` so its findings arrive as structured data the next chain step can read. Both are enforced by the host after the child settles, so a confident "tests pass" is either confirmed or reported as a failure.

## Comparison with the npm `pi-subagents` package

The native tool covers ad-hoc delegation plus reusable configuration: every call defines its own task, and an [agent definition file](#agent-definition-files) can carry the model, tools, thinking, and standing prompt behind a name. The npm [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) package builds on the same extension API for named, persisted agents with watchdog loops and mission-style task orchestration. Use the native tool for one-shot and short-chain delegation, including named definitions checked into the repo; use the package when you need long-lived named agents or scheduled mission loops.

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

> **Interactive wiring:** with `subagent.enableExperiments` on, `Ctrl+Shift+E` (`app.subagent.experimentsDashboard`) toggles the dashboard below the editor (`Esc` closes it), and the footer shows an experiments pill and a background-task pill as related tools run. The research-mode watcher runs in every session with the flag on: the suggestion is a warning notification plus the `RESEARCH_MODE_TRIGGERED` log event.

## Coexistence with the example extension

`examples/extensions/subagent/` remains a reference implementation. If a user-symlinked extension registers a tool named `subagent` while the built-in one is enabled, the extension's tool takes precedence and pi logs a one-line warning suggesting removal of the symlink. Nothing is disabled automatically.
