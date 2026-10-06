/**
 * Core types for the native subagent capability.
 *
 * A subagent is defined per tool call by the orchestrator: a short `role`
 * label, the full `instructions` for the work, and optionally a `model` and a
 * `tools` allowlist. A call may instead name an agent definition file
 * (`{ agent: "reviewer" }`, see `agents.ts`); that resolves to defaults which
 * are merged into the inline fields before validation, so `SubagentSpec` is
 * still the whole definition by the time a runner sees it.
 *
 * Everything here is runtime-agnostic on purpose. `SubagentRunner` is the seam:
 * the shipped implementation spawns a `pi` subprocess, but an in-process
 * `AgentSession` runner can replace it without touching the tool surface.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { CompletionEscalation } from "./result-record.ts";

/** How the orchestrator dispatched a set of subagent tasks. */
export type SubagentMode = "single" | "parallel" | "chain" | "resume" | "dag";

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
	/**
	 * Thinking level for the child (#1046), usually from an agent definition
	 * file's `thinking` key. Applies whether or not the model is inherited; omit
	 * to fall back to the parent's level, which only carries over on an inherited
	 * model (a pinned model may not support it).
	 */
	thinking?: ThinkingLevel;
	/** Allowlist of built-in tool names. Omit for the full coding tool set. */
	tools?: string[];
	/** Working directory for the child process. Omit to inherit the parent's cwd. */
	cwd?: string;
	/** Persisted child session file to resume. Wins over `parentSessionFile`. */
	sessionFile?: string;
	/**
	 * JSON Schema the child's final output must satisfy (#1045). When set, the
	 * parent appends a structured-output instruction to the child prompt, then
	 * parses the final output and validates it after the child settles; a
	 * mismatch turns the run into a failed `SubagentResult`. Validated by the
	 * parent, never inside the child, so a parallel batch reports per-task.
	 *
	 * Only enforced on the paths that settle in the parent process (inline
	 * single / parallel / chain and inline redirects). A `background` dispatch
	 * settles in the detached-run pipeline, which does not run the contract.
	 */
	outputSchema?: Record<string, unknown>;
	/**
	 * Host-run verify command for the child's work (#1045): `pnpm check`, a
	 * `test --filter` invocation, and so on. Runs on the **host** after the
	 * child settles — never through the child's own bash tool — so the verdict
	 * is not something the graded agent can decline to produce. Skipped when the
	 * child failed or its output did not validate.
	 */
	gate?: SubagentGate;
}

/**
 * One authored node of a `dag` call (#1052): a `SubagentSpec` plus the upstream
 * nodes it waits for. Nodes are keyed by their `role`, so `dependsOn` lists
 * roles — `"reviewer"` names the node whose role is `"reviewer"`, and the value
 * may also be the authoring index as a string (`"0"`) for a nameless node.
 */
export interface DagNodeSpec extends SubagentSpec {
	/** Roles of the nodes this node waits for. Omitted or empty: a root node. */
	dependsOn?: string[];
}

/** A `gate` declaration on a spec. */
export interface SubagentGate {
	/** Command line, run through the platform shell by the host. */
	command: string;
	/** Directory to run it in. Omit to use the same directory the child ran in. */
	cwd?: string;
	/** Hard wall-clock limit. Default: `DEFAULT_GATE_TIMEOUT_MS` (5 minutes). */
	timeoutMs?: number;
}

/** Default wall-clock limit for a host-run `gate` command. */
export const DEFAULT_GATE_TIMEOUT_MS = 300_000;

/** Combined stdout+stderr cap kept from a `gate` command's output. */
export const GATE_OUTPUT_CAP_BYTES = 64 * 1024;

/**
 * Outcome of one host-run `gate` command, recorded on the settled result.
 *
 * On a passing run this is details-only — the verdict is never injected into the
 * model-facing text, because the model already got a successful tool result and
 * the transcript is the child's, not the gate's. On a failing run the verdict
 * plus bounded excerpts become the failure message.
 */
export interface SubagentGateOutcome {
	command: string;
	/** Resolved directory the command ran in. */
	cwd: string;
	passed: boolean;
	exitCode: number;
	durationMs: number;
	timedOut: boolean;
	cancelled: boolean;
	/** Bounded stdout excerpt (cap: `GATE_OUTPUT_CAP_BYTES` across both streams). */
	stdout: string;
	stderr: string;
	/** True when the excerpts were cut to the cap. */
	truncated: boolean;
	/** Set when the command never ran: `"child-failed"` or `"schema-failed"`. */
	skipped?: "child-failed" | "schema-failed";
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
	/**
	 * Directory the child's file control plane lives in: `<taskDir>/control/` is the
	 * inbox the parent files steer/stop/interrupt requests into (issue #1047) and
	 * `<taskDir>/supervisor/` carries the child's `contact_supervisor` questions and
	 * the parent's replies (issue #1048). A background run already has one — the
	 * directory holding its `log.jsonl` — and a foreground run gets one keyed by its
	 * run id. The runner maps it to `PI_SUBAGENT_CONTROL_DIR` /
	 * `PI_SUBAGENT_SUPERVISOR_DIR` for the child process; when it is absent the
	 * runner derives a default from the run id it minted.
	 */
	taskDir?: string;
	/**
	 * Delegation depth of the child to launch. The root session is 0, so its
	 * direct children are 1. Passed to the child on argv so the child resolves
	 * its own tool set without `subagent` once the depth budget is spent —
	 * see `subagent.maxDepth`.
	 */
	depth?: number;

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
	/**
	 * Set by the background settle path (#1051) when this failure is the
	 * threshold-th consecutive failure of the same role with an identical error
	 * signature. It rides the settle notification only: an inline run never
	 * carries it, because a streak is a property of the background queue's
	 * history, not of one child process.
	 */
	escalation?: CompletionEscalation;
	/**
	 * Parsed JSON value the child's final output validated against `spec.outputSchema`
	 * (#1045). Present only when the spec declared a schema AND the output
	 * satisfied it; absent otherwise, so a consumer can trust the field's type.
	 */
	structuredOutput?: unknown;
	/**
	 * Validation state for a spec that declared `outputSchema`. Absent when the
	 * spec had no schema. `failed` makes this a failed result and puts the
	 * per-property errors in `errorMessage`.
	 */
	outputValidation?: SubagentOutputValidation;
	/** Host-run verify command outcome, when the spec declared `gate`. */
	gate?: SubagentGateOutcome;
}

export interface SubagentOutputValidation {
	status: "passed" | "failed";
	/** Per-property error strings; empty when `status === "passed"`. */
	errors: string[];
	/** Set when the final output was not parseable JSON at all. */
	parseError?: string;
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
	if (result.aborted || result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
		return true;
	}
	// Contract failures (#1045) are reported through these two fields rather
	// than by faking a process exit code: the child did exit cleanly, and the
	// run still did not deliver what was asked of it.
	if (result.outputValidation && result.outputValidation.status === "failed") return true;
	if (result.gate && result.gate.skipped === undefined && !result.gate.passed) return true;
	return false;
}

/** Model-facing text for one result: final output, or the best available diagnostic. */
export function getSubagentResultOutput(result: SubagentResult): string {
	if (isFailedSubagentResult(result)) {
		return result.errorMessage || result.stderr || result.finalOutput || "(no output)";
	}
	return result.finalOutput || "(no output)";
}
