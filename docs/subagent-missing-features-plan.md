# Native Subagent — Missing Management Features

## Context

The native subagent tool (`subagent-tool.ts`) now has a basic control plane:

```
action: "status"        → list running inline + background subagents
action: "stop"          → kill an inline child / cancel a background task
action: "interrupt"     → alias for stop
```

Three capabilities are missing. This document designs each one with UX flows,
implementation strategy, and edge cases.

---

## 1. Steer — Redirect a running subagent's focus

### Problem

A subagent goes down the wrong path. Today the only option is `action: "stop"`
— kill it and lose all progress. The user wants to send a corrective message
mid-run without nuking the conversation.

### Design constraint

The child pi process runs in `--mode json` with `stdin: "ignore"`. It has no
inbox, no file-watcher, no signal handler for steering messages. Adding a
real-time side-channel (stdin, signal, file-watch) requires changes in the pi
child entry point — a separate PR that benefits steer but is not required by
it.

**Practical approach**: interrupt + re-dispatch with the session file. The
child's session file captures its full conversation state. When we stop the
child and re-spawn with `--session <file>`, pi resumes from that conversation
— the steering message becomes the next user turn.

This gives us "redirect" semantics, not "real-time inject mid-tool-call." A
child busy in a 30-second bash call won't see the steer until the tool ends.
That is the correct semantic: steering is about changing direction, not
micromanaging a tool that is already running.

### UX flow

```
Model calls: subagent(action: "steer", id: "abc-123", message: "Focus on the auth module, not the database layer.")
```

1. Look up `abc-123`:
   - **Inline**: `runner.listRunning()` → found → `runner.interrupt(id)` → settled result carries `sessionFile`
   - **Background**: `registry.listRunning()` → found → `registry.cancel(id)` → poll for settled row → row carries `sessionFile`
   - **Neither**: throw with known ids like `stop` today

2. Wait for the interrupted run to settle. The result is aborted but carries
   `sessionFile` and all conversation history (messages, tool results).

3. Re-dispatch as a single run:
   ```
   subagent({
     role: "steer:<original-role>",
     instructions: "[STEER] <message>\n\n---\n\nContinue your work.",
     sessionFile: <captured-session-file>,
     model: <original-model>,
     tools: <original-tools>,
   })
   ```

4. The child resumes from its pre-interrupt conversation. The steering message
   is the next user turn. The child continues.

5. The new run gets a fresh `runId`. The old run's id is marked settled; the
   steer result carries the new run's id so the caller can chain further
   actions.

### States

| State | Behavior |
|---|---|
| **Normal** | Interrupt → settle → capture sessionFile → re-dispatch → new runId |
| **Empty** (id not found) | Throw with known-id listing |
| **Error** (interrupt lands but child already settled) | Same as not-found: child's sessionFile is still available on the settled result in background registry, but inline settled results are ephemeral — throw and tell user to re-dispatch manually |
| **No session** (child ran with `--no-session`) | Throw: "Cannot steer a subagent that has no persisted session. Re-dispatch with session support." |

### Implementation

**Files**: `subagent-tool.ts` only (add `case "steer"` to `handleManagementAction`)

**New schema fields**:
```typescript
message: Type.Optional(Type.String({
  description: "Steering message injected as the next user turn when the child resumes.",
}))
```

**No runner changes needed**: stop already works, re-dispatch already works,
sessionFile capture already works. Steer is composition of existing primitives.

### Edge cases

- **Chain steer**: Only the currently-running chain step is steerable. Chain
  steps that haven't started yet are in the parent process's queue, not in a
  child. Steer targets one child process.
- **Parallel steer**: One parallel task among many. Steer it; the other tasks
  keep running independently.
- **Background steer**: Interrupt → cancel in registry → wait for settlement
  (poll or listen to `onBackgroundSettled`) → re-dispatch as background.
  Background-to-background steer preserves the fire-and-forget contract.
- **Steer loop**: User steers, then steers again before re-dispatch completes.
  Each steer is a stop + re-dispatch; the second steer stops the first steer's
  child. No infinite loop — each steer produces a distinct runId.

---

## 2. Model Swap — Change the model of a running subagent

### Problem

A subagent is running on a cheap model but hits a wall. The user wants to bump
it to a stronger model without losing conversation state.

### Design

Identical mechanism to steer, but simpler: the re-dispatch keeps the same
instructions and only changes the model.

### UX flow

```
subagent(action: "swap-model", id: "abc-123", model: "anthropic/claude-sonnet-4-20250514")
```

1. Same lookup + interrupt as steer.
2. Re-dispatch with the new model, same sessionFile, original instructions:
   ```
   subagent({
     role: "<original-role>",
     instructions: "Continue your work.",
     sessionFile: <captured-session-file>,
     model: "<new-model>",
     tools: <original-tools>,
   })
   ```
3. The child resumes from its conversation with the new model answering the
   next turn.

Note: `instructions: "Continue your work."` is enough because the child's
session contains the full conversation — the model sees all prior messages,
the original task, and knows where it was. A long re-statement is noise.

### Implementation

**Files**: `subagent-tool.ts` only (add `case "swap-model"`)

**No new schema fields**: `id` + `model` are already on the schema.

### Edge cases

- **Model not available**: Standard model resolution failure — throw.
- **Thinking level mismatch**: The new model might have different thinking
  defaults. Inherit from parent or use the new model's default — don't carry
  the old model's thinking level unless explicitly set.
