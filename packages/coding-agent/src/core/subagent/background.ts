/**
 * Background-task registry for fire-and-forget subagents.
 *
 * File-backed store so a background subagent survives the parent's turn and
 * can be inspected by a later session. On disk, under the agent dir:
 *
 * subagent-bg/
 *   registry.json                # array of BackgroundTask entries
 *   registry.lock                # write lock guarding registry.json
 *   failure-counters.json        # consecutive-failure streaks per role (#1051)
 *   replay/<encoded taskId>.json # undelivered completion record (#1050)
 *   <taskId>/log.jsonl           # per-task append-only event log
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
 * Durable completion (#1050): a run started with an `onSettled` callback writes a result
 * record under `replay/` before the callback fires, so a crash in between cannot swallow
 * the notification. The record carries a claim token; the callback deletes it once the
 * notification has been handed to the UI. A later session replays leftover records once,
 * bounded by count, age, and attempt count, and never re-enters the settle path while
 * doing so. Identical consecutive failure signatures escalate after a threshold (#1051).
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
import {
	applySettleToStreaks,
	buildCompletionRecord,
	type CompletionDelivery,
	type CompletionEscalation,
	type CompletionRecord,
	type CompletionRecordInput,
	type CompletionReplayReceipt,
	type CompletionStatus,
	claimRecord,
	countersFile,
	deleteRecordFile,
	FAILURE_ESCALATION_THRESHOLD,
	failureSignature,
	isClaimFresh,
	isRecordStale,
	listRecordFiles,
	REPLAY_MAX_AGE_MS,
	REPLAY_MAX_ATTEMPTS,
	REPLAY_MAX_RECORDS,
	readFailureCounters,
	readRecordFile,
	recordFile,
	replayDir,
	writeFailureCounters,
	writeRecordFile,
} from "./result-record.ts";
import { getBun } from "./runtime.ts";
import { killPidTree } from "./shell.ts";
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

/**
 * What a `cancel` request actually achieved. The tool's text is derived from
 * this, so a cancellation that could not stop its child can never be reported
 * as one that did (REQ-X01.5).
 */
export type CancelResult =
	| {
			kind: "cancelled" /** Pid that was signalled, or undefined in the spawn window. */;
			pid?: number;
			killed: boolean;
	  }
	| { kind: "cancelled-queued" }
	| { kind: "not-found" }
	| { kind: "already-terminal"; status: TaskStatus }
	| { kind: "not-cancelled"; reason: string };

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
	 *
	 * A crashed row's surviving child is KILLED in the same pass (REQ-X02), so
	 * a parent SIGKILL cannot leave a live, write-capable orphan behind a row
	 * that claims it is dead.
	 */
	markAllRunningAsCrashed(): Promise<number>;
	/**
	 * Drop over-retention terminal rows and delete their `<taskId>/` log dirs
	 * (best-effort: row removal is persisted before any dir delete, so a failed
	 * delete only leaks — it never orphans a log the registry still references).
	 * Returns the number of rows removed.
	 */
	prune(): Promise<number>;
	/**
	 * Stop a task and report what happened.
	 *
	 * A queued row is cancelled with no signalling: it never reached the runner,
	 * so there is no child. A running row is SIGNALLLED through its recorded pid
	 * before the terminal write, escalating SIGTERM -> SIGKILL tree like
	 * `killPidTree`.
	 *
	 * Signalling is gated on this process still being the row's owner: a pid
	 * outlives its row, and once the owning session is gone the number may have
	 * been recycled by an unrelated process. Killing on pid liveness alone would
	 * let a `stop` reach into some other program. Rows whose owner is gone are
	 * reaped by `markAllRunningAsCrashed` instead, which has the same gate.
	 */
	cancel(taskId: string, reason: string): Promise<CancelResult>;
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

/** Whether a row has already been cancelled — the spawn-window kill's precondition. */
function isRowCancelled(registry: BackgroundRegistry, taskId: string): boolean {
	try {
		return registry.snapshot().tasks.find((t) => t.id === taskId)?.status === "cancelled";
	} catch {
		// An unreadable registry is not evidence of a cancellation; leave the
		// child alone rather than killing one nobody asked to stop.
		return false;
	}
}

/**
 * Current row status, or undefined when the row is gone or unreadable. Used by
 * the crash path to let an already-terminal row (a `stop` that wrote
 * `cancelled`) outrank the synthesized `crashed`.
 */
function currentRowStatus(registry: BackgroundRegistry, taskId: string): TaskStatus | undefined {
	try {
		return registry.snapshot().tasks.find((t) => t.id === taskId)?.status;
	} catch {
		return undefined;
	}
}

