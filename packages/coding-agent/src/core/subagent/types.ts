/**
 * Core types for the native subagent capability.
 *
 * A subagent is defined per tool call by the orchestrator: a short `role`
 * label, the full `instructions` for the work, and optionally a `model` and a
 * `tools` allowlist. There are no agent definition files and no discovery —
 * `SubagentSpec` is the whole definition.
 *
 * Everything here is runtime-agnostic on purpose. `SubagentRunner` is the seam:
 * the shipped implementation spawns a `pi` subprocess, but an in-process
 * `AgentSession` runner can replace it without touching the tool surface.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

/** How the orchestrator dispatched a set of subagent tasks. */
export type SubagentMode = "single" | "parallel" | "chain";

/** Tool results carry their own details payload; the parent only needs these. */
export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Total tokens in the child's context window at the last assistant message. */
	contextTokens: number;
	turns: number;
}

export function createEmptyUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * The complete definition of one subagent, authored by the orchestrator at
 * call time.
 */
export interface SubagentSpec {
	/** Short specialist label shown in the UI and recorded in analytics (e.g. "code-reviewer"). */
	role: string;
	/**
	 * The full task and behavioral guidance. The child starts with a fresh
	 * context and never sees the parent conversation, so this must carry every
	 * piece of context the subagent needs.
	 */
	instructions: string;
	/** Model id (`provider/model` or a bare id resolved by the child). Omit to inherit the parent model. */
	model?: string;
	/** Allowlist of built-in tool names. Omit for the full coding tool set. */
	tools?: string[];
	/** Working directory for the child process. Omit to inherit the parent's cwd. */
	cwd?: string;
}

/** Everything needed to launch one subagent run. */
export interface SubagentRunRequest {
	spec: SubagentSpec;
	/** The concrete task message. For the native tool this is `spec.instructions`. */
	task: string;
	/** Resolved working directory (already merged with `spec.cwd` and the parent cwd). */
	cwd: string;
	/** Model the parent session is using, used when `spec.model` is absent. */
	parentModel?: string;
	/** Thinking level the parent session is using, used when `spec.model` is absent. */
	parentThinkingLevel?: ThinkingLevel;
	/** 1-based position within a `chain` dispatch, for display. */
	step?: number;
	/** Hard wall-clock limit. Default: no limit. */
	timeoutMs?: number;
	/** Append-only JSONL event log path. */
	logPath?: string;
}

/** Outcome of one subagent run. */
export interface SubagentResult {
	role: string;
	task: string;
	/**
	 * Process exit code. Always a number — widening to `null` was rejected
	 * because consumers require one. A child that survives even the force-kill
	 * reports HARD_KILL_EXIT_CODE (137) instead, and the kill context lives in
	 * `aborted` (a timeout additionally sets `errorMessage`).
	 */
	exitCode: number;
	aborted: boolean;
	finalOutput: string;
	stderr: string;
	usage: SubagentUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	/** Full child transcript. Kept in tool details, not in the model-facing text. */
	messages: Message[];
}

export type SubagentEvent =
	| { type: "spawned"; pid: number | undefined }
	| { type: "message_end"; message: Message }
	| { type: "tool_result_end"; message: Message }
	| { type: "stderr"; text: string }
	| { type: "exit"; exitCode: number | null; signal: NodeJS.Signals | null };

export type SubagentEventListener = (event: SubagentEvent) => void;

/**
 * Runtime seam for executing subagents.
 *
 * Implementations must resolve the result for every non-thrown path and honor
 * `signal` by terminating the child. They may throw to report a failure that
 * prevented the run from starting at all.
 */
export interface SubagentRunner {
	run(
		request: SubagentRunRequest,
		signal: AbortSignal | undefined,
		onEvent?: SubagentEventListener,
	): Promise<SubagentResult>;
}

export function isFailedSubagentResult(result: SubagentResult): boolean {
	return result.aborted || result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/** Model-facing text for one result: final output, or the best available diagnostic. */
export function getSubagentResultOutput(result: SubagentResult): string {
	if (isFailedSubagentResult(result)) {
		return result.errorMessage || result.stderr || result.finalOutput || "(no output)";
	}
	return result.finalOutput || "(no output)";
}
