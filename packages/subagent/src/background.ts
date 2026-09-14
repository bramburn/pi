/**
 * Background-task registry — file-backed store for fire-and-forget subagents.
 *
 * The subagent extension's `background: true` mode spawns detached child pi
 * processes and tracks their lifecycle here. On disk:
 *
 *   <agentDir>/subagent-bg/
 *     registry.json              # array of BackgroundTask entries
 *     <taskId>/
 *       log.jsonl                # per-task append-only event log
 *
 * Concurrency: a single *.lock file guards registry.json writes (5s retry,
 * then throw). Atomic writes via *.tmp rename. Per-task logs are append-only
 * (one event per line); the append itself is naturally atomic on POSIX and
 * best-effort on Windows.
 *
 * Lifecycle states:
 *   pending -> running -> (completed | failed | cancelled | crashed)
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
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const BG_DIR_NAME = "subagent-bg";
export const BG_REGISTRY_FILE = "registry.json";
export const BG_LOCK_FILE = "registry.lock";
export const BG_LOG_FILE = "log.jsonl";
export const BG_REGISTRY_VERSION = 1;
export const BG_LOCK_RETRY_MS = 100;
export const BG_LOCK_MAX_RETRIES = 50; // 5s total

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
	mode: "single" | "parallel" | "chain" | "script";
	agent: string;
	agentScope: "user" | "project" | "both";
	label: string;
	scriptOrTask: string;
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

class RegistryLockError extends Error {
	readonly lockPath: string;
	constructor(lockPath: string) {
		super(`Background registry locked by another process (${lockPath})`);
		this.name = "RegistryLockError";
		this.lockPath = lockPath;
	}
}

function withLock<T>(lockPath: string, fn: () => T): T {
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
				const current = file.tasks[idx]!;
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
				// Logging failures must not break the parent extension.
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
				const current = file.tasks[idx]!;
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
export function getRegistry(): BackgroundRegistry {
	if (!singleton) singleton = createRegistry();
	return singleton;
}

/** Test helper — clear the singleton so a new instance is created on next call. */
export function _resetRegistryForTests(): void {
	singleton = null;
}
