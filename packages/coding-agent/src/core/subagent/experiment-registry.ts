/**
 * Experiment registry — single source of truth for experiment state.
 *
 * On-disk layout: <repo>/.pi-experiments/registry.json
 * Concurrency: single-writer per process; cross-process via a *.lock file
 * whose JSON record (pid + createdAt + token) lets a crashed holder be
 * detected and the stale lock broken after LOCK_STALE_MS (30s) or when its
 * pid is dead. Atomic writes via *.tmp rename; an unreadable registry.json is
 * renamed aside (registry.json.corrupt-<ts>) instead of being overwritten.
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
 * (`openSync(path, "wx")`) plus a write through the held fd (`writeSync`), and
 * the registry write needs atomic rename, none of which `Bun.write`/`Bun.file`
 * provide. The synchronous lock API also needs synchronous reads. Everything
 * else in this module tree prefers the Bun-native surface (see AGENTS.md
 * "Runtime: Bun only").
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
	writeSync,
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
/** A lock older than this is broken even when its recorded pid is alive. */
const LOCK_STALE_MS = 30_000;
/**
 * A just-created lock is briefly empty (openSync "wx", then writeSync), so
 * unreadable content is re-checked before being judged stale; foreign/corrupt
 * lock files become breakable after this grace.
 */
const LOCK_PARSE_GRACE_MS = 25;
const LOCK_PARSE_GRACE_ATTEMPTS = 3;
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
 * A lock file records its owner as JSON —
 * `{"pid": ..., "createdAt": ..., "token": ...}` — so a crashed holder can be
 * detected instead of bricking registry writes forever. The token identifies
 * one acquisition and is checked before unlinking, so a process can never
 * remove a lock it no longer owns.
 */
interface LockRecord {
	pid: number;
	createdAt: number;
	token: string;
}

/**
 * Cheap cross-platform liveness probe. `process.kill(pid, 0)` throws ESRCH for
 * a dead pid on Unix and on Windows (verified under Node and Bun on win32:
 * libuv maps signal 0 to an OpenProcess existence check there as well); EPERM
 * means "alive but not ours". Pid 0 and negative pids are special to kill()
 * and are never probed — they count as not alive.
 */
function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** 0% CPU sleep — a busy-spin here froze the TUI while burning a core. */
function sleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined; // lock is gone
	}
}

function parseLockRecord(text: string): LockRecord | undefined {
	try {
		const parsed = JSON.parse(text) as Record<string, unknown> | null;
		if (!parsed || typeof parsed !== "object") return undefined;
		const { pid, createdAt, token } = parsed;
		if (typeof pid !== "number" || typeof createdAt !== "number" || typeof token !== "string") return undefined;
		return { pid, createdAt, token };
	} catch {
		return undefined;
	}
}

type LockInspection = { state: "gone" } | { state: "stale"; text: string } | { state: "fresh" };

/** Decide whether a contended lock is breakable. `text` backs that decision. */
function inspectLock(path: string): LockInspection {
	let text = readLockText(path);
	if (text === undefined) return { state: "gone" };
	for (let i = 0; i < LOCK_PARSE_GRACE_ATTEMPTS && parseLockRecord(text) === undefined; i++) {
		sleepMs(LOCK_PARSE_GRACE_MS);
		const reread = readLockText(path);
		if (reread === undefined) return { state: "gone" };
		text = reread;
	}
	const record = parseLockRecord(text);
	if (!record) return { state: "stale", text };
	if (Date.now() - record.createdAt > LOCK_STALE_MS) return { state: "stale", text };
	if (!isProcessAlive(record.pid)) return { state: "stale", text };
	return { state: "fresh" };
}

/** Unlink a stale lock, but only while it still holds the exact content the staleness decision was made on. */
function breakLockIfUnchanged(path: string, decidedText: string): void {
	if (readLockText(path) !== decidedText) return;
	try {
		unlinkSync(path);
	} catch {
		/* already gone */
	}
}

