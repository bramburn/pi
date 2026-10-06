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
export type SubagentMode = "single" | "parallel" | "chain" | "resume";

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
 * Phase 1 orchestrator decisions for GitHub issue #1043 (persist child session
 * files and support resume for native subagents). Reported and repeated in the
 * commit message for traceability.
 *
 * 1. `SessionHeader.parentSession` is the parent's session **id**, not path.
 *    Resolved at the write site so lineage survives session-file renames and
 *    cross-device moves. Readers (`session-manager.ts` commit path and
 *    `SessionInfo.parentSessionId`) accept the id form.
 * 2. `--session-parent <path|id>` is a public CLI flag and appears in `--help`.
 *    Phase 1 accepts a PATH and errors on a bare session id (id resolution is
 *    deferred to Phase 2 once the id lookup helper lands).
 * 3. The default child session path is whatever `SessionManager.newSession`
 *    returns for a fresh random id. No parallel naming scheme; the id-based
 *    path is the only convention.
 * 4. The `session_start` JSONL event fires exactly once on every child session
 *    open (new, resume, fork, or import). It carries the chosen `sessionFile`
 *    and the `parentSession` id so downstream tooling can reconstruct lineage
 *    without a second bookkeeping channel.
 * 5. Phase 3 message-budget constants are deferred. Phase 1 does not populate
 *    `messageBudget` or `capabilityCeiling` fields and does not extend the
 *    spec-to-argv mapping to pass them to the child.
 * 6. Phase 3 `capabilityCeiling` is deferred. Phase 1 resumes by `sessionFile`
 *    + `session_start` + `parentSession` only; the ceiling is added in Phase 2.
 */

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
	/** Persisted child session file to resume. Wins over `parentSessionFile`. */
	sessionFile?: string;

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
	/** Parent session file path; threaded into the runner so the child can nest under it. */
	parentSessionFile?: string;

	/** 1-based position within a `chain` dispatch, for display. */
	step?: number;
	/** Hard wall-clock limit. Default: no limit. */
	timeoutMs?: number;
	/**
	 * When both `timeoutMs` and this are set, the runner emits a
	 * `checkpoint_pending` event this many milliseconds BEFORE the deadline.
	 * The actual deadline kill fires at the same instant regardless; this is a
	 * best-effort signal to allow the parent to capture partial state.
	 */
	checkpointBeforeDeadlineMs?: number;
	/** Append-only JSONL event log path. */
	logPath?: string;
}

/**
 * One run a runner has dispatched and not yet settled: the control-plane view
 * of a live run. `runId` is the correlation id — the same value the settled
 * `SubagentResult` carries back — so an id read out of a `listRunning()`
 * snapshot can be handed straight to `interrupt()` without the two sides
 * disagreeing about what identifies the run.
 */
export interface InFlightRun {
	/** Runner-generated id, unique per dispatched run. */
	runId: string;
	/** Role name the run was resolved to. */
	role: string;
	/** Task text handed to the child. Untruncated; display callers clip it. */
	task: string;
	/** Resolved working directory the child runs in. */
	cwd: string;
	/** ISO timestamp of the moment the run was registered as in-flight. */
	startedAt: string;
	/** OS pid of the child, when the runner knows it. */
	pid?: number;
	/**
	 * Model id the run was pinned to, when its spec carried one. Absent means
	 * "inherits the parent's model", which is not knowable from here. Stamped by
	 * the runner at registration; the control plane reads it back so a
	 * `swap-model` on a live run can report what it is changing *from*.
	 */
	model?: string;
	/** Tool allowlist the run was pinned to, when its spec carried one. */
	tools?: string[];
	/**
	 * Child session file, stamped the moment the child emits `session_start`.
	 * This is the pre-settle half of the value a settled `SubagentResult`
	 * carries in `sessionFile`, and it is what makes steering a *live* run
	 * possible: `interrupt()` reports only whether the kill landed, never the
	 * session path, so without this the runner would have nothing to hand a
	 * resuming re-dispatch.
	 *
	 * Lives only while the run is in flight — the runner drops the whole entry
	 * when the run settles, and a settled run is resumed from the registry row
	 * (background) or not at all (inline).
	 */
	sessionFile?: string;
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
	/**
	 * Correlation id of the run that produced this result, matching the
	 * `InFlightRun.runId` the same run carried while it was in flight. Lets a
	 * control-plane listing be tied back to a settled result. Undefined for a
	 * result synthesized by a consumer instead of a runner — e.g. the background
	 * registry's crash placeholder, which has no run to name.
	 */
	runId?: string;
	/** Persisted child session file path (set when the child opens a session). */
	sessionFile?: string;
}

export type SubagentEvent =
	| { type: "spawned"; pid: number | undefined }
	| { type: "session_start"; sessionFile: string }
	| { type: "message_end"; message: Message }
	| { type: "tool_result_end"; message: Message }
	| { type: "stderr"; text: string }
	| { type: "checkpoint_pending"; msUntilDeadline: number }
	| { type: "exit"; exitCode: number | null; signal: NodeJS.Signals | null };

export type SubagentEventListener = (event: SubagentEvent) => void;

/**
 * Runtime seam for executing subagents.
 *
 * Implementations must resolve the result for every non-thrown path and honor
 * `signal` by terminating the child. They may throw to report a failure that
 * prevented the run from starting at all.
 *
 * The control-plane pair (`listRunning` / `interrupt`) is optional: a runner may
 * legitimately be a thin shim over a process manager that owns killing, and the
 * stub runners used across the test suite implement `run` only. Consumers must
 * read a missing method as "this runner reports nothing", never as "no runs
 * exist".
 */
export interface SubagentRunner {
	run(
		request: SubagentRunRequest,
		signal: AbortSignal | undefined,
		onEvent?: SubagentEventListener,
	): Promise<SubagentResult>;
	/** Runs this runner has dispatched that have not yet settled. */
	listRunning?(): InFlightRun[];
	/**
	 * Ask one in-flight run to stop, with the same semantics as aborting through
	 * the run's own `AbortSignal`: the child is killed gracefully, escalates if
	 * it survives, and the settled result reports `aborted: true`.
	 *
	 * Returns whether the id belonged to this runner. `false` means "unknown or
	 * already settled", which is the caller's cue to try another registry —
	 * typically the background one.
	 */
	interrupt?(runId: string): Promise<boolean>;
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