- **Swap then steer**: Two separate actions. Swap completes (new child starts),
  steer targets the new child's id.

---

## 3. Saved Specs — Persist and reuse SubagentSpec templates

### Problem

The native subagent creates ad-hoc specs per call (`role` + `instructions` +
`model` + `tools` + `cwd` + `contextWindow`). There is no way to save a common
spec and reuse it. Every dispatch must repeat all fields.

The pi-subagents extension has agent `.md` files (markdown frontmatter with
system prompts, model defaults, tool allowlists). Those are rich — they carry
prompt templates, thinking levels, skill references. The native system is
simpler: a spec is just field values.

### Design

Persist `SubagentSpec` JSON objects to disk. Reference them by name on
dispatch. Optional overrides let the caller tweak a saved spec without editing
the file.

**Storage**: `~/.pi/agent/subagent-specs/<name>.json`

```
{
  "role": "code-reviewer",
  "instructions": "Review the code for bugs...",
  "model": "anthropic/claude-sonnet-4-20250514",
  "tools": ["read", "grep", "bash"],
  "cwd": null,
  "contextWindow": 64000
}
```

### UX flow — Save

```
subagent(action: "save-spec", name: "code-reviewer", role: "code-reviewer",
  instructions: "Review the code for bugs, security issues, and style violations.",
  model: "anthropic/claude-sonnet-4-20250514", tools: ["read", "grep", "bash"])
```

Saves to `~/.pi/agent/subagent-specs/code-reviewer.json`. Overwrites if name
already exists (ask or warn? → overwrite silently, the call is explicit).

### UX flow — List

```
subagent(action: "list-specs")
```

Returns:

```
Saved subagent specs (3):
  code-reviewer — anthropic/claude-sonnet-4-20250514 [read, grep, bash]
  fixer — qwen/qwen3.8-omni-flash [read, edit, write, bash]
  scout — deepseek/deepseek-v4.1-flash [read, grep, find, ls]
```

### UX flow — Delete

```
subagent(action: "delete-spec", name: "code-reviewer")
```

Removes the file. Throws if not found.

### UX flow — Dispatch with a saved spec

```
subagent(agent: "code-reviewer")
```

Equivalent to copying all the saved spec's fields into the call. Optional
overrides merge on top:

```
subagent(agent: "code-reviewer", instructions: "Review for security only.")
```

Overrides `instructions` but keeps `model`, `tools`, etc. from the saved spec.

### Implementation

**Files**:
- New: `packages/coding-agent/src/core/subagent/saved-specs.ts` — CRUD
- Modified: `subagent-tool.ts` — add `agent` field to schema, add
  `action: "save-spec" | "list-specs" | "delete-spec"`, resolve `agent` before
  dispatch

**New schema fields**:
```typescript
agent: Type.Optional(Type.String({
  description: "Name of a saved subagent spec. Resolved from ~/.pi/agent/subagent-specs/<name>.json. Fields on the call override the saved spec.",
})),
name: Type.Optional(Type.String({
  description: "Name for 'save-spec'/'delete-spec' actions. Becomes the filename.",
})),
```

**saved-specs.ts API**:
```typescript
export interface SavedSpec {
  name: string;
  spec: SubagentSpec;
  savedAt: string; // ISO
}

export function listSpecs(): SavedSpec[];
export function loadSpec(name: string): SubagentSpec;   // throws if missing
export function saveSpec(name: string, spec: SubagentSpec): void;
export function deleteSpec(name: string): void;          // throws if missing
```

**Dispatch precedence**: `agent` is mutually exclusive with `role`. When
`agent` is set:
1. Load the saved spec
2. Apply any explicit overrides from the call (`instructions`, `model`,
   `tools`, `cwd`, `contextWindow`)
3. Dispatch with the merged spec

### Edge cases

- **Name collision on save**: Overwrite — the call is explicit.
- **Name with slashes**: Reject — names are flat filenames, no subdirectories.
- **Agent + role both set**: Throw — mutually exclusive.
- **Agent not found**: Throw with available names listed.
- **Saved spec references unknown model**: Resolve at dispatch time like any
  other model — throw if unresolvable.
- **Spec file is corrupt JSON**: Throw with path and parse error.
- **Cross-session**: Specs are user-global (`~/.pi/agent/`), so all sessions
  share them. A spec saved in one session is available in another.

---

## Implementation order

```
1. saved-specs.ts + dispatch support    (no dependencies)
2. steer action                          (uses stop + re-dispatch)
3. swap-model action                     (uses stop + re-dispatch, shares steer's re-dispatch helper)
```

Steer and swap-model share the same "interrupt → capture sessionFile →
re-dispatch" helper. Implement that once, then both actions are thin wrappers.

## Files summary

| File | Change |
|---|---|
| `subagent-tool.ts` | Add `steer`, `swap-model`, `save-spec`, `list-specs`, `delete-spec` actions + `agent`/`name`/`message` schema fields + re-dispatch helper |
| `types.ts` | No changes needed (existing types cover all new actions) |
| `saved-specs.ts` | NEW — CRUD for `~/.pi/agent/subagent-specs/*.json` |
| `render.ts` | Add control-plane branches for new actions (similar to current `action` branch) |
| `tests/subagent-management-action.test.ts` | Unit tests for steer, swap-model, saved specs |