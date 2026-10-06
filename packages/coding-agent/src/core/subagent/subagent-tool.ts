/**
 * The native `subagent` tool.
 *
 * The orchestrator authors each subagent at call time — `role` (short label),
 * `instructions` (the complete task; the child never sees the parent
 * conversation), and optionally `model` and a `tools` allowlist. A call may
 * instead name an agent definition file with `agent` (see `agents.ts`), which
 * supplies those defaults so the same user-written agent is reused everywhere.
 *
 * Modes (exactly one per call):
 * - single:  `{ role, instructions, ... }`
 * - parallel: `{ tasks: [spec, ...] }` — independent, capped and concurrency-limited
 * - chain:   `{ chain: [spec, ...] }` — sequential, `{previous}` in a step's
 *   instructions is replaced with the previous step's output; stops at the
 *   first failure.
 *
 * Background (`background: true`) dispatch fires detached tasks; the on-disk
 * registry is the record of what is running.
 *
 * Agent dispatch (`agent: "<name>"`) resolves one name against two stores,
 * definition files first: a markdown file under `.pi/agents/` (project scope,
 * then user scope) provides configuration — model, tools, thinking, a standing
 * system prompt — while the call still supplies the task in `instructions`; an
 * older `action: "save-spec"` entry provides both, and takes `instructions`
 * from the store instead. Files win over saved specs on a name collision
 * because a hand-authored definition is the deliberate one. Either way
 * resolution happens before mode validation, so `agent` occupies the
 * single-dispatch slot, and `role` / `tasks` / `chain` are never accepted
 * alongside it.
 *
 * Control (`action`) manages runs instead of starting one. Beyond listing and
 * killing, `steer` and `swap-model` interrupt a target and re-dispatch it
 * against its own child session, carrying the new instruction in the
 * replacement run's prompt; `resume` skips the kill and re-dispatches a run that
 * has already settled against the session file its registry row recorded. See
 * `handleManagementAction` for the exact admission rules — a background task
 * whose child has not provably settled is never steered, because two processes
 * appending to one session file corrupts it. Every redirect (steer, swap-model,
 * resume) holds a cross-process lease on the child session file for its whole
 * duration (`session-lease.ts`), so a second pi process cannot revive the same
 * session in the window between the old child settling and the replacement
 * opening it.
 *
 * Spawn budget: a session-wide counter (`subagent.maxTotalSpawns`, default 64)
 * caps the total number of subagent spawns across all dispatch paths —
 * inline and background share the same budget. The check is atomic per call:
 * if a batch would push the counter past the cap, the whole call is rejected
 * (no partial admission).
 *
 * Services arrive through the options bag, not `ExtensionContext`: the runner,
 * the settings reader (registration guard), concurrency limits, and a getter for
 * the parent session's model + thinking level (read at dispatch time so
 * mid-session model changes are inherited).
 *
 * Analytics: one `pi_subagent_tasks` span per dispatched run (`role` as the
 * task label). The store self-gates on an active run, so no enable flag is
 * needed here.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import { endSubagentTask, newTaskSpanId, startSubagentTask } from "../analytics-store.ts";
import { DEFAULT_SUBAGENT_SETTINGS, type ResolvedSubagentSettings } from "../defaults.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { agentsDirs, listAgents, resolveAgent } from "./agents.ts";
import {
	type BackgroundRegistry,
	backgroundTaskDir,
	getBackgroundRegistry,
	queuedTaskIds,
	queuePositionOf,
	releaseBackgroundDispatch,
	requestBackgroundDispatch,
} from "./background.ts";
import { createBunProcessRunner } from "./bun-process-runner.ts";
import {
	type ControlAction,
	type ControlReceiptState,
	claimControlRequest,
	controlDirFor,
	formatControlRequestsForStatus,
	recordControlState,
	writeControlRequest,
} from "./control.ts";
import { createDagRun, type DagStateFile, makeDagRunId, runDagInline, startDagDetached } from "./orchestration.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { isBunRuntime } from "./runtime.ts";
import { deleteSpec, listSpecs, loadSpec, saveSpec } from "./saved-specs.ts";
import {
	checkSchemaSupport,
	extractJsonFromText,
	formatSchemaErrors,
	validateAgainstSchema,
} from "./schema-validate.ts";
import { acquireSessionLease, SessionLeaseConflictError, type SessionLeaseHandle } from "./session-lease.ts";
import { runShellLine } from "./shell.ts";
import {
	formatOpenSupervisorRequests,
	listOpenSupervisorRequests,
	supervisorDirFor,
	writeSupervisorReply,
} from "./supervisor-channel.ts";
import {
	createEmptyUsage,
	DEFAULT_GATE_TIMEOUT_MS,
	GATE_OUTPUT_CAP_BYTES,
	getSubagentResultOutput,
	isFailedSubagentResult,
	type SubagentEventListener,
	type SubagentGate,
	type SubagentGateOutcome,
	type SubagentMode,
	type SubagentResult,
	type SubagentRunner,
	type SubagentRunRequest,
	type SubagentSpec,
} from "./types.ts";

/**
 * Model-facing output cap: parallel per-task summaries, single/chain result
 * text, and the `{previous}` substitution input. Full output stays in tool
 * details.
 */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

const subagentSpecProperties = {
	role: Type.String({
		description:
			"Short specialist label for the subagent, e.g. 'code-reviewer' or 'scout'. Shown in the UI and analytics.",
	}),
	instructions: Type.String({
		description:
			"The complete task and behavioral guidance. The subagent runs with a fresh context and never sees this conversation, so include every piece of context it needs to succeed.",
	}),
	model: Type.Optional(
		Type.String({
			description: "Model id for the subagent. Omit to inherit this session's model and thinking level.",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Allowlist of built-in tool names (read, bash, edit, write, grep, find, ls). Omit for the full coding set.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the subagent. Omit to inherit this session's working directory.",
		}),
	),
	outputSchema: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"JSON Schema this task's final output must satisfy. When set, the child is told to end with exactly one JSON value matching it, and the host parses and validates the final output after the child settles: a mismatch fails this task (errors reported per task, the other tasks keep running) and a match attaches the parsed value to the result details as `structuredOutput`. Supports type (including type arrays), properties, required, enum, items (single or tuple form), additionalProperties: false, oneOf, anyOf, minimum/maximum, minLength/maxLength, pattern; any other construct is rejected before the child is spawned. Enforced on inline runs only: a `background` dispatch is rejected outright when these fields are present, and a replacement child spawned by steer, swap-model, or resume inherits the task text but not the contract.",
		}),
	),
	gate: Type.Optional(
		Type.Object(
			{
				command: Type.String({
					description:
						"Shell command line the host runs after this child settles to verify its work (e.g. 'bun run check', 'pnpm test --filter x'). Run by the host, not by the child's own bash tool, so the verdict cannot be skipped. A non-zero exit or a timeout fails this task with the verdict plus bounded output excerpts; a passing verdict appears in tool details only and is not added to the model-facing text. Skipped when the child failed or its output did not validate against `outputSchema`.",
				}),
				cwd: Type.Optional(
					Type.String({
						description:
							"Working directory for the gate command. Relative paths resolve against this subagent's working directory. Omit to run where the subagent ran.",
					}),
				),
				timeoutMs: Type.Optional(
					Type.Number({
						description: `Wall-clock limit for the gate command in milliseconds. Default ${DEFAULT_GATE_TIMEOUT_MS} (5 minutes).`,
					}),
				),
			},
			{
				description: "Host-run verify command for this task's work.",
			},
		),
	),
};

const subagentSpecSchema = Type.Object(subagentSpecProperties);

/**
 * A `dag` entry (#1052): every `tasks` / `chain` field plus `dependsOn`, the
 * nodes this one waits for. Nodes are keyed by role, so `dependsOn` lists roles.
 */
const subagentDagNodeSchema = Type.Object({
	...subagentSpecProperties,
	dependsOn: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Roles of the nodes this node waits for, e.g. ['scout']. Omit or pass [] to start immediately. A node runs as soon as every node listed here has settled successfully; a node whose upstream failed or was skipped is itself skipped without spawning a child. Reference an upstream node's output from `instructions` as {{nodes.<role>.result}} — referencing a node not listed here is rejected before anything spawns.",
		}),
	),
});

export const subagentSchema = Type.Object({
	role: Type.Optional(
		Type.String({
			description:
				"Short specialist label for the subagent, e.g. 'code-reviewer' or 'scout'. Shown in the UI and analytics.",
		}),
	),
	instructions: Type.Optional(
		Type.String({
			description:
				"The complete task and behavioral guidance. The subagent runs with a fresh context and never sees this conversation, so include every piece of context it needs to succeed. In chain mode, '{previous}' is replaced with the previous step's output.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "Model id for the subagent. Omit to inherit this session's model and thinking level.",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Allowlist of built-in tool names (read, bash, edit, write, grep, find, ls). Omit for the full coding set.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the subagent. Omit to inherit this session's working directory.",
		}),
	),
	// The thinking levels are spelled out because TypeBox infers a literal union
	// only from an explicit tuple — mapping `THINKING_LEVEL_OPTIONS` here yields an
	// `undefined` static type. `test/subagent-tool.test.ts` asserts this list stays
	// equal to `THINKING_LEVEL_OPTIONS`, so the two cannot drift apart.
	thinking: Type.Optional(
		Type.Union(
			[
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
			],
			{
				description:
					"Thinking level for the subagent, applied whether or not the model is inherited. Omit to use this session's level (which applies only when the model is inherited too). An `agent` dispatch takes the level from the definition file when this is absent.",
			},
		),
	),
	outputSchema: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"JSON Schema the subagent's final output must satisfy (single-dispatch form; each `tasks` or `chain` entry can also carry its own). Same subset and same inline-only enforcement as the `tasks` entry description.",
		}),
	),
	gate: Type.Optional(
		Type.Object(
			{
				command: Type.String({
					description:
						"Shell command line the host runs after the subagent settles to verify its work (single-dispatch form; each `tasks` or `chain` entry can also carry its own). Same behavior as the `tasks` entry description: host-run, non-zero exit or timeout fails the run, a passing verdict stays in tool details.",
				}),
				cwd: Type.Optional(
					Type.String({
						description:
							"Working directory for the gate command. Relative paths resolve against this subagent's working directory. Omit to run where the subagent ran.",
					}),
				),
				timeoutMs: Type.Optional(
					Type.Number({
						description: `Wall-clock limit for the gate command in milliseconds. Default ${DEFAULT_GATE_TIMEOUT_MS} (5 minutes).`,
					}),
				),
			},
			{
				description: "Host-run verify command for this subagent's work.",
			},
		),
	),
	tasks: Type.Optional(
		Type.Array(subagentSpecSchema, {
			description:
				"Independent subagent tasks to run in parallel. Mutually exclusive with role/instructions and chain.",
		}),
	),
	chain: Type.Optional(
		Type.Array(subagentSpecSchema, {
			description:
				"Sequential subagent steps. '{previous}' in a step's instructions is replaced with the previous step's output. Stops at the first failure. Mutually exclusive with role/instructions and tasks.",
		}),
	),
	dag: Type.Optional(
		Type.Array(subagentDagNodeSchema, {
			description:
				"Declarative dependency graph of subagent nodes. Each node declares `dependsOn` roles; a node starts as soon as its upstream nodes have settled successfully, so independent branches run in parallel and only the edges serialize (up to subagent.maxConcurrent children at once, and every node counts against subagent.maxTotalSpawns). A failed node skips its transitive dependents while unrelated branches continue; there is no partial re-run. Every node's role must be non-empty and unique. Mutually exclusive with role/instructions, tasks, and chain.",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Fire-and-forget mode. The call returns immediately with task id(s); each subagent runs detached and its result is delivered when it settles. Default false (synchronous).",
			default: false,
		}),
	),
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("status"),
				Type.Literal("stop"),
				Type.Literal("interrupt"),
				Type.Literal("steer"),
				Type.Literal("swap-model"),
				Type.Literal("resume"),
				Type.Literal("save-spec"),
				Type.Literal("list-specs"),
				Type.Literal("delete-spec"),
				Type.Literal("supervisor"),
			],
			{
				description:
					"Control-plane call in place of a dispatch. 'status' lists every subagent run that has not settled, along with anything filed in its control inbox and the questions it has asked that nobody answered; 'stop' and 'interrupt' are synonyms that ask one run to stop; 'steer' interrupts one run and re-dispatches it against its own child session with `message` appended; 'swap-model' does the same with a new `model` (plus optional `message`); 'resume' re-dispatches a run that has already settled against the child session it left behind, with an optional `message` as the continuation instruction; 'supervisor' reads the open questions a run has asked its parent, and answers one when `replyTo` and `message` are given; 'save-spec' stores the dispatch fields of this call under `name`; 'list-specs' lists saved specs; 'delete-spec' removes the one under `name`. Mutually exclusive with role/instructions, tasks, and chain. Listing and spec calls spawn nothing, so the spawn budget is untouched; steer, swap-model and resume re-dispatch through the normal path, which does account for the spawn budget.",
			},
		),
	),
	id: Type.Optional(
		Type.String({
			description:
				"Target of action 'stop'/'interrupt'/'steer'/'swap-model'/'resume'/'supervisor': an inline run id or a background task id, exactly as reported by action 'status'. Required for those actions.",
		}),
	),
	message: Type.Optional(
		Type.String({
			description:
				"New instruction for action 'steer' (required), an optional continuation note for action 'swap-model' or action 'resume', the answer for action 'supervisor' when `replyTo` names the question. Ignored by the other actions.",
		}),
	),
	replyTo: Type.Optional(
		Type.String({
			description:
				"Open supervisor question to answer for action 'supervisor', as reported by that action without `replyTo` or by the run's `status` rows. Requires `message`; the child asking the question picks the reply up from its run directory.",
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				"Dispatch a reusable agent by name instead of defining one inline: an agent definition file under `.pi/agents/<name>.md` (project scope first, then the user-level agent dir), or a spec stored by action 'save-spec'. Files win over stored specs on a name collision. A definition file supplies configuration (`model`, `tools`, `thinking`, a standing system prompt prepended to the task) while `instructions` still carries this call's task; a stored spec supplies the task too, so `instructions` is then rejected. `model` / `tools` / `thinking` / `cwd` given here override the file or spec, and the name is resolved before mode validation, so the call occupies the single-dispatch slot. Mutually exclusive with `role`, `tasks`, and `chain`.",
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"Spec name for action 'save-spec' and action 'delete-spec'. A bare filesystem-safe label: no path separators and no '..'. Saving over an existing name overwrites it in place.",
		}),
	),
});

