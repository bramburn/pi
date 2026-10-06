# Considered and Rejected

Recorded so these are not re-proposed. Each entry states the idea, why it was refused, and what
would change the answer.

---

## 1. Foreground to background promotion

**Idea.** A running foreground child can be promoted to background mid-flight, so the parent
stops blocking and is notified on completion. Available upstream because promotion hands the
same live execution to a registry.

**Why rejected.**

1. We cannot detach a running OS process from a foreground wait without a new IPC protocol. The
   child holds a pipe, a lease, and a session file.
2. Our own code already argues against the underlying operation.
   `resolveSteerTarget` refuses a background row with no `sessionFile` because *"resuming its
   session while it writes would corrupt the JSONL"* (`subagent-tool.ts:737-745`). Promotion
   hits exactly that window.
3. Low value here. The other system needs promotion because its tool blocks in-process and cannot
   do otherwise. We can start in background, and we already have `steer`, `status` and `interrupt`
   for a running foreground child.

**Revisit if** a future design gives the parent a cancellable, non-blocking wait without
surrendering the lease.

---

## 2. Task graph with dependency edges, and autonomous claim

**Idea.** A durable file-based task graph with status and dependencies, plus teammates that scan
it and **claim** tasks themselves instead of the lead assigning each one.

**Why rejected.**

1. **Disproportionate.** The equivalent implementation is ~6,800 lines in 22 files for the swarm
   layer alone — roughly 92% of our entire 7,389-line subsystem. With its coordinator and
   team/task tools the bundle is around 9,400 lines: larger than what it would be bolted onto.
2. **In-process only.** Its teammates live in-process or in a tmux pane and synchronise against
   the parent's *live* permission object. That does not survive a process boundary — it is the
   same permission-derivation pattern already rejected from the other reference.
3. **It does not ship.** Behind an experimental env var plus a remotely-revocable A/B flag; the
   underlying coordinator module is compiled out of the public bundle entirely. We would be
   building against another company's unpublished internal bet.
4. **Sequencing.** Autonomous claim is a fan-out amplifier. Layered on unbounded depth with
   write-capable children, it makes REQ-D01 worse, not better.

**What survives.** Locking, not autonomy, is the hard part. If a task board is ever built, a
file-locked claim primitive (~30 lines) is the only transferable piece.

**Revisit if** REQ-D01 lands **and** we can measure delegation quality at all.

---

## 3. Remote / container spawn mode

**Idea.** A fourth isolation rung that bridges a child to a remote container.

**Why rejected.** Requires a bridge layer, JWT work-secret exchange, capacity-wake, and a
5-transport MCP client. We have no remote surface to reach. Recorded as absent at
[isolation §1](features/isolation/spec.md) rung 9.

**Revisit if** pi gains a server or remote execution mode.

---

## 4. Full per-tool-call permission pipeline

**Idea.** `validateInput` before any permission check, then PreToolUse hooks that may approve,
deny or **rewrite** tool input, then allow/deny/ask rule sets by tool-name pattern, then an
interactive Allow Once / Allow Always / Deny prompt, then tool-specific checks such as path
sandboxing.

**Why rejected.** It is a product philosophy, not a patch — a decision about whether an agent
asks or acts. Our model is *capability granted at spawn, enforced by the process*: explicit tool
set, explicit cwd, isolated process. That is defensible on its own terms.

A lighter variant — deriving child permissions from a parent's live ruleset — was already
rejected: it reads parent in-process state that does not exist across a process boundary.

**What survives.** Exactly one hole is worth closing: REQ-P02, admission for *detached*
children, where the user is not watching and the capability grant is never revisited.

**Revisit if** users report unwanted behaviour from background children that a narrower tool set
would not have prevented.

---

## 5. Graceful turn-cap wrap-up

**Idea.** On a child's final allowed turn, inject a synthetic prompt telling it to wrap up
cleanly, so it produces a summary instead of being killed.

**Why rejected — permanent.** The child's stdin is `"ignore"`
(`bun-process-runner.ts:539`) and the JSONL channel is one-way outbound. There is no way to
inject anything into a running child. Only a hard kill works.

This is a **permanent capability loss of the subprocess architecture**, not an oversight.

**Recorded so** a future change does not "fix" it by adding a half-working injection channel.

**Mitigation instead:** REQ-D03.3 returns the partial output plus an explicit "stopped at turn
cap", so the parent knows it is acting on a truncated result and may `resume`.

---

## 6. TUI child-session tab cycling and drill-down

**Idea.** Nested tabs for subagent sessions, arrow-key navigation between parent and children,
a footer inspector showing per-part deltas, and re-bootstrapping child views after restart.

**Why rejected.** Requires a session tree and a shared event bus — upstream can navigate into a
child session because the child *is* a session row in the same runtime with the same store. We
have neither. REQ-O02 captures most of the value (live inline rows, readable rendering) at a
fraction of the cost by reusing the log layout and renderer that already exist.

Restart re-bootstrapping is separately rejected: reattaching to a live process requires a shared
bus. Our model is better — orphans are marked `crashed` but keep their log and session file, and
`resume` accepts a crashed row with a surviving session file
(`subagent-tool.ts:374-404`).

**Revisit if** the session store grows a first-class parent/child tree.

---

## 7. Mid-run status injection to the parent model

**Idea.** Push a status block into the parent context as child events arrive, so the parent
knows what is running without calling `status`.

**Why rejected.** Each injection forces a synthetic turn to re-render the prompt and re-arms
the "is it done yet?" loop. The reviewed system forbids this in its own task prompt: *"DO NOT
sleep, poll for progress, ask the task for status, or duplicate this task's work"* — because the
parent already has a real answer available via `status`. Making it push the answer anyway makes
the model worse at using the tool.

REQ-O01.1 instead injects **once per turn**, which informs without manufacturing turns.

**Injecting into the child** is rejected separately: the child produced the events and already
knows them; the block would corrupt task framing and spend the child's own context.

---

## 8. Mixed write durability for the session log

**Idea.** User messages written blocking for crash recovery; assistant messages fire-and-forget
through an ordering queue.

**Status: not rejected, simply not adopted.** It is shipped upstream and is a genuine
improvement over uniform durability. Not currently required — our session store already has a
946-line conformance suite and no observed durability problem. Listed here so the option is not
mistaken for an oversight.

**Revisit if** crash-during-write is ever reported against our session store.

---

## 9. Agent-to-agent messaging

**Idea.** A single request-response primitive (`SendMessage`) driving all inter-agent
negotiation.

**Why rejected.** There is no bidirectional transport. Child stdin is `"ignore"` and the JSONL
channel is one-way outbound. `steer` is kill-and-re-dispatch, not a live channel. Background
settle injection into the parent is **system-initiated and one-way** — the child never addresses
anyone, cannot choose timing, and receives no reply. It is a completion notification, not a
messaging primitive.

Adding real messaging requires an IPC protocol on a pipe that is currently one-way. That is a
larger change than any feature it would enable, and REQ-D01 makes the motivating case (many
independent children) smaller, not larger.

**Revisit if** REQ-D01 lands and depth 1 proves genuinely limiting in practice.