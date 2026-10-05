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
	unlinkSync,
	writeFileSync,
	writeSync,
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
/** A lock older than this is broken even when its recorded pid is alive. */
export const BG_LOCK_STALE_MS = 30_000;
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
	 * Pid of the session process that created the task (stamped by add()).
	 * markAllRunningAsCrashed() uses it to tell orphans of a dead session apart
	 * from another live session's in-flight tasks.
	 */
	ownerPid?: number;
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
	/**
	 * Store a task row. Task ids live in a cross-process namespace, so a
	 * duplicate id is a namespace clash — not a duplicate delivery: add()
	 * assigns a fresh id on `task` in place and stores the row under it instead
	 * of silently dropping it (which let one session overwrite another's row).
	 */
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
	if (Date.now() - record.createdAt > BG_LOCK_STALE_MS) return { state: "stale", text };
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
			breakLockIfUnchanged(lockPath, inspection.text);
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
 */
function preserveCorruptRegistry(path: string): void {
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
	preserveCorruptRegistry(p);
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
			return withLock(lockPath(), () => {
				const file = readRegistry();
				const now = new Date().toISOString();
				let count = 0;
				for (const t of file.tasks) {
					if (t.status !== "running" && t.status !== "pending") continue;
					// Only orphans: a row whose owning session is alive may still
					// be mid-flight, so any session can call this at startup
					// without crashing another live session's tasks. Rows from
					// before ownerPid existed carry no owner and count as orphans.
					if (t.ownerPid !== undefined && isProcessAlive(t.ownerPid)) continue;
					t.status = "crashed";
					t.finishedAt = now;
					t.errorMessage = t.errorMessage ?? "Parent session ended before task completed";
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
			// still in flight are never dropped. This bounds registry.json growth
			// now that no startup wiring exists yet to call prune() regularly.
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
				file.tasks = file.tasks.filter((t) => !terminal(t) || keep.has(t));
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
			try {
				registry.update(taskId, {
					status: "crashed",
					errorMessage: `runner crashed: ${message}`,
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
	try {
		options.onSettled?.(taskId, result);
	} catch (err) {
		// onSettled "must not throw" — swallow a violation anyway: the task is
		// already terminal here, and letting the throw reach the outer catch
		// would rewrite its completed status to "crashed".
		console.warn(
			`[subagent-bg] onSettled callback threw for ${taskId}:`,
			err instanceof Error ? err.message : String(err),
		);
	}
	return {
		failed,
		...(failed ? { errorMessage: result.errorMessage ?? `exit code ${result.exitCode}` } : {}),
	};
}