export type SubagentToolInput = Static<typeof subagentSchema>;

export interface SubagentToolDetails {
	mode: SubagentMode;
	results: SubagentResult[];
	/** Present when the call dispatched background tasks instead of running inline. */
	background?: boolean;
	taskIds?: string[];
	/**
	 * The orchestration state file for a `dag` call (#1052): node statuses, levels,
	 * and timestamps, mirrored from `dag-state.json`. `results` carries the same
	 * rows in authoring order; this is the structured view the renderer reads.
	 */
	dag?: DagStateFile;
	/**
	 * Present when the call was a control-plane action instead of a dispatch.
	 * `results` is empty for those calls, with one exception: `steer`,
	 * `swap-model` and `resume` re-dispatch a replacement run through the normal
	 * path, so they carry that run's result. The other actions only report on
	 * other runs and never produce one.
	 */
	action?:
		| "status"
		| "stop"
		| "interrupt"
		| "steer"
		| "swap-model"
		| "resume"
		| "save-spec"
		| "list-specs"
		| "delete-spec"
		| "supervisor";
}

/** Minimal settings surface consulted by the registration guard. */
export interface SubagentSettingsReader {
	get(key: string): unknown;
}

export interface SubagentToolOptions {
	/** Runner used for every subagent. Defaults to the Bun subprocess runner, created lazily. */
	runner?: SubagentRunner;
	/** Settings reader; the guard reads the `subagent.enabled` master switch from it. */
	settings?: SubagentSettingsReader;
	/**
	 * Live `subagent.*` settings (maxConcurrent, maxParallelTasks, worktreeBase),
	 * read at dispatch time so mid-session settings changes take effect without a
	 * runtime rebuild. Defaults to DEFAULT_SUBAGENT_SETTINGS when absent.
	 */
	subagentSettings?: () => ResolvedSubagentSettings;
	/**
	 * Delegation depth of THIS process: 0 for the top-level session, 1 for a
	 * child it spawned. Read once at registration from `--subagent-depth`.
	 *
	 * This is the parent-side half of the depth guard. The load-bearing half is
	 * in the child, which drops `subagent` from its own tool set once its depth
	 * reaches `subagent.maxDepth` — a check here alone would be advisory,
	 * because the grandchild's model would still see a working delegation tool.
	 */
	depth?: number;
	/** Parent session model + thinking level, read at dispatch time for inheritance. */
	getParentContext?: () => { model?: string; thinkingLevel?: ThinkingLevel };
	/**
	 * Path of the parent session file. Read at dispatch time so the child
	 * `pi` process can nest its own session under the parent's session
	 * directory via `--session-parent`. Undefined when the parent is in-memory
	 * (ephemeral callers) or the spec is resuming an existing child session
	 * (which uses `--session` instead).
	 */
	getParentSessionFile?: () => string | undefined;
	/**
	 * Resolve a requested model id to its canonical `provider/model` form.
	 * Return undefined for unknown ids — the call then fails with a tool error
	 * naming the model instead of dispatching a doomed child. Wired from
	 * `findExactModelReferenceMatch` in `model-resolver.ts` at the harness.
	 */
	resolveModel?: (modelId: string) => string | undefined;
	/**
	 * Called once per background subagent when it settles. The harness wires this
	 * to session result injection; without it the result still lands in the
	 * registry and the task log.
	 */
	onBackgroundSettled?: (taskId: string, result: SubagentResult) => void;
	/** Background registry. Defaults to the on-disk singleton. Injectable for tests. */
	registry?: BackgroundRegistry;
	/** Called after experiment registry mutations so the UI can refresh its status pill. */
	onRegistryChanged?: () => void;
}

/** Clip free text onto one listing line; task strings are unbounded, ids are not. */
function clipForListing(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}...`;
}

// ---------------------------------------------------------------------------
// The file control plane (issues #1047, #1048).
//
// Every subagent run gets a directory of its own — a background run already has
// one (the directory holding its `log.jsonl`), a foreground run gets one keyed
// by its run id — and inside it two channels:
//
//   <taskDir>/control/    the child's inbox. The parent FILES a steer /
//                         stop / interrupt request here and records a receipt
//                         for it, and the child's watcher claims and applies
//                         requests in id order. Filing is never the only path:
//                         both the parent-side kill and the in-band injection
//                         still fire in the same call, so a run dies even
//                         without the file. The file is what makes the intent
//                         inspectable, ordered, and replayable.
//   <taskDir>/supervisor/ the child's outbox for `contact_supervisor` (see
//                         `supervisor-channel.ts`), which the parent answers
//                         with `action: "supervisor"`.
//
// The paths are derived rather than threaded through the request: the same
// id-addressing the management plane already uses is enough to find a run's
// directory. `SubagentRunRequest.taskDir` is what the runner hands the child,
// and the runner derives the same default from the run id it mints when a
// caller leaves it unset.
// ---------------------------------------------------------------------------

/**
 * Directory name holding foreground runs' control planes under the agent dir.
 * A background run does not use it — its `subagent-bg/<taskId>/` directory
 * already exists and holds `log.jsonl` beside these subdirectories.
 */
export const INLINE_TASK_DIR_NAME = "subagent-control";

export function inlineTaskDir(runId: string): string {
	return join(getAgentDir(), INLINE_TASK_DIR_NAME, runId);
}

/** A run's control-plane directory: the registry's row wins, else the run id. */
export function runTaskDir(id: string, registry?: BackgroundRegistry): string {
	const known = registry?.snapshot().tasks.some((task) => task.id === id);
	return known ? backgroundTaskDir(id) : inlineTaskDir(id);
}

export function runControlDir(id: string, registry?: BackgroundRegistry): string {
	return controlDirFor(runTaskDir(id, registry));
}

export function runSupervisorDir(id: string, registry?: BackgroundRegistry): string {
	return supervisorDirFor(runTaskDir(id, registry));
}

/**
 * Status lines reporting the file control plane for one run: what is pending in
 * its inbox, which receipts the parent recorded, and what the child asked that
 * nobody answered. Silent when nothing has ever been filed or asked, so
 * `status` reads exactly as it did before for runs that never used the control
 * plane.
 */
export function controlPlaneStatusLines(id: string, registry?: BackgroundRegistry, indent = " "): string[] {
	const lines: string[] = [];
	const inbox = formatControlRequestsForStatus(runControlDir(id, registry));
	if (inbox !== "") {
		lines.push(...inbox.split("\n").map((line) => `${indent}${line}`));
	}
	const questions = formatOpenSupervisorRequests(runSupervisorDir(id, registry));
	if (questions !== "") {
		lines.push(
			`${indent}Supervisor questions (unanswered):`,
			...questions.split("\n").map((line) => `${indent}  ${line}`),
		);
	}
	return lines;
}

/**
 * A filed control request, so the caller can record the later states of the same
 * id against the same inbox without re-deriving a path. Receipts are append-only:
 * `status` collapses them into the newest state per id, which is what makes the
 * requested → scheduled → queued → delivered|failed transition readable.
 */
interface FiledControlAction {
	dir: string;
	id: string;
	action: ControlAction;
	/** Append one receipt for this request. Never throws. */
	record: (state: ControlReceiptState, note?: string, claimed?: boolean) => void;
	/** Append `scheduled` and then the terminal state in one call. */
	settle: (state: "delivered" | "failed", note?: string, claimed?: boolean) => void;
}

/**
 * File a control request into the run's inbox. `writeControlRequest` records the
 * `requested` receipt itself, so the request is on disk and in the ledger before
 * the caller does anything else — a crash mid-action leaves the intent readable.
 *
 * Returns `undefined` when the inbox could not be written. It never throws: the
 * control plane is additive, and a run whose directory is unavailable must still
 * be killed or steered by the existing paths.
 */
function fileControlRequest(
	registry: BackgroundRegistry | undefined,
	id: string,
	action: ControlAction,
	text: string,
): FiledControlAction | undefined {
	const dir = runControlDir(id, registry);
	try {
		const filed = writeControlRequest(dir, { action, text, targetId: id });
		const requestId = filed.request.id;
		const record = (state: ControlReceiptState, note?: string, claimed?: boolean): void => {
			try {
				if (claimed) claimControlRequest(dir, requestId);
				recordControlState(dir, {
					id: requestId,
					action,
					state,
					by: "parent",
					...(note === undefined || note === "" ? {} : { note }),
				});
			} catch {
				// The action's own outcome text is the authority; a control-plane write
				// failure is reported by `status`, not by failing a successful kill.
			}
		};
		return {
			dir,
			id: requestId,
			action,
			record,
			settle: (state, note, claimed) => {
				record("scheduled");
				record(state, note, claimed);
			},
		};
	} catch {
		return undefined;
	}
}

/**
 * A background row whose child was launched detached has no session file, so
 * the kill-and-redispatch path has nothing to redirect onto. Its control inbox
 * is the only channel that exists — the watcher applies it in the live child.
 */
function isDetachedSteerTarget(registry: BackgroundRegistry, rawId: string): boolean {
	const id = rawId.trim();
	if (id === "") return false;
	const row = registry.listRunning().find((task) => task.id === id);
	return row !== undefined && row.sessionFile === undefined;
}

/** Column budget for the `action="status"` listing's task preview. */
const LISTING_TASK_CLIP = 120;

/** How long `steer`/`swap-model` wait for an interrupted inline run to settle. */
const STEER_SETTLE_TIMEOUT_MS = 10_000;
/** Poll interval while waiting for an interrupted inline run to leave the runner. */
const STEER_SETTLE_POLL_MS = 50;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for an interrupted inline run to leave the runner's in-flight map.
 *
 * This is the barrier that makes a steer safe: the replacement dispatch resumes
 * the same child session file, so it must not start while the old child could
 * still be appending to it. Returns false on timeout, which the caller treats
 * as "do not dispatch" rather than "dispatch anyway".
 *
 * An aborted `signal` stops the wait early and reports unsettled: the parent
 * tearing down is no guarantee that the child already did.
 */
async function waitForInlineSettle(
	runner: SubagentRunner,
	runId: string,
	signal: AbortSignal | undefined,
	timeoutMs = STEER_SETTLE_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted === true) return false;
		if (!(runner.listRunning?.() ?? []).some((run) => run.runId === runId)) return true;
		if (Date.now() >= deadline) return false;
		await delay(STEER_SETTLE_POLL_MS);
	}
}

/** What a `steer` / `swap-model` / `resume` call resolved its target id into. */
export interface SteerTarget {
	kind: "inline" | "background";
	id: string;
	role: string;
	cwd: string;
	sessionFile: string;
	model?: string;
	tools?: string[];
	/** Caveats the caller must surface to the orchestrator next to the result. */
	warnings: string[];
}

/** The continuation prompt a steered replacement is dispatched with. */
function buildSteerInstructions(message: string): string {
	return `[STEER] ${message}\n\n---\n\nContinue your work.`;
}

/** The continuation prompt a model-swapped replacement is dispatched with. */
function buildSwapModelInstructions(message: string | undefined): string {
	const trimmed = (message ?? "").trim();
	return trimmed === "" ? "[MODEL SWAP] Continue from where you left off." : `[MODEL SWAP] ${trimmed}`;
}

/** The continuation prompt a resumed replacement is dispatched with. */
export function buildResumeInstructions(message: string | undefined): string {
	const trimmed = (message ?? "").trim();
	return trimmed === ""
		? "[RESUME] Continue from where your session left off."
		: `[RESUME] ${trimmed}\n\n---\n\nContinue from where your session left off.`;
}

/**
 * Resolve the settled background task a `resume` call is aimed at.
 *
 * Unlike `steer`, this only ever targets the background namespace: an inline
 * run is by definition still in the runner, i.e. not settled, so there is
 * nothing to resume — the caller rejects inline ids before getting here.
 *
 * Every rejection is a hard error rather than a fallback dispatch. Resuming is
 * a claim about a specific child session file; silently starting a fresh run
 * instead would report a result the orchestrator did not ask for.
 */
export function resolveResumeTarget(registry: BackgroundRegistry, rawId: string | undefined): SteerTarget {
	const id = (rawId ?? "").trim();
	if (id === "") {
		throw new Error(
			'Invalid parameters. action="resume" requires `id` — pass a settled background task id from action="status".',
		);
	}
	const tasks = registry.snapshot().tasks;
	const row = tasks.find((task) => task.id === id);
	if (row === undefined) {
		const known = tasks.length > 0 ? `background: ${tasks.map((task) => task.id).join(", ")}` : "background: none";
		throw new Error(`Unknown subagent run "${id}" (${known}). Run action="status" for a full listing.`);
	}
	if (row.status === "running" || row.status === "pending") {
		throw new Error(
			`Background task ${id} is still ${row.status}, so it has not settled and there is nothing to resume. Use action="steer" to redirect it now, or wait for action="status" to report it settled.`,
		);
	}
	if (row.status === "cancelled") {
		throw new Error(
			`Background task ${id} was cancelled, so it cannot be resumed. A cancellation does not signal the detached child — it may still be writing that session file, and resuming would put two processes on one JSONL. Dispatch a fresh run instead.`,
		);
	}
	if (row.sessionFile === undefined) {
		throw new Error(
			`Background task ${id} (status=${row.status}) settled before the child reported a session file, so there is nothing to resume. Dispatch a fresh run instead.`,
		);
	}
	if (!existsSync(row.sessionFile)) {
		throw new Error(
			`Background task ${id} points at child session ${row.sessionFile}, which no longer exists on disk (pruned or moved). Dispatch a fresh run instead.`,
		);
	}
	// The tools allowlist is not persisted on registry rows, so the replacement
	// runs with the full tool set. Same caveat `steer` surfaces.
	return {
		kind: "background",
		id,
		role: row.role,
		cwd: row.cwd,
		sessionFile: row.sessionFile,
		...(row.model === undefined ? {} : { model: row.model }),
		warnings: [`Note: background rows do not record a tools allowlist, so the resumed run uses the full tool set.`],
	};
}

/**
 * Take the cross-process lease guarding a redirect target's child session file.
 *
 * A conflict is reframed as a redirect failure: the raw lease message names the
 * holder and the file, which is the actionable part, but not the run the caller
 * was aiming at. `sourceRunId` in the holder record is that run, so the two
 * halves line up in the message.
 */
function acquireRedirectLease(action: "steer" | "swap-model" | "resume", target: SteerTarget): SessionLeaseHandle {
	try {
		return acquireSessionLease({
			sessionFile: target.sessionFile,
			// The replacement's own run id is assigned by the runner and is not
			// knowable here, so the holder is named by the redirect that took the
			// lease. `sourceRunId` carries the run whose session is being revived.
			runId: `${action}-${target.id}`,
			sourceRunId: target.id,
		});
	} catch (err) {
		if (err instanceof SessionLeaseConflictError) {
			throw new Error(`Cannot ${action} run ${target.id}: ${err.message}`);
		}
		throw err;
	}
}

/**
 * Validate a saved-spec label. Names become file components in the spec store,
 * so they are bare labels: no separators, no `..`, not empty. `site` names the
 * field being checked, for the error message.
 */
function validateSpecName(rawName: string | undefined, site: string): string {
	const name = (rawName ?? "").trim();
	if (name === "" || name.includes("/") || name.includes("\\") || name.includes("..")) {
		throw new Error(
			`Invalid parameters. ${site} must be a bare spec label — no path separators, no "..", not empty.`,
		);
	}
	return name;
}

/**
 * Error text for an `agent` name that matched neither store. Names what is
 * actually available — definitions with their scope, then saved specs — and
 * where a definition file would go, so the orchestrator can fix the name or
 * create the file instead of guessing.
 */
function unknownAgentError(name: string, cwd: string): string {
	const definitions = listAgents(cwd);
	const parts: string[] = [];
	if (definitions.length > 0) {
		parts.push(`agents: ${definitions.map((definition) => `${definition.name} (${definition.scope})`).join(", ")}`);
	}
	const savedNames = listSpecs().map((saved) => saved.name);
	if (savedNames.length > 0) {
		parts.push(`saved specs: ${savedNames.join(", ")}`);
	}
	const known =
		parts.length > 0 ? `Known ${parts.join("; ")}.` : "No agent definition files or saved specs exist yet.";
	const dirs = agentsDirs(cwd)
		.map((entry) => join(entry.dir, "<name>.md"))
		.join(" or ");
	return `Invalid parameters. No agent is named "${name}". ${known} Define one at ${dirs}, store one with action "save-spec", or dispatch an ad-hoc subagent with \`role\` + \`instructions\`.`;
}

