# Fix parallel tool batches losing completed results when one sibling stalls

## Summary

Restructure `executeToolCallsParallel` in `packages/agent/src/agent-loop.ts` so that each sibling's `toolResultMessage` is persisted (emitted) at that sibling's own completion, never gated on the batch's `Promise.all` barrier. Add an abort race so the barrier can be abandoned when the user presses Esc, synthesizing "Operation aborted" outcomes for never-settled siblings so no tool call is orphaned.

## Root Cause

In the previous implementation, `createToolResultMessage` + `emitToolResultMessage` ran in a sequential loop **after** `await Promise.all(...)`. This meant:

1. `tool_execution_end` was emitted per sibling on completion (from #3503), but the toolResult message was not persisted until **all** siblings settled.
2. If one tool stalled (e.g. a network socket ignoring the abort signal), the `Promise.all` barrier never resolved.
3. While waiting, **no** toolResult was persisted to `Agent.state.messages` via `message_end` → `agent.ts::processEvents`.
4. On the next turn, `transformMessages` synthesised `isError: true "No result provided"` for every tool in the batch.
5. The UI appeared frozen because `turn_end`/`agent_end` were never reached.

## The Fix

### Per-sibling persistence
Each prepared tool call thunk now calls `createToolResultMessage` + `emitToolResultMessage` inline on its own completion, before resolving. Completed siblings can no longer be gated by a stalled sibling.

### Claim map
A `Map<toolCallId, ToolResultMessage>` coordinates emission with the abort race. Whoever inserts an id into the map is the one to emit that result. The check-before-insert never spans an `await`, so every `toolCallId` gets exactly one emitted `toolResult` — including when a stalled sibling settles after the batch was already abandoned on abort (it sees the claim and stays silent).

### Abort race
`Promise.race([allSettled, waitForAbort(signal)])` lets the function exit even when a sibling ignores the abort signal. On abort, `synthesizeAbortedOutcomes` builds error outcomes for any sibling that never settled (or whose thunk's emission was still in-flight), emitting `tool_execution_end` + `toolResult` for each so UIs clear their "running" state.

### Return-value semantics preserved
The returned `messages` array and `turn_end.toolResults` remain in assistant source order regardless of completion order, so downstream consumers and `shouldTerminateToolBatch` are unaffected.

## Behavior Change

**In parallel mode, `toolResult` message events (`message_start`/`message_end`) are now emitted in tool completion order** rather than assistant source order. `turn_end.toolResults` and the messages returned from the batch remain in assistant source order (matched by `toolCallId`). This mirrors the existing `tool_execution_end` completion-order semantics from #3503. Extensions and UIs that consume `toolResult` events should be updated accordingly.

## Files Changed

- `packages/agent/src/agent-loop.ts` — restructured `executeToolCallsParallel`
- `packages/agent/src/types.ts` — updated `ToolExecutionMode` and `AgentLoopConfig.toolExecution` TSDoc
- `packages/agent/test/agent-loop.test.ts` — updated one existing test + 6 new regression tests
- `packages/coding-agent/docs/extensions.md` — updated `tool_execution_*` and `tool_result` documentation

## Test Commands

```bash
# Run agent-loop tests (21 original + 6 new = 27 passing)
cd packages/agent && npx vitest --run test/agent-loop.test.ts

# Typecheck
cd .. && npx tsc --noEmit -p packages/agent/tsconfig.build.json
```

## Related Issues

Fixes #7053. Related to the broader `Promise.all`-barrier pattern: #7113, #6665, #7153, #6755.
