# Subagent Subsystem Specifications

Executable specification for the native subagent subsystem in `packages/coding-agent/src/core/subagent/`.

Derived from two adversarial architecture reviews against external reference implementations:

| Source | Reference | Licence | Status |
|---|---|---|---|
| OpenCode | `sst/opencode` @ `f03046d`, cloned to `C:\dev\opencode` | MIT | Readable source — trustworthy |
| Claude Code | third-party decompile analysis @ `C:\dev\cc-analysis` | proprietary, closed | **Prose analysis only — see [`subagent/vendor-policy.md`](subagent/vendor-policy.md)** |

Narrative reviews (not normative):
- [`docs/opencode-subagent-comparison.md`](../docs/opencode-subagent-comparison.md)
- [`docs/claude-code-subagent-review.md`](../docs/claude-code-subagent-review.md)

---

## Layout

```text
specs/
├── README.md                          # this file — index and conventions
└── subagent/
    ├── subagent.md                    # ROOT ENTRY POINT — the tool contract
    ├── components/                    # shared contracts, referenced by features/
    │   ├── schemas.md                 #   SubagentSpec, SubagentEvent, BackgroundTask, RunRecord
    │   ├── budgets.md                 #   every numeric limit, its default, and its scope
    │   ├── states.md                  #   lifecycle state machines
    │   └── errors.md                  #   error catalogue + model-facing message contract
    ├── features/                      # one folder per capability domain
    │   ├── delegation/                #   depth, recursion, roster, turn caps
    │   ├── isolation/                 #   worktrees, tool-set narrowing, `concurrentSafe`
    │   ├── concurrency/               #   parallel admission, shared budget, chain
    │   ├── durability/                #   session lease, completion records, lock discipline
    │   ├── lifecycle/                 #   background registry, control plane
    │   ├── cancellation/              #   kill escalation, orphan reaping
    │   ├── context/                   #   truncation, result propagation, usage
    │   ├── permissions/               #   capability grants, detached admission
    │   └── observability/             #   status injection, inspection surfaces
    ├── requirements.md                # atomic REQ register with acceptance criteria
    ├── traceability.md                # finding -> REQ -> evidence citation
    ├── vendor-policy.md               # rules for consuming external reference implementations
    └── rejected.md                    # considered and refused, with reasons
```

## Conventions

**Normative language.** MUST / MUST NOT / SHOULD / MAY per RFC 2119. Anything not marked
normative in a `features/` document is commentary.

**Status vocabulary.**

| Status | Meaning |
|---|---|
| `EXISTING` | Implemented and tested in the current tree. Spec documents current behaviour. |
| `GAP` | Verified absent by direct code inspection. Spec defines the target behaviour. |
| `DEFECT` | Implemented incorrectly. Spec defines corrected behaviour. |
| `REJECTED` | Deliberately not adopted. See [`subagent/rejected.md`](subagent/rejected.md). |

**Citations.** Every claim carries `path:line`. Line numbers drift — when a citation looks
wrong, trust the path and symbol over the line number, and fix the number.

**Evidence rule.** A `GAP` or `DEFECT` may only be marked `VERIFIED` if read directly from the
source tree, not inferred from a review agent. All `VERIFIED` rows in
[`traceability.md`](subagent/traceability.md) were confirmed by direct read.

**Cross-references.** Features reference shared contracts as
`../components/<name>.md#<anchor>`. Requirements are referenced by `REQ-nnn`.

## Priority

| Priority | Meaning |
|---|---|
| `P0` | Safety defect. Ship-blocking. |
| `P1` | Correctness or containment defect. |
| `P2` | Quality or capability gap. |
| `P3` | Nice to have. |

## Process

1. A requirement is proposed here with evidence.
2. Implementation lands in `packages/coding-agent/src/core/subagent/`.
3. On merge, the requirement's status flips `GAP`/`DEFECT` -> `EXISTING` and the citation is
   refreshed against the merged code.
4. A `VERIFIED` claim that turns out false on direct read is a defect in the *specification*,
   not the code. Fix the spec and note it.

## Change log

| Date | Change |
|---|---|
| 2026-10-06 | Initial spec set. Derived from OpenCode and Claude Code architecture reviews. |