/**
 * Registration guard: the `subagent.enabled` master switch and the runtime.
 *
 * The default runner is Bun-only (`pi.dev` ships as a Bun build), so without an
 * explicitly injected runner registration is gated on `isBunRuntime()`. An
 * injected runner is runtime-agnostic — tests use this to exercise the tool
 * under Node.
 */
export function shouldRegisterSubagentTool(options?: SubagentToolOptions): boolean {
	const enabled = options?.settings?.get("subagent.enabled") ?? true;
	if (enabled === false) return false;
	return options?.runner !== undefined || isBunRuntime();
}

interface ParentContext {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/**
	 * Delegation depth of this process, 0 for the top-level session. Carried
	 * here rather than as a separate `runOne` parameter because both request
	 * builders (`runOne` and `dispatchDetached`) already receive it, and the
	 * child it produces needs exactly the same value.
	 */
	depth?: number;
}

/**
 * Output contracts (`outputSchema` / `gate`, #1045).
 *
 * All three helpers are exported for tests; the only production caller is
 * `runOne`, which is the single chokepoint every inline dispatch path goes
 * through (single, parallel, chain, and the inline steer/swap-model/resume
 * replacements).
 */

/** Cap on the schema text echoed into the child prompt. The host validates in full. */
const SCHEMA_PROMPT_CAP_BYTES = 8 * 1024;

/** Keep the last `budget` UTF-8 bytes of `text`, cut on a code-point boundary. */
function keepTailBytes(text: string, budget: number): { text: string; omittedBytes: number } {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= budget) return { text, omittedBytes: 0 };
	const chars = Array.from(text);
	let kept = 0;
	let first = chars.length;
	for (let i = chars.length - 1; i >= 0; i--) {
		const width = Buffer.byteLength(chars[i], "utf8");
		if (kept + width > budget) break;
		kept += width;
		first = i;
	}
	return { text: chars.slice(first).join(""), omittedBytes: bytes - kept };
}

/**
 * The instruction block appended to a schema-bound child's system prompt.
 *
 * Wording is deterministic and strict about the one thing that matters: the
 * final message is a single JSON value, nothing else. The child is never told
 * the schema is checked by the parent, only that a mismatch fails the run.
 */
export function buildSchemaInstruction(schema: Record<string, unknown>): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(schema, null, 2);
	} catch {
		// A schema with a cycle or a getter that throws is a spec-authoring bug.
		serialized = "{}";
	}
	if (Buffer.byteLength(serialized, "utf8") > SCHEMA_PROMPT_CAP_BYTES) {
		serialized = `${keepTailBytes(serialized, SCHEMA_PROMPT_CAP_BYTES).text}\n[... schema truncated in this prompt; the host validates against the full schema ...]`;
	}
	return [
		"## Required structured output",
		"",
		"Your FINAL message must be exactly one JSON value that validates against this JSON Schema:",
		"",
		"```json",
		serialized,
		"```",
		"",
		"Emit the JSON only: no prose before or after it, and do not wrap it in an extra code fence (the block above shows the schema, not the expected shape of your reply). The parent parses your final message and validates it against the schema; output that does not match fails this run.",
	].join("\n");
}

/**
 * Reject unusable contract declarations before a child is spawned.
 *
 * Cheaper than discovering it after the run: an unsupported schema keyword or
 * an empty gate command can never pass, so there is no reason to pay for a
 * child to find that out. Returns the model-facing message, or `undefined`
 * when the declarations are usable.
 */
export function checkContractSpec(spec: SubagentSpec): string | undefined {
	if (spec.outputSchema !== undefined) {
		const unsupported = checkSchemaSupport(spec.outputSchema);
		if (unsupported.length > 0) {
			return `Subagent "${spec.role}" has an unusable outputSchema: ${formatSchemaErrors(unsupported)}`;
		}
	}
	if (spec.gate !== undefined && spec.gate.command.trim() === "") {
		return `Subagent "${spec.role}" has a gate with an empty command. Provide the shell command line to run, or omit \`gate\`.`;
	}
	return undefined;
}

/** Where a gate command runs: its own `cwd` when set (relative to the subagent's). */
function gateCwd(gate: SubagentGate, subagentCwd: string): string {
	if (gate.cwd === undefined) return subagentCwd;
	return isAbsolute(gate.cwd) ? gate.cwd : resolvePath(subagentCwd, gate.cwd);
}

function skippedGate(gate: SubagentGate, cwd: string, reason: "child-failed" | "schema-failed"): SubagentGateOutcome {
	return {
		command: gate.command,
		cwd: gateCwd(gate, cwd),
		passed: false,
		exitCode: -1,
		durationMs: 0,
		timedOut: false,
		cancelled: false,
		stdout: "",
		stderr: "",
		truncated: false,
		skipped: reason,
	};
}

/**
 * Run one gate command on the host.
 *
 * `runShellLine` is the `Bun.spawn` path in `shell.ts` — the dynamic command
 * line is exactly what `Bun.$` cannot express safely, and this reuses the kill
 * controller, timeout, abort signal, and env handling instead of duplicating
 * them. Output is capped to `GATE_OUTPUT_CAP_BYTES` combined, keeping the tail
 * of each stream (test runners put the summary last).
 */
async function runGate(
	gate: SubagentGate,
	subagentCwd: string,
	signal: AbortSignal | undefined,
): Promise<SubagentGateOutcome> {
	const cwd = gateCwd(gate, subagentCwd);
	const shell = await runShellLine(gate.command, {
		cwd,
		timeoutMs: gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
		...(signal === undefined ? {} : { signal }),
	});
	const budget = Math.floor(GATE_OUTPUT_CAP_BYTES / 2);
	const out = keepTailBytes(shell.stdout, budget);
	const err = keepTailBytes(shell.stderr, budget);
	const note = (omittedBytes: number): string =>
		omittedBytes > 0 ? `\n[... ${omittedBytes} bytes omitted from the start of this stream ...]` : "";
	return {
		command: gate.command,
		cwd,
		passed: shell.exitCode === 0 && !shell.timedOut && !shell.cancelled,
		exitCode: shell.exitCode,
		durationMs: shell.durationMs,
		timedOut: shell.timedOut,
		cancelled: shell.cancelled,
		stdout: out.text + note(out.omittedBytes),
		stderr: err.text + note(err.omittedBytes),
		truncated: out.omittedBytes > 0 || err.omittedBytes > 0,
	};
}

/** Failure message for a gate that did not pass: verdict plus bounded excerpts. */
function gateFailureMessage(role: string, gate: SubagentGateOutcome): string {
	const why = gate.timedOut ? "timed out" : gate.cancelled ? "was cancelled" : `exited with code ${gate.exitCode}`;
	const parts = [
		`Subagent "${role}" finished but its gate command ${why} after ${(gate.durationMs / 1000).toFixed(1)}s in ${gate.cwd}: ${gate.command}`,
	];
	if (gate.stdout.trim() !== "") parts.push(`--- gate stdout ---\n${gate.stdout}`);
	if (gate.stderr.trim() !== "") parts.push(`--- gate stderr ---\n${gate.stderr}`);
	parts.push(
		"The gate runs on the host, not in the subagent, so its verdict stands regardless of what the subagent reported. Fix the underlying failure and re-dispatch, or drop `gate` from the spec if this check does not apply.",
	);
	return parts.join("\n\n");
}

/** Parse + validate the child's final output against `spec.outputSchema`. */
function applySchemaContract(spec: SubagentSpec, result: SubagentResult): SubagentResult {
	const schema = spec.outputSchema as Record<string, unknown>;
	const extracted = extractJsonFromText(result.finalOutput);
	if (!extracted.ok) {
		return {
			...result,
			outputValidation: { status: "failed", errors: [], parseError: extracted.error },
			errorMessage: `Subagent "${spec.role}" was required to end with JSON matching its outputSchema, but ${extracted.error}. Final output:\n${truncateModelFacingOutput(result.finalOutput)}`,
		};
	}
	const validation = validateAgainstSchema(extracted.value, schema);
	if (!validation.ok) {
		return {
			...result,
			outputValidation: { status: "failed", errors: validation.errors },
			errorMessage: `Subagent "${spec.role}" output does not match its outputSchema:\n${formatSchemaErrors(validation.errors)}`,
		};
	}
	return {
		...result,
		structuredOutput: extracted.value,
		outputValidation: { status: "passed", errors: [] },
	};
}