/**
 * Kill one orphaned row's surviving child, and describe what was done.
 *
 * This is the REQ-X02 half: `isOrphanCandidate` has already proved the owning
 * session is gone, so a still-live `t.pid` is a write-capable process with no
 * parent and no killer. Leaving it behind a row that says `crashed` is the leak.
 *
 * Recycled-pid gate (REQ-X01.3 applies here too). Pid liveness cannot
 * distinguish our child from an unrelated process that inherited the number.
 * Two facts narrow it, and neither is sufficient alone:
 *
 * 1. The row must be an orphan (owner dead) — proven by the caller.
 * 2. The pid must still be alive AND must not be this process.
 *
 * A row that predates `pid` recording has nothing to kill, which is reported
 * rather than silently skipped so the row's message says why no reap happened.
 *
 * Residual (accepted, documented rather than hidden): Windows offers no
 * portable process start time, so a pid recycled within the same reconcile pass
 * is indistinguishable from the original child. The window is one startup pass
 * wide and only ever follows a parent crash, where the alternative — leaving a
 * live orphan — is strictly worse.
 */
function reapOrphanChild(t: BackgroundTask): string | undefined {
	const pid = t.pid;
	if (pid === undefined) return undefined; // never recorded, or never reached the runner
	if (!isProcessAlive(pid)) return undefined; // already exited on its own
	const outcome = killPidTree(pid);
	return outcome === "signalled"
		? `reaped surviving child process (pid ${pid})`
		: `could NOT reap surviving child process (pid ${pid}): the kill could not be delivered and the child may still be running`;
}

