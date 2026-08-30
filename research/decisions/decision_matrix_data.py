"""
Decision matrix v1 data for the DeepSeek Harness feature.

This module is the single source of truth for the 15 architectural
questions in the sign-off xlsx. The build script
(`build_decision_matrix.py`) imports `DECISION_MATRIX_ROWS` and
`EXPECTED_ROW_COUNT`, asserts every required key is present, and
writes the xlsx.

Convention (per user workflow rule, 2026-08-18): "dicts + assert k in d".
Every row is a flat dict with the keys listed in `REQUIRED_ROW_KEYS`
in the build script. If a row is missing a key or has an extra key,
the build refuses to write the xlsx.

The user fills `user_decision` and `user_notes` in the produced xlsx
itself; those columns are not pre-populated here.
"""

from __future__ import annotations

# If you add or remove a row, update this constant. The build script
# asserts `len(DECISION_MATRIX_ROWS) == EXPECTED_ROW_COUNT`.
EXPECTED_ROW_COUNT: int = 15


DECISION_MATRIX_ROWS: list[dict] = [
    {
        "id": 1,
        "question": "Should we ship the deepseek-harness-style context pipeline behind a single opt-in toggle?",
        "phase": "Toggle surface",
        "severity": "High",
        "effort": "L",
        "depends_on": [],
        "affected_files": (
            "packages/coding-agent/src/core/settings-manager.ts, "
            "packages/coding-agent/src/modes/interactive/components/settings-selector.ts, "
            "packages/coding-agent/src/modes/rpc/rpc-types.ts, "
            "packages/coding-agent/src/cli/args.ts"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "The toggle is non-breaking (default off), opt-in, and the minimal surface that "
            "lets the four sub-pipelines ship behind user opt-in. Without it, each sub-pipeline "
            "would have its own flag and the rollout would be incoherent."
        ),
    },
    {
        "id": 2,
        "question": "Should we replace the one-shot overflow recovery with a multi-attempt retry loop?",
        "phase": "Phase 1",
        "severity": "High",
        "effort": "M",
        "depends_on": [1],
        "affected_files": (
            "packages/coding-agent/src/core/agent-session.ts, "
            "packages/agent/src/harness/compaction/compaction.ts"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "Today a single overflow fails the session with a hard error. A multi-attempt "
            "compact-and-retry loop fixes the most visible user symptom of long sessions and is "
            "the single biggest behavioural change for the lowest cost."
        ),
    },
    {
        "id": 3,
        "question": "Should we ship a model-free tool-result re-pruner that walks the session surface every N turns?",
        "phase": "Phase 2",
        "severity": "High",
        "effort": "M",
        "depends_on": [],
        "affected_files": (
            "packages/agent/src/harness/compaction/tool-result-pruner.ts (new), "
            "packages/coding-agent/src/core/agent-session.ts"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "Old tool results sit in the input for the lifetime of the session. Re-pruning them "
            "in place shrinks a 50 KiB-per-result footprint to a few KiB with no LLM call, "
            "letting long sessions work without hitting the input cap."
        ),
    },
    {
        "id": 4,
        "question": "Should we ship an abstract SpillStore with a spill-policy plugin for tool results?",
        "phase": "Phase 2",
        "severity": "Medium",
        "effort": "L",
        "depends_on": [],
        "affected_files": (
            "packages/agent/src/harness/utils/truncate.ts, "
            "packages/agent/src/harness/utils/shell-output.ts, "
            "packages/spill/spill/src/index.ts (new), "
            "packages/spill/spill-policy/src/index.ts (new)"
        ),
        "my_recommendation": "Defer",
        "recommendation_rationale": (
            "The re-pruner (row 3) fixes the worst symptom at lower cost. The full spill abstraction "
            "is a bigger redesign of how tool outputs are stored and only pays off once users ask "
            "for 'show me the original tool output the model did not see'."
        ),
    },
    {
        "id": 5,
        "question": "Should maxTokens be dynamically shaped against the live input size?",
        "phase": "Phase 1",
        "severity": "High",
        "effort": "S",
        "depends_on": [],
        "affected_files": (
            "packages/agent/src/agent-loop.ts, "
            "packages/ai/src/api/anthropic-messages.ts, "
            "packages/ai/src/api/openai-completions.ts, "
            "packages/ai/src/api/openai-responses.ts"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "When the input is 95% of the context window, the model still receives the full "
            "static maxTokens and burns most of it on thinking before the user-visible answer. "
            "Shaping it down to the residual budget avoids the length finish that today produces "
            "a clean cutoff."
        ),
    },
    {
        "id": 6,
        "question": "Should we add per-model compaction policy overrides (so MiniMax gets a different profile)?",
        "phase": "Phase 1",
        "severity": "High",
        "effort": "S",
        "depends_on": [1],
        "affected_files": (
            "packages/coding-agent/src/core/settings-manager.ts, "
            "packages/coding-agent/src/core/agent-session.ts"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "A 1M-context model and a 32K-context model cannot share a single fixed reserveTokens. "
            "Per-model overrides let MiniMax compact more aggressively on cache-friendly providers "
            "and Anthropic compact more conservatively on expensive-output providers."
        ),
    },
    {
        "id": 7,
        "question": "Should workspace AGENTS.md be rendered inside a byte-budgeted <system-reminder> envelope?",
        "phase": "Phase 4",
        "severity": "Medium",
        "effort": "S",
        "depends_on": [],
        "affected_files": (
            "packages/coding-agent/src/core/system-prompt.ts, "
            "packages/agent/src/agent.ts, "
            "packages/agent/src/agent-loop.ts"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "Today a 5 MiB AGENTS.md silently inflates the system prompt and degrades the "
            "model's attention. A byte budget with omission diagnostics and UTF-8-safe truncation "
            "fixes a class of bugs the user cannot currently see."
        ),
    },
    {
        "id": 8,
        "question": "Should we ship an event-sourced token meter with systemTokens / toolsTokens / messageTokens breakdown?",
        "phase": "Phase 1",
        "severity": "Medium",
        "effort": "M",
        "depends_on": [],
        "affected_files": (
            "packages/agent/src/harness/compaction/compaction.ts, "
            "packages/llm/token-meter/src/estimate.ts (new), "
            "packages/llm/token-meter/src/breakdown-projection.ts (new)"
        ),
        "my_recommendation": "Defer",
        "recommendation_rationale": (
            "The current heuristic estimate is good enough for the overflow and pruner paths. "
            "A per-section breakdown is nice-to-have telemetry, not a prerequisite for the user-"
            "visible wins. Defer until we have a real consumer of the per-section numbers."
        ),
    },
    {
        "id": 9,
        "question": "Should we wire the existing harness subsystem (currently a stub) into the production runtime?",
        "phase": "Phase 1",
        "severity": "High",
        "effort": "XL",
        "depends_on": [1, 8],
        "affected_files": (
            "packages/agent/src/harness/agent-harness.ts, "
            "packages/agent/src/agent.ts, "
            "packages/agent/src/agent-loop.ts, "
            "packages/coding-agent/src/core/agent-session.ts"
        ),
        "my_recommendation": "Defer",
        "recommendation_rationale": (
            "The harness class is a stub skeleton with throw-everything-not-implemented methods. "
            "Wiring it in is a multi-week refactor that does not directly improve the user-"
            "visible behaviour. The sub-pipelines (rows 2, 3, 5, 7) can ship without the full "
            "harness integration by hooking the existing transformContext / prepareNextTurn seams."
        ),
    },
    {
        "id": 10,
        "question": "Should we stop the read -> truncate -> read loop by exempting read from the spill policy?",
        "phase": "Phase 2",
        "severity": "Low",
        "effort": "S",
        "depends_on": [3],
        "affected_files": (
            "packages/agent/src/harness/tools/read.ts, "
            "packages/agent/src/harness/utils/shell-output.ts"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "When a file is truncated to 50 KiB head + tail, the model often re-reads it. "
            "Exempting read from the spill policy avoids the loop. Mirrors the deepseek-harness "
            "spill-policy which already skips read for the same reason."
        ),
    },
    {
        "id": 11,
        "question": "Should we surface a graceful 'answer truncated at N tokens - run /compact' notice on length finish?",
        "phase": "Phase 1",
        "severity": "Medium",
        "effort": "S",
        "depends_on": [],
        "affected_files": (
            "packages/agent/src/agent-loop.ts, "
            "packages/agent/src/agent.ts, "
            "packages/coding-agent/src/modes/interactive/interactive-mode.ts"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "Today a clean cutoff on length finish is silent - the user just sees a half answer. "
            "A trailing notice plus a queued follow-up compaction turns a silent failure into a "
            "self-recovering workflow."
        ),
    },
    {
        "id": 12,
        "question": "Should the summarisation call send the live conversation as a prefix to reuse the provider's KV cache?",
        "phase": "Phase 3",
        "severity": "High",
        "effort": "M",
        "depends_on": [1],
        "affected_files": (
            "packages/coding-agent/src/core/compaction/compaction.ts, "
            "packages/ai/src/api/anthropic-messages.ts, "
            "packages/ai/src/api/openai-completions.ts"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "Today the summarisation call serialises the whole conversation as one text block "
            "and pays cache-miss for every token. Prefix-replay turns that into cache-hit + "
            "cache-write, which on a 150K-token session is roughly a 5-10x wall-time and cost "
            "improvement on cache-friendly providers."
        ),
    },
    {
        "id": 13,
        "question": "Should we add a 'model-visible = logged' desync invariant that asserts the LLM request matches the session log?",
        "phase": "Phase 4",
        "severity": "Low",
        "effort": "S",
        "depends_on": [],
        "affected_files": (
            "packages/agent/src/agent-loop.ts, "
            "packages/coding-agent/src/core/agent-session.ts"
        ),
        "my_recommendation": "Defer",
        "recommendation_rationale": (
            "Power-user and debugging feature, not a user-visible improvement. The structural "
            "validateLlmMessages check at agent-loop.ts:302 catches the worst extension bugs "
            "today. Defer until we have a concrete bug class this would have caught."
        ),
    },
    {
        "id": 14,
        "question": "Should we make plan mode a logged section toggle (event-sourced plan/mode) instead of a live mirror?",
        "phase": "Deferred",
        "severity": "Low",
        "effort": "M",
        "depends_on": [],
        "affected_files": (
            "packages/plan/plan-mode/src/index.ts (new), "
            "packages/coding-agent/src/core/agent-session.ts"
        ),
        "my_recommendation": "Defer",
        "recommendation_rationale": (
            "Independent feature. The current plan-mode plumbing works. The event-sourced "
            "fold-on-event refactor is correct but does not move the needle on the user-visible "
            "truncation symptom."
        ),
    },
    {
        "id": 15,
        "question": "Should we switch the tool-result pruner defaults to thresholdChars: 8192, headChars: 4096, tailChars: 1024 (matching the deepseek-harness defaults)?",
        "phase": "Phase 2",
        "severity": "Low",
        "effort": "S",
        "depends_on": [3],
        "affected_files": (
            "packages/agent/src/harness/compaction/tool-result-pruner.ts (new)"
        ),
        "my_recommendation": "Ship",
        "recommendation_rationale": (
            "The deepseek-harness defaults are battle-tested and 6x smaller than the current "
            "50 KiB / 2000-line truncation. Smaller is better for long sessions; the marker "
            "text tells the model what is missing."
        ),
    },
]
