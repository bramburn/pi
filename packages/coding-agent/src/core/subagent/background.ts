/**
 * Background-task registry for fire-and-forget subagents.
 *
 * File-backed store so a background subagent survives the parent's turn and
 * can be inspected by a later session. On disk, under the agent dir:
 *
 * subagent-bg/
 *   registry.json   # array of BackgroundTask entries
 *   <taskId>/log.jsonl  # per-task append-only event log
 *
 * Concurrency: a single *.lock file guards registry.json writes (5s retry,
 * then throw). Atomic writes via *.tmp rename. Per-task logs are append-only.
 *
 * Lifecycle states: pending -> running -> (completed | failed | cancelled | crashed)
 *
 * This is a direct port of the reference extension's `background.ts`, with the
 * `agentScope` field dropped: the native path has no agent files, so there is
 * no scope to record.
 */

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { endSubagentTask, newTaskSpanId, startSubagentTask } from "../analytics-store.ts";
import {
	isFailedSubagentResult,
	type SubagentResult,
	type SubagentRunner,
	type SubagentRunRequest,
	type SubagentSpec,
} from "./types.ts";

export const BG_DIR_NAME = "subagent-bg";
export const BG_REGISTRY_FILE = "registry.json";
export const BG_LOCK_FILE = "registry.lock";
export const BG_LOG_FILE = "log.jsonl";
export const BG_REGISTRY_VERSION = 1;
export const BG_LOCK_RETRY_MS = 100;
export const BG_LOCK_MAX_RETRIES = 50; // 5s total
export const BG_CUSTOM_MESSAGE_TYPE = "subagent-background-result";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "crashed";

export interface BackgroundUsage {
	input: number;
	output: number;
	cost: number;
	turns: number;
}

export interface BackgroundTask {
	id: string;
	kind: "pi-subprocess";
	mode: "single" | "parallel" | "chain";
	role: string;
	label: string;
	task: string;
	model?: string;
	status: TaskStatus;
	startedAt: string;
	lastEventAt: string;
	lastOutput: string;
	cwd: string;
	pid?: number;
	exitCode?: number;
	finishedAt?: string;
	usage?: BackgroundUsage;
	errorMessage?: string;
}

interface RegistryFile {
	version: number;
	tasks: BackgroundTask[];
}

export interface BackgroundLogEvent {
	type: string;
	[key: string]: unknown;
}

export interface BackgroundRegistry {
	makeTaskId(): string;
	add(task: BackgroundTask): void;
	update(taskId: string, partial: Partial<BackgroundTask>): void;
	appendLog(taskId: string, event: BackgroundLogEvent | Record<string, unknown>): void;
	listRunning(): BackgroundTask[];
	snapshot(): { tasks: BackgroundTask[] };
	markAllRunningAsCrashed(): Promise<number>;
	prune(): Promise<number>;
	cancel(taskId: string, reason: string): Promise<void>;
}

export class RegistryLockError extends Error {
	readonly lockPath: string;
	constructor(lockPath: string) {
		super(`Background registry locked by another process (${lockPath})`);
		this.name = "RegistryLockError";
		this.lockPath = lockPath;
	}
}

function withLock<T>(lockPath: string, fn: () => T): T {
	// The first registry write on a fresh agent dir must create the directory
	// before "wx" can create the lock file inside it (openSync does not mkdir).
	ensureBgDir();
	for (let attempt = 0; attempt < BG_LOCK_MAX_RETRIES; attempt++) {
		try {
			const fd = openSync(lockPath, "wx");
			closeSync(fd);
			try {
				return fn();
			} finally {
				try {
					unlinkSync(lockPath);
				} catch {
					/* ignore */
				}
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				const start = Date.now();
				while (existsSync(lockPath) && Date.now() - start < BG_LOCK_RETRY_MS) {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
				}
				continue;
			}
			throw err;
		}
	}
	throw new RegistryLockError(lockPath);
}

function backgroundDir(): string {
	return join(getAgentDir(), BG_DIR_NAME);
}

function registryPath(): string {
	return join(backgroundDir(), BG_REGISTRY_FILE);
}

function lockPath(): string {
	return join(backgroundDir(), BG_LOCK_FILE);
}

function taskLogPath(taskId: string): string {
	return join(backgroundDir(), taskId, BG_LOG_FILE);
}

function ensureBgDir(): void {
	const dir = backgroundDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readRegistry(): RegistryFile {
	ensureBgDir();
	const p = registryPath();
	if (!existsSync(p)) {
		return { version: BG_REGISTRY_VERSION, tasks: [] };
	}
	try {
		const raw = readFileSync(p, "utf8");
		const parsed = JSON.parse(raw) as Partial<RegistryFile>;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
			return { version: BG_REGISTRY_VERSION, tasks: [] };
		}
		return {
			version: parsed.version ?? BG_REGISTRY_VERSION,
			tasks: parsed.tasks as BackgroundTask[],
		};
	} catch {
		return { version: BG_REGISTRY_VERSION, tasks: [] };
	}
}