/**
 * Clamp evidence to MAX_CRASH_EVIDENCE_CHARS, keeping the head or the tail.
 */
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
			// Kill surviving children OUTSIDE the lock, for the same reason as
			// cancel(): a wedged kill must not hold the registry lock against
			// every other session. The child is killed before the row is rewritten
			// to `crashed`, so no observer ever sees a crashed row whose child is
			// still running (REQ-X02.3).
			const reaps = new Map<string, string>();
			for (const t of candidates) {
				const note = reapOrphanChild(t);
				if (note !== undefined) reaps.set(t.id, note);
			}
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
					// The reap outcome rides in the same message so a single read of
					// the row explains both why the task ended and what happened to
					// its process (REQ-X02.2).
					const reap = reaps.get(t.id);
					if (reap !== undefined) t.errorMessage = `${t.errorMessage}; ${reap}`;
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
			// Read outside the lock: the kill below must not hold the registry
			// lock, or a wedged taskkill would block every other session's writes.
			// The authoritative re-check happens again inside the lock below.
			const current = readRegistry().tasks.find((t) => t.id === taskId);
			if (current === undefined) return { kind: "not-found" };
			if (current.status !== "running" && current.status !== "pending") {
				return { kind: "already-terminal", status: current.status };
			}

			// Queued: never reached the runner, so no child exists and none can
			// be signalled. This is the one case where the row alone is the whole
			// story.
			if (current.status === "pending") {
				withLock(lockPath(), () => {
					const file = readRegistry();
					const idx = file.tasks.findIndex((t) => t.id === taskId);
					if (idx === -1) return;
					const row = file.tasks[idx];
					if (!row || (row.status !== "running" && row.status !== "pending")) return;
					const now = new Date().toISOString();
					file.tasks[idx] = {
						...row,
						status: "cancelled",
						finishedAt: now,
						errorMessage: reason,
						lastEventAt: now,
					};
					writeRegistry(file);
				});
				return { kind: "cancelled-queued" };
			}

			// Recycled-pid guard, checked BEFORE anything acts on the pid. A pid
			// outlives its row, and pid liveness alone cannot tell our child from
			// an unrelated process that inherited the number. The trustworthy fact
			// is ownership: this session recorded that pid and is still the row's
			// owner. A row belonging to another session is left alone entirely —
			// including the harmless "mark a dead child cancelled" path below —
			// because `stop` on a foreign row must never write state for it.
			// markAllRunningAsCrashed handles genuinely abandoned rows, and applies
			// the same rule from the other side: dead owner, then the pid is fair
			// game to reap.
			if (current.ownerPid !== undefined && current.ownerPid !== process.pid) {
				return {
					kind: "not-cancelled",
					reason: `Refusing to act on pid ${current.pid ?? "unknown"}: the task is owned by session ${current.ownerPid}, not this one (${process.pid}). A pid outlives its row and may have been recycled by an unrelated process.`,
				};
			}

			// Running. A row with no pid yet is the spawn window: the row is written
			// before the runner resolves its invocation, so a `stop` issued right
			// after dispatch lands here. Cancelling it is still honest — the child
			// is killed the instant it spawns (see the `spawned` handler in
			// runDetached), so no live child is ever left behind a cancelled row.
			const pid = current.pid;
			if (pid === undefined) {
				withLock(lockPath(), () => {
					const file = readRegistry();
					const idx = file.tasks.findIndex((t) => t.id === taskId);
					if (idx === -1) return;
					const row = file.tasks[idx];
					if (!row || (row.status !== "running" && row.status !== "pending")) return;
					const now = new Date().toISOString();
					file.tasks[idx] = {
						...row,
						status: "cancelled",
						finishedAt: now,
						errorMessage: `${reason} (cancelled during the spawn window: the child had not reported a pid yet and is killed as soon as it does)`,
						lastEventAt: now,
					};
					writeRegistry(file);
				});
				return { kind: "cancelled", killed: false };
			}
			if (!isProcessAlive(pid)) {
				// Already gone on its own: cancelling the row is then accurate,
				// and this is the only path where no signal is needed.
				withLock(lockPath(), () => {
					const file = readRegistry();
					const idx = file.tasks.findIndex((t) => t.id === taskId);
					if (idx === -1) return;
					const row = file.tasks[idx];
					if (!row || (row.status !== "running" && row.status !== "pending")) return;
					const now = new Date().toISOString();
					file.tasks[idx] = {
						...row,
						status: "cancelled",
						finishedAt: now,
						errorMessage: reason,
						lastEventAt: now,
					};
					writeRegistry(file);
				});
				return { kind: "cancelled", pid, killed: false };
			}

			const outcome = killPidTree(pid);
			appendToTaskLog(taskId, { type: "KILL", pid, outcome, reason });
			if (outcome === "failed") {
				return {
					kind: "not-cancelled",
					reason: `Signalled pid ${pid} but the kill could not be delivered (permission or an invalid pid). The child may still be running; the row is left running rather than falsely marked cancelled.`,
				};
			}

			withLock(lockPath(), () => {
				const file = readRegistry();
				const idx = file.tasks.findIndex((t) => t.id === taskId);
				if (idx === -1) return;
				const row = file.tasks[idx];
				// The child may have settled while the kill was in flight; its own
				// terminal status is the truth and must not be overwritten.
				if (!row || (row.status !== "running" && row.status !== "pending")) return;
				const now = new Date().toISOString();
				file.tasks[idx] = {
					...row,
					status: "cancelled",
					finishedAt: now,
					errorMessage: reason,
					lastEventAt: now,
				};
				writeRegistry(file);
			});
			return { kind: "cancelled", pid, killed: true };
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
	/** Delegation depth of the child to launch. Root session is 0, so its children are 1. */
	depth?: number;
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
 *
 * Durable completion (#1050): when a notification is to be delivered, its
 * record is written and claimed under the registry lock *before* the callback
 * runs, and deleted only once the callback returned. A callback that throws —
 * or a parent that dies mid-delivery — leaves the record behind for the next
 * session's replay pass (`claimReplayDeliveries`). The consecutive-failure
 * streak (#1051) is folded in the same lock hold, and a streak that just
 * reached the escalation threshold rides out on `result.escalation`.
 */
function notifySettled(
	onSettled: BackgroundRunOptions["onSettled"],
	taskId: string,
	result: SubagentResult,
	context: SettleContext = {},
): void {
	const status = context.status ?? deriveCompletionStatus(result);
	const { escalation, delivery, skipped } = recordSettle(
		{
			taskId,
			role: result.role,
			status,
			exitCode: result.exitCode,
			...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
			output: context.output ?? result.finalOutput,
			task: result.task,
			logPath: taskLogPath(taskId),
		},
		onSettled !== undefined,
	);
	// A fresh claim means this settle is already mid-delivery elsewhere;
	// delivering again would report the same task twice.
	if (onSettled === undefined || skipped) return;
	if (escalation !== undefined) result.escalation = escalation;
	try {
		onSettled(taskId, result);
	} catch (err) {
		// The record stays on disk with its fresh claim: the next replay pass
		// reclaims it once the claim goes stale or this pid dies. A best-effort
		// delivery (no record) has nothing left to replay.
		console.warn(`[subagent-bg] onSettled callback threw for ${taskId}:`, errorText(err));
		return;
	}
	if (delivery !== undefined) completeReplayDelivery(delivery);
}

// ============================================================================
// Durable completion + startup replay (#1050) and failure streaks (#1051)
// ============================================================================

/**
 * Overrides for the durable record a settle writes. The terminal state a
 * settle describes is not always derivable from the result: `runDetached`
 * lets an already-terminal row win (a `stop` writes `cancelled` while the
 * child is still running), and the crash path synthesizes a result the runner
 * never produced.
 */
interface SettleContext {
	status?: CompletionStatus;
	/** Resolved display output; falls back to `result.finalOutput`. */
	output?: string;
}

function deriveCompletionStatus(result: SubagentResult): CompletionStatus {
	if (!isFailedSubagentResult(result)) return "completed";
	return result.aborted ? "cancelled" : "failed";
}

/** `TaskStatus` narrowed to the terminal states a completion record accepts. */
function terminalStatusOf(status: TaskStatus | undefined): CompletionStatus | undefined {
	switch (status) {
		case "completed":
		case "failed":
		case "cancelled":
		case "crashed":
			return status;
		default:
			return undefined;
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Fold one settle into the failure-streak table and — for a settle that has a
 * notification to deliver — write and claim its durable completion record.
 *
 * One `withLock` hold covers both writes: a claim on a record is only safe
 * against a concurrent settle of the same task while the registry lock is
 * held. A record already claimed by a live process belongs to another delivery
 * of the same settle, so the caller is told to skip it (at-most-once per
 * claim).
 *
 * Every failure here is swallowed: durable bookkeeping is best-effort, and a
 * disk problem must never cost the model its settle notification.
 */
function recordSettle(
	input: CompletionRecordInput,
	durable: boolean,
): { escalation?: CompletionEscalation; delivery?: CompletionDelivery; skipped: boolean } {
	const bgDir = backgroundDir();
	const now = Date.now();
	const signature = failureSignature(input.status, input.exitCode, input.errorMessage);
	let escalation: CompletionEscalation | undefined;
	let delivery: CompletionDelivery | undefined;
	let skipped = false;
	try {
		withLock(lockPath(), () => {
			const countersPath = countersFile(bgDir);
			const counters = readFailureCounters(countersPath);
			escalation = applySettleToStreaks(counters, {
				role: input.role,
				taskId: input.taskId,
				status: input.status,
				signature,
				threshold: FAILURE_ESCALATION_THRESHOLD,
				now,
			});
			writeFailureCounters(countersPath, counters);

			// Without a notification to deliver there is nothing to replay, and
			// the streak table above is the whole record of this settle.
			if (!durable) return;

			const path = recordFile(bgDir, input.taskId);
			const existing = readRecordFile(path);
			if (existing !== undefined && isClaimFresh(existing, now, isProcessAlive)) {
				skipped = true;
				return;
			}
			const record = buildCompletionRecord(escalation === undefined ? input : { ...input, escalation });
			// A leftover record for this task id is an earlier, undelivered
			// settle (nothing delivered deletes it): the replay bounds are
			// measured from its first write, so its age and attempt count carry
			// over instead of restarting on every retry.
			if (existing !== undefined) {
				record.createdAt = existing.createdAt;
				record.attempts = existing.attempts;
			}
			const token = crypto.randomUUID();
			claimRecord(record, token, now, process.pid);
			writeRecordFile(path, record);
			delivery = { record, token };
		});
	} catch (err) {
		console.warn(`[subagent-bg] failed to persist settle record for ${input.taskId}:`, errorText(err));
	}
	return { escalation, delivery, skipped };
}

/**
 * Clear a claimed record once its notification has been handed to a consumer.
 *
 * The token is re-checked under the lock: a record that changed hands since we
 * claimed it (a stale-claim break, or another process's delivery) must not be
 * deleted by us. A delivery without a token means the durable write itself
 * failed, so there is nothing on disk to clear. Failures are swallowed — the
 * record stays, and the next replay pass retries within its bounds.
 */
export function completeReplayDelivery(delivery: CompletionDelivery): void {
	if (delivery.token === undefined) return;
	const path = recordFile(backgroundDir(), delivery.record.taskId);
	try {
		withLock(lockPath(), () => {
			const current = readRecordFile(path);
			if (current === undefined || current.claimToken !== delivery.token) return;
			deleteRecordFile(path);
		});
	} catch (err) {
		console.warn(`[subagent-bg] failed to clear settle record for ${delivery.record.taskId}:`, errorText(err));
	}
}

/**
 * Claim the settle notifications a previous process wrote but never delivered.
 *
 * One pass under one lock hold: a record that cannot be parsed, has outlived
 * `REPLAY_MAX_AGE_MS`, or has already been claimed `REPLAY_MAX_ATTEMPTS` times
 * is collected (deleted) rather than replayed, a record whose claim is still
 * fresh is left to its owner, and the oldest `REPLAY_MAX_RECORDS` survivors are
 * claimed and returned for delivery, in `createdAt` order. Anything beyond
 * that cap is counted as deferred and stays on disk.
 *
 * `now` is injectable so a test can age claims and records without sleeping.
 */
export function claimReplayDeliveries(now: number = Date.now()): CompletionReplayReceipt {
	const bgDir = backgroundDir();
	const receipt: CompletionReplayReceipt = { delivered: [], deferred: 0, collected: 0, claimsHeld: 0 };
	try {
		withLock(lockPath(), () => {
			const candidates: Array<{ path: string; record: CompletionRecord }> = [];
			for (const path of listRecordFiles(replayDir(bgDir))) {
				const record = readRecordFile(path);
				if (
					record === undefined ||
					isRecordStale(record, now, REPLAY_MAX_AGE_MS) ||
					record.attempts >= REPLAY_MAX_ATTEMPTS
				) {
					deleteRecordFile(path);
					receipt.collected += 1;
					continue;
				}
				candidates.push({ path, record });
			}
			candidates.sort(
				(a, b) =>
					Date.parse(a.record.createdAt) - Date.parse(b.record.createdAt) ||
					(a.record.taskId < b.record.taskId ? -1 : 1),
			);
			for (const { path, record } of candidates) {
				if (isClaimFresh(record, now, isProcessAlive)) {
					receipt.claimsHeld += 1;
					continue;
				}
				if (receipt.delivered.length >= REPLAY_MAX_RECORDS) {
					receipt.deferred += 1;
					continue;
				}
				const token = crypto.randomUUID();
				claimRecord(record, token, now, process.pid);
				writeRecordFile(path, record);
				receipt.delivered.push({ record, token });
			}
		});
	} catch (err) {
		// Losing the lock only postpones the replay; the records stay on disk.
		console.warn("[subagent-bg] replay pass could not take the registry lock:", errorText(err));
	}
	return receipt;
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
	// The row is stamped once here and handed to the runner under that id, so
	// the registry and the detached run can never disagree about which row
	// this dispatch owns.
	dispatchBackgroundRow({ ...options, taskId: row.id }, row.id);
	return { taskId: row.id };
}

/**
 * Everything a background task does AFTER its row exists: the SPAWN log entry,
 * the telemetry span, and the detached run.
 *
 * Split out of `startBackgroundSubagent` so the dispatch queue can promote an
 * already-recorded `pending` row (see `requestBackgroundDispatch`) without
 * re-adding it — re-adding would collide with the parked row and silently
 * relocate the task to a fresh id, orphaning the id the model was given.
 * `options` must already carry this `taskId`: the row and the run share one id.
 */
function dispatchBackgroundRow(options: BackgroundRunOptions, taskId: string): void {
	const registry = options.registry;
	registry.appendLog(taskId, { type: "SPAWN", role: options.spec.role });

	const spanId = newTaskSpanId();
	startSubagentTask({ spanId, agentName: options.spec.role, taskLabel: options.task.slice(0, 200) });

	// Fire and forget: this promise is intentionally not awaited here, and every
	// exit path is guarded so it can never reject.
	void runDetached(options, taskId)
		.then(({ failed, errorMessage }) => {
			// Telemetry must never throw here: a rejection from this callback would
			// land in the catch below and report a task that already settled — and
			// already notified — a second time as `crashed`.
			try {
				endSubagentTask(spanId, !failed, failed ? errorMessage : undefined);
			} catch (spanErr) {
				console.warn(`[subagent-bg] failed to close span for ${taskId}:`, errorText(spanErr));
			}
		})
		.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			try {
				endSubagentTask(spanId, false, message);
			} catch (spanErr) {
				console.warn(`[subagent-bg] failed to close span for ${taskId}:`, errorText(spanErr));
			}
			const errorMessage = `runner crashed: ${message}`;
			// A row that is already terminal wins here exactly as it does in
			// `runDetached`: `stop` writes `cancelled` while the child is still
			// running, the killed child then rejects, and stamping `crashed` over
			// that would contradict the cancellation the model was already told
			// about (REQ-X01.4).
			const existing = currentRowStatus(registry, taskId);
			const status = terminalStatusOf(existing) ?? "crashed";
			if (existing !== status) {
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
			}
			// The task is terminal, so the settle notification must fire here
			// too — without it the model gets no subagent-background-result
			// message and dependent chain steps just vanish, while inline mode
			// reports the same failure as a tool error. Synthesize the failed
			// result the runner never produced (exit code 1, stopReason "error")
			// so consumers treat it exactly like a failed run.
			notifySettled(
				options.onSettled,
				taskId,
				{
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
				},
				{ status },
			);
		});
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
			depth: options.depth,
			logPath: join(getAgentDir(), BG_DIR_NAME, taskId, BG_LOG_FILE),
			...(options.parentSessionFile === undefined ? {} : { parentSessionFile: options.parentSessionFile }),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		},
		// No caller signal: a background task must not inherit the turn's abort.
		undefined,
		(event) => {
			if (event.type === "spawned") {
				// The pid is the only handle that outlives this call: `stop` from
				// another session and startup orphan reconciliation both address
				// the child by pid alone, because neither has the BunSubprocess
				// handle `createKillController` needs. Recorded before any other
				// event can settle the row so there is no window in which a
				// running row is unaddressable.
				if (event.pid !== undefined) registry.update(taskId, { pid: event.pid });
				// The row can already read `cancelled` here: `stop` is issued the
				// moment a task is dispatched, and the row exists before the runner
				// has resolved its invocation, so the cancel lands in the spawn
				// window with no pid to signal. Honour it now that a pid exists,
				// otherwise the child would run to completion behind a row that
				// says it was stopped.
				if (event.pid !== undefined && isRowCancelled(registry, taskId)) {
					const outcome = killPidTree(event.pid);
					appendToTaskLog(taskId, {
						type: "KILL",
						pid: event.pid,
						outcome,
						reason: "cancelled during spawn window",
					});
				}
			} else if (event.type === "message_end" && event.message.role === "assistant") {
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
	// A `stop` that landed while the child was running already wrote the terminal
	// `cancelled` row. The child then settles (killed -> exit != 0) and this write
	// would overwrite `cancelled` with `failed`, undoing the cancellation the
	// model was just told about — the exact contradiction REQ-X01.4 forbids.
	// A row that is already terminal wins; only the observable output is added.
	let status: TaskStatus | undefined;
	try {
		const row = registry.snapshot().tasks.find((t) => t.id === taskId);
		if (row !== undefined && row.status !== "running" && row.status !== "pending") status = row.status;
	} catch {
		// An unreadable registry is not evidence that the row was cancelled;
		// fall through and record this run's own terminal status.
	}
	registry.update(taskId, {
		...(status === undefined ? { status: failed ? (result.aborted ? "cancelled" : "failed") : "completed" } : {}),
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
	registry.appendLog(taskId, {
		type: "EXIT",
		exitCode: result.exitCode,
		status: status ?? (failed ? "failed" : "completed"),
		...(status === undefined ? {} : { supersededBy: status }),
	});
	// Guarded: a throwing onSettled must not reach the outer catch, which would
	// rewrite this terminal status to "crashed".
	notifySettled(options.onSettled, taskId, result, {
		status: terminalStatusOf(status) ?? deriveCompletionStatus(result),
		output,
	});
	return {
		failed,
		...(failed ? { errorMessage: result.errorMessage ?? `exit code ${result.exitCode}` } : {}),
	};
}

// ============================================================================
// Dispatch cap + FIFO queue
// ============================================================================

/** How a capped dispatch request was admitted: started immediately, or parked. */
export type DispatchAdmission = "running" | "queued";

export interface BackgroundDispatchRequest {
	/**
	 * Registry row id. The row exists from the moment the request returns:
	 * `running` when admitted, `pending` while it waits for a slot.
	 */
	taskId: string;
	admission: DispatchAdmission;
	/** 1-based position in the queue. 0 when admitted immediately. */
	queuePosition: number;
}

interface DispatchQueue {
	/**
	 * Task ids holding a live slot. `size` is the live count the cap compares
	 * against: added at admission, removed when the task settles.
	 */
	readonly slots: Set<string>;
	/** Parked task ids, FIFO. */
	readonly order: string[];
	/** Parked payloads by task id. Removed on promotion, cancellation, or failure. */
	readonly parked: Map<string, BackgroundRunOptions>;
	/** Re-entrancy guard: a failed promotion releases its slot from inside the drain loop. */
	draining: boolean;
}

/**
 * Queue state lives per registry instance, in memory.
 *
 * The on-disk row is the visible half — `pending`, so `action="status"` and the
 * UI can list queued work. The dispatch payload is the invisible half: a parked
 * task carries the runner, spec, parent context and settle callback that
 * registry.json does not record, so no other process could promote it. A session
 * that dies therefore leaves its parked rows `pending` and startup hygiene
 * crashes them exactly like orphaned `running` rows — the queue survives as a
 * report, not as work in flight.
 */
let dispatchQueues = new WeakMap<BackgroundRegistry, DispatchQueue>();

function dispatchQueueFor(registry: BackgroundRegistry): DispatchQueue {
	let queue = dispatchQueues.get(registry);
	if (queue === undefined) {
		queue = { slots: new Set(), order: [], parked: new Map(), draining: false };
		dispatchQueues.set(registry, queue);
	}
	return queue;
}

/** A cap below 1 would park every task forever; clamp to one slot instead of stalling. */
export function normalizeDispatchCap(maxConcurrent: number): number {
	if (!Number.isFinite(maxConcurrent)) return 1;
	return Math.max(1, Math.trunc(maxConcurrent));
}

/** Whether a parked row may still be promoted to a running task. */
type ParkedRowState = "pending" | "settled" | "unknown";

function parkedRowState(registry: BackgroundRegistry, taskId: string): ParkedRowState {
	try {
		const row = registry.snapshot().tasks.find((t) => t.id === taskId);
		// A missing row was pruned or never landed: there is nothing to promote.
		if (row === undefined) return "settled";
		return row.status === "pending" ? "pending" : "settled";
	} catch {
		// An unreadable registry is not a reason to spend a slot on a task whose
		// row cannot be confirmed; leave it parked and retry on the next release.
		return "unknown";
	}
}

/**
 * Forget reservations whose row is already terminal.
 *
 * Every normal path releases its slot from the settle callback, but a row can
 * also be ended from the outside — startup hygiene crashes orphans, and a
 * registry-level cancel marks a row whose detached child is still running and
 * will settle later. Without this sweep such a leak would shrink the effective
 * cap forever and stall the queue, so slots are re-checked against the file
 * before the cap is applied.
 */
function sweepReleasedSlots(registry: BackgroundRegistry, queue: DispatchQueue): void {
	if (queue.slots.size === 0) return;
	let rows: BackgroundTask[];
	try {
		rows = registry.snapshot().tasks;
	} catch {
		// Cannot prove anything is stale; keep the reservations and let the next
		// release sweep again.
		return;
	}
	const byId = new Map(rows.map((t) => [t.id, t]));
	for (const taskId of [...queue.slots]) {
		const row = byId.get(taskId);
		const terminal =
			row === undefined ||
			row.status === "completed" ||
			row.status === "failed" ||
			row.status === "cancelled" ||
			row.status === "crashed";
		if (terminal) queue.slots.delete(taskId);
	}
}

/**
 * Drop parked tasks whose row stopped being `pending` while it waited.
 *
 * Cancelling a queued task marks its row `cancelled`, but the drain only looks
 * at a row when it pops it, so a dead task at the head of the line would sit in
 * `order` indefinitely and keep showing up in `queuedTaskIds` — counted as
 * queued work in status listings and the UI, with a position nobody can claim.
 * Pruning on every drain keeps the reported queue to work that can still start.
 * One registry read covers the whole line, and an unreadable registry is left
 * alone: the per-promotion row check stays the authoritative gate.
 */
function pruneSettledParkedTasks(registry: BackgroundRegistry, queue: DispatchQueue): void {
	if (queue.order.length === 0) return;
	let rows: BackgroundTask[];
	try {
		rows = registry.snapshot().tasks;
	} catch {
		return;
	}
	const byId = new Map(rows.map((t) => [t.id, t]));
	for (const taskId of [...queue.order]) {
		const row = byId.get(taskId);
		if (row !== undefined && row.status === "pending") continue;
		const index = queue.order.indexOf(taskId);
		if (index !== -1) queue.order.splice(index, 1);
		queue.parked.delete(taskId);
	}
}

/**
 * Hand free slots to the oldest parked tasks.
 *
 * Called after every release and after every enqueue (an enqueue can free a
 * slot itself when the sweep finds the cap was overstated). Self-limiting: it
 * never promotes more than `maxConcurrent` slots are worth, so calling it when
 * nothing is eligible is cheap and safe.
 */
function drainDispatchQueue(registry: BackgroundRegistry, queue: DispatchQueue, maxConcurrent: number): void {
	if (queue.draining || queue.order.length === 0) return;
	queue.draining = true;
	try {
		sweepReleasedSlots(registry, queue);
		pruneSettledParkedTasks(registry, queue);
		const cap = normalizeDispatchCap(maxConcurrent);
		while (queue.order.length > 0 && queue.slots.size < cap) {
			const taskId = queue.order.shift();
			if (taskId === undefined) break;
			const run = queue.parked.get(taskId);
			if (run === undefined) continue;
			const state = parkedRowState(registry, taskId);
			if (state === "unknown") {
				// Put it back at the head and stop: promoting anything out of order
				// while the registry is unreadable would break FIFO for no gain.
				queue.order.unshift(taskId);
				return;
			}
			queue.parked.delete(taskId);
			if (state === "settled") continue; // cancelled or finished while it waited: no slot spent
			queue.slots.add(taskId);
			try {
				promoteParkedTask(registry, taskId, run);
			} catch (err) {
				// The slot is given back here; the enclosing loop picks it up on its
				// next iteration (drainDispatchQueue itself is re-entrancy-guarded).
				queue.slots.delete(taskId);
				failParkedPromotion(registry, taskId, run, err);
			}
		}
	} finally {
		queue.draining = false;
	}
}

/** Flip a parked row to `running` and start it under the id the model already has. */
function promoteParkedTask(registry: BackgroundRegistry, taskId: string, run: BackgroundRunOptions): void {
	const now = new Date().toISOString();
	// The label follows the row's state: it said `(queued)` while it waited, and
	// says `(background)` from here on exactly like a task admitted outright.
	registry.update(taskId, {
		status: "running",
		label: `${run.spec.role} (background)`,
		startedAt: now,
		lastEventAt: now,
	});
	registry.appendLog(taskId, { type: "QUEUE_PROMOTE", role: run.spec.role });
	// No registry.add(): the row was written at enqueue time, and add() would
	// collide with it and move the task to an id nobody is waiting for.
	dispatchBackgroundRow({ ...run, taskId }, taskId);
}

/**
 * Record a parked task that could not be promoted, and settle it so consumers
 * (chain steps, the background-result injector) see a terminal result instead of
 * a task that silently vanished. Mirrors the synthesized failure result the
 * detached crash path reports.
 */
function failParkedPromotion(
	registry: BackgroundRegistry,
	taskId: string,
	run: BackgroundRunOptions,
	err: unknown,
): void {
	const message = err instanceof Error ? err.message : String(err);
	const errorMessage = `queued dispatch failed: ${message}`;
	try {
		registry.update(taskId, {
			status: "failed",
			exitCode: 1,
			finishedAt: new Date().toISOString(),
			errorMessage,
		});
	} catch (updateErr) {
		console.warn(
			`[subagent-bg] failed to record queued dispatch failure for ${taskId}:`,
			updateErr instanceof Error ? updateErr.message : String(updateErr),
		);
	}
	notifySettled(run.onSettled, taskId, {
		role: run.spec.role,
		task: run.task,
		exitCode: 1,
		aborted: false,
		finalOutput: "",
		stderr: "",
		usage: createEmptyUsage(),
		messages: [],
		stopReason: "error",
		errorMessage,
	});
}

/**
 * Cap-aware entry point for every detached subagent dispatch.
 *
 * `startBackgroundSubagent` starts a child immediately and has no notion of how
 * many children the session is already running, so a model that fires twenty
 * background tasks in one call spawned twenty concurrent children — the
 * `subagent.maxConcurrent` cap only ever guarded inline parallel batches. This
 * admits a dispatch into one slot of that budget, and parks the overflow in a
 * FIFO queue behind it (see the module comment on `dispatchQueues`).
 *
 * The caller owns two obligations:
 *
 * 1. Pass the returned `taskId` to the model. It is the row id from here on,
 *    whether the task started or is waiting.
 * 2. Call `releaseBackgroundDispatch(registry, taskId, maxConcurrent)` from the
 *    task's settle callback. That is what frees the slot and promotes the next
 *    queued task; a release that never happens is only recovered by
 *    `sweepReleasedSlots` on the following dispatch.
 *
 * A queued task never reaches the runner until it is promoted, so cancelling one
 * is a plain `registry.cancel()` — it holds no slot and starts no child.
 */
export function requestBackgroundDispatch(
	registry: BackgroundRegistry,
	run: BackgroundRunOptions,
	maxConcurrent: number,
): BackgroundDispatchRequest {
	const queue = dispatchQueueFor(registry);
	sweepReleasedSlots(registry, queue);
	const cap = normalizeDispatchCap(maxConcurrent);

	// Fast path: nothing waiting and a slot free. The `order.length === 0`
	// condition is what keeps FIFO — a free slot found by the sweep while tasks
	// are parked belongs to them, not to whoever arrived last.
	if (queue.order.length === 0 && queue.slots.size < cap) {
		const requestedId = run.taskId ?? registry.makeTaskId();
		queue.slots.add(requestedId);
		let dispatch: BackgroundDispatch;
		try {
			dispatch = startBackgroundSubagent({ ...run, taskId: requestedId });
		} catch (err) {
			queue.slots.delete(requestedId);
			throw err;
		}
		// add() regenerates the id on a cross-process clash. Re-key so the
		// settle-time release matches the row that actually holds the slot.
		if (dispatch.taskId !== requestedId) {
			queue.slots.delete(requestedId);
			queue.slots.add(dispatch.taskId);
		}
		return { taskId: dispatch.taskId, admission: "running", queuePosition: 0 };
	}

	// Overflow path: record the row as pending so status listings and the UI can
	// see the work, then park the payload beside it.
	const now = new Date().toISOString();
	const row: BackgroundTask = {
		id: run.taskId ?? registry.makeTaskId(),
		kind: "pi-subprocess",
		mode: "single",
		role: run.spec.role,
		label: `${run.spec.role} (queued)`,
		task: run.task,
		model: run.spec.model ?? run.parentModel,
		status: "pending",
		startedAt: now,
		lastEventAt: now,
		lastOutput: "",
		cwd: run.cwd,
	};
	registry.add(row); // stamps ownerPid, and lands the final id on `row`
	queue.parked.set(row.id, { ...run, taskId: row.id });
	queue.order.push(row.id);
	// A sweep may have just revealed a free slot (or this row may be the only
	// parked one); let it start now rather than waiting for an unrelated settle.
	drainDispatchQueue(registry, queue, cap);
	const stillParked = queue.parked.has(row.id);
	return {
		taskId: row.id,
		admission: stillParked ? "queued" : "running",
		queuePosition: stillParked ? queue.order.indexOf(row.id) + 1 : 0,
	};
}

/**
 * Free the slot a settled task held, then promote whatever is next in line.
 * Idempotent: releasing an unknown id is a no-op that still runs the drain, so
 * a double settle cannot strand the queue.
 */
export function releaseBackgroundDispatch(registry: BackgroundRegistry, taskId: string, maxConcurrent: number): void {
	const queue = dispatchQueueFor(registry);
	queue.slots.delete(taskId);
	drainDispatchQueue(registry, queue, maxConcurrent);
}

/** Task ids waiting for a slot, in the order they will be promoted. */
export function queuedTaskIds(registry: BackgroundRegistry): string[] {
	const queue = dispatchQueues.get(registry);
	return queue === undefined ? [] : [...queue.order];
}

/** Position of one queued task (1-based), or 0 when it is not waiting. */
export function queuePositionOf(registry: BackgroundRegistry, taskId: string): number {
	const index = dispatchQueues.get(registry)?.order.indexOf(taskId) ?? -1;
	return index === -1 ? 0 : index + 1;
}

/** Test helper — drop every registry's in-memory queue state. */
export function _resetBackgroundQueueForTests(): void {
	dispatchQueues = new WeakMap();
}