/**
 * Enforce the spec's output contract on a settled result.
 *
 * Ordering matters: a child that failed is never graded against the schema and
 * its gate never runs (there is nothing to verify); a child whose output did not
 * validate is already failed, so the gate is skipped for the same reason. Only a
 * clean child reaches the gate. A passing gate verdict lands in details alone —
 * the model-facing text of a successful run is the child's output, unchanged.
 */
export async function applyOutputContract(
	spec: SubagentSpec,
	cwd: string,
	result: SubagentResult,
	signal: AbortSignal | undefined,
): Promise<SubagentResult> {
	if (spec.outputSchema === undefined && spec.gate === undefined) return result;

	if (isFailedSubagentResult(result)) {
		return spec.gate === undefined ? result : { ...result, gate: skippedGate(spec.gate, cwd, "child-failed") };
	}

	let settled = result;
	if (spec.outputSchema !== undefined) {
		settled = applySchemaContract(spec, settled);
		if (isFailedSubagentResult(settled)) {
			return spec.gate === undefined ? settled : { ...settled, gate: skippedGate(spec.gate, cwd, "schema-failed") };
		}
	}
	if (spec.gate === undefined) return settled;

	const gate = await runGate(spec.gate, cwd, signal);
	if (gate.passed) return { ...settled, gate };
	return { ...settled, gate, errorMessage: gateFailureMessage(spec.role, gate) };
}

/** Run one subagent and record exactly one analytics span for it. */
async function runOne(
	runner: SubagentRunner,
	spec: SubagentSpec,
	baseCwd: string,
	parent: ParentContext,
	parentSessionFile: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onPartial?: (snapshot: SubagentResult) => void,
): Promise<SubagentResult> {
	const cwd = spec.cwd ? (isAbsolute(spec.cwd) ? spec.cwd : resolvePath(baseCwd, spec.cwd)) : baseCwd;
	// A schema-bound child gets the format contract in its system prompt; the
	// authored `instructions` stay the run's task text everywhere they are
	// reported (result, in-flight snapshot, span label), so nothing downstream
	// has to know the block was appended.
	const schemaBlock = spec.outputSchema === undefined ? undefined : buildSchemaInstruction(spec.outputSchema);
	const childSpec: SubagentSpec =
		schemaBlock === undefined ? spec : { ...spec, instructions: `${spec.instructions}\n\n${schemaBlock}` };
	const request: SubagentRunRequest = {
		spec: childSpec,
		task: spec.instructions,
		cwd,
		...(parent.model === undefined ? {} : { parentModel: parent.model }),
		...(parent.thinkingLevel === undefined ? {} : { parentThinkingLevel: parent.thinkingLevel }),
		// The child is one level deeper than this process. Passing it on argv is
		// what makes the guard cross the process boundary — the child drops
		// `subagent` from its own tool set once it reaches subagent.maxDepth.
		depth: (parent.depth ?? 0) + 1,
		// parentSessionFile is set for every inline single/chain/parallel step
		// unless the harness has none. A spec.sessionFile (resume) wins in the
		// runner, so passing the parent path here too is safe.
		...(parentSessionFile === undefined ? {} : { parentSessionFile }),
		...(step === undefined ? {} : { step }),
	};

	const spanId = newTaskSpanId();
	startSubagentTask({ spanId, agentName: spec.role, taskLabel: spec.instructions.slice(0, 200) });

	try {
		// Fail an unusable contract before the child runs — the catch below turns
		// this into a failed result like any other dispatch failure.
		const contractProblem = checkContractSpec(spec);
		if (contractProblem !== undefined) throw new Error(contractProblem);

		let lastText = "";
		const liveUsage = createEmptyUsage();
		const seen: Message[] = [];
		const listener: SubagentEventListener | undefined = onPartial
			? (event) => {
					if (event.type === "message_end" || event.type === "tool_result_end") {
						seen.push(event.message);
					}
					if (event.type !== "message_end" || event.message.role !== "assistant") return;
					const message = event.message;
					if (message.usage) {
						liveUsage.input += message.usage.input ?? 0;
						liveUsage.output += message.usage.output ?? 0;
						liveUsage.cost += message.usage.cost?.total ?? 0;
						liveUsage.turns += 1;
					}
					for (const part of message.content) {
						if (part.type === "text") lastText = part.text;
					}
					onPartial({
						role: spec.role,
						task: spec.instructions,
						exitCode: -1,
						aborted: false,
						finalOutput: lastText,
						stderr: "",
						usage: { ...liveUsage },
						...(step === undefined ? {} : { step }),
						messages: [...seen],
					});
				}
			: undefined;

		const result = await runner.run(request, signal, listener);
		const settled = await applyOutputContract(spec, cwd, result, signal);
		const failed = isFailedSubagentResult(settled);
		endSubagentTask(spanId, !failed, failed ? (settled.errorMessage ?? `exit code ${settled.exitCode}`) : undefined);
		return settled;
	} catch (err) {
		// The run never started (spawn failure, runner rejection): report it as a
		// failed result rather than propagating, so the orchestrator gets a
		// diagnosable tool error instead of a raw exception.
		const errorMessage = err instanceof Error ? err.message : String(err);
		endSubagentTask(spanId, false, errorMessage);
		return {
			role: spec.role,
			task: spec.instructions,
			exitCode: -1,
			aborted: false,
			finalOutput: "",
			stderr: errorMessage,
			usage: createEmptyUsage(),
			...(step === undefined ? {} : { step }),
			...(spec.gate === undefined ? {} : { gate: skippedGate(spec.gate, cwd, "child-failed") }),
			messages: [],
			errorMessage,
		};
	}
}

/** Map with a bounded number of concurrently running promises, preserving order. */
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<TOut>(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Cap model-facing output at PER_TASK_OUTPUT_CAP bytes (UTF-8).
 *
 * Trimming walks code points via the string iterator, so the cut can never
 * split a UTF-16 surrogate pair.
 */
function truncateModelFacingOutput(output: string, fullOutputNote = "Full output preserved in tool details."): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let keptBytes = 0;
	let keptLength = 0;
	for (const codePoint of output) {
		const width = Buffer.byteLength(codePoint, "utf8");
		if (keptBytes + width > PER_TASK_OUTPUT_CAP) break;
		keptBytes += width;
		keptLength += codePoint.length;
	}
	const truncated = output.slice(0, keptLength);
	return `${truncated}\n\n[Output truncated: ${byteLength - keptBytes} bytes omitted.${fullOutputNote ? ` ${fullOutputNote}` : ""}]`;
}

function specFromInput(input: {
	role: string;
	instructions: string;
	model?: string;
	tools?: string[];
	cwd?: string;
	thinking?: ThinkingLevel;
	outputSchema?: Record<string, unknown>;
	gate?: SubagentGate;
}): SubagentSpec {
	return {
		role: input.role,
		instructions: input.instructions,
		...(input.model === undefined ? {} : { model: input.model }),
		...(input.tools === undefined ? {} : { tools: input.tools }),
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
		...(input.thinking === undefined ? {} : { thinking: input.thinking }),
		...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
		...(input.gate === undefined ? {} : { gate: input.gate }),
	};
}

/**
 * Validate and canonicalize `model` overrides before anything dispatches.
 *
 * Every spec position is checked (single fields, `tasks`, `chain`), and the
 * first unknown model aborts the whole call with an error naming it so the
 * orchestrator can retry with a valid id. Resolved specs carry the canonical
 * `provider/model` form.
 */
export function resolveModelOverrides(
	input: SubagentToolInput,
	resolveModel: (modelId: string) => string | undefined,
): { input: SubagentToolInput; error?: string } {
	const next: SubagentToolInput = {
		...input,
		...(input.tasks ? { tasks: input.tasks.map((t) => ({ ...t })) } : {}),
		...(input.chain ? { chain: input.chain.map((s) => ({ ...s })) } : {}),
		...(input.dag ? { dag: input.dag.map((n) => ({ ...n })) } : {}),
	};
	const specs: Array<{ role?: string; model?: string }> = [];
	if (next.role !== undefined) specs.push(next);
	for (const task of next.tasks ?? []) specs.push(task);
	for (const step of next.chain ?? []) specs.push(step);
	for (const node of next.dag ?? []) specs.push(node);

	for (const spec of specs) {
		if (spec.model === undefined) continue;
		const canonical = resolveModel(spec.model);
		if (canonical === undefined) {
			return {
				input,
				error: `Unknown model "${spec.model}" for subagent "${spec.role ?? "subagent"}". Omit \`model\` to inherit this session's model, or pass a registered model id (run pi --list-models to see them).`,
			};
		}
		spec.model = canonical;
	}
	return { input: next };
}

/**
 * One entry point for every detached subagent dispatch — fresh background
 * calls, steers, model swaps and resumes.
 *
 * `startBackgroundSubagent` starts a child immediately and knows nothing about
 * how many children the session is already running, so each of those paths used
 * to bypass `subagent.maxConcurrent` (the cap only guarded inline parallel
 * batches). Routing them all through one helper means the cap is applied by
 * construction: a dispatch cannot start unless a slot is free, and one that
 * misses out is recorded as a `pending` row and promoted by the settle of
 * whatever held the slot.
 *
 * The settle callback is wrapped so the slot is released *before* the caller's
 * own callback runs. A chain step that fires its successor from `onSettled`
 * therefore sees the true free-slot count instead of one that is about to be
 * freed, so the successor queues behind the tasks already waiting rather than
 * jumping ahead of them.
 *
 * The cap comes from the live settings getter on both admission and release, so
 * a mid-session change to `subagent.maxConcurrent` applies to the next dispatch
 * and the next drain — matching how `maxTotalSpawns` already behaves.
 */
function dispatchDetached(args: {
	registry: BackgroundRegistry;
	runner: SubagentRunner;
	spec: SubagentSpec;
	task: string;
	cwd: string;
	parent: ParentContext;
	parentSessionFile: string | undefined;
	settings: () => ResolvedSubagentSettings;
	taskId?: string;
	onSettled?: (taskId: string, result: SubagentResult) => void;
}): { taskId: string; started: boolean; queuePosition: number } {
	const cap = (): number => args.settings().maxConcurrent;
	let released = false;
	const request = requestBackgroundDispatch(
		args.registry,
		{
			registry: args.registry,
			runner: args.runner,
			spec: args.spec,
			task: args.task,
			cwd: args.cwd,
			parentModel: args.parent.model,
			parentThinkingLevel: args.parent.thinkingLevel,
			depth: (args.parent.depth ?? 0) + 1,
			...(args.parentSessionFile === undefined ? {} : { parentSessionFile: args.parentSessionFile }),
			...(args.taskId === undefined ? {} : { taskId: args.taskId }),
			onSettled: (taskId, result) => {
				// Guarded so a spurious second settle cannot free a slot that has
				// since been handed to a different task.
				if (!released) {
					released = true;
					releaseBackgroundDispatch(args.registry, taskId, cap());
				}
				args.onSettled?.(taskId, result);
			},
		},
		cap(),
	);
	return {
		taskId: request.taskId,
		started: request.admission === "running",
		queuePosition: request.queuePosition,
	};
}

/**
 * Report a batch of detached dispatch ids, splitting work that started from
 * work that is waiting for a slot. Naming a queued task as "started" would send
 * the model to poll `action="status"` for a child that has not been spawned yet.
 */
function describeDetachedDispatch(registry: BackgroundRegistry, taskIds: string[], mode: string): string {
	const waiting = queuedTaskIds(registry);
	const queued = taskIds.filter((id) => waiting.includes(id));
	if (queued.length === 0) {
		return taskIds.length === 1
			? `Background task ${taskIds[0]} started (${mode}). Its result is delivered when it settles.`
			: `Started ${taskIds.length} background tasks: ${taskIds.join(", ")} (${mode}). Results are delivered as they settle.`;
	}
	const started = taskIds.filter((id) => !queued.includes(id));
	const queuedText = queued.map((id) => `${id} (#${queuePositionOf(registry, id)})`).join(", ");
	const head =
		started.length === 0
			? `All ${taskIds.length} task(s) are queued (${mode})`
			: `Started ${started.length} background task(s): ${started.join(", ")} (${mode})`;
	return `${head}. Queued behind the subagent concurrency cap: ${queuedText}. Each starts when a slot frees, and its result is delivered when it settles.`;
}

