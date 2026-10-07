/**
 * Declarative DAG orchestration for the `subagent` tool (#1052, part 1).
 *
 * `chain` wires an implicit linear pipeline together through `{previous}`. `dag`
 * makes the graph explicit: every node names the nodes it depends on, the
 * scheduler launches each node as soon as its dependencies have settled (maximal
 * parallelism within the `subagent.maxConcurrent` cap), and
 * `{{nodes.<name>.result}}` in a node's instructions is replaced with that node's
 * capped output at launch time.
 *
 * The graph state machine (`createDagRun`) is deliberately separate from the
 * dispatch. Two drivers sit on top of it — `runDagInline` (awaits each node) and
 * `startDagDetached` (fire-and-forget) — and both call the same `begin` /
 * `settle` methods, so a background DAG honors `dependsOn`, cascades failures,
 * and writes the same `dag-state.json` as an inline one. Neither driver knows
 * how a child is spawned, which keeps the whole layer testable with a stub
 * dispatch that launches nothing, and keeps this module free of any import from
 * `subagent-tool.ts` (the tool imports this file, never the reverse).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { createEmptyUsage, type DagNodeSpec, isFailedSubagentResult, type SubagentResult } from "./types.ts";

/** Directory under the agent dir holding one folder per DAG run. */
export const DAG_DIR_NAME = "subagent-dag";
/** Per-run graph state file, rewritten atomically on every node state change. */
export const DAG_STATE_FILE_NAME = "dag-state.json";
/** Hard ceiling on nodes in one DAG call. A fan-out this wide is a different shape of work. */
export const DAG_MAX_NODES = 32;
/**
 * Cap on the text substituted for one `{{nodes.<name>.result}}` reference, in
 * UTF-8 bytes. Separate from `PER_TASK_OUTPUT_CAP` on purpose: a node's own
 * result is capped at 50 KB for the model, but the copy injected into a
 * dependent's prompt stays small enough that a wide fan-out cannot stack a
 * dozen 50 KB blobs into one instruction.
 */
export const DAG_NODE_OUTPUT_CAP = 8000;

/**
 * One authored DAG node: the `tasks` / `chain` entry fields plus `dependsOn`
 * (#1052). Named here because the scheduler, the validators, and both drivers
 * all speak in terms of it.
 */
export type DagNodeInput = DagNodeSpec;

export type DagNodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type DagRunStatus = "running" | "completed" | "failed" | "aborted";

export interface DagNodeRecord {
	/** The node id: its authored `role`. */
	name: string;
	index: number;
	level: number;
	status: DagNodeStatus;
	dependsOn: string[];
	startedAt?: string;
	finishedAt?: string;
	/** Character count of the settled output, never the output itself. */
	outputChars?: number;
	error?: string;
	/** Detached dispatch id, set when the run is backgrounded. */
	taskId?: string;
}

export interface DagStateFile {
	runId: string;
	mode: "dag";
	status: DagRunStatus;
	createdAt: string;
	updatedAt: string;
	nodes: DagNodeRecord[];
}

export interface DagProgress {
	total: number;
	settled: number;
	running: number;
	completed: number;
	failed: number;
	skipped: number;
}

/** `{{nodes.<id>.result}}`. Ids are node roles (trimmed) or array indices. */
const DAG_NODE_REF_RE = /\{\{\s*nodes\.([^{}]+?)\.result\s*\}\}/g;

/** Mint the id naming one DAG run. Timestamp prefix keeps run dirs sortable. */
export function makeDagRunId(): string {
	return `dag_${Date.now().toString(36)}_${randomUUID()}`;
}

export function dagRunDir(runId: string): string {
	return join(getAgentDir(), DAG_DIR_NAME, runId);
}

export function dagStatePath(runId: string): string {
	return join(dagRunDir(runId), DAG_STATE_FILE_NAME);
}

export function serializeDagState(state: DagStateFile): string {
	return `${JSON.stringify(state, undefined, "\t")}\n`;
}

/** Atomic write: temp file in the target dir, then rename over the state. */
export function writeDagState(path: string, state: DagStateFile): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, serializeDagState(state));
	renameSync(tmp, path);
}

/** Returns undefined for a missing state file and for one that cannot be parsed. */
export function readDagState(path: string): DagStateFile | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	return parseDagState(raw);
}

