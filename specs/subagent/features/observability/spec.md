# Observability

What a human can see while a child runs, and what the model is told.

Source: `status-injector.ts`, `experiments-dashboard.ts`, `interactive-mode.ts:3214`,
`:4475-4494`, `packages/tui/src`.

---

## 1. Current surfaces

| Surface | Scope | Status |
|---|---|---|
| `/subagents` dashboard | **background only** | EXISTING |
| Per-task log-tail overlay (`Enter`) | **background only** | EXISTING |
| Tool-call expansion in the transcript | inline, **after** settle | EXISTING |
| `buildStatusInjection` | **never called** | DEAD CODE |
| TUI awareness | **zero** — `packages/tui/src` contains no occurrence of "subagent" | GAP |

The overlay reads `getBackgroundRegistry().snapshot().tasks`
(`interactive-mode.ts:4484-4490`) and renders raw JSONL through `formatLogLine`
(`experiments-dashboard.ts:330-340`).

> **Correction to a common assumption.** The subsystem is *not* blind. A task dashboard and a
> log overlay exist, and background settle already injects into the parent. The gap is narrower
> than "no visibility" — see §3.

---

## 2. `buildStatusInjection` — REQ-O01 (S, DECIDE)

### 2.1 State

`buildStatusInjection` is exported (`core/subagent/index.ts:94`, `core/index.ts:134`) and has
**zero call sites under `src/core/`**. The only real caller is
`examples/extensions/subagent/index.ts:1442`, using its own separate copy of the helper.

Its cost control is already sane: 2400 chars, 8 running rows, 5 terminal rows
(`status-injector.ts:20-22`, `:72-83`).

### 2.2 Decision: wire it, or delete it

| Option | Verdict |
|---|---|
| **A.** Inject into the **parent** system prompt once per turn | **Recommended** |
| **B.** Delete the helper | Acceptable if (A) is not wanted now |
| **C.** Inject mid-run on every update | **Reject** — see §2.3 |
| **D.** Inject into the child | **Reject** — see §2.3 |

| ID | Requirement |
|---|---|
| **REQ-O01.1** | Inject the status block into the parent system prompt at most once per turn, not per event. |
| **REQ-O01.2** | The block MUST be marked read-only and MUST NOT contain instructions the model could act on as commands. |
| **REQ-O01.3** | If not wired, delete the export and the duplicated copy in the example extension. |

### 2.3 Why C and D are rejected

**C — mid-run injection.** Each injection forces a synthetic turn to re-render the prompt, and
re-arms the "is it done yet?" loop. The reviewed system forbids this explicitly in its own task
prompt: *"DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's
work"*. That instruction exists because the parent already has a real answer available —
calling `status` — and inventing a synthetic turn to deliver a status line makes the model
worse at using it.

**D — child injection.** The child already knows its own state; it produced the events.
Injecting a status block corrupts the task framing and spends the child's context on information
it generated.

> **Check before shipping (A).** Confirm the parent system prompt does not already carry the
> "do not poll" instruction, so the two do not contradict. Tracked in
> [`../../traceability.md`](../../traceability.md).

---

## 3. Inline runs are not inspectable — REQ-O02 (M)

### 3.1 Gap

The dashboard and overlay are background-only. A long inline run is inspectable **only after it
settles**, by expanding the tool result.

Given inline is the default mode, the common case has no live view. That is the actual gap.

### 3.2 Requirement

| ID | Requirement |
|---|---|
| **REQ-O02.1** | Inline runs MUST write their JSONL to the same `<taskId>/log.jsonl` layout the background registry already uses. |
| **REQ-O02.2** | The dashboard MUST include inline rows, sourced from `runner.listRunning()` (`bun-process-runner.ts:345`). |
| **REQ-O02.3** | The overlay MUST render via `getDisplayItems` / `formatToolCall` (`render.ts:122-149`) rather than raw JSONL, so inline and background rows are readable the same way. |

### 3.3 Blast radius

`interactive-mode.ts`, `experiments-dashboard.ts`, `bun-process-runner.ts`. The log format and
the renderer already exist; this is wiring, not new machinery.

---

## 4. What we deliberately do NOT do

| Idea | Verdict |
|---|---|
| TUI child-session tab cycling, drill-down, parent/child navigation | **REJECTED.** Requires a session tree we do not have, and the reviewed implementation's own sessions are the reason it can do it. REQ-O02 captures most of the value at a fraction of the cost. |
| Re-bootstrapping live children after restart | **REJECTED.** No shared event bus to reattach to. Our model is better: orphans are marked `crashed` but keep their log and session file, and `resume` accepts a crashed row with a surviving session file. |
| Streaming child output to the parent model mid-run | **REJECTED.** Same reason as REQ-O01 C. |

---

## 5. Acceptance criteria

```gherkin
Scenario: Inline run is inspectable while running
  Given a long inline subagent run
  And the subagent dashboard is open
  When the child emits a message
  Then the inline run MUST appear as a live row

Scenario: Unwired code is removed
  Given buildStatusInjection is not wired into the parent
  Then its export MUST be deleted rather than left as an unwired public API
```

---

## 6. Related unverified

Whether background children reach the `trackedDetachedChildPids` set that shutdown kills was not
traced end to end. It does not change anything in this spec, but it is the last open question
about whether the cancellation leaks in
[`cancellation/spec.md`](../cancellation/spec.md) are the only ones.