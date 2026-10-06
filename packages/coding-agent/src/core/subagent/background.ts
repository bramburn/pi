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
 * then throw). The lock records its owner (pid + createdAt + token) so a
 * crashed holder can be detected and its stale lock broken after 30s or when
 * the recorded pid is dead. Atomic writes via *.tmp rename; an unreadable
 * registry.json is renamed aside (registry.json.corrupt-<ts>) instead of being
 * silently overwritten. Per-task logs are append-only.
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
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { endSubagentTask, newTaskSpanId, startSubagentTask } from "../analytics-store.ts";
import { getBun } from "./runtime.ts";
import {
	createEmptyUsage,
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
/** A lock older than this is broken even when its recorded pid is alive. */
export const BG_LOCK_STALE_MS = 30_000;
/** Crash evidence recorded on a row is clamped to this many chars (bounded tail). */
const MAX_CRASH_EVIDENCE_CHARS = 2048;
/** Terminal rows older than this are pruned. */
const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many terminal rows are kept, even when all are recent. */
const PRUNE_MAX_TERMINAL_ROWS = 200;
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
	/** Pid of the spawned child process, when known. */
	pid?: number;
	/**
	 * Pid of the session process that created the task. add() stamps it in the
	 * same object construction as the row, so the stored row is never
	 * observable without it (update() can explicitly clear it, which makes the
	 * row ownerless-legacy; see markAllRunningAsCrashed).
	 * markAllRunningAsCrashed() uses it to tell orphans of a dead session apart
	 * from another live session's in-flight tasks.
	 */
	ownerPid?: number;
	exitCode?: number;
	finishedAt?: string;
	usage?: BackgroundUsage;
	errorMessage?: string;
	/**
	 * Persistent child session file path. Captured from the run's
	 * `sessionFile` when the child emitted a `session_start` event — i.e. a
	 * `--session-parent` (or `--session`) child that wrote a session file.
	 * Undefined for `--no-session` children and for runs that crashed before
	 * opening their session. Persists in the registry so a parent restart
	 * can hand the same file to a later `subagent(..., sessionFile: ...)`
	 * call to resume the child.
	 */
	sessionFile?: string;
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
	/**
	 * Store a task row. Task ids live in a cross-process namespace, so a
	 * duplicate id is a namespace clash — not a duplicate delivery: add()
	 * assigns a fresh id on `task` in place and stores the row under it instead
	 * of silently dropping it (which let one session overwrite another's row).
	 * The stored row is built with ownerPid already stamped in the same object
	 * construction (before the row joins the file), so a persisted running row
	 * never exists in a window without an owner.
	 */
	add(task: BackgroundTask): void;
	update(taskId: string, partial: Partial<BackgroundTask>): void;
	appendLog(taskId: string, event: BackgroundLogEvent | Record<string, unknown>): void;
	listRunning(): BackgroundTask[];
	snapshot(): { tasks: BackgroundTask[] };
	/**
	 * Crash every running/pending row whose owning session is gone and return
	 * how many were crashed. A row whose ownerPid is alive is left alone — any
	 * session may call this at startup without crashing another live session's
	 * in-flight tasks. Legacy-row semantics: a row with no ownerPid (written
	 * before ownerPid existed, or cleared via update(taskId, { ownerPid:
	 * undefined })) cannot prove a live owner and always counts as an orphan;
	 * crashing it is the safe default.
	 */
	markAllRunningAsCrashed(): Promise<number>;
	/**
	 * Drop over-retention terminal rows and delete their `<taskId>/` log dirs
	 * (best-effort: row removal is persisted before any dir delete, so a failed
	 * delete only leaks — it never orphans a log the registry still references).
	 * Returns the number of rows removed.
	 */
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

/**
 * A lock file records its owner as JSON —
 * `{"pid": ..., "createdAt": ..., "token": ...}` — so a crashed holder can be
 * detected instead of bricking registry writes for every session (the
 * background dir is user-level). The token identifies one acquisition and is
 * checked before unlinking, so a process can never remove a lock it no longer
 * owns.
 */
interface LockRecord {
	pid: number;
	createdAt: number;
	token: string;
}

/**
 * A just-created lock is briefly empty (openSync "wx", then writeSync), so
 * unreadable content is re-checked before being judged stale; foreign/corrupt
 * lock files become breakable after this grace.
 */
const LOCK_PARSE_GRACE_MS = 25;
const LOCK_PARSE_GRACE_ATTEMPTS = 3;

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

/** Identity of one lock file at one moment: content plus a cheap stat stamp. */
interface LockSnapshot {
	text: string;
	size: number;
	mtimeMs: number;
}

type LockInspection = { state: "gone" } | { state: "stale"; snapshot: LockSnapshot } | { state: "fresh" };

/** Cheap identity stamp (size + mtime) for the break comparison. */
function fileStamp(path: string): { size: number; mtimeMs: number } | undefined {
	try {
		const st = statSync(path);
		return { size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return undefined;
	}
}

/**
 * Decide whether a contended lock is breakable. The returned snapshot is the
 * evidence for that decision — it is what breakLockIfUnchanged verifies before
 * unlinking.
 *
 * Exported for the pins in test/subagent-background-registry.test.ts; not part
 * of the supported API.
 */
export function inspectLock(path: string): LockInspection {
	let text = readLockText(path);
	if (text === undefined) return { state: "gone" };
	for (let i = 0; i < LOCK_PARSE_GRACE_ATTEMPTS && parseLockRecord(text) === undefined; i++) {
		sleepMs(LOCK_PARSE_GRACE_MS);
		const reread = readLockText(path);
		if (reread === undefined) return { state: "gone" };
		text = reread;
	}
	const stamp = fileStamp(path);
	if (stamp === undefined) return { state: "gone" };
	// The stamp is read after the content: if a replacement slips in between,
	// the mixed snapshot can only fail the later verification (content and
	// stamp cannot both re-match), so it fails closed.
	const snapshot: LockSnapshot = { text, ...stamp };
	const record = parseLockRecord(text);
	if (!record) return { state: "stale", snapshot };
	if (Date.now() - record.createdAt > BG_LOCK_STALE_MS) return { state: "stale", snapshot };
	if (!isProcessAlive(record.pid)) return { state: "stale", snapshot };
	return { state: "fresh" };
}

/**
 * Unlink a stale lock, but only while the path provably still holds the exact
 * lock the staleness decision was made on: identical content, size and mtime.
 *
 * Why: the staleness decision and this unlink are two syscalls, so competitor
 * A can judge T1 stale and unlink it while competitor C acquires a fresh lock
 * T2 before our unlink runs — an unverified unlink then deletes C's LIVE lock
 * and two writers sit in the critical section together. Content alone catches
 * every realistic swap (a valid lock carries a fresh randomUUID token); size
 * and mtime discriminate where content cannot — a recreated foreign-format or
 * empty lock file with identical bytes.
 *
 * Residual micro-window (accepted): the checks and unlinkSync are still
 * separate syscalls and win32 has no portable compare-and-swap delete
 * (renameat2/link-directory tricks are Unix-only), so a replacement landing
 * exactly in that one-syscall gap is still deleted. The window is minimal
 * without OS-level atomicity and is documented rather than hidden.
 *
 * Exported for the pins in test/subagent-background-registry.test.ts; not part
 * of the supported API.
 */
export function breakLockIfUnchanged(path: string, decided: LockSnapshot): void {
	const stamp = fileStamp(path);
	if (stamp === undefined || stamp.size !== decided.size || stamp.mtimeMs !== decided.mtimeMs) return;
	if (readLockText(path) !== decided.text) return;
	try {
		unlinkSync(path);
	} catch {
		/* already gone */
	}
}

/**
 * Release our lock — never remove one that changed hands while we held it.
 *
 * The token is a per-acquisition crypto UUID, so unlike breakLockIfUnchanged's
 * decided content (foreign/empty bytes that can legitimately recur) token
 * comparison is exact: no other lock can ever carry our token, so no stat
 * stamp is needed here. The same one-syscall check/unlink micro-window as in
 * breakLockIfUnchanged applies and is accepted for the same reason.
 */
function releaseLock(path: string, token: string): void {
	const record = parseLockRecord(readLockText(path) ?? "");
	if (record?.token !== token) return;
	try {
		unlinkSync(path);
	} catch {
		/* already gone */
	}
}

export function withLock<T>(lockPath: string, fn: () => T): T {
	// The first registry write on a fresh agent dir must create the directory
	// before "wx" can create the lock file inside it (openSync does not mkdir).
	ensureBgDir();
	// Acquisition budget: BG_LOCK_MAX_RETRIES × BG_LOCK_RETRY_MS (~5s). fn()
	// itself is never timed out — only how long we wait to enter it.
	const deadline = Date.now() + BG_LOCK_MAX_RETRIES * BG_LOCK_RETRY_MS;
	let brokeStaleLock = false;
	for (let attempt = 0; attempt < BG_LOCK_MAX_RETRIES; attempt++) {
		let token: string | undefined;
		try {
			const fd = openSync(lockPath, "wx");
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
			try {
				return fn();
			} finally {
				releaseLock(lockPath, token);
			}
		}
		if (Date.now() >= deadline) throw new RegistryLockError(lockPath);
		// Contention: break a stale lock at most once per acquisition (dead
		// pid, past BG_LOCK_STALE_MS, or foreign format) so one crashed session
		// cannot brick background dispatch for every session; otherwise wait
		// for the live holder to release.
		const inspection = inspectLock(lockPath);
		if (inspection.state === "gone") {
			sleepMs(5); // someone just released — retry promptly, but never spin
			continue;
		}
		if (inspection.state === "stale" && !brokeStaleLock) {
			brokeStaleLock = true;
			breakLockIfUnchanged(lockPath, inspection.snapshot);
			continue;
		}
		const waitStart = Date.now();
		while (readLockText(lockPath) !== undefined && Date.now() - waitStart < BG_LOCK_RETRY_MS) {
			sleepMs(5);
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

function parseRegistry(raw: string): RegistryFile | null {
	// An empty file has nothing to lose; anything else unreadable is preserved.
	if (raw.trim() === "") return { version: BG_REGISTRY_VERSION, tasks: [] };
	try {
		const parsed = JSON.parse(raw) as Partial<RegistryFile> | null;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) return null;
		if (parsed.version !== undefined && parsed.version !== BG_REGISTRY_VERSION) return null;
		return {
			version: parsed.version ?? BG_REGISTRY_VERSION,
			tasks: parsed.tasks as BackgroundTask[],
		};
	} catch {
		return null;
	}
}

/**
 * Rename an unreadable registry aside (`registry.json.corrupt-<timestamp>`)
 * instead of letting the next locked write persist `[]` over it and destroy
 * every row. renameSync is the sanctioned atomic-rename primitive.
 *
 * The read path is unlocked (snapshot()/listRunning()), so between the corrupt
 * read at t0 and this rename at t2 a writer inside withLock can replace
 * registry.json with valid rows at t1. Renaming whatever is at the path would
 * move that FRESH registry aside and the next locked write would persist a
 * registry without the writer's rows — silent row loss. So, like
 * breakLockIfUnchanged, verify before renaming: only the exact corrupt payload
 * (`corruptRaw`) that triggered preservation is ever moved. String equality is
 * the right test — preservation cares about parseability, and identical
 * decoded bytes parse identically. (The alternative fix — preserving only
 * under the write lock — was rejected: it forces the intentionally lock-free
 * read path to contend on the write lock.)
 *
 * Residual micro-window (accepted): the verification and renameSync are two
 * syscalls, so a writer replacing the file exactly in between still gets its
 * fresh registry moved aside. win32 has no compare-and-swap rename to close
 * it; the window is one syscall wide (same accepted class as
 * breakLockIfUnchanged's).
 *
 * Exported for the interleaving pin in
 * test/subagent-background-registry.test.ts; not part of the supported API.
 */
export function preserveCorruptRegistry(path: string, corruptRaw: string): void {
	let current: string | undefined;
	try {
		current = readFileSync(path, "utf8");
	} catch {
		return; // gone — nothing left to preserve
	}
	if (current !== corruptRaw) return; // replaced by a writer — its rows win
	const target = `${path}.corrupt-${Date.now()}`;
	try {
		renameSync(path, target);
		console.warn(`[subagent-bg] registry.json was unreadable; preserved at ${target} and starting empty`);
	} catch {
		// Another process preserved it first — nothing left to do.
	}
}

function readRegistry(): RegistryFile {
	ensureBgDir();
	const p = registryPath();
	if (!existsSync(p)) {
		return { version: BG_REGISTRY_VERSION, tasks: [] };
	}
	let raw: string;
	try {
		raw = readFileSync(p, "utf8");
	} catch {
		return { version: BG_REGISTRY_VERSION, tasks: [] };
	}
	const parsed = parseRegistry(raw);
	if (parsed) return parsed;
	preserveCorruptRegistry(p, raw);
	return { version: BG_REGISTRY_VERSION, tasks: [] };
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
	// Timestamp prefix keeps ids sortable. The suffix is a crypto.randomUUID()
	// instead of 16 bits of Math.random(): task ids live in a namespace shared
	// by every concurrently-dispatching session process. add() additionally
	// regenerates on the (astronomically unlikely) residual collision.
	return `bg_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

/**
 * The only directory names deleteTaskLogDir() may remove: our own task-id
 * shape (`bg_<base36 ms>_<uuid>`). A registry row is untrusted input — a row
 * with any other id (legacy ids, hand-edited rows, or a traversal attempt like
 * `..`) leaks its dir rather than risking a deletion outside the background
 * dir.
 */
const TASK_ID_DIR_PATTERN = /^bg_[0-9a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Best-effort GC of one pruned task's `<taskId>/` dir (log.jsonl). Called only
 * after the row's removal is persisted: a failed delete leaks the dir but can
 * never orphan a log the registry still references. rmSync (node:fs) because
 * Bun has no recursive directory-remove primitive (verified under Bun:
 * `Bun.file(dir).delete()` is unlink-based and fails with EPERM on
 * directories; `rmSync(..., { recursive: true })` works).
 */
function deleteTaskLogDir(taskId: string): void {
	if (!TASK_ID_DIR_PATTERN.test(taskId)) return;
	const dir = join(backgroundDir(), taskId);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (err) {
		// Best-effort: leaking a log dir must never fail prune().
		console.warn(`[subagent-bg] failed to delete task log dir for ${taskId}:`, (err as Error).message);
	}
}

/**
 * Whether a row is an orphan candidate for crash reconciliation: still
 * in-flight, and its owning session is gone (or it predates ownerPid and so
 * cannot prove a live owner — the safe default is to treat it as orphaned).
 * A row whose owner is alive may still be mid-flight, so any session can call
 * markAllRunningAsCrashed() at startup without crashing another live session's
 * tasks.
 */
function isOrphanCandidate(t: BackgroundTask): boolean {
	const inFlight = t.status === "running" || t.status === "pending";
	return inFlight && (t.ownerPid === undefined || !isProcessAlive(t.ownerPid));
}

/** Clamp evidence to MAX_CRASH_EVIDENCE_CHARS, keeping the head or the tail. */
function clampEvidence(text: string, keepEnd: boolean): string {
	if (text.length <= MAX_CRASH_EVIDENCE_CHARS) return text;
	return keepEnd
		? `... [truncated]${text.slice(-MAX_CRASH_EVIDENCE_CHARS)}`
		: `${text.slice(0, MAX_CRASH_EVIDENCE_CHARS)}... [truncated]`;
}

/**
 * Pull the last meaningful evidence out of a task's JSONL event log: the final
 * `exitCode`, the last `errorMessage`/`error`, or — when the log carries no
 * structured signal (e.g. it was cut off mid-write) — a bounded raw tail. The
 * log format is produced by bun-process-runner's EventLog; if that format
 * changes, this extractor needs updating. Line-parse tolerant: a mid-write
 * crash can leave a partial tail line.
 */
function extractEvidenceFromLogText(text: string): string | undefined {
	let lastExitCode: number | undefined;
	let lastErrorMessage: string | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof event.exitCode === "number") lastExitCode = event.exitCode;
		const message = event.errorMessage ?? event.error;
		if (typeof message === "string" && message.trim()) lastErrorMessage = message;
	}
	const parts: string[] = [];
	if (lastExitCode !== undefined) parts.push(`exit code ${lastExitCode}`);
	if (lastErrorMessage !== undefined) parts.push(`error: ${clampEvidence(lastErrorMessage, false)}`);
	if (parts.length > 0) return parts.join("; ");
	const tail = text.trim();
	return tail ? clampEvidence(tail, true) : undefined;
}

/**
 * Best-effort crash evidence from a task's `log.jsonl`, read at startup
 * reconciliation. The log is written by the DETACHED child (bun-process-runner's
 * EventLog flushes it) — this only ever READS it. Any failure (missing file,
 * permissions, unreadable bytes) yields `undefined`, which crashMessage()
 * renders as the generic "no log available" note. Read via `Bun.file().text()`
 * per the Bun-only file-IO rule; the call is async, which is why the caller
 * gathers evidence before entering the (synchronous) registry lock.
 */
async function readCrashEvidence(logFile: string): Promise<string | undefined> {
	try {
		const bun = getBun();
		if (!(await bun.file(logFile).exists())) return undefined;
		return extractEvidenceFromLogText(await bun.file(logFile).text());
	} catch {
		return undefined;
	}
}

/**
 * The crash note for one orphaned row. ALWAYS returns a defined, non-empty
 * string — this is the guard that keeps the note in the stored row: the
 * registry is persisted with JSON.stringify, which silently strips `undefined`
 * fields, so a `t.errorMessage = undefined` here would drop the evidence on the
 * floor. crashMessage's guaranteed string (the extracted evidence, or the
 * "no log available" fallback) round-trips through the JSON store intact.
 */
function crashMessage(evidence: string | undefined): string {
	return evidence
		? `crashed (parent process died) — last known state: ${evidence}`
		: "crashed (parent process died; no log available)";
}

function createRegistry(): BackgroundRegistry {
	return {
		makeTaskId: makeTaskIdImpl,

		add(task) {
			withLock(lockPath(), () => {
				const file = readRegistry();
				// A duplicate id is a cross-process namespace clash, not a
				// duplicate delivery: regenerate instead of silently dropping the
				// row (which let update() hit the other session's task). The fresh
				// id lands on `task` itself so the caller can read the final id.
				while (file.tasks.some((t) => t.id === task.id)) {
					task.id = makeTaskIdImpl();
				}
				file.tasks.push({
					...task,
					ownerPid: task.ownerPid ?? process.pid,
					lastEventAt: task.lastEventAt ?? new Date().toISOString(),
				});
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
			// Startup reconciliation is best-effort and read-only over the detached
			// child's log. Gather evidence BEFORE the lock: Bun file reads are async
			// and the lock callback below is synchronous. The extra lock-free
			// readRegistry() only decides which logs to read — the authoritative
			// orphan decision re-runs inside the lock.
			const candidates = readRegistry().tasks.filter(isOrphanCandidate);
			const evidence = new Map<string, string | undefined>();
			await Promise.all(
				candidates.map(async (t) => {
					evidence.set(t.id, await readCrashEvidence(taskLogPath(t.id)));
				}),
			);
			return withLock(lockPath(), () => {
				const file = readRegistry();
				const now = new Date().toISOString();
				let count = 0;
				for (const t of file.tasks) {
					if (!isOrphanCandidate(t)) continue;
					t.status = "crashed";
					t.finishedAt = now;
					// Preserve any pre-existing result (not overwritten); otherwise
					// record the crash with the extracted evidence. crashMessage always
					// returns a defined string, so the JSON store can never strip it.
					t.errorMessage = t.errorMessage ?? crashMessage(evidence.get(t.id));
					t.lastEventAt = now;
					count += 1;
				}
				if (count > 0) writeRegistry(file);
				return count;
			});
		},

		async prune() {
			// Retention: keep terminal rows for at most PRUNE_MAX_AGE_MS (7 days)
			// and at most PRUNE_MAX_TERMINAL_ROWS (200) of the newest ones; rows
			// still in flight are never dropped. The bounds keep registry.json
			// small even though agent-session's constructor calls prune() on every
			// startup (nothing prunes during a long-lived session).
			return withLock(lockPath(), () => {
				const file = readRegistry();
				const cutoff = Date.now() - PRUNE_MAX_AGE_MS;
				const terminal = (t: BackgroundTask): boolean =>
					t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "crashed";
				const stamp = (t: BackgroundTask): number => {
					const ts = new Date(t.finishedAt ?? t.lastEventAt ?? t.startedAt).getTime();
					return Number.isNaN(ts) ? 0 : ts; // unparseable stamps sort oldest → prunable
				};
				const newestFirst = file.tasks.filter(terminal).sort((a, b) => stamp(b) - stamp(a));
				const keep = new Set<BackgroundTask>();
				for (let i = 0; i < newestFirst.length; i++) {
					const row = newestFirst[i];
					if (row !== undefined && i < PRUNE_MAX_TERMINAL_ROWS && stamp(row) > cutoff) keep.add(row);
				}
				const before = file.tasks.length;
				const prunedIds = file.tasks.filter((t) => terminal(t) && !keep.has(t)).map((t) => t.id);
				file.tasks = file.tasks.filter((t) => !terminal(t) || keep.has(t));
				const removed = before - file.tasks.length;
				// Row removal first, dir deletion second: once writeRegistry has
				// persisted the drop, a failed dir delete only leaks — it can never
				// orphan a log the registry still references.
				if (removed > 0) writeRegistry(file);
				for (const id of prunedIds) deleteTaskLogDir(id);
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
	/** Parent session file path; threaded into the runner so the child can nest under it. */
	parentSessionFile?: string;
	/** Called once the task reaches a terminal state. Must not throw. */
	onSettled?: (taskId: string, result: SubagentResult) => void;
	/** No hard limit by default: a background task is expected to outlive a turn. */
	timeoutMs?: number;
}

/**
 * Deliver the settle notification for a terminal task. onSettled "must not
 * throw" — swallow a violation anyway: at both call sites the task is already
 * terminal, and a throw escaping here would either become an unhandled
 * rejection (crash path) or rewrite the terminal status to "crashed" (normal
 * path).
 */
function notifySettled(onSettled: BackgroundRunOptions["onSettled"], taskId: string, result: SubagentResult): void {
	try {
		onSettled?.(taskId, result);
	} catch (err) {
		console.warn(
			`[subagent-bg] onSettled callback threw for ${taskId}:`,
			err instanceof Error ? err.message : String(err),
		);
	}
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
	const now = new Date().toISOString();
	const row: BackgroundTask = {
		id: options.taskId ?? registry.makeTaskId(),
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
	};
	registry.add(row);
	// add() regenerates on an id collision — track the final id everywhere.
	const taskId = row.id;
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
			const errorMessage = `runner crashed: ${message}`;
			try {
				registry.update(taskId, {
					status: "crashed",
					errorMessage,
					finishedAt: new Date().toISOString(),
				});
			} catch (updateErr) {
				// Never let this catch reject — that would surface as an
				// unhandled rejection and take the parent session down.
				console.warn(
					`[subagent-bg] failed to record crash for ${taskId}:`,
					updateErr instanceof Error ? updateErr.message : String(updateErr),
				);
			}
			// The task is terminal, so the settle notification must fire here
			// too — without it the model gets no subagent-background-result
			// message and dependent chain steps just vanish, while inline mode
			// reports the same failure as a tool error. Synthesize the failed
			// result the runner never produced (exit code 1, stopReason "error")
			// so consumers treat it exactly like a failed run.
			notifySettled(options.onSettled, taskId, {
				role: options.spec.role,
				task: options.task,
				exitCode: 1,
				aborted: false,
				finalOutput: "",
				stderr: "",
				usage: createEmptyUsage(),
				messages: [],
				stopReason: "error",
				errorMessage,
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
			...(options.parentSessionFile === undefined ? {} : { parentSessionFile: options.parentSessionFile }),
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
		// sessionFile is captured for the resume path: a parent restart can
		// hand it back via spec.sessionFile to continue the same child
		// session. Only stamp it on a successful capture (the runner leaves
		// result.sessionFile undefined for --no-session children and for
		// runs that crashed before opening their session).
		...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
		...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
	});
	registry.appendLog(taskId, { type: "EXIT", exitCode: result.exitCode, status: failed ? "failed" : "completed" });
	// Guarded: a throwing onSettled must not reach the outer catch, which would
	// rewrite this terminal status to "crashed".
	notifySettled(options.onSettled, taskId, result);
	return {
		failed,
		...(failed ? { errorMessage: result.errorMessage ?? `exit code ${result.exitCode}` } : {}),
	};
}