export function parseDagState(raw: string): DagStateFile | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const state = value as Partial<DagStateFile>;
	if (typeof state.runId !== "string" || !Array.isArray(state.nodes)) return undefined;
	if (typeof state.status !== "string" || typeof state.createdAt !== "string") return undefined;
	return state as DagStateFile;
}

/**
 * Resolve one `dependsOn` / placeholder reference to a node index: a role match
 * wins, then an array index. Returns undefined for a reference that names nothing.
 */
export function resolveNodeRef(nodes: readonly DagNodeInput[], ref: string): number | undefined {
	const trimmed = ref.trim();
	if (trimmed === "") return undefined;
	const byRole = nodes.findIndex((node) => node.role === trimmed);
	if (byRole !== -1) return byRole;
	if (/^\d+$/.test(trimmed)) {
		const index = Number(trimmed);
		if (index >= 0 && index < nodes.length) return index;
	}
	return undefined;
}

/** Every `{{nodes.<id>.result}}` id written into a node's instructions. */
export function referencedNodeIds(instructions: string): string[] {
	const ids: string[] = [];
	for (const match of instructions.matchAll(DAG_NODE_REF_RE)) {
		if (match[1] !== undefined) ids.push(match[1]);
	}
	return ids;
}

/** Resolved dependency indices for one node. Assumes the graph already validated. */
function dependencyIndices(nodes: readonly DagNodeInput[], index: number): number[] {
	const out: number[] = [];
	for (const ref of nodes[index].dependsOn ?? []) {
		const resolved = resolveNodeRef(nodes, ref);
		if (resolved !== undefined && !out.includes(resolved)) out.push(resolved);
	}
	return out;
}

/**
 * Check the authored graph before a single child is spawned.
 *
 * Every rule here is cheaper to report now than after a fan-out has cost real
 * tokens: an empty or oversized graph, a blank or duplicated node id, a
 * dependency that names no node, a self-dependency, a cycle, and a
 * `{{nodes.<id>.result}}` reference that is not a direct dependency (a dependent
 * can only read what it waits for, so a reference to anything else can never
 * resolve — and reading a transitive dependency's output through a node that
 * does not wait for it would race).
 */
export function validateDagGraph(nodes: readonly DagNodeInput[]): void {
	if (nodes.length === 0) {
		throw new Error("dag graph invalid: `dag` must contain at least one node.");
	}
	if (nodes.length > DAG_MAX_NODES) {
		throw new Error(
			`dag graph invalid: \`dag\` supports at most ${DAG_MAX_NODES} nodes, got ${nodes.length}. Split the work across calls, or run independent work as \`tasks\`.`,
		);
	}

	const names = nodes.map((node) => node.role.trim());
	names.forEach((name, index) => {
		const node = nodes[index] as DagNodeInput;
		if (name === "") {
			throw new Error(`dag graph invalid: node ${index} has an empty \`role\`; a node id is required.`);
		}
		if (name !== node.role) {
			throw new Error(`dag graph invalid: node id "${node.role}" has leading or trailing whitespace.`);
		}
		if (node.instructions.trim() === "") {
			throw new Error(`dag graph invalid: node "${name}" has empty \`instructions\`.`);
		}
		const duplicate = names.indexOf(name);
		if (duplicate !== index) {
			throw new Error(`dag graph invalid: duplicate node id "${name}" (nodes ${duplicate} and ${index}).`);
		}
	});

	for (let index = 0; index < nodes.length; index++) {
		const name = names[index] as string;
		for (const ref of nodes[index].dependsOn ?? []) {
			const trimmed = ref.trim();
			if (trimmed === "") {
				throw new Error(`dag graph invalid: node "${name}" has an empty \`dependsOn\` entry.`);
			}
			const resolved = resolveNodeRef(nodes, trimmed);
			if (resolved === undefined) {
				throw new Error(
					`dag graph invalid: node "${name}" depends on unknown node "${trimmed}". Known node ids: ${names.join(", ")}.`,
				);
			}
			if (resolved === index) {
				throw new Error(`dag graph invalid: node "${name}" depends on itself.`);
			}
		}
	}

	const deps = nodes.map((_, index) => dependencyIndices(nodes, index));
	const cycle = findCycle(names, deps);
	if (cycle !== undefined) {
		throw new Error(`dag graph invalid: cycle detected: ${cycle.join(" → ")}.`);
	}

	for (let index = 0; index < nodes.length; index++) {
		const name = names[index] as string;
		const declared = new Set(deps[index]);
		for (const ref of referencedNodeIds(nodes[index].instructions)) {
			const resolved = resolveNodeRef(nodes, ref);
			if (resolved === undefined || !declared.has(resolved)) {
				throw new Error(
					`dag graph invalid: node "${name}" references {{nodes.${ref}.result}} but "${ref}" is not one of its \`dependsOn\` nodes (a node may only read the output of a node it waits for).`,
				);
			}
		}
	}
}

