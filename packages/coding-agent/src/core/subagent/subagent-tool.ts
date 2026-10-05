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
 * Background (`background: true`) dispatch is intentionally NOT parallel-capped
 * or concurrency-limited: `maxParallelTasks`/`maxConcurrent` bound the inline
 * work of one call, while a detached task outlives the turn. The on-disk
 * registry is the record of what is running.
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
});

export type SubagentToolInput = Static<typeof subagentSchema>;

export interface SubagentToolDetails {
	mode: SubagentMode;
	results: SubagentResult[];
	/** Present when the call dispatched background tasks instead of running inline. */
	background?: boolean;
	taskIds?: string[];
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
		defaultRunner ??= createBunProcessRunner();
		return options?.runner ?? defaultRunner;
	};

	return {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to a subagent that runs with a fresh context and returns its final summary.",
			"Define the subagent per call: `role` (short specialist label) and `instructions` (the complete task — the subagent never sees this conversation, so include all context it needs), optionally `model` (omit to inherit this session's model) and a `tools` allowlist.",
			"Modes: single (`role` + `instructions`), parallel (`tasks`: independent investigations that can run at once), chain (`chain`: sequential steps where `{previous}` is replaced with the previous step's output).",
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
			const runner = getRunner();
			// Read live per dispatch — see SubagentToolOptions.subagentSettings.
			const subagentSettings = options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS;

			const resolution = options?.resolveModel
				? resolveModelOverrides(rawParams, options.resolveModel)
				: { input: rawParams };
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
					const result = await runOne(runner, spec, cwd, parent, i + 1, signal, (snapshot) => {
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
			const result = await runOne(runner, spec, cwd, parent, undefined, signal, (snapshot) => {
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
