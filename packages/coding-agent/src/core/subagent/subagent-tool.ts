/**
 * The native `subagent` tool.
 *
 * The orchestrator authors each subagent at call time — `role` (short label),
 * `instructions` (the complete task; the child never sees the parent
 * conversation), and optionally `model` and a `tools` allowlist. There are no
 * agent definition files and no discovery in this path.
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
 * Saved specs (`agent: "<name>"`) dispatch a spec an earlier
 * `action: "save-spec"` call stored, with top-level `model` / `tools` / `cwd`
 * overriding the saved values. `agent` and `role` are mutually
 * exclusive, and resolution happens before mode validation so a saved spec
 * occupies the single-dispatch slot.
 *
 * Control (`action`) manages runs instead of starting one. Beyond listing and
 * killing, `steer` and `swap-model` interrupt a target and re-dispatch it
 * against its own child session, carrying the new instruction in the
 * replacement run's prompt. See `handleManagementAction` for the exact
 * admission rules — a background task whose child has not provably settled is
 * never steered, because two processes appending to one session file corrupts it.
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

import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { endSubagentTask, newTaskSpanId, startSubagentTask } from "../analytics-store.ts";
import { DEFAULT_SUBAGENT_SETTINGS, type ResolvedSubagentSettings } from "../defaults.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { type BackgroundRegistry, getBackgroundRegistry, startBackgroundSubagent } from "./background.ts";
import { createBunProcessRunner } from "./bun-process-runner.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { isBunRuntime } from "./runtime.ts";
import { deleteSpec, listSpecs, loadSpec, saveSpec } from "./saved-specs.ts";
import {
	createEmptyUsage,
	getSubagentResultOutput,
	isFailedSubagentResult,
	type SubagentEventListener,
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

const subagentSpecSchema = Type.Object({
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
				Type.Literal("save-spec"),
				Type.Literal("list-specs"),
				Type.Literal("delete-spec"),
			],
			{
				description:
					"Control-plane call in place of a dispatch. 'status' lists every subagent run that has not settled; 'stop' and 'interrupt' are synonyms that ask one run to stop; 'steer' interrupts one run and re-dispatches it against its own child session with `message` appended; 'swap-model' does the same with a new `model` (plus optional `message`); 'save-spec' stores the dispatch fields of this call under `name`; 'list-specs' lists saved specs; 'delete-spec' removes the one under `name`. Mutually exclusive with role/instructions, tasks, and chain. Listing and spec calls spawn nothing, so the spawn budget is untouched; steer and swap-model re-dispatch through the normal path, which does account for the spawn budget.",
			},
		),
	),
	id: Type.Optional(
		Type.String({
			description:
				"Target of action 'stop'/'interrupt'/'steer'/'swap-model': an inline run id or a background task id, exactly as reported by action 'status'. Required for those actions.",
		}),
	),
	message: Type.Optional(
		Type.String({
			description:
				"New instruction for action 'steer' (required), or an optional continuation note for action 'swap-model'. Ignored by the other actions.",
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				"Dispatch a saved spec by `name` instead of defining one inline. The spec is loaded before mode validation, so it occupies the single-dispatch slot. Top-level `model` / `tools` / `cwd` override the saved values. Mutually exclusive with `role`.",
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
	 * Present when the call was a control-plane action instead of a dispatch.
	 * `results` is empty for those calls, with one exception: `steer` and
	 * `swap-model` re-dispatch a replacement run through the normal path, so
	 * they carry that run's result. The other actions only report on other runs
	 * and never produce one.
	 */
	action?: "status" | "stop" | "interrupt" | "steer" | "swap-model" | "save-spec" | "list-specs" | "delete-spec";
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

/** What a `steer` / `swap-model` call resolved its target id into. */
interface SteerTarget {
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
	const request: SubagentRunRequest = {
		spec,
		task: spec.instructions,
		cwd,
		...(parent.model === undefined ? {} : { parentModel: parent.model }),
		...(parent.thinkingLevel === undefined ? {} : { parentThinkingLevel: parent.thinkingLevel }),
		// parentSessionFile is set for every inline single/chain/parallel step
		// unless the harness has none. A spec.sessionFile (resume) wins in the
		// runner, so passing the parent path here too is safe.
		...(parentSessionFile === undefined ? {} : { parentSessionFile }),
		...(step === undefined ? {} : { step }),
	};