/** Depth-first back-edge search. Returns the cycle as node ids, first repeated last. */
function findCycle(names: readonly string[], deps: readonly (readonly number[])[]): string[] | undefined {
	const unvisited = 0;
	const onPath = 1;
	const done = 2;
	const marks = new Array<number>(names.length).fill(unvisited);
	const path: number[] = [];

	const visit = (index: number): string[] | undefined => {
		marks[index] = onPath;
		path.push(index);
		for (const dep of deps[index] ?? []) {
			if (marks[dep] === onPath) {
				// Report from the first node of the loop so the cycle reads as a loop.
				const start = path.indexOf(dep);
				const loop = path.slice(start).concat(dep);
				return loop.map((i) => names[i] as string);
			}
			if (marks[dep] === unvisited) {
				const found = visit(dep);
				if (found !== undefined) return found;
			}
		}
		path.pop();
		marks[index] = done;
		return undefined;
	};

	for (let index = 0; index < names.length; index++) {
		if (marks[index] !== unvisited) continue;
		const found = visit(index);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * Longest-path layering: a node's level is one more than the deepest level of
 * its dependencies. Levels are reporting metadata (`step` on the result and the
 * state file), not the scheduling unit — the scheduler is a ready queue, so a
 * node whose dependencies finished early launches before a slower node in its
 * own level finishes.
 */
export function computeDagLevels(nodes: readonly DagNodeInput[]): number[] {
	const deps = nodes.map((_, index) => dependencyIndices(nodes, index));
	const levels = new Array<number>(nodes.length).fill(0);
	const resolved = new Array<boolean>(nodes.length).fill(false);
	const visit = (index: number): number => {
		if (resolved[index]) return levels[index] as number;
		resolved[index] = true;
		let level = 0;
		for (const dep of deps[index] ?? []) {
			level = Math.max(level, visit(dep) + 1);
		}
		levels[index] = level;
		return level;
	};
	for (let index = 0; index < nodes.length; index++) visit(index);
	return levels;
}

/**
 * Cap substituted node output at `DAG_NODE_OUTPUT_CAP` UTF-8 bytes.
 *
 * Trimming walks code points, so the cut can never split a surrogate pair, and
 * the note follows the `PER_TASK_OUTPUT_CAP` convention.
 */
export function capDagNodeOutput(output: string, cap: number = DAG_NODE_OUTPUT_CAP): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return output;

	let keptBytes = 0;
	let keptLength = 0;
	for (const codePoint of output) {
		const width = Buffer.byteLength(codePoint, "utf8");
		if (keptBytes + width > cap) break;
		keptBytes += width;
		keptLength += codePoint.length;
	}
	const omitted = byteLength - keptBytes;
	const suffix = omitted === 1 ? "1 byte" : `${omitted} bytes`;
	return `${output.slice(0, keptLength)}\n[... ${suffix} omitted from this node reference; the node's full output stays in the run's tool details]`;
}

/**
 * Replace every `{{nodes.<id>.result}}` in `instructions` with the producing
 * node's capped output.
 *
 * Substitution happens at launch, never at authoring time, so a node sees the
 * real output of the node it waited for. The replacement is a function form:
 * a `$&` / `$1` sequence inside a dependency's output is inserted verbatim
 * instead of being re-read as a replacement pattern.
 */
export function substituteNodeResults(
	nodes: readonly DagNodeInput[],
	index: number,
	instructions: string,
	outputs: readonly (string | undefined)[],
	cap: number = DAG_NODE_OUTPUT_CAP,
): string {
	return instructions.replace(DAG_NODE_REF_RE, (match, rawId: string) => {
		const id = rawId.trim();
		const target = resolveNodeRef(nodes, id);
		if (target === undefined) {
			throw new Error(
				`dag node "${nodes[index].role}" references ${match}, but no node has that id (known ids: ${nodes
					.map((node) => node.role)
					.join(", ")}).`,
			);
		}
		if (!dependencyIndices(nodes, index).includes(target)) {
			throw new Error(
				`dag node "${nodes[index].role}" references {{nodes.${id}.result}}, but "${id}" is not in its \`dependsOn\`.`,
			);
		}
		const output = outputs[target];
		if (output === undefined) {
			throw new Error(
				`dag node "${nodes[index].role}" references {{nodes.${id}.result}}, but "${id}" has no output yet.`,
			);
		}
		return capDagNodeOutput(output, cap);
	});
}

/** Result for a node that never ran, shaped like a settled failure so summaries count it. */
export function createSkippedDagResult(node: DagNodeInput, level: number, reason: string): SubagentResult {
	return {
		role: node.role,
		task: node.instructions,
		// An unlaunched node has no process exit code. 1 keeps it in the failed
		// bucket, which is the true reading: the node did not deliver what was asked.
		exitCode: 1,
		aborted: false,
		finalOutput: "",
		stderr: "",
		usage: createEmptyUsage(),
		stopReason: "skipped",
		errorMessage: reason,
		step: level + 1,
		messages: [],
	};
}

/** Result for a node the scheduler could not even launch (a bad placeholder). */
export function createDagLaunchFailureResult(node: DagNodeInput, level: number, message: string): SubagentResult {
	return {
		role: node.role,
		task: node.instructions,
		exitCode: 1,
		aborted: false,
		finalOutput: "",
		stderr: "",
		usage: createEmptyUsage(),
		stopReason: "error",
		errorMessage: message,
		step: level + 1,
		messages: [],
	};
}

/** One node's scheduler-side state, kept beside the serializable record. */
interface DagNodeRuntime {
	record: DagNodeRecord;
	level: number;
	deps: number[];
	dependents: number[];
	settled: boolean;
	result?: SubagentResult;
	/** Live snapshot of an in-flight node, for progress reporting. */
	snapshot?: SubagentResult;
}

export interface DagLaunch {
	index: number;
	node: DagNodeInput;
	/** 0-based topological level; `step` on the result is this + 1. */
	level: number;
	/** Node instructions with every `{{nodes.<id>.result}}` already replaced. */
	instructions: string;
	signal?: AbortSignal;
	/** Fold an in-flight snapshot into the run's progress without settling the node. */
	onPartial: (result: SubagentResult) => void;
}

export type DagNodeRunner = (launch: DagLaunch) => Promise<SubagentResult>;
export type DagNodeDispatcher = (launch: DagLaunch) => void;

export interface DagRunOptions {
	nodes: DagNodeInput[];
	runId: string;
	/** Absolute path of `dag-state.json`. Defaults to `dagStatePath(runId)`. */
	statePath?: string;
	/** Cap on simultaneously launched nodes. Default: unbounded. */
	maxConcurrent?: number;
	signal?: AbortSignal;
	/** Detached dispatch ids, index-aligned with `nodes`, for a background run. */
	taskIds?: string[];
	onUpdate?: (progress: DagProgress) => void;
	/**
	 * Called for a node that settles without ever being dispatched — a cascade
	 * skip, an abort before launch, or a substitution error. The background path
	 * uses it to close the node's registry row and fire the completion callback.
	 */
	onSyntheticSettle?: (index: number, result: SubagentResult) => void;
}

export interface DagRun {
	readonly runId: string;
	readonly nodes: readonly DagNodeInput[];
	readonly statePath: string;
	/** Serializable view of the graph, current at every state change. */
	getState(): DagStateFile;
	getProgress(): DagProgress;
	/** Pending nodes whose dependencies all completed, in authoring order. */
	readyIndices(): number[];
	inFlightCount(): number;
	/** Claim one launch slot. Returns false when `maxConcurrent` is saturated. */
	tryAcquireSlot(): boolean;
	releaseSlot(): void;
	/** Mark a node running and return what the dispatch needs. Throws on a bad reference. */
	begin(index: number): DagLaunch;
	/** Fold an in-flight snapshot into progress without settling the node. */
	updatePartial(index: number, result: SubagentResult): void;
	/**
	 * One row per node in authoring order: the settled result, else the latest
	 * live snapshot, else an in-flight stub (`exitCode: -1`). Read
	 * `getState().nodes[i].status` to tell a node that has not launched yet from
	 * one that is running.
	 */
	getResults(): SubagentResult[];
	/** Settle a dispatched node; a failure cascades `skipped` to its transitive dependents. */
	settle(index: number, result: SubagentResult): void;
	/** Settle a node that never ran (or could not launch) with a synthesized result. */
	settleSynthetic(index: number, result: SubagentResult): void;
	isAborted(): boolean;
	/** True once every node is settled and nothing is in flight. */
	isDone(): boolean;
	/** Close the run: skip anything left pending, persist, report the final status. */
	finish(): DagProgress;
}

/**
 * Build the scheduler for one DAG run.
 *
 * The state file is rewritten after every transition, in graph order rather than
 * completion order, so a reader can follow the run without racing the writes.
 * Node results stay in memory: `dag-state.json` records statuses, timestamps,
 * output sizes, and errors only.
 */
export function createDagRun(options: DagRunOptions): DagRun {
	const { nodes, runId, signal, taskIds = [] } = options;
	validateDagGraph(nodes);
	const levels = computeDagLevels(nodes);
	const statePath = options.statePath ?? dagStatePath(runId);
	const maxConcurrent = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
	const createdAt = new Date().toISOString();

	const runtime: DagNodeRuntime[] = nodes.map((node, index) => {
		const deps = dependencyIndices(nodes, index);
		return {
			record: {
				name: node.role,
				index,
				level: levels[index] as number,
				status: "pending",
				dependsOn: (node.dependsOn ?? []).map((ref) => ref.trim()),
				taskId: taskIds[index],
			},
			level: levels[index] as number,
			deps,
			dependents: [],
			settled: false,
		};
	});
	for (let index = 0; index < nodes.length; index++) {
		for (const dep of runtime[index].deps) runtime[dep].dependents.push(index);
	}

	const state: DagStateFile = {
		runId,
		mode: "dag",
		status: "running",
		createdAt,
		updatedAt: createdAt,
		nodes: runtime.map((entry) => entry.record),
	};

	let inFlight = 0;
	let slotsUsed = 0;
	let aborted = false;
	let closed = false;

	const nowIso = (): string => new Date().toISOString();

	const persist = (): void => {
		// Best-effort like the registry's own bookkeeping: a state write that
		// cannot land must never turn a healthy node into a failure.
		try {
			writeDagState(statePath, state);
		} catch {
			// The run's results and the tool details remain the source of truth.
		}
	};

	const progress = (): DagProgress => {
		let settled = 0;
		let running = 0;
		let completed = 0;
		let failed = 0;
		let skipped = 0;
		for (const entry of runtime) {
			if (entry.settled) settled++;
			if (entry.record.status === "running") running++;
			else if (entry.record.status === "completed") completed++;
			else if (entry.record.status === "failed") failed++;
			else if (entry.record.status === "skipped") skipped++;
		}
		return { total: runtime.length, settled, running, completed, failed, skipped };
	};

	function report(): void {
		if (options.onUpdate === undefined) return;
		try {
			options.onUpdate(progress());
		} catch {
			// A progress consumer that throws must not take the graph down with it.
		}
	}

	/** Cascade a non-success out to everything that transitively waits for it. */
	function cascade(index: number, detail: string): void {
		for (const dependent of runtime[index].dependents) {
			if (runtime[dependent].settled) continue;
			markSkipped(dependent, `Skipped: dependency "${runtime[index].record.name}" ${detail}`);
		}
	}

	function markSkipped(index: number, reason: string): void {
		const entry = runtime[index];
		entry.settled = true;
		entry.snapshot = undefined;
		entry.record.status = "skipped";
		entry.record.finishedAt = nowIso();
		entry.record.error = reason;
		entry.result = createSkippedDagResult(nodes[index] as DagNodeInput, entry.level, reason);
		// Deeper dependents read "was skipped", so the chain of messages names the
		// closest ancestor that stopped the work at each hop.
		cascade(index, "was skipped");
		options.onSyntheticSettle?.(index, entry.result as SubagentResult);
	}

	function settleNow(index: number, status: "completed" | "failed", result: SubagentResult): void {
		const entry = runtime[index];
		entry.settled = true;
		entry.result = result;
		entry.snapshot = undefined;
		entry.record.status = status;
		entry.record.finishedAt = nowIso();
		entry.record.outputChars = result.finalOutput.length;
		if (status === "failed") {
			entry.record.error = result.errorMessage || result.stderr || `exit code ${result.exitCode}`;
			cascade(index, "failed");
		}
	}

	const run: DagRun = {
		runId,
		nodes,
		statePath,

		getState(): DagStateFile {
			return state;
		},

		getProgress(): DagProgress {
			return progress();
		},

		readyIndices(): number[] {
			const ready: number[] = [];
			for (let index = 0; index < runtime.length; index++) {
				const entry = runtime[index];
				if (entry.settled || entry.record.status === "running") continue;
				if (entry.deps.every((dep) => runtime[dep].record.status === "completed")) ready.push(index);
			}
			return ready;
		},

		inFlightCount(): number {
			return inFlight;
		},

		tryAcquireSlot(): boolean {
			if (slotsUsed >= maxConcurrent) return false;
			slotsUsed++;
			return true;
		},

		releaseSlot(): void {
			slotsUsed = Math.max(0, slotsUsed - 1);
		},

		begin(index: number): DagLaunch {
			const entry = runtime[index];
			if (entry.settled || entry.record.status === "running") {
				throw new Error(
					`dag scheduler: node "${entry.record.name}" cannot launch from status ${entry.record.status}.`,
				);
			}
			const node = nodes[index] as DagNodeInput;
			const outputs = runtime.map((dep) =>
				dep.result && dep.record.status === "completed" ? dep.result.finalOutput : undefined,
			);
			// Throws for a reference that names no node, a node this one does not
			// wait for, or a dependency with no output. validateDagGraph has already
			// rejected the first two before any spawn, so this is the race guard.
			const instructions = substituteNodeResults(nodes, index, node.instructions, outputs);
			entry.record.status = "running";
			entry.record.startedAt = nowIso();
			inFlight++;
			persist();
			report();
			return {
				index,
				node,
				level: entry.level,
				instructions,
				signal,
				onPartial: (result) => run.updatePartial(index, result),
			};
		},

		updatePartial(index: number, result: SubagentResult): void {
			runtime[index].snapshot = result;
			report();
		},

		getResults(): SubagentResult[] {
			return runtime.map((entry, index) => {
				if (entry.result) return entry.result;
				if (entry.snapshot) return entry.snapshot;
				const node = nodes[index] as DagNodeInput;
				return {
					role: node.role,
					task: node.instructions,
					exitCode: -1,
					aborted: false,
					finalOutput: "",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
					step: entry.level + 1,
				};
			});
		},

		settle(index: number, result: SubagentResult): void {
			if (runtime[index].settled) return;
			inFlight = Math.max(0, inFlight - 1);
			settleNow(index, isFailedSubagentResult(result) ? "failed" : "completed", result);
			persist();
			report();
		},

		settleSynthetic(index: number, result: SubagentResult): void {
			if (runtime[index].settled) return;
			settleNow(index, "failed", result);
			persist();
			report();
		},

		isAborted(): boolean {
			return aborted || signal?.aborted === true;
		},

		isDone(): boolean {
			return runtime.every((entry) => entry.settled) && inFlight === 0;
		},

		finish(): DagProgress {
			if (!closed) {
				closed = true;
				const detail = run.isAborted()
					? "Skipped: the run was aborted before this node launched."
					: "Skipped: an upstream dependency did not complete.";
				for (let index = 0; index < runtime.length; index++) {
					if (runtime[index].settled) continue;
					markSkipped(index, detail);
				}
				const final = progress();
				state.status = run.isAborted() ? "aborted" : final.failed > 0 ? "failed" : "completed";
				state.updatedAt = nowIso();
				persist();
			}
			return progress();
		},
	};

	signal?.addEventListener(
		"abort",
		() => {
			aborted = true;
		},
		{ once: true },
	);

	// The first write creates the run directory and the file, so a reader can
	// find the state as soon as the call is admitted.
	persist();
	report();
	return run;
}

/** Message text for an unknown throw coming out of a dispatch. */
function dispatchErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : String(error);
}