export function createSubagentToolDefinition(
	cwd: string,
	options?: SubagentToolOptions,
): ToolDefinition<typeof subagentSchema, SubagentToolDetails | undefined> {
	let defaultRunner: SubagentRunner | undefined;
	const getRunner = (): SubagentRunner => {
		// Lazy: build the default runner from the live subagent settings so a
		// mid-session change to subagent.toolTimeoutMs takes effect without a
		// harness rebuild. An injected runner is always honored as-is.
		if (!defaultRunner) {
			const liveSettings = options?.subagentSettings?.();
			defaultRunner = createBunProcessRunner({
				...(liveSettings?.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: liveSettings.toolTimeoutMs }),
			});
		}
		return options?.runner ?? defaultRunner;
	};
	// Session-wide spawn counter: one definition owns one counter, so a single
	// tool registration tracks all spawns in this process. The cap is checked
	// atomically per call (the proposed count vs. the current counter), so a
	// batch is either admitted in full or rejected in full — no partial
	// admission, no two parallel calls slipping through the same hole.
	let totalSpawnCount = 0;

	// ------------------------------------------------------------------------
	// Control plane: action = status | stop | interrupt | steer | swap-model |
	// supervisor | resume | save-spec | list-specs | delete-spec
	//
	// Two namespaces are reported side by side rather than merged. Inline runs
	// live only in this process's runner and carry bare-UUID runIds; background
	// rows live in the on-disk registry and carry `bg_`-prefixed ids. Keeping
	// them distinct means an id copied out of a listing is always aimed at the
	// right place.
	//
	// stop / interrupt / steer additionally file a request in the target run's
	// `control/` inbox and record receipts for it, so the intent survives the
	// parent's own process: the child's watcher can still apply it, and
	// `status` shows its state. `supervisor` is the parent's half of the child's
	// `contact_supervisor` outbox.
	// ------------------------------------------------------------------------

	/**
	 * Resolve the run a `steer` / `swap-model` call is aimed at into the fields a
	 * replacement dispatch needs.
	 *
	 * Admission is deliberately asymmetric between the two namespaces. An inline
	 * run can be steered once it has opened its child session: the caller
	 * interrupts it and waits for it to leave the runner before re-dispatching, a
	 * race the runner can actually observe. A background row can only be steered
	 * once its child has *provably* settled, and the registry signals that by
	 * stamping `sessionFile` — the detached settle path writes it, `cancel()`
	 * never does. Absent means the process may still be alive, and resuming a
	 * session file another process holds puts two writers on one JSONL.
	 */
	const resolveSteerTarget = (
		action: "steer" | "swap-model",
		rawId: string | undefined,
		runner: SubagentRunner,
		registry: BackgroundRegistry,
	): SteerTarget => {
		const id = (rawId ?? "").trim();
		if (id === "") {
			throw new Error(
				`Invalid parameters. action="${action}" requires \`id\` — pass a run id from action="status".`,
			);
		}
		const runningInline = runner.listRunning?.() ?? [];
		const inlineRun = runningInline.find((run) => run.runId === id);
		if (inlineRun !== undefined) {
			// No session file means the child never emitted `session_start`: it is
			// still spawning. Killing it would destroy a run with no resumable
			// state, so refuse instead.
			if (inlineRun.sessionFile === undefined) {
				throw new Error(
					`Inline run ${id} has not opened a child session yet, so there is nothing to ${action}. It is still spawning — wait for it to appear in action="status" with a session, or interrupt it and dispatch a fresh run.`,
				);
			}
			return {
				kind: "inline",
				id,
				role: inlineRun.role,
				cwd: inlineRun.cwd,
				sessionFile: inlineRun.sessionFile,
				...(inlineRun.model === undefined ? {} : { model: inlineRun.model }),
				...(inlineRun.tools === undefined ? {} : { tools: inlineRun.tools }),
				warnings: [],
			};
		}
		const tasks = registry.snapshot().tasks;
		const row = tasks.find((task) => task.id === id);
		if (row !== undefined) {
			if (row.sessionFile === undefined) {
				const stillDetached = row.status === "running" || row.status === "pending";
				throw new Error(
					`Background task ${id} (status=${row.status}) has no recorded child session, so it cannot be redirected safely. ${
						stillDetached
							? "Its detached process may still be running, and resuming its session while it writes would corrupt the JSONL."
							: "The row settled before the child reported a session file (cancelled, crashed, or killed by the watchdog)."
					} Use action="stop" to mark it cancelled, or dispatch a fresh run.`,
				);
			}
			// The tools allowlist is not persisted on registry rows, so the
			// replacement would silently widen the child's permissions. Say so.
			return {
				kind: "background",
				id,
				role: row.role,
				cwd: row.cwd,
				sessionFile: row.sessionFile,
				...(row.model === undefined ? {} : { model: row.model }),
				warnings: [
					`Note: background rows do not record a tools allowlist, so the replacement runs with the full tool set.`,
				],
			};
		}
		const known = [
			runningInline.length > 0 ? `inline: ${runningInline.map((run) => run.runId).join(", ")}` : "inline: none",
			tasks.length > 0 ? `background: ${tasks.map((task) => task.id).join(", ")}` : "background: none",
		].join("; ");
		throw new Error(`Unknown subagent run "${id}" (${known}). Run action="status" for a full listing.`);
	};

	/**
	 * Interrupt a resolved target (inline only) and dispatch its replacement.
	 *
	 * Model validation happens in the caller, before any kill lands: a steer
	 * with a typo'd model must leave the original run alone rather than kill it
	 * and then fail.
	 *
	 * Reached only through {@link redispatchSteered}, which holds the cross-process
	 * lease on the target's session file for the whole call and hands it to the
	 * detached replacement on the background path via `leaseControl`.
	 */
	const dispatchRedirect = async (
		payload: {
			action: "steer" | "swap-model" | "resume";
			target: SteerTarget;
			instructions: string;
			model?: string;
			runner: SubagentRunner;
			baseCwd: string;
			parent: ParentContext;
			parentSessionFile: string | undefined;
			signal: AbortSignal | undefined;
			onUpdate: SubagentToolUpdateCallback | undefined;
			background: boolean;
		},
		leaseControl: { handOff: () => void; release: () => void },
	): Promise<SubagentToolResult> => {
		const { action, target } = payload;
		if (target.kind === "inline") {
			const stopped = (await payload.runner.interrupt?.(target.id)) ?? false;
			if (!stopped) {
				throw new Error(
					`Inline run ${target.id} settled before the ${action} kill landed, so it was not redirected. Its result is already final.`,
				);
			}
			if (!(await waitForInlineSettle(payload.runner, target.id, payload.signal))) {
				throw new Error(
					`Inline run ${target.id} was signalled but did not settle within ${STEER_SETTLE_TIMEOUT_MS}ms. Refusing to dispatch a replacement: two processes on one child session file would corrupt it. Check action="status" before retrying.`,
				);
			}
		}
		const spec: SubagentSpec = {
			role: target.role,
			instructions: payload.instructions,
			sessionFile: target.sessionFile,
			// Pin the replacement to the directory the target was already working
			// in: a steer must not relocate a run mid-branch.
			cwd: target.cwd,
			...(payload.model === undefined ? {} : { model: payload.model }),
			...(target.tools === undefined ? {} : { tools: target.tools }),
		};
		// One replacement child pays one budget slot, exactly like a fresh single
		// dispatch. Checked here rather than in execute() because the control-plane
		// short-circuit runs before the dispatch budget does.
		const maxTotalSpawns = (options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS).maxTotalSpawns;
		if (totalSpawnCount + 1 > maxTotalSpawns) {
			throw new Error(
				`Subagent spawn budget exceeded: ${action} on ${target.id} would add 1 spawn(s) to the current ${totalSpawnCount}, exceeding the per-session cap of ${maxTotalSpawns} (subagent.maxTotalSpawns).`,
			);
		}
		totalSpawnCount += 1;
		const verb = action === "steer" ? "Steered" : action === "resume" ? "Resumed" : "Re-dispatched with a new model";
		const head = `${verb} ${target.kind} run ${target.id} (role=${target.role}), resuming child session ${target.sessionFile}`;

		if (payload.background) {
			const registry = options?.registry ?? getBackgroundRegistry();
			// Routed through the capped dispatcher: a steering replacement is a new
			// child process, and starting it beside a full set of running children
			// is exactly the bypass this issue is about. The replacement parks
			// behind the cap instead, still holding the lease until it settles.
			const dispatch = dispatchDetached({
				registry,
				runner: payload.runner,
				spec,
				task: spec.instructions,
				cwd: target.cwd,
				parent: payload.parent,
				parentSessionFile: payload.parentSessionFile,
				settings: () => options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS,
				// The replacement child outlives this call, so the lease is not
				// released in the wrapper's finally — it is released when the row
				// settles, which is the last moment the child can be writing.
				onSettled: (taskId, result) => {
					leaseControl.release();
					options?.onBackgroundSettled?.(taskId, result);
				},
			});
			leaseControl.handOff();
			const outcome = dispatch.started
				? `${head} as detached task ${dispatch.taskId}.`
				: `${head} as queued task ${dispatch.taskId} (position ${dispatch.queuePosition} behind the subagent concurrency cap; it starts when a slot frees).`;
			return {
				content: [{ type: "text", text: [outcome, ...target.warnings].join(" ") }],
				details: {
					mode: "single",
					results: [],
					background: true,
					taskIds: [dispatch.taskId],
					action,
				},
			};
		}

		const result = await runOne(
			payload.runner,
			spec,
			payload.baseCwd,
			payload.parent,
			payload.parentSessionFile,
			undefined,
			payload.signal,
			(snapshot) => {
				payload.onUpdate?.({
					content: [{ type: "text", text: snapshot.finalOutput || "(running)" }],
					details: { mode: "single", results: [snapshot], action },
				});
			},
		);
		if (isFailedSubagentResult(result)) {
			throw new Error(
				`Subagent ${result.role} ${result.stopReason || "failed"} after ${action} of ${target.id}: ${truncateModelFacingOutput(getSubagentResultOutput(result), "")}`,
			);
		}
		const output = truncateModelFacingOutput(result.finalOutput) || "(no output)";
		return {
			content: [
				{ type: "text", text: target.warnings.length > 0 ? `${output}\n\n${target.warnings.join("\n")}` : output },
			],
			details: { mode: "single", results: [result], action },
		};
	};

	/**
	 * Lease-guarded entry point for `steer`, `swap-model` and `resume`.
	 *
	 * The lease is taken before anything is killed. Killing the old child and
	 * dispatching the replacement leaves a window in which nobody is writing the
	 * session file, and a second pi process reviving the same child would happily
	 * open it in that window; holding the lease across the whole redirect closes
	 * it. The old child holds no lease of its own — only redirects take one — so
	 * this never self-conflicts, and the inline settle-wait cannot deadlock
	 * against it.
	 *
	 * The background path hands ownership to the settle callback instead of
	 * releasing here, because the detached replacement keeps writing after this
	 * call returns. `release` is idempotent, so a settle that lands before the
	 * hand-off is still safe.
	 */
	const redispatchSteered = async (payload: Parameters<typeof dispatchRedirect>[0]): Promise<SubagentToolResult> => {
		const lease = acquireRedirectLease(payload.action, payload.target);
		let handedOff = false;
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			lease.release();
		};
		try {
			return await dispatchRedirect(payload, {
				handOff: () => {
					handedOff = true;
				},
				release,
			});
		} finally {
			if (!handedOff) release();
		}
	};

	const handleManagementAction = async (
		action: NonNullable<SubagentToolInput["action"]>,
		rawParams: SubagentToolInput,
		runner: SubagentRunner,
		baseCwd: string,
		parent: ParentContext,
		parentSessionFile: string | undefined,
		signal: AbortSignal | undefined,
		onUpdate: SubagentToolUpdateCallback | undefined,
	): Promise<SubagentToolResult> => {
		const registry = options?.registry ?? getBackgroundRegistry();
		// A runner without the control plane reports no inline candidates rather
		// than failing the call: "this runner cannot see in-flight work" is not
		// "no work exists". The background half is always available.
		const inline = runner.listRunning?.() ?? [];
		const background = registry.listRunning();

		if (action === "status") {
			const rows: string[] = [];
			rows.push(`Inline runs (this process, not yet settled): ${inline.length}`);
			for (const run of inline) {
				rows.push(
					[
						`  id=${run.runId}`,
						`role=${run.role}`,
						run.pid === undefined ? "" : `pid=${run.pid}`,
						`started=${run.startedAt}`,
						`cwd=${run.cwd}`,
						`task=${clipForListing(run.task, LISTING_TASK_CLIP)}`,
					]
						.filter(Boolean)
						.join(" "),
				);
				for (const line of controlPlaneStatusLines(run.runId, registry)) rows.push(line);
			}
			rows.push(`Background tasks (registry, running or pending): ${background.length}`);
			const waiting = queuedTaskIds(registry);
			for (const task of background) {
				rows.push(
					[
						`  id=${task.id}`,
						`role=${task.role}`,
						`status=${task.status}`,
						// A pending row is either queued behind the concurrency cap or
						// already launched and awaiting its first event; only the queue
						// knows which, so report the position when it can.
						waiting.includes(task.id) ? `queued=#${queuePositionOf(registry, task.id)}` : "",
						task.pid === undefined ? "" : `pid=${task.pid}`,
						`started=${task.startedAt}`,
						`cwd=${task.cwd}`,
						`task=${clipForListing(task.task, LISTING_TASK_CLIP)}`,
					]
						.filter(Boolean)
						.join(" "),
				);
				for (const line of controlPlaneStatusLines(task.id, registry)) rows.push(line);
			}
			if (inline.length === 0 && background.length === 0) rows.push("No subagent run is in flight.");
			if (waiting.length > 0) {
				rows.push(
					`${waiting.length} task(s) are queued behind subagent.maxConcurrent. They start in FIFO order as running tasks settle; cancelling one drops it from the queue.`,
				);
			}
			return {
				content: [{ type: "text", text: rows.join("\n") }],
				details: { mode: "single", results: [], action },
			};
		}

		// ----------------------------------------------------------------------
		// Saved specs: operations on the name store, not on any run. They spawn
		// nothing, so they are handled before the target-id plumbing.
		// ----------------------------------------------------------------------
		if (action === "list-specs") {
			const specs = listSpecs();
			const rows: string[] = [`Saved subagent specs: ${specs.length}`];
			for (const entry of specs) {
				rows.push(
					[
						` name=${entry.name}`,
						`role=${entry.spec.role}`,
						entry.spec.model === undefined ? "model=<inherit>" : `model=${entry.spec.model}`,
						entry.spec.tools === undefined ? "tools=<full set>" : `tools=${entry.spec.tools.join(",")}`,
						entry.spec.cwd === undefined ? "" : `cwd=${entry.spec.cwd}`,
						`savedAt=${entry.savedAt}`,
						`instructions=${clipForListing(entry.spec.instructions, LISTING_TASK_CLIP)}`,
					]
						.filter(Boolean)
						.join(" "),
				);
			}
			if (specs.length === 0) {
				rows.push(
					'Nothing stored yet. Save a dispatch with action="save-spec" plus `name`, `role`, `instructions`.',
				);
			}
			return {
				content: [{ type: "text", text: rows.join("\n") }],
				details: { mode: "single", results: [], action },
			};
		}

		if (action === "save-spec") {
			const name = validateSpecName(rawParams.name, action);
			const role = (rawParams.role ?? "").trim();
			const instructions = (rawParams.instructions ?? "").trim();
			if (role === "" || instructions === "") {
				throw new Error(
					'Invalid parameters. action="save-spec" stores a dispatch, so it needs `name`, `role`, and `instructions` (plus optional model / tools / cwd).',
				);
			}
			// Canonicalize through the same resolver a dispatch uses, so a typo
			// fails at save time instead of on every later `agent` call.
			const requested = (rawParams.model ?? "").trim();
			let model: string | undefined;
			if (requested !== "") {
				model = options?.resolveModel ? options.resolveModel(requested) : requested;
				if (model === undefined) {
					throw new Error(`Unknown model "${requested}" for action="save-spec".`);
				}
			}
			saveSpec(
				name,
				specFromInput({
					role,
					instructions,
					...(model === undefined ? {} : { model }),
					...(rawParams.tools === undefined ? {} : { tools: rawParams.tools }),
					...(rawParams.cwd === undefined ? {} : { cwd: rawParams.cwd }),
				}),
			);
			return {
				content: [
					{
						type: "text",
						text: `Saved spec "${name}" (role=${role}${model === undefined ? ", model inherits the session" : `, model=${model}`}). Dispatch it with \`agent: "${name}"\`.`,
					},
				],
				details: { mode: "single", results: [], action },
			};
		}

		if (action === "delete-spec") {
			const name = validateSpecName(rawParams.name, action);
			deleteSpec(name);
			return {
				content: [{ type: "text", text: `Deleted saved spec "${name}".` }],
				details: { mode: "single", results: [], action },
			};
		}

		// ----------------------------------------------------------------------
		// supervisor: the parent's half of the child's `contact_supervisor`
		// channel. Called with just `id` it reports the run's open questions; with
		// `replyTo` and `message` it files the answer, which the asking child is
		// polling for (see `supervisor-channel.ts`).
		//
		// This action never touches the running child — a question is advisory, and
		// answering it must not interrupt work that is already in flight.
		// ----------------------------------------------------------------------
		if (action === "supervisor") {
			const supervisorId = (rawParams.id ?? "").trim();
			if (supervisorId === "") {
				throw new Error(
					'Invalid parameters. action="supervisor" requires `id` — the run whose supervisor questions you want to read or answer.',
				);
			}
			const supervisorDir = runSupervisorDir(supervisorId, registry);
			const replyTo = (rawParams.replyTo ?? "").trim();
			if (replyTo === "") {
				if ((rawParams.message ?? "").trim() !== "") {
					throw new Error(
						'Invalid parameters. action="supervisor" takes `replyTo` — the open request id from action="supervisor" — to answer a question. Without it the action only lists them.',
					);
				}
				const questions = formatOpenSupervisorRequests(supervisorDir);
				return {
					content: [
						{
							type: "text",
							text: questions === "" ? `No open supervisor questions for ${supervisorId}.` : questions,
						},
					],
					details: { mode: "single", results: [], action },
				};
			}
			const reply = (rawParams.message ?? "").trim();
			if (reply === "") {
				throw new Error(
					`Invalid parameters. action="supervisor" with \`replyTo=${replyTo}\` requires \`message\` — the answer the child is waiting for.`,
				);
			}
			const open = listOpenSupervisorRequests(supervisorDir);
			if (!open.some((request) => request.id === replyTo)) {
				throw new Error(
					`Supervisor request ${replyTo} is not open for run ${supervisorId}. Run action="supervisor" with this id to list the questions it is still waiting on.`,
				);
			}
			if (writeSupervisorReply(supervisorDir, replyTo, reply) === undefined) {
				throw new Error(`Could not file the supervisor reply for request ${replyTo} (run ${supervisorId}).`);
			}
			return {
				content: [
					{
						type: "text",
						text: `Answered supervisor question ${replyTo} for run ${supervisorId}. A child still polling contact_supervisor picks it up within its poll interval; one that gave up has already finished, and its open question rode along with the completion notification.`,
					},
				],
				details: { mode: "single", results: [], action },
			};
		}

		// ----------------------------------------------------------------------
		// resume: re-dispatch a settled background run against the child session
		// file it left behind. The optional `message` becomes the continuation
		// instruction; the replacement inherits the row's role and cwd.
		//
		// Unlike steer and swap-model there is nothing to kill — the target already
		// settled, and that is precisely what makes it resumable.
		// ----------------------------------------------------------------------
		if (action === "resume") {
			if ((rawParams.model ?? "").trim() !== "") {
				throw new Error(
					'Invalid parameters. action="resume" does not take `model` — it continues a settled run on whatever model its role resolves to. Use action="swap-model" to redirect a running run onto a different model.',
				);
			}
			const resumeId = (rawParams.id ?? "").trim();
			if ((runner.listRunning?.() ?? []).some((run) => run.runId === resumeId)) {
				throw new Error(
					`Inline run ${resumeId} is still running, so there is nothing to resume. Use action="steer" to redirect it now, or action="stop" to end it.`,
				);
			}
			const target = resolveResumeTarget(registry, resumeId);
			return await redispatchSteered({
				action,
				target,
				instructions: buildResumeInstructions(rawParams.message),
				runner,
				baseCwd,
				parent,
				parentSessionFile,
				signal,
				onUpdate,
				background: rawParams.background === true,
			});
		}

		// ----------------------------------------------------------------------
		// steer / swap-model: interrupt a target and re-dispatch its replacement
		// against the same child session file.
		//
		// Both arguments are validated before anything is killed, so a malformed
		// steer leaves the original run running.
		// ----------------------------------------------------------------------
		if (action === "steer" || action === "swap-model") {
			const message = (rawParams.message ?? "").trim();
			// A detached background task has no session file to redirect onto, and the
			// kill-and-redispatch path would refuse it for that reason alone. Its
			// control inbox is the only channel that reaches a live child, so the steer
			// is filed there and applied by the child's watcher (issue #1047). The
			// message check comes first: an empty steer is a bad call whatever the
			// target's shape, and it must not be accepted into the inbox.
			if (action === "steer" && message !== "" && isDetachedSteerTarget(registry, rawParams.id ?? "")) {
				const detachedId = (rawParams.id ?? "").trim();
				const control = fileControlRequest(registry, detachedId, action, message);
				if (control === undefined) {
					throw new Error(`Could not file a steer request in the control inbox of background task ${detachedId}.`);
				}
				control.record("queued");
				return {
					content: [
						{
							type: "text",
							text: `Steer request ${control.id} queued in the control inbox of background task ${detachedId}. It was not killed or restarted: the child's control watcher claims it on its next pass and injects it into the live session, and action="status" reports the request with its receipt state until it is applied.`,
						},
					],
					details: { mode: "single", results: [], action },
				};
			}
			const target = resolveSteerTarget(action, rawParams.id, runner, registry);
			let model: string | undefined;
			if (action === "steer") {
				if (message === "") {
					throw new Error(
						'Invalid parameters. action="steer" requires `message` — the new instruction for the replacement run. Use action="swap-model" to change only the model.',
					);
				}
			} else {
				const requested = (rawParams.model ?? "").trim();
				if (requested === "") {
					throw new Error(
						'Invalid parameters. action="swap-model" requires `model` — the model the replacement run should use. Use action="steer" to redirect a run without changing its model.',
					);
				}
				model = options?.resolveModel ? options.resolveModel(requested) : requested;
				if (model === undefined) {
					throw new Error(`Unknown model "${requested}" for action="swap-model".`);
				}
			}
			// File the steer before anything is killed: the intent is on disk and in
			// the receipt ledger first, so a crash between the kill and the dispatch
			// leaves a pending request the child's watcher can still apply instead of
			// a silently lost instruction.
			const control = action === "steer" ? fileControlRequest(registry, target.id, action, message) : undefined;
			try {
				const redirected = await redispatchSteered({
					action,
					target,
					instructions:
						action === "steer" ? buildSteerInstructions(message) : buildSwapModelInstructions(rawParams.message),
					...(model === undefined ? {} : { model }),
					runner,
					baseCwd,
					parent,
					parentSessionFile,
					signal,
					onUpdate,
					background: rawParams.background === true,
				});
				// Applied in band by the replacement run: claim the request so the
				// child's watcher cannot apply the same steer a second time.
				control?.settle("delivered", "injected by the redirected run", true);
				return redirected;
			} catch (error) {
				control?.settle("failed", error instanceof Error ? error.message : String(error));
				throw error;
			}
		}

		const id = (rawParams.id ?? "").trim();
		if (id === "") {
			// Thrown, per the file's failure contract: a bad dispatch is a tool
			// error, not a resolved result with an apology in it.
			throw new Error(
				`Invalid parameters. action="${action}" requires \`id\` — pass a run id from action="status" (inline) or a background task id.`,
			);
		}
		const reason = `Cancelled by the parent session via subagent action="${action}".`;

		if (inline.some((run) => run.runId === id)) {
			// The gap between the listing and the kill is real: a run can settle in
			// it, and `interrupt` then correctly reports "not mine". Say so rather
			// than falling through to the background namespace, where the id
			// definitely does not belong.
			//
			// The file plane is written alongside the kill, never instead of it: the
			// request is filed before the signal so a crash leaves the intent readable,
			// and claimed afterwards so the child's watcher does not apply a stop the
			// parent already served.
			const control = fileControlRequest(registry, id, action, reason);
			const stopped = (await runner.interrupt?.(id)) ?? false;
			if (!stopped) {
				control?.settle("failed", "settled before the kill landed");
				throw new Error(`Inline run ${id} could not be interrupted — it settled before the kill landed.`);
			}
			control?.settle("delivered", `killed inline run ${id}`, true);
			return {
				content: [
					{
						type: "text",
						text: `Interrupted inline run ${id}. The child is killed gracefully, escalating if it survives the first signal, and the pending dispatch settles as aborted.`,
					},
				],
				details: { mode: "single", results: [], action },
			};
		}

		const row = background.find((task) => task.id === id);
		if (row !== undefined) {
			// File the stop before cancelling: if the kill cannot reach the child, the
			// request stays pending in its inbox as the backstop path, and the receipt
			// ledger says so instead of pretending the run died.
			const control = fileControlRequest(registry, id, action, reason);
			const outcome = await registry.cancel(id, reason);
			// The tool text is derived from what cancel() actually achieved. A
			// cancellation that could not reach its child must say so: the old
			// text claimed "cancelled" while the child kept burning tokens, which
			// is worse than reporting no cancellation at all.
			if (outcome.kind === "not-cancelled") {
				control?.settle("failed", outcome.reason);
				throw new Error(`Could not stop background task ${id} (role=${row.role}): ${outcome.reason}`);
			}
			if (outcome.kind === "not-found" || outcome.kind === "already-terminal") {
				control?.settle(
					"failed",
					outcome.kind === "not-found" ? "no registry row to cancel" : "already terminal",
					true,
				);
			} else {
				control?.settle("delivered", `cancelled background task ${id}`, true);
			}
			// Release the id whether or not it held a slot: a running task frees its
			// slot and the queue advances, and a queued task is dropped from the queue
			// by that same drain (its row is no longer pending). Cancelling without
			// this would strand everything behind it until some unrelated settle
			// happened to fire the pump.
			releaseBackgroundDispatch(
				registry,
				id,
				(options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS).maxConcurrent,
			);
			const text =
				outcome.kind === "cancelled-queued"
					? `Background task ${id} (role=${row.role}) was queued and had not started: marked cancelled and dropped from the concurrency queue. ${reason} No child process was launched for it.`
					: `Background task ${id} (role=${row.role}) marked cancelled: ${reason} ${
							outcome.kind !== "cancelled"
								? ""
								: outcome.pid === undefined
									? "The child had not spawned yet; it will be killed the moment it does."
									: outcome.killed
										? `Signalled pid ${outcome.pid} (graceful first, escalating to a process-tree kill if it survives) and the row is now cancelled.`
										: `Child pid ${outcome.pid} had already exited on its own; no signal was needed.`
						}`;
			return {
				content: [{ type: "text", text }],
				details: { mode: "single", results: [], action },
			};
		}

		const inlineIds = inline.map((run) => run.runId);
		const backgroundIds = background.map((task) => task.id);
		const known = [
			inlineIds.length > 0 ? `inline: ${inlineIds.join(", ")}` : "inline: none",
			backgroundIds.length > 0 ? `background: ${backgroundIds.join(", ")}` : "background: none",
		].join("; ");
		throw new Error(`Unknown subagent run "${id}" (${known}). Run action="status" for a full listing.`);
	};

	return {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to a subagent that runs with a fresh context and returns its final summary.",
			"Define the subagent per call: `role` (short specialist label) and `instructions` (the complete task — the subagent never sees this conversation, so include all context it needs), optionally `model` (omit to inherit this session's model) and a `tools` allowlist.",
			"Modes: single (`role` + `instructions`), parallel (`tasks`: independent investigations that can run at once), chain (`chain`: sequential steps where `{previous}` is replaced with the previous step's output).",
			"Control: `action` manages runs instead of starting one — 'status' lists unfinished runs (with any filed control requests, their receipt state, and the questions a run has asked you), 'stop'/'interrupt' end one, 'steer' (`id` + `message`) redirects a run against its own child session, 'swap-model' (`id` + `model`) does the same on a new model, 'supervisor' (`id` + `replyTo` + `message`) answers a question a run asked with `contact_supervisor`, 'resume' (`id` + optional `message`) re-dispatches a run that has already settled against the child session it left behind, and 'save-spec'/'list-specs'/'delete-spec' manage stored dispatches. Target ids come from a 'status' listing. Controlling a run whose child has detached is not lost: steer/stop/interrupt file the request in the run's control inbox and the child picks it up itself.",
		].join(" "),
		promptSnippet: "Delegate work to a subagent with a fresh context (role + instructions per call)",
		parameters: subagentSchema,

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme);
		},

		async execute(_toolCallId, rawParams, signal, onUpdate) {
			// Failure contract (matches agent-loop): dispatch failures (invalid
			// params, unknown model) and single/chain run failures THROW — the loop
			// turns a thrown error into error content + isError:true. A parallel
			// batch with per-task failures still resolves: the call itself worked.
			const parent = { ...(options?.getParentContext?.() ?? {}), depth: options?.depth ?? 0 };
			// Resolved once per dispatch; threading the same value into every
			// runOne call (single / chain steps / parallel tasks) keeps the
			// child's `--session-parent` arg identical across steps and lets a
			// later resume land back in the parent's session dir.
			const parentSessionFile = options?.getParentSessionFile?.();
			const runner = getRunner();

			// ----------------------------------------------------------------
			// Control plane: `action` short-circuits before dispatch, model
			// resolution, mode validation, and the dispatch-path spawn budget. A
			// listing or spec call spawns nothing; 'steer' / 'swap-model' / 'resume'
			// re-dispatch one replacement child through the normal path, which
			// accounts for the spawn budget inside `dispatchRedirect`.
			// ----------------------------------------------------------------
			if (rawParams.action !== undefined) {
				return await handleManagementAction(
					rawParams.action,
					rawParams,
					runner,
					cwd,
					parent,
					parentSessionFile,
					signal,
					onUpdate,
				);
			}

			// Read live per dispatch — see SubagentToolOptions.subagentSettings.
			const subagentSettings = options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS;

			// ----------------------------------------------------------------
			// Agent dispatch: `agent` names a reusable definition, resolved
			// BEFORE model resolution and expanded into inline dispatch fields, so a
			// model from the definition is canonicalized — and a typo fails — on the
			// same path an inline spec takes. Definition files (project scope, then
			// user scope) win over the older saved-spec store on a name collision,
			// because a hand-authored file is the deliberate one. A file carries
			// configuration and the call still carries the task; a saved spec carries
			// both, so `instructions` is then rejected. Call-site fields win over
			// either source, and `agent` never coexists with an inline definition, so
			// mode validation below still sees exactly one mode.
			// ----------------------------------------------------------------
			let dispatchParams: SubagentToolInput = rawParams;
			if (rawParams.agent !== undefined) {
				const agentName = validateSpecName(rawParams.agent, "`agent`");
				if (
					(rawParams.role ?? "").trim() !== "" ||
					(rawParams.tasks?.length ?? 0) > 0 ||
					(rawParams.chain?.length ?? 0) > 0 ||
					(rawParams.dag?.length ?? 0) > 0
				) {
					throw new Error(
						"Invalid parameters. `agent` names a whole agent, so it is mutually exclusive with `role`, `tasks`, `chain`, and `dag`. Pass this call's task in `instructions`; overrides go in top-level `model` / `tools` / `thinking` / `cwd`.",
					);
				}
				const definition = resolveAgent(agentName, cwd);
				if (definition !== undefined) {
					// A definition file is configuration, not a task — the orchestrator
					// still has to say what to do. Its system prompt goes in front of the
					// task verbatim, so the child reads standing guidance plus this call's
					// work, and the authored text is never reflowed.
					const taskText = rawParams.instructions ?? "";
					if (taskText.trim() === "") {
						throw new Error(
							`Invalid parameters. Agent "${definition.name}" is a definition file: it supplies model, tools, thinking, and a system prompt, but the task itself must come from \`instructions\`.`,
						);
					}
					dispatchParams = {
						...rawParams,
						role: definition.name,
						instructions:
							definition.systemPrompt === undefined ? taskText : `${definition.systemPrompt}\n\n${taskText}`,
						model: rawParams.model ?? definition.model,
						tools: rawParams.tools ?? definition.tools,
						thinking: rawParams.thinking ?? definition.thinking,
					};
				} else {
					const savedNames = new Set(listSpecs().map((saved) => saved.name));
					if (!savedNames.has(agentName)) throw new Error(unknownAgentError(agentName, cwd));
					if (rawParams.instructions !== undefined) {
						throw new Error(
							`Invalid parameters. "${agentName}" is a saved spec, which carries its own \`instructions\`, so they cannot be overridden here. Dispatch the definition-file form (.pi/agents/<name>.md) to supply the task per call, or save a new spec with action "save-spec".`,
						);
					}
					const saved = loadSpec(agentName);
					dispatchParams = {
						...rawParams,
						role: saved.role,
						instructions: saved.instructions,
						model: rawParams.model ?? saved.model,
						tools: rawParams.tools ?? saved.tools,
						cwd: rawParams.cwd ?? saved.cwd,
						thinking: rawParams.thinking ?? saved.thinking,
						// The contract fields belong to the spec, so the saved values are the
						// defaults and a top-level override wins — same rule as model/tools/cwd.
						outputSchema: rawParams.outputSchema ?? saved.outputSchema,
						gate: rawParams.gate ?? saved.gate,
					};
				}
			}

			const resolution = options?.resolveModel
				? resolveModelOverrides(dispatchParams, options.resolveModel)
				: { input: dispatchParams };
			if (resolution.error !== undefined) {
				throw new Error(resolution.error);
			}
			const params = resolution.input;

			const singleSpec =
				params.role && params.instructions?.trim()
					? specFromInput({ ...params, role: params.role, instructions: params.instructions })
					: undefined;
			const tasks = params.tasks ?? [];
			const chain = params.chain ?? [];
			const dag = params.dag ?? [];
			const modeCount =
				Number(singleSpec !== undefined) +
				Number(tasks.length > 0) +
				Number(chain.length > 0) +
				Number(dag.length > 0);
			const mode: SubagentMode =
				dag.length > 0 ? "dag" : chain.length > 0 ? "chain" : tasks.length > 0 ? "parallel" : "single";

			if (modeCount !== 1) {
				throw new Error(
					"Invalid parameters. Provide exactly one mode: `{ role, instructions }` (single), `{ tasks }` (parallel), `{ chain }` (sequential), or `{ dag }` (dependency graph).",
				);
			}

			// ----------------------------------------------------------------
			// Contract pre-flight, before the spawn budget is committed.
			//
			// Two rules, both cheaper here than after a child has run: an output
			// contract the validator cannot honor (unsupported keyword, empty gate
			// command) can never pass, so it must not cost a spawn; and a detached
			// dispatch cannot enforce contracts at all — it returns task ids
			// immediately and delivers results as text, so nothing would ever
			// validate the output or run the verify command. Dropping the contract
			// silently would be worse than refusing the call.
			// ----------------------------------------------------------------
			const dispatchedSpecs = [singleSpec, ...tasks, ...chain, ...dag].filter(
				(spec): spec is SubagentSpec => spec !== undefined,
			);
			for (const spec of dispatchedSpecs) {
				const problem = checkContractSpec(spec);
				if (problem !== undefined) throw new Error(problem);
			}
			if (
				params.background === true &&
				dispatchedSpecs.some((spec) => spec.outputSchema !== undefined || spec.gate !== undefined)
			) {
				throw new Error(
					"Invalid parameters. `background: true` cannot be combined with `outputSchema` or `gate`: a detached task returns its id immediately and its result arrives as plain text, so no one would validate the output or run the verify command. Dispatch inline (omit `background`) to get the contract, or drop the contract fields.",
				);
			}

			// ----------------------------------------------------------------
			// Session-wide spawn budget (subagent.maxTotalSpawns)
			//
			// Counted once per dispatched child: chain counts every step, parallel
			// counts every task, single counts 1, background counts every
			// detached task. The check is atomic — a parallel batch that would
			// push the counter past the cap is rejected as a whole, never
			// admitted partially.
			// ----------------------------------------------------------------
			const proposedSpawns =
				dag.length > 0
					? dag.length
					: chain.length > 0
						? chain.length
						: tasks.length > 0
							? tasks.length
							: singleSpec
								? 1
								: 0;
			// ----------------------------------------------------------------
			// Delegation depth (subagent.maxDepth)
			//
			// `maxTotalSpawns` cannot bound a tree: it is a per-process counter
			// and every child is its own process starting a fresh one. Depth is
			// the only bound that crosses the boundary, because it rides to the
			// child on argv and the child resolves its own tool set from it.
			//
			// Refused here so the parent gets a usable error, and dropped from
			// the child's tool set so the grandchild never sees the tool at all.
			// Only one is load-bearing on its own; both are cheap.
			// ----------------------------------------------------------------
			const depth = options?.depth ?? 0;
			const maxDepth = subagentSettings.maxDepth;
			if (proposedSpawns > 0 && depth + 1 > maxDepth) {
				throw new Error(
					`Subagent depth limit reached: this session is at delegation depth ${depth} and cannot spawn at level ${depth + 1} (subagent.maxDepth is ${maxDepth}). Do the work in this session instead of delegating further.`,
				);
			}
			const maxTotalSpawns = subagentSettings.maxTotalSpawns;
			if (proposedSpawns > 0 && totalSpawnCount + proposedSpawns > maxTotalSpawns) {
				throw new Error(
					`Subagent spawn budget exceeded: this call would add ${proposedSpawns} spawn(s) to the current ${totalSpawnCount}, exceeding the per-session cap of ${maxTotalSpawns} (subagent.maxTotalSpawns).`,
				);
			}
			// Commit the count up front: from the budget's perspective the spawn
			// slot is consumed the moment the call enters its dispatch path. Any
			// throw from here on is a dispatch failure, and the orchestrator pays
			// for the slot the same way it pays for a hung child.
			totalSpawnCount += proposedSpawns;
			// ----------------------------------------------------------------
			// Background: fire detached tasks, return their ids immediately.
			//
			// Chain stays sequential even detached: each step's {previous} carries
			// the prior step's output and the next step fires when it settles. (The
			// reference extension fired chain steps as independent tasks, ignoring
			// the dependency; that is corrected here.) Task ids are pre-generated so
			// the response can name every step up front.
			// ----------------------------------------------------------------
			if (params.background === true) {
				const registry = options?.registry ?? getBackgroundRegistry();
				const resolveTaskCwd = (spec: SubagentSpec) =>
					spec.cwd ? (isAbsolute(spec.cwd) ? spec.cwd : resolvePath(cwd, spec.cwd)) : cwd;
				const fire = (
					spec: SubagentSpec,
					taskId: string | undefined,
					onSettled?: (taskId: string, result: SubagentResult) => void,
				): string =>
					dispatchDetached({
						registry,
						runner,
						spec,
						task: spec.instructions,
						cwd: resolveTaskCwd(spec),
						parent,
						parentSessionFile,
						// Live getter rather than the `subagentSettings` snapshot above: the release
						// half of this closure runs when the task settles, which can be long after this
						// call returned. Reading the cap at settle time is what lets a mid-session
						// change to subagent.maxConcurrent apply to the drain instead of promoting
						// against a stale cap.
						settings: () => options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS,
						onSettled: onSettled ?? options?.onBackgroundSettled,
						...(taskId === undefined ? {} : { taskId }),
					}).taskId;

				const taskIds: string[] = [];
				if (singleSpec) {
					// fire() returns the post-add registry id (add() reassigns on a
					// collision), so the reported id always matches the registry.
					taskIds.push(fire(singleSpec, undefined));
				} else if (tasks.length > 0) {
					const ids = tasks.map(() => registry.makeTaskId());
					for (let i = 0; i < tasks.length; i++) taskIds.push(fire(specFromInput(tasks[i]), ids[i]));
				} else if (chain.length > 0) {
					const ids = chain.map(() => registry.makeTaskId());
					taskIds.push(...ids);
					// Best-effort bookkeeping for a chain step the up-front summary
					// already promised but that can never start (its dispatch threw).
					// update() can throw RegistryLockError and this runs inside a settle
					// callback that background.ts guards against throws — nothing may
					// propagate, and the dead step must settle explicitly instead of
					// leaving its promised id dangling.
					const failDeadStep = (next: number, message: string): void => {
						try {
							registry.update(ids[next], {
								status: "failed",
								errorMessage: `chain step ${next + 1} could not be dispatched: ${message}`,
								finishedAt: new Date().toISOString(),
							});
						} catch {
							/* best-effort */
						}
						registry.appendLog(ids[next], { type: "CHAIN_STEP_DISPATCH_FAILED", error: message });
						try {
							options?.onBackgroundSettled?.(ids[next], {
								role: chain[next].role,
								task: chain[next].instructions,
								exitCode: -1,
								aborted: false,
								finalOutput: "",
								stderr: message,
								usage: createEmptyUsage(),
								messages: [],
								errorMessage: `chain step ${next + 1} could not be dispatched: ${message}`,
							});
						} catch {
							/* best-effort */
						}
					};
					const fireStep = (index: number, previousOutput: string): void => {
						const stepInput = chain[index];
						const spec = specFromInput({
							...stepInput,
							// Function replacement: a literal $ pattern in `previousOutput`
							// must not be reinterpreted by `replace`.
							instructions: stepInput.instructions.replace(/\{previous\}/g, () =>
								truncateModelFacingOutput(previousOutput),
							),
						});
						// Steps beyond the first fire only when their predecessor settles,
						// so their pre-generated ids are all the up-front summary can name.
						// Record the post-add id back into the tracked arrays (add()
						// reassigns on a collision) so every later report and the
						// onSettled callback line up with the registry.
						const finalId = fire(spec, ids[index], (taskId, result) => {
							// background.ts swallows an onSettled throw as a warn and never
							// fires the remaining steps, so a sync throw here (a throwing
							// onBackgroundSettled, or fireStep dispatching the next step)
							// would silently orphan the ids the up-front summary promised.
							// Guard the whole continuation and settle the dead step instead.
							try {
								options?.onBackgroundSettled?.(taskId, result);
								const next = index + 1;
								if (next >= chain.length || isFailedSubagentResult(result)) return;
								fireStep(next, result.finalOutput);
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								const next = index + 1;
								if (next >= chain.length || isFailedSubagentResult(result)) return;
								failDeadStep(next, message);
							}
						});
						ids[index] = finalId;
						taskIds[index] = finalId;
					};
					fireStep(0, "");
				} else {
					// DAG detached: every node gets a pre-generated id so the up-front
					// summary can name the whole graph. Nodes launch as their dependencies
					// settle; a node that never dispatches (cascade skip, abort, a bad
					// reference) closes its own registry row via onSyntheticSettle.
					const runId = makeDagRunId();
					const ids = dag.map(() => registry.makeTaskId());
					const run = createDagRun({
						nodes: dag,
						runId,
						signal,
						taskIds: ids,
						onSyntheticSettle: (index, result) => {
							const failed = isFailedSubagentResult(result);
							try {
								registry.update(ids[index] as string, {
									status: result.aborted ? "cancelled" : failed ? "failed" : "completed",
									errorMessage: failed ? result.errorMessage || result.stderr : undefined,
									finishedAt: new Date().toISOString(),
								});
							} catch {
								/* best-effort */
							}
							registry.appendLog(ids[index] as string, { type: "DAG_NODE_SKIPPED", error: result.errorMessage });
							try {
								options?.onBackgroundSettled?.(ids[index] as string, result);
							} catch {
								/* best-effort */
							}
						},
					});
					taskIds.push(...ids);
					startDagDetached(run, (launch) => {
						const spec = specFromInput({ ...launch.node, instructions: launch.instructions });
						// fire() returns the post-add id (the registry reassigns on a collision).
						const finalId = fire(spec, ids[launch.index] as string, (taskId, result) => {
							// background.ts swallows a throwing onSettled as a warn and would
							// never reach the graph, so guard the notify and always close the
							// node — exactly once — or its dependents hang forever.
							try {
								options?.onBackgroundSettled?.(taskId, result);
							} catch {
								/* best-effort */
							}
							launch.done(result);
						});
						ids[launch.index] = finalId;
						taskIds[launch.index] = finalId;
						run.getState().nodes[launch.index].taskId = finalId;
					});
				}

				const summary = describeDetachedDispatch(registry, taskIds, mode);
				return {
					content: [{ type: "text", text: summary }],
					details: { mode, results: [], background: true, taskIds },
				};
			}

			// ----------------------------------------------------------------
			// DAG: dependency graph, ready-queue scheduling, {{nodes.X.result}} refs.
			// A run is a resolved result even when nodes fail or are skipped: the
			// per-node statuses carry the outcome, exactly like parallel mode.
			// ----------------------------------------------------------------
			if (dag.length > 0) {
				const runId = makeDagRunId();
				const run = createDagRun({
					nodes: dag,
					runId,
					maxConcurrent: subagentSettings.maxConcurrent,
					signal,
					onUpdate: (progress) => {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `DAG: ${progress.settled}/${progress.total} settled (${progress.running} running, ${progress.failed} failed, ${progress.skipped} skipped)`,
								},
							],
							details: { mode: "dag", results: run.getResults(), dag: run.getState() },
						});
					},
				});
				const progress = await runDagInline(run, async (launch) => {
					const spec = specFromInput({ ...launch.node, instructions: launch.instructions });
					return runOne(
						runner,
						spec,
						cwd,
						parent,
						parentSessionFile,
						launch.level + 1,
						launch.signal,
						launch.onPartial,
					);
				});
				const results = run.getResults();
				const nodeStates = run.getState().nodes;
				const summaries = results.map((result, index) => {
					const status = nodeStates[index]?.status ?? "completed";
					const output = truncateModelFacingOutput(getSubagentResultOutput(result));
					return `### [${result.role}] ${status}\n\n${output}`;
				});
				const finalText = `DAG: ${progress.completed}/${progress.total} completed, ${progress.failed} failed, ${progress.skipped} skipped\n\n${summaries.join("\n\n---\n\n")}`;
				return {
					content: [{ type: "text", text: truncateModelFacingOutput(finalText) || "(no output)" }],
					details: { mode: "dag", results, dag: run.getState() },
				};
			}

			// ----------------------------------------------------------------
			// Chain: sequential with {previous} substitution, stop at first failure
			// ----------------------------------------------------------------
			if (chain.length > 0) {
				const results: SubagentResult[] = [];
				let previousOutput = "";
				for (let i = 0; i < chain.length; i++) {
					const stepInput = chain[i];
					const spec = specFromInput({
						...stepInput,
						// Function replacement: a literal $ pattern in `previousOutput`
						// must not be reinterpreted by `replace`.
						instructions: stepInput.instructions.replace(/\{previous\}/g, () =>
							truncateModelFacingOutput(previousOutput),
						),
					});
					const result = await runOne(runner, spec, cwd, parent, parentSessionFile, i + 1, signal, (snapshot) => {
						onUpdate?.({
							content: [{ type: "text", text: snapshot.finalOutput || "(running)" }],
							details: { mode: "chain", results: [...results, snapshot] },
						});
					});
					results.push(result);
					if (isFailedSubagentResult(result)) {
						// A thrown error becomes tool-error content verbatim (agent-loop
						// contract) and carries no tool details — the embedded output must
						// respect the model-facing cap just like resolved output.
						throw new Error(
							`Chain stopped at step ${i + 1} (${stepInput.role}): ${truncateModelFacingOutput(getSubagentResultOutput(result), "")}`,
						);
					}
					previousOutput = result.finalOutput;
				}
				const last = results[results.length - 1];
				const finalText = truncateModelFacingOutput(last?.finalOutput ?? "");
				return {
					content: [{ type: "text", text: finalText || "(no output)" }],
					details: { mode: "chain", results },
				};
			}

			// ----------------------------------------------------------------
			// Parallel: bounded concurrency, per-task output cap
			// ----------------------------------------------------------------
			if (tasks.length > 0) {
				if (tasks.length > subagentSettings.maxParallelTasks) {
					throw new Error(
						`Too many parallel tasks (${tasks.length}). Max is ${subagentSettings.maxParallelTasks} (subagent.maxParallelTasks).`,
					);
				}

				const allResults: SubagentResult[] = tasks.map((task) => ({
					role: task.role,
					task: task.instructions,
					exitCode: -1,
					aborted: false,
					finalOutput: "",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				}));
				// Settled flags — not exit codes — mark completion in progress text:
				// a failed spawn settles with exitCode -1 while live snapshots stream
				// with exitCode -1 too, so the code alone cannot tell "running" from
				// "done and failed to start".
				const settled = tasks.map(() => false);
				const emitParallelUpdate = () => {
					if (!onUpdate) return;
					const done = settled.filter(Boolean).length;
					const running = allResults.length - done;
					onUpdate({
						content: [
							{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
						],
						details: { mode: "parallel", results: [...allResults] },
					});
				};

				const results = await mapWithConcurrencyLimit(
					tasks,
					subagentSettings.maxConcurrent,
					async (task, index) => {
						const result = await runOne(
							runner,
							specFromInput(task),
							cwd,
							parent,
							parentSessionFile,
							undefined,
							signal,
							(snapshot) => {
								allResults[index] = snapshot;
								emitParallelUpdate();
							},
						);
						allResults[index] = result;
						settled[index] = true;
						emitParallelUpdate();
						return result;
					},
				);

				const successCount = results.filter((r) => !isFailedSubagentResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateModelFacingOutput(getSubagentResultOutput(r));
					const status = isFailedSubagentResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.role}] ${status}\n\n${output}`;
				});
				// A partially failed batch is a resolved result — the tool did its job
				// and the per-task summaries carry each failure. Only a failed dispatch
				// throws.
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: { mode: "parallel", results },
				};
			}

			// ----------------------------------------------------------------
			// Single
			// ----------------------------------------------------------------
			const spec = singleSpec as SubagentSpec;
			const result = await runOne(runner, spec, cwd, parent, parentSessionFile, undefined, signal, (snapshot) => {
				onUpdate?.({
					content: [{ type: "text", text: snapshot.finalOutput || "(running)" }],
					details: { mode: "single", results: [snapshot] },
				});
			});
			if (isFailedSubagentResult(result)) {
				// Same cap as the chain throw above: thrown error.message becomes
				// tool-error content verbatim and has no tool details attached.
				throw new Error(
					`Subagent ${result.role} ${result.stopReason || "failed"}: ${truncateModelFacingOutput(getSubagentResultOutput(result), "")}`,
				);
			}
			return {
				content: [{ type: "text", text: truncateModelFacingOutput(result.finalOutput) || "(no output)" }],
				details: { mode: "single", results: [result] },
			};
		},
	};
}

/** Wrap the definition for the core runtime, mirroring `createBashTool`. */
export function createSubagentTool(cwd: string, options?: SubagentToolOptions): AgentTool<typeof subagentSchema> {
	const definition = createSubagentToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}

// Keep the result type referenced for consumers composing their own dispatchers.
export type { SubagentResult, SubagentSpec };
export type SubagentToolResult = AgentToolResult<SubagentToolDetails | undefined>;
export type SubagentToolUpdateCallback = AgentToolUpdateCallback<SubagentToolDetails | undefined>;