function writeRegistry(file: RegistryFile): void {
	ensureBgDir();
	const p = registryPath();
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
	renameSync(tmp, p);
}

function appendToTaskLog(taskId: string, event: BackgroundLogEvent | Record<string, unknown>): void {
	ensureBgDir();
	const dir = join(backgroundDir(), taskId);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const p = taskLogPath(taskId);
	const stamped = { at: new Date().toISOString(), ...event };
	appendFileSync(p, `${JSON.stringify(stamped)}\n`, "utf8");
}

function makeTaskIdImpl(): string {
	// timestamp + short random suffix; collisions across same-millisecond writes
	// are not a concern in practice (single writer, microtask spacing).
	const t = Date.now().toString(36);
	const r = Math.floor(Math.random() * 0xffff)
		.toString(36)
		.padStart(4, "0");
	return `bg_${t}_${r}`;
}

function createRegistry(): BackgroundRegistry {
	return {
		makeTaskId: makeTaskIdImpl,

		add(task) {
			withLock(lockPath(), () => {
				const file = readRegistry();
				if (file.tasks.some((t) => t.id === task.id)) return; // idempotent
				file.tasks.push({ ...task, lastEventAt: task.lastEventAt ?? new Date().toISOString() });
				writeRegistry(file);
			});
		},

		update(taskId, partial) {
			withLock(lockPath(), () => {
				const file = readRegistry();
				const idx = file.tasks.findIndex((t) => t.id === taskId);
				if (idx === -1) return;
				const current = file.tasks[idx];
				if (!current) return;
				file.tasks[idx] = {
					...current,
					...partial,
					lastEventAt: new Date().toISOString(),
				};
				writeRegistry(file);
			});
		},

		appendLog(taskId, event) {
			try {
				appendToTaskLog(taskId, event);
			} catch (err) {
				// Logging failures must not break the parent session.
				console.error(`[subagent-bg] appendLog failed for ${taskId}:`, (err as Error).message);
			}
		},

		listRunning() {
			const file = readRegistry();
			return file.tasks.filter((t) => t.status === "running" || t.status === "pending");
		},

		snapshot() {
			const file = readRegistry();
			return { tasks: file.tasks };
		},

		async markAllRunningAsCrashed() {
			return withLock(lockPath(), () => {
				const file = readRegistry();
				const now = new Date().toISOString();
				let count = 0;
				for (const t of file.tasks) {
					if (t.status === "running" || t.status === "pending") {
						t.status = "crashed";
						t.finishedAt = now;
						t.errorMessage = t.errorMessage ?? "Parent session ended before task completed";
						t.lastEventAt = now;
						count += 1;
					}
				}
				if (count > 0) writeRegistry(file);
				return count;
			});
		},

		async prune() {
			// Drop tasks that have been in a terminal state for more than 24h.
			return withLock(lockPath(), () => {
				const file = readRegistry();
				const cutoff = Date.now() - 24 * 60 * 60 * 1000;
				const before = file.tasks.length;
				file.tasks = file.tasks.filter((t) => {
					const terminal =
						t.status === "completed" ||
						t.status === "failed" ||
						t.status === "cancelled" ||
						t.status === "crashed";
					if (!terminal) return true;
					const stamp = t.finishedAt ?? t.lastEventAt ?? t.startedAt;
					const ts = new Date(stamp).getTime();
					return !Number.isNaN(ts) && ts > cutoff;
				});
				const removed = before - file.tasks.length;
				if (removed > 0) writeRegistry(file);
				return removed;
			});
		},

		async cancel(taskId, reason) {
			withLock(lockPath(), () => {
				const file = readRegistry();
				const idx = file.tasks.findIndex((t) => t.id === taskId);
				if (idx === -1) return;
				const current = file.tasks[idx];
				if (!current) return;
				if (current.status !== "running" && current.status !== "pending") return;
				const now = new Date().toISOString();
				file.tasks[idx] = {
					...current,
					status: "cancelled",
					finishedAt: now,
					errorMessage: reason,
					lastEventAt: now,
				};
				writeRegistry(file);
			});
		},
	};
}

let singleton: BackgroundRegistry | null = null;

/** Return the process-wide background registry instance. */
export function getBackgroundRegistry(): BackgroundRegistry {
	if (!singleton) singleton = createRegistry();
	return singleton;
}

/** Test helper — clear the singleton so a new instance is created on next call. */
export function _resetBackgroundRegistryForTests(): void {
	singleton = null;
}

// ============================================================================
// Detached dispatch
// ============================================================================