function levelOf(run: DagRun, index: number): number {
	return run.getState().nodes[index]?.level ?? 0;
}

/**
 * Inline driver: launch every ready node, bounded by the run's slot cap, and
 * await the graph.
 *
 * The loop is a ready queue rather than a level barrier — a node whose
 * dependencies finished early launches immediately instead of waiting for the
 * slower members of its own level. On an abort, no new node is launched; the
 * ones already in flight settle through their own `AbortSignal`, and everything
 * still pending is closed out as skipped by `finish()`.
 */
export async function runDagInline(run: DagRun, dispatch: DagNodeRunner): Promise<DagProgress> {
	const inFlightNodes = new Set<Promise<void>>();

	const launch = (index: number): void => {
		const node = run.nodes[index] as DagNodeInput;
		let request: DagLaunch;
		try {
			request = run.begin(index);
		} catch (error) {
			// A node whose own text cannot be assembled fails that node and cascades
			// to its dependents, exactly like a child that exits non-zero. A bad node
			// never stalls the rest of the graph.
			run.settleSynthetic(
				index,
				createDagLaunchFailureResult(node, levelOf(run, index), dispatchErrorMessage(error)),
			);
			run.releaseSlot();
			return;
		}
		const tracked: Promise<void> = dispatch(request)
			.then(
				(result) => run.settle(index, result),
				(error) =>
					run.settle(index, createDagLaunchFailureResult(node, levelOf(run, index), dispatchErrorMessage(error))),
			)
			.finally(() => {
				run.releaseSlot();
				inFlightNodes.delete(tracked);
			});
		inFlightNodes.add(tracked);
	};

	for (;;) {
		if (!run.isAborted()) {
			for (const index of run.readyIndices()) {
				if (!run.tryAcquireSlot()) break;
				launch(index);
			}
		}
		if (inFlightNodes.size === 0) break;
		await Promise.race(inFlightNodes);
	}

	return run.finish();
}

