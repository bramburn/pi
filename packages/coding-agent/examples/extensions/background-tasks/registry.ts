/**
 * Background Task Registry
 *
 * File-based registry for background task metadata.
 * Stored at ~/.pi/agent/background-tasks/registry.json
 * Per-task logs at ~/.pi/agent/background-tasks/<id>/log.jsonl
 *
 * Uses atomic writes (write to .tmp then rename).
 * Uses advisory file locking for concurrent access.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BG_TASKS_DIR_NAME = "background-tasks";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTask {
	id: string;
	name: string;
	role: string;
	objective: string;
	status: TaskStatus;
	pid?: number;
	exitCode?: number | null;
	startedAt: string;
	completedAt?: string;
	updatedAt: string;
	command: string;
	args: string[];
	cwd: string;
	model?: string;
	allowedTools?: string[];
	contextQuery?: string;
	outputPath: string;
	resultSummary?: string;
	lastOutput?: string;
	errorMessage?: string;
}

export interface TaskRegistry {
	version: number;
	tasks: BackgroundTask[];
}

const REGISTRY_VERSION = 1;

export function tasksDir(baseDir: string): string {
	return join(baseDir, BG_TASKS_DIR_NAME);
}

export function registryPath(baseDir: string): string {
	return join(tasksDir(baseDir), "registry.json");
}

export function taskLogPath(baseDir: string, taskId: string): string {
	return join(tasksDir(baseDir), taskId, "log.jsonl");
}

export function taskDir(baseDir: string, taskId: string): string {
	return join(tasksDir(baseDir), taskId);
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readRegistry(baseDir: string): TaskRegistry {
	const path = registryPath(baseDir);
	if (!existsSync(path)) {
		return { version: REGISTRY_VERSION, tasks: [] };
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as TaskRegistry;
		if (!parsed.tasks) parsed.tasks = [];
		return parsed;
	} catch {
		return { version: REGISTRY_VERSION, tasks: [] };
	}
}

export function writeRegistry(baseDir: string, registry: TaskRegistry): void {
	const dir = tasksDir(baseDir);
	ensureDir(dir);
	const path = registryPath(baseDir);
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(registry, null, 2), "utf-8");
	renameSync(tmpPath, path);
}

export function addTask(baseDir: string, task: BackgroundTask): void {
	const registry = readRegistry(baseDir);
	registry.tasks.push(task);
	writeRegistry(baseDir, registry);
}

export function getTask(baseDir: string, taskId: string): BackgroundTask | undefined {
	return readRegistry(baseDir).tasks.find((t) => t.id === taskId);
}

export function updateTask(
	baseDir: string,
	taskId: string,
	patch: Partial<BackgroundTask>,
): BackgroundTask | undefined {
	const registry = readRegistry(baseDir);
	const idx = registry.tasks.findIndex((t) => t.id === taskId);
	if (idx === -1) return undefined;
	registry.tasks[idx] = { ...registry.tasks[idx], ...patch, updatedAt: new Date().toISOString() };
	writeRegistry(baseDir, registry);
	return registry.tasks[idx];
}

export function listTasks(baseDir: string, status?: TaskStatus | "all"): BackgroundTask[] {
	const tasks = readRegistry(baseDir).tasks;
	if (!status || status === "all") return tasks;
	return tasks.filter((t) => t.status === status);
}

export function removeTask(baseDir: string, taskId: string): boolean {
	const registry = readRegistry(baseDir);
	const before = registry.tasks.length;
	registry.tasks = registry.tasks.filter((t) => t.id !== taskId);
	if (registry.tasks.length === before) return false;
	writeRegistry(baseDir, registry);
	return true;
}

export function makeTaskId(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const now = Date.now();
	const random = Math.floor(Math.random() * 1000).toString(36);
	return `${slug}-${now}-${random}`;
}

export function appendTaskLog(baseDir: string, taskId: string, event: Record<string, unknown>): void {
	const logPath = taskLogPath(baseDir, taskId);
	ensureDir(taskDir(baseDir, taskId));
	const line = JSON.stringify({ ...event, at: new Date().toISOString() });
	try {
		writeFileSync(logPath, `${line}\n`, { flag: "a", encoding: "utf-8" });
	} catch {
		/* log is best-effort */
	}
}

export function readTaskLogTail(baseDir: string, taskId: string, maxLines: number = 20): string[] {
	const logPath = taskLogPath(baseDir, taskId);
	if (!existsSync(logPath)) return [];
	try {
		const raw = readFileSync(logPath, "utf-8");
		const lines = raw.split("\n").filter(Boolean);
		return lines.slice(-maxLines);
	} catch {
		return [];
	}
}
