---
name: council-mode
description: Run a bounded, parent-supervised advisor council on a material decision. Two or three read-only advisors analyse in parallel, the parent cross-examines each one by resuming it on its own child session, then the parent writes a single decision memo. Use when the user asks for council mode, /council, to convene advisors, to debate a decision, to cross-examine recommendations, or to get a second and third opinion where disagreement is surfaced rather than averaged.
---

# Council Decision Mode

Council mode is **parent-mediated advice for a decision with real tradeoffs**. It is prompt orchestration on top of the ordinary `subagent` tool — there is no council runtime, no chair advisor, and no peer chat.

You, the parent session, are the supervisor. You select the roster, relay curated claims between passes, decide which claims are valid, and write the final memo. The advisors never see each other, never see this conversation, and never write anything.

## 1. What council mode is and is not

**Is:**

- A bounded, three-pass protocol: independent analyses → one cross-examination → memo.
- Multi-perspective advice whose whole value is that the advisors disagree.
- A read-only investigation: advisors inspect the repo, they do not change it.

**Is not:**

- Free-form agent chat, transcript sharing, or a transcript dump.
- Implementation work. When the memo is written, the council is over.
- Mutation authority. No advisor edits, commits, pushes, or runs mutating commands.
- An unbounded debate loop. The pass cap is a cap.
- Worth running on a trivial or already-settled question. If the answer is obvious, answer it directly and say why no council was convened.

## 2. The passes

| Pass | What happens | Who runs |
| --- | --- | --- |
| 1 | Each advisor answers independently, read-only, from its own stance | Advisors, in parallel |
| 2 | Each advisor is resumed on its own session with a curated challenge packet | Advisors, in parallel |
| 3 | Optional re-resume, **only** if requested and a material dispute can still be settled by evidence | Advisors, in parallel |
| — | The memo | You, the parent |

Default to two passes. Allow three only when the user asks for `--max-passes 3` and a dispute is still open after Pass 2. Never run a fourth.

## 3. Roster

Pick 2–3 advisors; never more than 4.

1. If the user named advisors, use exactly those names. An unknown name is a hard error from the tool (`No agent is named "..."`), and the error lists the known agent definitions and saved specs — use that listing to correct the roster, or ask the user.
2. Otherwise prefer the shipped `council-*` profiles in `.pi/agents/` (`council-skeptic`, `council-optimist`, `council-pragmatist`). List the directory to see what exists.
3. If fewer than two council profiles are available, fill the roster with an ad-hoc parallel dispatch (section 4, variant B) using a distinct stance in each `role`/`instructions`.

The advisor's **stance** lives in its profile body (the standing system prompt), not in invented per-run role labels. If the user wants a specific lens, put it in the question, scope, or profile.

Announce the roster, the pass cap, and the advisories' tool allowlist to the user **before** dispatching.

## 4. Pass 1 — independent analyses

