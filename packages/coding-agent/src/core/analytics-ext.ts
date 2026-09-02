/**
 * Analytics InlineExtension.
 *
 * Wires pi run events to the SQLite analytics store when analytics is enabled.
 * This extension is injected via `extensionFactories` in `createAgentSession`
 * so it participates in the normal extension lifecycle without requiring any
 * changes to the public SDK surface.
 *
 * Tracked events:
 *   - `agent_start`          → begin run
 *   - `turn_start`           → increment turn count
 *   - `tool_execution_start` → record invocation start
 *   - `tool_execution_end`   → record invocation end + error rate
 *   - `session_compact`      → record compaction event
 *   - `agent_settled`        → flush run to SQLite (immediate, no batching)
 */

import { getAnalyticsStore } from "./analytics-store.ts";
import type {
	AgentSettledEvent,
	AgentStartEvent,
	ExtensionAPI,
	SessionCompactEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnStartEvent,
} from "./extensions/types.ts";

interface ToolInFlight {
	toolName: string;
	startTime: number;
}

let _analyticsEnabled = false;
let _trackingId: string | null = null;
let _sessionId = "";

// Track in-flight tool invocations keyed by toolCallId
const _toolInFlight = new Map<string, ToolInFlight>();

/**
 * Set the session ID for analytics instrumentation.
 * Called by the session layer before the extension factory is invoked.
 * If not set, a placeholder is used.
 */
export function setAnalyticsSessionId(sessionId: string): void {
	_sessionId = sessionId;
}

export function createAnalyticsExtension(
	enabled: boolean,
	trackingId: string | null,
	sessionId: string,
): (api: ExtensionAPI) => void {
	_analyticsEnabled = enabled;
	_trackingId = trackingId;
	_sessionId = sessionId;

	return (api: ExtensionAPI) => {
		if (!_analyticsEnabled) return;

		// Register an internal flag so other extensions (e.g. subagent) can guard
		// their instrumentation with api.getFlag("pi:analytics").
		api.registerFlag("pi:analytics", { type: "boolean", default: true });

		api.on("agent_start", (_event: AgentStartEvent) => {
			_toolInFlight.clear();
			getAnalyticsStore().beginRun(_sessionId, _trackingId);
		});

		api.on("turn_start", (_event: TurnStartEvent) => {
			getAnalyticsStore().recordTurn();
		});

		api.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
			_toolInFlight.set(event.toolCallId, {
				toolName: event.toolName,
				startTime: Date.now(),
			});
		});

		api.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
			const inFlight = _toolInFlight.get(event.toolCallId);
			if (inFlight) {
				const durationMs = Date.now() - inFlight.startTime;
				getAnalyticsStore().recordToolInvocation(inFlight.toolName, event.isError, durationMs);
				_toolInFlight.delete(event.toolCallId);
			}
		});

		api.on("session_compact", (event: SessionCompactEvent) => {
			// success: compaction succeeds when the aborted turn will be retried (overflow)
			// or when it was a manual compaction. durationMs is not on the event — use 0.
			const success = event.willRetry;
			getAnalyticsStore().recordCompaction(event.reason, 0, success, event.willRetry);
		});

		api.on("agent_settled", (_event: AgentSettledEvent) => {
			// Flush is synchronous; SQLite WAL + NORMAL pragma keeps it fast.
			getAnalyticsStore().flushRun("completed");
			_toolInFlight.clear();
		});
	};
}