/** Release our lock — never remove one that changed hands while we held it. */
function releaseLock(path: string, token: string): void {
	const record = parseLockRecord(readLockText(path) ?? "");
	if (record?.token !== token) return;
	try {
		unlinkSync(path);
	} catch {
		/* already gone */
	}
}

/**
 * Acquire an exclusive file lock for registry writes.
 * Breaks a stale lock (dead pid, older than LOCK_STALE_MS, foreign format)
 * at most once per acquisition, then waits for a live holder.
 * Throws ExperimentRegistryLockError if the lock is still held after ~5s.
 */
export function acquireLock(repoRoot: string): LockHandle {
	const path = lockPathFor(repoRoot);
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let brokeStaleLock = false;
	while (true) {
		let token: string | undefined;
		try {
			const fd = openSync(path, "wx");
			const owned = crypto.randomUUID();
			try {
				writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: owned }));
			} finally {
				closeSync(fd);
			}
			token = owned;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		if (token !== undefined) {
			const owned = token;
			return {
				release(): void {
					releaseLock(path, owned);
				},
			};
		}
		if (Date.now() >= deadline) {
			throw new ExperimentRegistryLockError(path);
		}
		const inspection = inspectLock(path);
		if (inspection.state === "gone") {
			sleepMs(5); // someone just released — retry promptly, but never spin
			continue;
		}
		if (inspection.state === "stale" && !brokeStaleLock) {
			brokeStaleLock = true;
			breakLockIfUnchanged(path, inspection.text);
			continue;
		}
		sleepMs(LOCK_RETRY_MS);
	}
}

function emptyRegistry(): RegistryFile {
	return { version: REGISTRY_VERSION, experiments: [] };
}

/**
 * Parse registry content. Returns null when the content is non-empty but
 * unparseable, structurally invalid, or written by a different
 * REGISTRY_VERSION — callers preserve such files instead of silently
 * discarding rows. An empty file is just an empty registry (nothing to lose).
 */
function parseRegistry(text: string): RegistryFile | null {
	if (text.trim() === "") return emptyRegistry();
	try {
		const parsed = JSON.parse(text) as Partial<RegistryFile> | null;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.experiments)) return null;
		if (parsed.version !== REGISTRY_VERSION) {
			// Future-proofing: known future versions can be migrated here;
			// unknown ones are preserved, never silently discarded.
			return null;
		}
		return { version: REGISTRY_VERSION, experiments: parsed.experiments as ExperimentRow[] };
	} catch {
		return null;
	}
}

/**
 * Rename an unreadable registry aside (`registry.json.corrupt-<timestamp>`)
 * instead of letting the next locked write persist `[]` over it and destroy
 * every row. renameSync is the sanctioned atomic-rename primitive.
 */
function preserveCorruptRegistry(path: string): void {
	const target = `${path}.corrupt-${Date.now()}`;
	try {
		renameSync(path, target);
		console.warn(`[pi-experiments] registry.json was unreadable; preserved at ${target} and starting empty`);
	} catch {
		// Another process preserved it first — nothing left to do.
	}
}

export function readRegistry(repoRoot: string): RegistryFile {
	const path = registryPath(repoRoot);
	if (!existsSync(path)) return emptyRegistry();
	const text = readFileSync(path, "utf-8");
	const parsed = parseRegistry(text);
	if (parsed) return parsed;
	preserveCorruptRegistry(path);
	return emptyRegistry();
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
	// randomUUID suffix: same-second, same-approach ids used to collide across
	// processes, and updateExperiment's findIndex would patch the wrong row.
	return `exp-${stamp}-${slug}-${crypto.randomUUID()}`;
}

// ============================================================================
// Per-experiment JSONL log
// ============================================================================

/**
 * Create `<id>/log.jsonl` when missing. Exclusive-create ("wx") so two
 * processes can never both "create" it and one truncate the other's events.
 */
export function ensureExperimentLog(path: string): void {
	const dir = join(path, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	try {
		const fd = openSync(path, "wx");
		closeSync(fd);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		// Already created by a concurrent process — that is the goal.
	}
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