export interface BackgroundDispatch {
	/** Registry id. Stable for the life of the task; shown to the model. */
	taskId: string;
}

export interface BackgroundRunOptions {
	registry: BackgroundRegistry;
	runner: SubagentRunner;
	spec: SubagentSpec;
	task: string;
	cwd: string;
	/** Pre-generated task id (e.g. a chain step reported before it starts). Default: fresh id. */
	taskId?: string;
	/** The model the parent session is using, used when `spec.model` is absent. */
	parentModel?: string;
	parentThinkingLevel?: SubagentRunRequest["parentThinkingLevel"];
	/** Called once the task reaches a terminal state. Must not throw. */
	onSettled?: (taskId: string, result: SubagentResult) => void;
	/** No hard limit by default: a background task is expected to outlive a turn. */
	timeoutMs?: number;
}

/**
 * Start a subagent that outlives the current tool call.
 *
 * The call returns as soon as the task is recorded, so the tool can hand the
 * model a task id immediately. Everything after that is detached: the runner's
 * events are folded into the registry as they arrive, and a top-level catch
 * marks the task `crashed` rather than surfacing an unhandled rejection that
 * would take the parent session down with it.
 */
export function startBackgroundSubagent(options: BackgroundRunOptions): BackgroundDispatch {
	const registry = options.registry;
	const taskId = options.taskId ?? registry.makeTaskId();
	const now = new Date().toISOString();
	registry.add({
		id: taskId,
		kind: "pi-subprocess",
		mode: "single",
		role: options.spec.role,
		label: `${options.spec.role} (background)`,
		task: options.task,
		model: options.spec.model ?? options.parentModel,
		status: "running",
		startedAt: now,
		lastEventAt: now,
		lastOutput: "",
		cwd: options.cwd,
	});
	registry.appendLog(taskId, { type: "SPAWN", role: options.spec.role });

	const spanId = newTaskSpanId();
	startSubagentTask({ spanId, agentName: options.spec.role, taskLabel: options.task.slice(0, 200) });

	// Fire and forget: this promise is intentionally not awaited here, and every
	// exit path is guarded so it can never reject.
	void runDetached(options, taskId)
		.then(({ failed, errorMessage }) => {
			endSubagentTask(spanId, !failed, failed ? errorMessage : undefined);
		})
		.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			endSubagentTask(spanId, false, message);
			registry.update(taskId, {
				status: "crashed",
				errorMessage: `runner crashed: ${message}`,
				finishedAt: new Date().toISOString(),
			});
		});
	return { taskId };
}

async function runDetached(
	options: BackgroundRunOptions,
	taskId: string,
): Promise<{ failed: boolean; errorMessage?: string }> {
	const registry = options.registry;
	let lastText = "";
	const usage = { input: 0, output: 0, cost: 0, turns: 0 };

	const result = await options.runner.run(
		{
			spec: options.spec,
			task: options.task,
			cwd: options.cwd,
			parentModel: options.parentModel,
			parentThinkingLevel: options.parentThinkingLevel,
			logPath: join(getAgentDir(), BG_DIR_NAME, taskId, BG_LOG_FILE),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		},
		// No caller signal: a background task must not inherit the turn's abort.
		undefined,
		(event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const message = event.message;
				if (message.usage) {
					usage.input += message.usage.input ?? 0;
					usage.output += message.usage.output ?? 0;
					usage.cost += message.usage.cost?.total ?? 0;
					usage.turns += 1;
				}
				for (const part of message.content) {
					if (part.type === "text") lastText = part.text;
				}
				registry.update(taskId, { lastOutput: lastText.slice(-200), usage });
			} else if (event.type === "tool_result_end") {
				const message = event.message as { toolName?: string; output?: unknown };
				const rendered = typeof message.output === "string" ? message.output : JSON.stringify(message.output ?? "");
				registry.update(taskId, { lastOutput: `[${message.toolName ?? "tool"}] ${rendered.slice(-160)}` });
			} else if (event.type === "stderr") {
				registry.update(taskId, { lastOutput: `[stderr] ${event.text.slice(-160)}` });
			}
		},
	);

	const failed = isFailedSubagentResult(result);
	const output = result.finalOutput || lastText || "(no output)";
	registry.update(taskId, {
		status: failed ? (result.aborted ? "cancelled" : "failed") : "completed",
		exitCode: result.exitCode,
		finishedAt: new Date().toISOString(),
		lastOutput: output.slice(-200),
		usage,
		...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
	});
	registry.appendLog(taskId, { type: "EXIT", exitCode: result.exitCode, status: failed ? "failed" : "completed" });
	options.onSettled?.(taskId, result);
	return {
		failed,
		...(failed ? { errorMessage: result.errorMessage ?? `exit code ${result.exitCode}` } : {}),
	};
}