	const spanId = newTaskSpanId();
	startSubagentTask({ spanId, agentName: spec.role, taskLabel: spec.instructions.slice(0, 200) });

	try {
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
		const failed = isFailedSubagentResult(result);
		endSubagentTask(spanId, !failed, failed ? (result.errorMessage ?? `exit code ${result.exitCode}`) : undefined);
		return result;
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
}): SubagentSpec {
	return {
		role: input.role,
		instructions: input.instructions,
		...(input.model === undefined ? {} : { model: input.model }),
		...(input.tools === undefined ? {} : { tools: input.tools }),
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
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
	};
	const specs: Array<{ role?: string; model?: string }> = [];
	if (next.role !== undefined) specs.push(next);
	for (const task of next.tasks ?? []) specs.push(task);
	for (const step of next.chain ?? []) specs.push(step);

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
	//                     save-spec | list-specs | delete-spec
	//
	// Two namespaces are reported side by side rather than merged. Inline runs
	// live only in this process's runner and carry bare-UUID runIds; background
	// rows live in the on-disk registry and carry `bg_`-prefixed ids. Keeping
	// them distinct means an id copied out of a listing is always aimed at the
	// right place.
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
	 */
	const redispatchSteered = async (payload: {
		action: "steer" | "swap-model";
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
	}): Promise<SubagentToolResult> => {
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
		const verb = action === "steer" ? "Steered" : "Re-dispatched with a new model";
		const head = `${verb} ${target.kind} run ${target.id} (role=${target.role}), resuming child session ${target.sessionFile}`;

		if (payload.background) {
			const registry = options?.registry ?? getBackgroundRegistry();
			const dispatch = startBackgroundSubagent({
				registry,
				runner: payload.runner,
				spec,
				task: spec.instructions,
				cwd: target.cwd,
				parentModel: payload.parent.model,
				parentThinkingLevel: payload.parent.thinkingLevel,
				...(payload.parentSessionFile === undefined ? {} : { parentSessionFile: payload.parentSessionFile }),
				onSettled: options?.onBackgroundSettled,
			});
			return {
				content: [
					{ type: "text", text: [`${head} as detached task ${dispatch.taskId}.`, ...target.warnings].join(" ") },
				],
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
			}
			rows.push(`Background tasks (registry, running or pending): ${background.length}`);
			for (const task of background) {
				rows.push(
					[
						`  id=${task.id}`,
						`role=${task.role}`,
						`status=${task.status}`,
						task.pid === undefined ? "" : `pid=${task.pid}`,
						`started=${task.startedAt}`,
						`cwd=${task.cwd}`,
						`task=${clipForListing(task.task, LISTING_TASK_CLIP)}`,
					]
						.filter(Boolean)
						.join(" "),
				);
			}
			if (inline.length === 0 && background.length === 0) rows.push("No subagent run is in flight.");
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
		// steer / swap-model: interrupt a target and re-dispatch its replacement
		// against the same child session file.
		//
		// Both arguments are validated before anything is killed, so a malformed
		// steer leaves the original run running.
		// ----------------------------------------------------------------------
		if (action === "steer" || action === "swap-model") {
			const target = resolveSteerTarget(action, rawParams.id, runner, registry);
			const message = (rawParams.message ?? "").trim();
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
			return await redispatchSteered({
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
			const stopped = (await runner.interrupt?.(id)) ?? false;
			if (!stopped) {
				throw new Error(`Inline run ${id} could not be interrupted — it settled before the kill landed.`);
			}
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
			await registry.cancel(id, reason);
			return {
				content: [
					{
						type: "text",
						text: `Background task ${id} (role=${row.role}) marked cancelled in the registry: ${reason} This does not signal the detached child — it keeps running, and when it settles it overwrites the row's status.`,
					},
				],
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
			"Control: `action` ('status' / 'stop' / 'interrupt') manages runs instead of starting one; `id` names the target run, taken from a 'status' listing.",
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
			const parent = options?.getParentContext?.() ?? {};
			// Resolved once per dispatch; threading the same value into every
			// runOne call (single / chain steps / parallel tasks) keeps the
			// child's `--session-parent` arg identical across steps and lets a
			// later resume land back in the parent's session dir.
			const parentSessionFile = options?.getParentSessionFile?.();
			const runner = getRunner();

			// ----------------------------------------------------------------
			// Control plane: `action` short-circuits before dispatch, model
			// resolution, mode validation, and the spawn budget. A control call
			// spawns nothing, so it neither proposes nor commits a spawn slot.
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

			// --------------------------------------------------------------
			// Saved-spec dispatch: `agent` names a spec an earlier call stored.
			// It is expanded into inline dispatch fields BEFORE model
			// resolution, so the saved model is canonicalized — and a typo
			// fails — on the same path an inline spec takes. Call-site fields
			// win over saved ones; `agent` never coexists with an inline
			// definition, so mode validation below still sees exactly one mode.
			// --------------------------------------------------------------
			let dispatchParams: SubagentToolInput = rawParams;
			if (rawParams.agent !== undefined) {
				const agentName = validateSpecName(rawParams.agent, "`agent`");
				if (
					(rawParams.role ?? "").trim() !== "" ||
					rawParams.instructions !== undefined ||
					(rawParams.tasks?.length ?? 0) > 0 ||
					(rawParams.chain?.length ?? 0) > 0
				) {
					throw new Error(
						"Invalid parameters. `agent` dispatches a saved spec and is mutually exclusive with `role`/`instructions`, `tasks`, and `chain`. Overrides go in top-level `model` / `tools` / `cwd`.",
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
				};
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
			const modeCount = Number(singleSpec !== undefined) + Number(tasks.length > 0) + Number(chain.length > 0);
			const mode: SubagentMode = chain.length > 0 ? "chain" : tasks.length > 0 ? "parallel" : "single";

			if (modeCount !== 1) {
				throw new Error(
					"Invalid parameters. Provide exactly one mode: `{ role, instructions }` (single), `{ tasks }` (parallel), or `{ chain }` (sequential).",
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
			const proposedSpawns = chain.length > 0 ? chain.length : tasks.length > 0 ? tasks.length : singleSpec ? 1 : 0;
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
				): string => {
					const dispatch = startBackgroundSubagent({
						registry,
						runner,
						spec,
						task: spec.instructions,
						cwd: resolveTaskCwd(spec),
						parentModel: parent.model,
						parentThinkingLevel: parent.thinkingLevel,
						// Background children nest under the parent's session dir
						// the same way inline children do. spec.sessionFile (resume)
						// still wins inside the runner, so passing both is safe.
						...(parentSessionFile === undefined ? {} : { parentSessionFile }),
						onSettled: onSettled ?? options?.onBackgroundSettled,
						...(taskId === undefined ? {} : { taskId }),
					});
					return dispatch.taskId;
				};

				const taskIds: string[] = [];
				if (singleSpec) {
					// fire() returns the post-add registry id (add() reassigns on a
					// collision), so the reported id always matches the registry.
					taskIds.push(fire(singleSpec, undefined));
				} else if (tasks.length > 0) {
					const ids = tasks.map(() => registry.makeTaskId());
					for (let i = 0; i < tasks.length; i++) taskIds.push(fire(specFromInput(tasks[i]), ids[i]));
				} else {
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
				}

				const summary =
					taskIds.length === 1
						? `Background task ${taskIds[0]} started (${mode}). Its result is delivered when it settles.`
						: `Started ${taskIds.length} background tasks: ${taskIds.join(", ")} (${mode}). Results are delivered as they settle.`;
				return {
					content: [{ type: "text", text: summary }],
					details: { mode, results: [], background: true, taskIds },
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
