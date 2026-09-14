/**
 * Research Mode — heuristic 3x-same-error tool-call trigger.
 *
 * Tracks consecutive tool-call failures per session. When the same error
 * string appears 3 times in a row, fires a notify() and appends a
 * RESEARCH_MODE_TRIGGERED event to the active experiment's log (if any).
 *
 * The trigger is opt-in per session; the user can disable via
 * /experimental off. We never auto-spawn a scratch worktree — the agent
 * still has to decide to enter Research Mode.
 */

import { appendLogEvent } from "./runner.ts";

const DEFAULT_THRESHOLD = 3;

export interface ResearchModeOptions {
	threshold?: number;
	/** Hook to surface the trigger to the user. */
	notify?: (message: string, type: "info" | "warning" | "error") => void;
}

interface SessionState {
	count: number;
	lastError: string;
	disabled: boolean;
}

export class ResearchModeTracker {
	private readonly sessions = new Map<string, SessionState>();
	private readonly threshold: number;
	private readonly notify: (message: string, type: "info" | "warning" | "error") => void;

	constructor(opts: ResearchModeOptions = {}) {
		this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
		this.notify =
			opts.notify ??
			(() => {
				/* no-op when no UI is available */
			});
	}

	/**
	 * Record a tool-call result. Returns true if Research Mode was just triggered.
	 */
	recordToolResult(
		sessionId: string,
		toolName: string,
		isError: boolean,
		errorText: string | undefined,
		experimentLogPath: string | undefined,
	): boolean {
		const state = this.sessions.get(sessionId) ?? { count: 0, lastError: "", disabled: false };
		if (state.disabled) {
			this.sessions.set(sessionId, state);
			return false;
		}

		if (!isError || !errorText) {
			// successful call — reset streak
			state.count = 0;
			state.lastError = "";
			this.sessions.set(sessionId, state);
			return false;
		}

		// Compare on a normalised fingerprint so formatting differences don't reset the streak.
		const fingerprint = normaliseError(errorText, toolName);
		if (fingerprint === state.lastError) {
			state.count += 1;
		} else {
			state.count = 1;
			state.lastError = fingerprint;
		}
		this.sessions.set(sessionId, state);

		if (state.count >= this.threshold) {
			this.notify(
				`Research Mode suggested: same error ${state.count}x on ${toolName} — consider a minimal repro in a fresh scratch worktree.`,
				"warning",
			);
			if (experimentLogPath) {
				appendLogEvent(experimentLogPath, {
					type: "RESEARCH_MODE_TRIGGERED",
					tool: toolName,
					error: errorText,
					streak: state.count,
				});
			}
			return true;
		}
		return false;
	}

	setDisabled(sessionId: string, disabled: boolean): void {
		const state = this.sessions.get(sessionId) ?? { count: 0, lastError: "", disabled: false };
		state.disabled = disabled;
		if (disabled) {
			state.count = 0;
			state.lastError = "";
		}
		this.sessions.set(sessionId, state);
	}

	reset(sessionId: string): void {
		this.sessions.delete(sessionId);
	}
}

function normaliseError(text: string, toolName: string): string {
	// Strip leading/trailing whitespace, collapse internal whitespace, drop line numbers and timestamps.
	return text
		.replace(/\s+/g, " ")
		.replace(/\b\d{1,3}:\d{2}(?::\d{2})?\b/g, "<ts>")
		.replace(/\bline\s+\d+\b/gi, "line <n>")
		.replace(/\bcolumn\s+\d+\b/gi, "col <n>")
		.replace(new RegExp(`\\b${toolName}\\b`, "gi"), "<tool>")
		.trim();
}
