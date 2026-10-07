# Vendor Policy

Rules for consuming external reference implementations when designing this subsystem.

---

## REQ-POL01 — No vendored-source code

> **No source code, identifiers, or structure from a closed-source third-party decompile may
> enter this codebase, in any form.**

This covers a repository that publishes a decompiled or deobfuscated archive of closed-source
software and applies its own licence header to it. A third party cannot relicense another
party's code, so a licence badge on such a repository grants nothing over the original.

Consequences:

1. We may read **analysis prose** — descriptions of behaviour, design rationale, architectural
   diagrams. Ideas are not the implementer's expression.
2. We may **verify our own understanding** against the source, but must not mine it for
   implementation.
3. Nothing is copied, paraphrased into near-identical naming, or structurally transliterated.
4. If a design is adopted, it is implemented against **our** architecture and **our** contracts,
   with citations pointing at our own files.

> pi is a published product (npm `@bramburn/pi-*`). A traceable copy of someone else's leaked
> source in its history is a liability that outlives any feature it enabled.

---

## REQ-POL02 — `enableExperiments` is semi-permanent

> **Absent from a shipped bundle is a stronger statement than off by default.**
> Anything gated behind `subagent.enableExperiments` is effectively permanent once enabled.

Verified: we have **no** A/B flag system, no GrowthBook equivalent, no remote kill switch
(grep of `packages/coding-agent/src` returns nothing). So a flag we ship is a flag a user keeps.

Rules:

1. Experiments stay **off by default**.
2. Adding an experiment flag requires accepting that it has no off-switch. If a feature should be
   revocable, it does not belong behind `enableExperiments`.
3. **Safety must not live behind a flag.** Worktree isolation (REQ-I01) is containment, not a
   feature — it is currently behind `enableExperiments: false`, which is the wrong place for it.
4. Every experiment flag carries a removal condition in the spec that introduced it.

---

## REQ-POL03 — References, not templates

> External implementations are a **menu**. The published frontier of another product is a
> statement about *their* users, not a definition of ours.

Rules:

1. Classify every borrowed idea as **shipped / gated / internal / unverified** before adopting
   it. A feature that is compiled out of a competitor's public bundle is not a reference for
   what works.
2. Judge each idea against **our** architecture first. Our decisive constraint is that children
   are separate processes with a one-way pipe.
3. Prefer the cheapest mechanism that solves a problem **we have actually observed**. Do not
   build toward a competitor's feature list.
4. Where we are already better, say so and do not regress it. See §6.

---

## REQ-POL04 — Keep the reviews

The two narrative reviews are retained because they carry reasoning the specs do not:

- [`docs/opencode-subagent-comparison.md`](../../docs/opencode-subagent-comparison.md)
- [`docs/claude-code-subagent-review.md`](../../docs/claude-code-subagent-review.md)

Specs state what must be true. Reviews explain why, and what was rejected. Keep both; when a
requirement is implemented, update the spec status and leave the review as the historical record.

---

## 5. Reference posture by source

| Source | Licence | Verdict |
|---|---|---|
| **OpenCode** (`sst/opencode`) | MIT | Legitimate. Readable, small, structured. Verify findings against code — they hold up. |
| **Claude Code analysis** (third-party decompile) | proprietary underlying code | **Prose only** per REQ-POL01. Medium trust for internal design, low for shipped features. |

---

## 6. What we must not regress

Adopting anything must not cost us these. They are the reason the subsystem is worth keeping.

| Asset | Contrast |
|---|---|
| Concurrency caps (`maxConcurrent` 4, all-or-nothing admission) | No cap found in either reviewed system |
| Spawn budget | None found |
| Per-tool-call timeout | No foreground timeout in the reviewed in-process design |
| Kill escalation SIGTERM -> 5 s -> SIGKILL tree, exit 137 | Not present |
| Durable background registry with stale-holder lock breaking | Documented as intentionally non-durable upstream |
| Partial results with `complete: false` | Upstream reports empty child output as success |
| Compaction: explicit boundary + no-API snip layer | ~1300 lines vs a single compaction module, itself duplicated mid-migration |
| JSONL session store with a conformance suite | — |
| Chain and parallel modes in one call | Neither reviewed system has them |
| Windows hardening throughout | Neither reviewed system has a Windows story |

> **The pattern to keep:** our wins are all *operational correctness* — bounded delegation,
> real cancellation, durability, inspectability. That is a different product focus from the
> autonomy/experimentation frontier the other systems publish. Optimise for ours.