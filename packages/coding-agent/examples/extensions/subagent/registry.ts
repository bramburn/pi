/**
 * Registry — single source of truth for experiment state.
 *
 * On-disk layout: <repo>/.pi-experiments/registry.json
 * Concurrency: single-writer per process; cross-process via a *.lock file
 * with 5-second retry. Atomic writes via *.tmp rename.
 *
 * Lifecycle states: scaffolded -> running -> (completed | failed | cancelled)
 *                                             \-> merged (terminal)
 *                                              \-> discarded (terminal)
 */

import {
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

export const EXPERIMENTS_DIR_NAME = ".pi-experiments";
export const REGISTRY_FILE_NAME = "registry.json";
export const LOCK_FILE_NAME = "registry.lock";
export const REGISTRY_VERSION = 1;

export type ExperimentStatus = "scaffolded" | "running" | "completed" | "failed" | "merged" | "discarded" | "cancelled";

export interface ExperimentResult {
	success?: boolean;
	testPassed?: number;
	testFailed?: number;
	testSkipped?: number;
	benchmarks?: Record<string, number>;
	notes?: string;
}

export interface ExperimentRow {
	id: string;
	hypothesis: string;
	approach: string;
	worktreePath: string;
	branch: string;
	parentCommit: string;
	startedInCwd: string;
	status: ExperimentStatus;
	pid?: number;
	taskId?: string;
	outputPath?: string;
	result: ExperimentResult;
	merged: boolean;
	mergeStrategy?: "cherry-pick" | "squash" | "merge";
	mergeCommit?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface RegistryFile {
	version: number;
	experiments: ExperimentRow[];
}

export interface LockHandle {
	release(): void;
}

export class RegistryLockError extends Error {
	readonly lockPath: string;
	constructor(lockPath: string) {
		super(`Registry locked by another process (${lockPath})`);
		this.name = "RegistryLockError";
		this.lockPath = lockPath;
	}
}

const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 5000;

function ensureDir(repoRoot: string): string {
	const dir = join(repoRoot, EXPERIMENTS_DIR_NAME);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function registryPath(repoRoot: string): string {
	return join(ensureDir(repoRoot), REGISTRY_FILE_NAME);
}

function lockPathFor(repoRoot: string): string {
	return join(ensureDir(repoRoot), LOCK_FILE_NAME);
}

export function experimentsDir(repoRoot: string): string {
	return ensureDir(repoRoot);
}

export function experimentDir(repoRoot: string, id: string): string {
	return join(ensureDir(repoRoot), id);
}

export function logPath(repoRoot: string, id: string): string {
	return join(experimentDir(repoRoot, id), "log.jsonl");
}

/**
 * Acquire an exclusive file lock for registry writes.
 * Throws RegistryLockError if another process holds the lock after the timeout.
 */
export function acquireLock(repoRoot: string): LockHandle {
	const path = lockPathFor(repoRoot);
	const start = Date.now();
	while (true) {
		try {
			const fd = openSync(path, "wx");
			closeSync(fd);
			return {
				release(): void {
					try {
						unlinkSync(path);
					} catch {
						/* ignore — lock may have been removed by another path */
					}
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (Date.now() - start > LOCK_TIMEOUT_MS) {
				throw new RegistryLockError(path);
			}
		}
		sleepSync(LOCK_RETRY_MS);
	}
}

function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		/* spin — short backoff, no async needed for <5000ms total */
	}
}

function emptyRegistry(): RegistryFile {
	return { version: REGISTRY_VERSION, experiments: [] };
}

function parseOrEmpty(text: string): RegistryFile {
	try {
		const parsed = JSON.parse(text) as RegistryFile;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.experiments)) {
			return emptyRegistry();
		}
		if (parsed.version !== REGISTRY_VERSION) {
			// Future-proofing: known future versions can be migrated here.
			return emptyRegistry();
		}
		return parsed;
	} catch {
		return emptyRegistry();
	}
}

export function readRegistry(repoRoot: string): RegistryFile {
	const path = registryPath(repoRoot);
	if (!existsSync(path)) return emptyRegistry();
	const text = readFileSync(path, "utf-8");
	return parseOrEmpty(text);
}

function atomicWrite(path: string, contents: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, contents, "utf-8");
	renameSync(tmp, path);
}

function writeRegistry(repoRoot: string, data: RegistryFile): void {
	const path = registryPath(repoRoot);
	atomicWrite(path, `${JSON.stringify(data, null, 2)}\n`);
}

export { writeRegistry };

export function withWriteLock<T>(repoRoot: string, fn: (reg: RegistryFile) => { next: RegistryFile; result: T }): T {
	const lock = acquireLock(repoRoot);
	try {
		const current = readRegistry(repoRoot);
		const { next, result } = fn(current);
		writeRegistry(repoRoot, next);
		return result;
	} finally {
		lock.release();
	}
}

export function addExperiment(repoRoot: string, row: ExperimentRow): ExperimentRow {
	return withWriteLock(repoRoot, (reg) => {
		reg.experiments.push(row);
		return { next: reg, result: row };
	});
}

export function updateExperiment(repoRoot: string, id: string, patch: Partial<ExperimentRow>): ExperimentRow | null {
	return withWriteLock(repoRoot, (reg) => {
		const idx = reg.experiments.findIndex((r) => r.id === id);
		if (idx === -1) return { next: reg, result: null };
		const updated: ExperimentRow = { ...reg.experiments[idx], ...patch, id, updatedAt: new Date().toISOString() };
		reg.experiments[idx] = updated;
		return { next: reg, result: updated };
	});
}

export function getExperiment(repoRoot: string, id: string): ExperimentRow | null {
	const reg = readRegistry(repoRoot);
	return reg.experiments.find((r) => r.id === id) ?? null;
}

export function listExperiments(repoRoot: string, status?: ExperimentStatus | "all"): ExperimentRow[] {
	const reg = readRegistry(repoRoot);
	if (!status || status === "all") return reg.experiments;
	return reg.experiments.filter((r) => r.status === status);
}

export function makeExperimentId(approach: string, now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const slug = approach
		.replace(/[^a-z0-9-]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	return `exp-${stamp}-${slug}`;
}