Write the **council brief** first, and keep it: question, scope, non-goals, evidence targets (files, paths, commands' output you already have), roster, and pass cap.

Put the report contract in every Pass 1 `instructions` (see section 8). Advisors start from a fresh context, so the brief must be self-contained.

### Variant A (preferred) — named profiles, parallel calls in one message

Issue one call per advisor **in the same message**. Concurrent tool calls run in parallel; each returns its own task id immediately.

```js
subagent({ agent: "council-skeptic",   instructions: "<report contract + council brief>", background: true })
subagent({ agent: "council-optimist",  instructions: "<report contract + council brief>", background: true })
subagent({ agent: "council-pragmatist", instructions: "<report contract + council brief>", background: true })
```

`background: true` is what makes the run **resumable** in Pass 2. Capture each returned `bg_...` task id from the result text (also in the call's `details.taskIds`) and record it against the advisor's name. Do not guess or reconstruct these ids later — a settled task disappears from `action: "status"`.

### Variant B — ad-hoc, one parallel call

When you do not want profile files, dispatch all advisors in a single call:

```js
subagent({
  background: true,
  tasks: [
    { role: "council-skeptic",   instructions: "<lens + report contract + council brief>", tools: ["read", "grep", "find", "ls"] },
    { role: "council-optimist",  instructions: "<lens + report contract + council brief>", tools: ["read", "grep", "find", "ls"] },
    { role: "council-pragmatist", instructions: "<lens + report contract + council brief>", tools: ["read", "grep", "find", "ls"] },
  ],
})
```

Each `tasks` entry carries `role` + `instructions` (+ its own `tools`); `agent` is only accepted in the single-dispatch slot and cannot be used inside a `tasks` entry.

### Waiting for Pass 1

End the turn after dispatching. Each detached result is delivered as a message when it settles. To check progress, `subagent({ action: "status" })` lists the runs that have **not** settled — an advisor that no longer appears has settled (or failed) and its result has arrived or is arriving.

On completion, report to the user: how many completed, how many agreed, how many disputed, and whether Pass 2 is warranted.

## 5. Pass 2 — cross-examination by resume

**You** synthesise; the advisors do not. In the parent, build a claim matrix: agreements, disputed claims, missing proof, owner decisions, and at most **five** material claims worth relaying per advisor.

Then resume each advisor on the child session it already owns:

```js
subagent({ action: "resume", id: "<bg_...>", background: true, message: "<challenge packet>\n\nStay read-only: no edits, no mutating commands, no subagents." })
```

Verified behaviour of `action: "resume"`:

- **`id` must be a settled background task id.** While the task is `running` or `pending` there is nothing to resume (use `action: "steer"`); a `cancelled` task is refused; a task that never reported a `sessionFile`, or whose file is gone, is refused. Every refusal is a hard error, never a silent fresh dispatch.
- **`resume` rejects `model`.** The replacement continues on whatever model its role resolves to.
- **The tools allowlist is not restored.** Background rows do not record one, so the resumed child runs with the full tool set and the tool reports that caveat. Read-only is therefore **prompt-level for Pass 2** — repeat the constraint in `message`.
- If a hard read-only guarantee matters more than session continuity, skip the resume and re-dispatch the profile fresh by name (`agent: "council-<x>"` + the Pass-1 report + challenge packet). That is a *fresh-context cross-exam* — label it as such in the memo, never as a true resume.
- Resume is the only way to get true continuation: the child session still holds the advisor's own reasoning, so it can be challenged without you re-pasting its report.

### Challenge packet contents

Include only what changes the advisor's mind:

- the disputed claims (attributed to **"another advisor"** — never name peers, never paste peer transcripts),
- strong conflicting evidence,
- missing proof that one side has and the other lacks,
- owner decisions that are already fixed,
- high-impact risks raised by the other seat.

Add a stable label (e.g. `label: "pass 2 — council-skeptic"`) so the returned ids stay attributable. Record the **new** id from each resume; Pass 3 resumes *those* ids.

## 6. Pass 3 — optional

Run it only when the user requested `--max-passes 3` **and** a material dispute remains that further evidence could plausibly settle. Resume the latest ids with the still-open claims. Then stop.

**Convergence:** no disputed claim remains that both affects the recommendation and could be settled by advisor evidence. Everything else becomes an owner decision. Do not add a round for polish, symmetry, or politeness.

## 7. Stop conditions

Stop the council at the first of:

- convergence,
- the pass cap,
- a failed or unrecoverable advisor,
- the user interrupting.

## 8. Advisor profiles and the read-only constraint

Advisor profiles live in `.pi/agents/<name>.md` (project scope) or `~/.pi/agent/agents/<name>.md` (user scope). Project wins on a name collision. The file supplies model, tool allowlist, thinking level, and a standing system prompt (the frontmatter `systemPrompt`, else the markdown body); the task always comes from the call's `instructions`.

The **read-only constraint is enforced with the tool allowlist**:

```markdown
---
name: council-skeptic
description: Read-only adversary for council decisions — hunts for the failure case
tools: read, grep, find, ls
thinking: high
---

You are a read-only council advisor. ...
```

`read, grep, find, ls` is the whole read-only set — deliberately no `bash`, `edit`, or `write`. Add the constraint to the prompt body as well, because Pass 2's resume does not restore the allowlist. Do not set `clarify`, `gate`, or `outputSchema` on advisors: a `background: true` dispatch is refused when it declares `outputSchema` or `gate`, and the council needs `background: true` for resume.

Three profiles ship with this skill: `council-skeptic` (attacks the proposal), `council-optimist` (finds the upside the others miss), `council-pragmatist` (asks what it costs and what ships). They inherit the session model; pin `model:` in a profile when you want a fixed one.

## 9. Report contract (Pass 1)

Because `background: true` rules out `outputSchema`, the contract is **prompt-level**. Ask for exactly this shape and nothing else:

```json
{
  "recommendation": "one paragraph",
  "evidence": [{ "claim": "...", "sources": ["path:line", "command output"] }],
  "assumptions": [{ "assumption": "...", "status": "verified | unverified" }],
  "risks": ["..."],
  "confidence": { "level": "high | medium | low", "reason": "..." },
  "challengeClaims": ["up to three claims you expect another advisor to attack"],
  "ownerDecisions": ["things only the user can decide"],
  "changeMyMind": ["what evidence would flip your recommendation"]
}
```

Task text to append:

- inspect the supplied evidence directly; read files yourself
- do not contact other advisors or read peer reports
- stay read-only; do not edit, run mutating commands, commit, or push
- do not spawn children
- return only the report, under ~600 words

For Pass 2, ask for:

```json
{
  "responses": [{ "claimId": "...", "disposition": "accept | reject | refine | owner-decision", "reason": "...", "sources": ["..."] }],
  "recommendationChanged": { "changed": true, "reason": "..." },
  "outOfScopeFindings": ["..."]
}
```

## 10. The memo

The memo is the deliverable. Write it yourself, after the council stops.

- question and scope
- recommendation and rationale
- accepted and rejected feedback, each with its reason
- **unresolved disputes** — carried explicitly, not averaged away
- owner decisions (everything only the user can settle)
- evidence and the run ids behind it
- confidence, and what would change the decision
- roster, passes run, any fallback or fresh-context substitution, and the advisors' tool allowlist

Identify advisors by profile name.

## 11. Hard rules and failure modes

- **The parent is the only synthesiser and the only writer.** No advisor writes, and no advisor ever sees another's transcript.
- **A dead advisor is not a skipped seat.** If an advisor fails, is cancelled, or cannot be resumed, re-dispatch the same profile (or an explicit fallback) and label the substitution in the memo. Silently shrinking the roster hides the loss of a perspective.
- **Do not average positions into mush.** If two advisors disagree after Pass 2, that disagreement is a finding. Put it in the memo as a disputed claim or an owner decision. A memo that reads "both approaches have merit" has failed.
- **Never loop unboundedly.** Pass cap 3 means at most 3.
- **Never give an advisor mutation tools**, and never let one spawn a subagent.
- **Never relay peer transcripts**, only curated claims attributed to "another advisor".
- **Never invent a context mode or a stance label** you did not actually configure; if it was runtime-default, say so.
- If the tool refuses a call (unknown agent, unsettled task, `background` + `outputSchema`), read the error and fix the call. Do not retry the same shape.

## 12. Checklist

1. Is the question material with real tradeoffs? If not, answer directly.
2. Write the council brief; announce the roster, pass cap, and allowlist.
3. Pass 1: parallel `background: true` dispatches; record every `bg_...` id.
4. End the turn; collect results as they settle.
5. Build the claim matrix; pick ≤5 relay claims per advisor.
6. Pass 2: `action: "resume"` each settled id with a curated packet; restate read-only; record the new ids.
7. (Optional) Pass 3 on the user's request only.
8. Stop at convergence or the cap.
9. Write the memo, disputes included.