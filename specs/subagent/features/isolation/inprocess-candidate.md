# Candidate: In-Process Read-Only Child

**Status: CANDIDATE. P3. Not scheduled. Gated behind REQ-D01.**

Adds an execution mode where the child runs inside the parent process. This document records the
shape, the constraints, and — more importantly — the reasons it is last in the queue.

Related: [isolation spec](spec.md) (spectrum rung 0), [delegation spec](../delegation/spec.md)
(REQ-D01), [rejected.md §9](../../rejected.md) (agent-to-agent messaging).

---

## 1. Motivation

The subprocess boundary costs us three things this mode would recover:

| Cost of the boundary | Recovered by in-process |
|---|---|
| Spawn latency — each child re-parses config, loads resources, walks for `AGENTS.md`, registers extensions before its first token | Yes, fully |
| `session-lease.ts` (465 lines) and its no-expiry problem (REQ-L01) | Yes — no second process, no lease |
| One-way pipe, which blocks agent messaging, graceful turn-cap wrap-up, and foreground promotion | Partially — see §6 |

The spawn cost is not hypothetical: `bun-process-runner.ts:11` already justifies choosing
`Bun.spawn` over `node:child_process` because it "starts faster (which matters at 4 concurrent
children)".

**Where it genuinely pays:** a read-only research child. Pure search and synthesis over a
codebase, no mutation, no shell, latency-dominated, low crash risk.

---

## 2. Shape

A new field. Note `mode` is already taken by `single | parallel | chain`, so this must not
reuse it.

```ts
execution: "subprocess" | "inprocess"   // default "subprocess"
```

Implemented as a second `SubagentRunner` behind the existing seam
(`types.ts:216-234`). The seam's own header anticipates this
(`types.ts:9-11`): *"an in-process `AgentSession` runner can replace it without touching the tool
surface."*

---

## 3. Constraints — these are the design, not caveats

| ID | Constraint |
|---|---|
| **REQ-IP01.1** | The tool set MUST be a subset of `{read, grep, find, ls}`. These are exactly our non-mutating tools (`core/tools/index.ts:124-134`); `bash`, `powershell`, `edit` and `write` are excluded. |
| **REQ-IP01.2** | `subagent` MUST NOT be present. This makes the mode **leaf-only by construction** — an in-process child cannot delegate, so it cannot form a fork bomb. |
| **REQ-IP01.3** | If a caller requests a broader tool set, the dispatch MUST be refused, not silently narrowed. |
| **REQ-IP01.4** | Cancellation MUST be cooperative, and the model MUST be told the child cannot be hard-killed. |
| **REQ-IP01.5** | No session lease is taken or broken for this mode. |

### 3.1 Why leaf-only is the whole safety argument

REQ-D01 exists because a child inherits `subagent` and the process boundary means each
grandchild gets a fresh spawn counter. An in-process child would remove the *only* backstop —
there is no kernel underneath it. 262,144 nested `AgentSession` objects in one heap is worse
than 262,144 processes, because nothing refuses.

Excluding `subagent` makes that unreachable by construction rather than by counter. That is the
entire reason this mode is safe to consider at all, and it is why REQ-IP01.2 is a hard
requirement rather than a default.

---

## 4. What it costs

| Cost | Detail |
|---|---|
| **No crash isolation** | An in-process child that segfaults, OOMs, or throws uncaught takes the parent with it. A subprocess child fails alone. |
| **No hard kill** | Subprocess cancellation is SIGTERM → 5 s → SIGKILL tree (`shell.ts:153-231`). In-process it is cooperative abort via the `AbortSignal` the runner already accepts. A child blocked on a promise that never settles cannot be recovered. |
| **Resource risk moves, not disappears** | Read-only still means unbounded input. A huge `read` or a `find` across a giant tree can exhaust parent memory or hang the parent. No per-child memory cap exists in-process. |
| **Test surface doubles** | Every existing behaviour — truncation, events, aggregation, budgets — needs a second runner path. |

> **REQ-IP01.4 is the serious one.** The subprocess design makes force-kill the primitive that
> the whole control plane rests on. In-process, the turn cap (REQ-D03) has nothing to fall back
> on: it can only ask the child to stop, and a wedged child ignores it. Do not promise a
> turn cap for in-process children unless the abort path is proven against a wedged tool call.

---

## 5. Why P3

Three independent reasons, any one sufficient:

1. **REQ-D01 must land first.** Adding a second execution path before the first is bounded
   doubles the surface we are trying to make safe.
2. **No observed problem it solves.** Spawn latency has not been reported as a pain point. This
   is an optimisation against a hypothetical.
3. **It weakens the property that makes the subsystem good.** Force-kill, crash containment and
   durable separation are why pi's subagent layer is ahead of both reviewed systems
   ([`../../vendor-policy.md`](../../vendor-policy.md) §6). This mode trades them away in the one
   scenario where they are least needed. That is a defensible trade — but it should be made
   deliberately, after the loud problems are closed.

---

## 6. What it does NOT unlock

Be honest about the ceiling:

- **Agent-to-agent messaging** ([`../../rejected.md`](../../rejected.md) §9) becomes *possible*,
  not solved. It still needs a channel design, a mailbox, and an addressing model. The pipe is
  not the only obstacle.
- **Graceful turn-cap wrap-up** stays blocked unless an abort path is proven (§4).
- **Foreground promotion** becomes mechanically easier but is still refused on lease-corruption
  grounds ([`../../rejected.md`](../../rejected.md) §1) — though with no lease, that specific
  objection weakens.

> The rejected features were refused on the grounds that they assume a shared runtime. Removing
> that assumption removes one of the objections. It does not turn any of them into work we
> should now do.

---

## 7. Acceptance criteria (if ever built)

```gherkin
Scenario: In-process child is leaf-only
  Given execution is "inprocess"
  When the child resolves its tool set
  Then the set MUST be a subset of read, grep, find, ls
  And subagent MUST NOT be present
  And the child MUST NOT be able to delegate

Scenario: Broadened tool set is refused, not narrowed
  Given execution is "inprocess" and tools includes write
  When the call is dispatched
  Then the dispatch MUST fail with an error naming the read-only restriction
  And no child MUST start

Scenario: Cancellation is cooperative and honest
  Given a running in-process child
  When cancellation is requested
  Then the child MUST receive an abort signal
  And the result MUST state the child could not be hard-killed
```