/** One detached DAG node plus the callback that closes it out. */
export interface DagDetachedLaunch extends DagLaunch {
	/**
	 * Settle this node with its detached result and launch whatever the graph made
	 * ready. The caller must invoke this exactly once per node, including for a
	 * task that died before its child process ran.
	 */
	done: (result: SubagentResult) => void;
}

export type DagDetachedDispatcher = (launch: DagDetachedLaunch) => void;

/**
 * Background driver: same graph, same cascade rules, dispatched detached.
 *
 * Each node's `done` callback closes the node and pumps the queue, so a
 * dependency's completion is what launches its dependents — the mirror of the
 * inline driver's ready queue, driven by registry callbacks instead of awaited
 * promises. Concurrency is the registry's own admission cap: every node is
 * dispatched as soon as its dependencies have completed.
 */
export function startDagDetached(run: DagRun, dispatch: DagDetachedDispatcher): void {
	let closed = false;

	const finishOnce = (): void => {
		if (closed) return;
		closed = true;
		run.finish();
	};

	const advance = (): void => {
		if (closed) return;
		if (run.isDone() || run.isAborted()) {
			finishOnce();
			return;
		}
		for (const index of run.readyIndices()) {
			if (!run.tryAcquireSlot()) return;
			launch(index);
		}
	};

	const launch = (index: number): void => {
		const node = run.nodes[index] as DagNodeInput;
		const settle = (result: SubagentResult): void => {
			run.settle(index, result);
			run.releaseSlot();
			advance();
		};
		let request: DagLaunch;
		try {
			request = run.begin(index);
		} catch (error) {
			// The node can never run: fail it, cascade, and close the registry row
			// the caller pre-generated for it.
			run.settleSynthetic(
				index,
				createDagLaunchFailureResult(node, levelOf(run, index), dispatchErrorMessage(error)),
			);
			run.releaseSlot();
			advance();
			return;
		}
		try {
			dispatch({ ...request, done: settle });
		} catch (error) {
			// Admission failed (lock contention, spawn budget, a dead session). Fail
			// this node rather than leaving its dependents waiting forever.
			run.settle(index, createDagLaunchFailureResult(node, levelOf(run, index), dispatchErrorMessage(error)));
			run.releaseSlot();
			advance();
			return;
		}
		if (run.isDone()) finishOnce();
	};

	advance();
}
