# ADR-0004: Native subagent subsystem is the only subagent implementation

**Status:** accepted
**Date:** 2026-10-20
**Domain:** subagents

## Context

The coding agent ships a built-in, out-of-process subagent subsystem under `packages/coding-agent/src/core/subagent/` (`subagent-tool.ts`, `bun-process-runner.ts`, `background.ts`, `agents.ts`, `worktree.ts`, `session-lease.ts`). Meanwhile:

1. `packages/coding-agent/docs/subagents.md:222-224` still steers users to the external npm `pi-subagents` package (`tintinweb/pi-subagents`) for named agents and mission loops (`specs/batch/batch-context.md` §3.3).
2. `packages/coding-agent/docs/subagents.md:251-253` and `packages/coding-agent/examples/extensions/subagent/` preserve an upstream-era extension implementation that carries a separate, unlocked copy of the worktree substrate (`specs/subagent/features/isolation/spec.md` §2.6) and a duplicate `buildStatusInjection` helper (`specs/subagent/features/observability/spec.md` §2.1).
3. `packages/agent/src` contains zero subagent code today (`specs/batch/batch-context.md` §3.3), and `packages/coding-agent/src/core/subagent/agents.ts:12-14,69` loads reusable agent definitions strictly from local directories without remote network calls.

Under decisions D1, D4, and D5 (`specs/batch/batch-context.md` §1), `qi` is severing upstream ties and hardening its native subagent implementation (`R-SUBAG-001`–`R-SUBAG-003`).

## Decision

We will maintain `packages/coding-agent/src/core/subagent/` as the sole subagent implementation in `qi`, remove `packages/coding-agent/examples/extensions/subagent/` and all documentation references to it or to the external `pi-subagents` npm package, keep `packages/agent/src` free of subagent code, and load agent definitions exclusively from local directories.

Removing `packages/coding-agent/examples/extensions/subagent/` needs no changes to root `package.json` workspaces, because only `with-deps`, `custom-provider-anthropic`, `custom-provider-gitlab-duo`, `sandbox`, and `gondolin` are listed in `package.json:7-13` (verified by direct read of root `package.json:5-14`).

## Consequences

**Positive:**
- Eliminates split guidance between the built-in `subagent` tool, the external `pi-subagents` npm package, and the legacy example extension.
- Removes the third, unlocked copy of the worktree substrate (`specs/subagent/features/isolation/spec.md` §2.6) and the duplicate `buildStatusInjection` caller (`examples/extensions/subagent/index.ts:1442`).
- Preserves process-boundary crash isolation, durable on-disk registries, and local-only definition resolution (`agents.ts:12-14,69`).

**Negative:**
- Users relying on the bundled `examples/extensions/subagent/` reference code must use the native `subagent` tool and `.qi/agents/*.md` definitions instead.

**Neutral:**
- `packages/agent/src` remains a single-agent runtime loop; multi-agent orchestration stays layered in `packages/coding-agent/src/core/subagent/`.

## Alternatives considered

- **Continue recommending the `pi-subagents` npm package for long-lived agents:** Rejected. `specs/subagent/traceability.md` (`V59`–`V66`) documents that `pi-subagents` runs children in-process with unbounded horizontal concurrency (`V61`), non-durable in-memory state (`V63`), and grandchild cancellation leaks (`V62`), contradicting our subprocess safety model (`specs/subagent/subagent.md` §1).
- **Keep `packages/coding-agent/examples/extensions/subagent/` as a compatibility shim:** Rejected. It duplicates worktree mutations without `worktree-lock.ts` (`specs/subagent/features/isolation/spec.md` §2.6) and shadows the built-in `subagent` tool when symlinked (`docs/subagents.md:251-253`).

## Compliance checklist

- [ ] `grep -rn "pi-subagents" packages/ docs/ website/` returns zero matches.
- [ ] `test ! -d packages/coding-agent/examples/extensions/subagent` passes, and `grep -rn "examples/extensions/subagent" packages/ docs/` returns zero matches.
- [ ] `grep -rn "subagent" packages/agent/src/` returns zero matches.
- [ ] `grep -rn "fetch(" packages/coding-agent/src/core/subagent/agents.ts` returns zero matches.

## Traceability

- **Realises:** `REQ-SUBAG` (`R-SUBAG-001`, `R-SUBAG-002`, `R-SUBAG-003`).
- **Depends on ADRs:** None.
- **Referenced specs:** `specs/00-requirements/features/subagents-requirements.md`, `specs/subagent/subagent.md`, `specs/subagent/traceability.md`, `specs/impl/subagents-phase.md`.
