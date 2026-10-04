/**
 * Experiment registry — single source of truth for experiment state.
 *
 * On-disk layout: <repo>/.pi-experiments/registry.json
 * Concurrency: single-writer per process; cross-process via a *.lock file
 * with 5-second retry. Atomic writes via *.tmp rename.
 *
 * The serialized shape is byte-compatible with the reference extension's
 * registry.json (`JSON.stringify(data, null, 2)` + trailing newline, version 1)
 * so a user moving between the extension and the native tool keeps state.
 *
 * Lifecycle states: scaffolded -> running -> (completed | failed | cancelled)
 *   -> merged (terminal)
 *   -> discarded (terminal)
 *
 * File IO uses `node:fs` deliberately: the lock needs exclusive-create
 * (`openSync(path, "wx")`) and the write needs atomic rename, neither of which
 * `Bun.write`/`Bun.file` provide. Everything else in this module tree prefers
 * the Bun-native surface (see AGENTS.md "Runtime: Bun only").
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

export class ExperimentRegistryLockError extends Error {
	readonly lockPath: string;
	constructor(lockPath: string) {
		super(`Registry locked by another process (${lockPath})`);
		this.name = "ExperimentRegistryLockError";
		this.lockPath = lockPath;
	}
}

const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 5000;
const MAX_LOG_LINE_BYTES = 1_000_000;

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
 * Throws ExperimentRegistryLockError if another process holds it after the timeout.
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
				throw new ExperimentRegistryLockError(path);
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

/**
 * The experiment a Research Mode trigger logs against: the newest row still
 * in flight (scaffolded or running). Undefined when nothing is active.
 */
export function getActiveExperimentLogPath(repoRoot: string): string | undefined {
	const active = listExperiments(repoRoot, "all").filter((r) => r.status === "scaffolded" || r.status === "running");
	if (active.length === 0) return undefined;
	const newest = active.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
	return logPath(repoRoot, newest.id);
}

export function makeExperimentId(approach: string, now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const slug = approach
		.replace(/[^a-z0-9-]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	return `exp-${stamp}-${slug}`;
}

// ============================================================================
// Per-experiment JSONL log
// ============================================================================

/** Create `<id>/log.jsonl` when missing. */
export function ensureExperimentLog(path: string): void {
	if (existsSync(path)) return;
	const dir = join(path, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, "", "utf-8");
}

function appendLogLine(path: string | undefined, line: string): void {
	if (!path) return;
	const capped = line.length > MAX_LOG_LINE_BYTES ? `${line.slice(0, MAX_LOG_LINE_BYTES)}\n... [truncated]` : line;
	try {
		appendFileSync(path, capped.endsWith("\n") ? capped : `${capped}\n`, "utf-8");
	} catch {
		/* log is best-effort; do not let logging fail the run */
	}
}

/** Append one JSONL event to an experiment log, timestamped with `at`. */
export function appendExperimentLogEvent(experimentLogPath: string, event: Record<string, unknown>): void {
	const line = JSON.stringify({ ...event, at: new Date().toISOString() });
	appendLogLine(experimentLogPath, line);
}
