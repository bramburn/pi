/**
 * Durable completion records for background subagent settle notifications.
 *
 * A detached subagent settles by handing the parent a `SubagentResult` and the
 * parent turns that into one model-facing notification. When the parent dies
 * between the two — or is killed while the notification sits in the next-turn
 * queue — the notification is lost even though the task's terminal state is on
 * disk. These records close that gap: the settle path writes the notification
 * to disk *before* it is delivered, claims it under the registry's token lock,
 * and deletes it only once delivery succeeded. Anything left behind is picked
 * up by the next startup.
 *
 * On disk, under the agent dir:
 *
 * subagent-bg/
 * replay/<encoded taskId>.json     one undelivered settle notification
 * failure-counters.json            consecutive-failure streaks per role
 *
 * All functions here are synchronous and path-parameterised: the claim
 * protocol runs inside `withLock`, whose callback cannot await. Callers supply
 * the background directory so this module stays free of agent-dir resolution
 * (and free of any import from `background.ts`, which imports this one).
 *
 * A record is only ever written for a task that reached a terminal state, so
 * its presence means "this settle has not been delivered yet". Delivery is
 * therefore at-most-once per claim: a fresh claim (recent `claimedAt`, live
 * `claimPid`) belongs to another process and is skipped, a stale one is
 * reclaimed. Records carry their own attempt count so a notification that keeps
 * failing to deliver is dropped instead of replayed forever.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BG_REPLAY_DIR_NAME = "replay";
export const BG_COUNTERS_FILE = "failure-counters.json";
export const COMPLETION_RECORD_VERSION = 1;
export const BG_COUNTERS_VERSION = 1;

/**
 * Cap on the output text a record carries. Matches the per-task output cap the
 * subagent tool applies to model-facing output, so a replayed notification is
 * no larger than a live one.
 */
export const MAX_RECORD_OUTPUT_CHARS = 50 * 1024;
/** Cap on the task description a record carries (prose, not payload). */
export const MAX_RECORD_TASK_CHARS = 2_000;

/** Records one startup pass will hand over. The rest wait for the next pass. */
export const REPLAY_MAX_RECORDS = 50;
/** A record delivered this many times without success is dropped. */
export const REPLAY_MAX_ATTEMPTS = 3;
/** Records older than this are collected rather than replayed. */
export const REPLAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A claim older than this is considered abandoned and can be reclaimed. */
export const COMPLETION_CLAIM_STALE_MS = 60_000;
/** Failure streaks older than this are forgotten. */
export const FAILURE_COUNTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Consecutive identical failures before the settle record escalates. */
export const FAILURE_ESCALATION_THRESHOLD = 3;

/** Terminal state a settle notification describes. */
export type CompletionStatus = "completed" | "failed" | "cancelled" | "crashed";

/** Escalation attached to a settle record when a failure streak crosses the threshold. */
export interface CompletionEscalation {
	consecutiveFailures: number;
	threshold: number;
	/** Normalized error signature the streak is keyed on. */
	signature: string;
}

/** One settle notification, persisted so it survives the process that wrote it. */
export interface CompletionRecord {
	version: number;
	taskId: string;
	role: string;
	status: CompletionStatus;
	exitCode: number;
	errorMessage?: string;
	/** Model-facing output: final output, else the best available diagnostic. */
	output: string;
	task: string;
	logPath: string;
	createdAt: string;
	/** Delivery attempts, including the live one that wrote the record. */
	attempts: number;
	/** Claim token of the in-flight delivery, if any. Cleared on reclaim. */
	claimToken?: string;
	claimedAt?: string;
	claimPid?: number;
	escalation?: CompletionEscalation;
}

/**
 * What the settle path hands the delivery callback. `token` is present only
 * when the record is durable and claimed by this process; delivery then has to
 * complete it. Without a token the notification is best-effort — the durable
 * write failed, or the caller settled outside the background registry — and
 * nothing is deleted afterwards.
 */
export interface CompletionDelivery {
	record: CompletionRecord;
	token?: string;
}

/** Outcome of one replay pass. */
export interface CompletionReplayReceipt {
	/** Claimed notifications to deliver, oldest first. */
	delivered: CompletionDelivery[];
	/** Records left on disk for a later pass (per-pass bound reached). */
	deferred: number;
	/** Records removed without delivery: corrupt, expired, or attempt-capped. */
	collected: number;
	/** Records held by another process' live claim. */
	claimsHeld: number;
}

/** One consecutive-failure streak for a role. */
export interface FailureCounterEntry {
	signature: string;
	role: string;
	count: number;
	lastTaskId: string;
	lastAt: string;
}

export interface FailureCountersFile {
	version: number;
	entries: FailureCounterEntry[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function replayDir(bgDir: string): string {
	return join(bgDir, BG_REPLAY_DIR_NAME);
}

export function countersFile(bgDir: string): string {
	return join(bgDir, BG_COUNTERS_FILE);
}

/**
 * One file per task id, percent-encoded so no id can escape the replay
 * directory through a path separator.
 */
export function recordFile(bgDir: string, taskId: string): string {
	return join(replayDir(bgDir), `${encodeURIComponent(taskId)}.json`);
}

export function recordFileExists(bgDir: string, taskId: string): boolean {
	return existsSync(recordFile(bgDir, taskId));
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Character-wise cap. Records are read back as text, so bytes == chars here. */
export function capText(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/**
 * Collapse the volatile parts of an error message — ids, hex addresses,
 * numbers — so the same failure keeps the same signature across retries.
 */
export function normalizeFailureSignature(text: string): string {
	return text
		.toLowerCase()
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
		.replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
		.replace(/\b\d+\b/g, "<num>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
}

/** Error signature a failure streak is keyed on. */
export function failureSignature(status: CompletionStatus, exitCode: number, errorMessage?: string): string {
	const text = errorMessage?.trim();
	if (text) return `err:${normalizeFailureSignature(text)}`;
	return `status:${status}:exit:${exitCode}`;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface CompletionRecordInput {
	taskId: string;
	role: string;
	status: CompletionStatus;
	exitCode: number;
	errorMessage?: string;
	output: string;
	task: string;
	logPath: string;
	escalation?: CompletionEscalation;
}

export function buildCompletionRecord(input: CompletionRecordInput): CompletionRecord {
	const record: CompletionRecord = {
		version: COMPLETION_RECORD_VERSION,
		taskId: input.taskId,
		role: input.role,
		status: input.status,
		exitCode: input.exitCode,
		output: capText(input.output, MAX_RECORD_OUTPUT_CHARS),
		task: capText(input.task, MAX_RECORD_TASK_CHARS),
		logPath: input.logPath,
		createdAt: new Date().toISOString(),
		attempts: 0,
	};
	if (input.errorMessage) record.errorMessage = capText(input.errorMessage, MAX_RECORD_OUTPUT_CHARS);
	if (input.escalation) record.escalation = input.escalation;
	return record;
}

/** Tolerant parse: a record that does not describe its own delivery is useless. */
export function parseCompletionRecord(raw: string): CompletionRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const rec = parsed as Record<string, unknown>;
	if (rec.version !== COMPLETION_RECORD_VERSION) return undefined;
	if (typeof rec.taskId !== "string" || typeof rec.role !== "string") return undefined;
	if (typeof rec.output !== "string" || typeof rec.createdAt !== "string") return undefined;
	const status = rec.status;
	if (status !== "completed" && status !== "failed" && status !== "cancelled" && status !== "crashed") {
		return undefined;
	}
	const record: CompletionRecord = {
		version: COMPLETION_RECORD_VERSION,
		taskId: rec.taskId,
		role: rec.role,
		status,
		exitCode: typeof rec.exitCode === "number" ? rec.exitCode : -1,
		output: rec.output,
		task: typeof rec.task === "string" ? rec.task : "",
		logPath: typeof rec.logPath === "string" ? rec.logPath : "",
		createdAt: rec.createdAt,
		attempts: typeof rec.attempts === "number" ? rec.attempts : 0,
	};
	if (typeof rec.errorMessage === "string") record.errorMessage = rec.errorMessage;
	if (typeof rec.claimToken === "string") record.claimToken = rec.claimToken;
	if (typeof rec.claimedAt === "string") record.claimedAt = rec.claimedAt;
	if (typeof rec.claimPid === "number") record.claimPid = rec.claimPid;
	const esc = rec.escalation;
	if (typeof esc === "object" && esc !== null) {
		const e = esc as Record<string, unknown>;
		if (
			typeof e.signature === "string" &&
			typeof e.consecutiveFailures === "number" &&
			typeof e.threshold === "number"
		) {
			record.escalation = {
				consecutiveFailures: e.consecutiveFailures,
				threshold: e.threshold,
				signature: e.signature,
			};
		}
	}
	return record;
}

export function serializeCompletionRecord(record: CompletionRecord): string {
	return `${JSON.stringify(record, null, "\t")}\n`;
}

/** Atomic write: temp file in the target dir, then rename over the record. */
export function writeRecordFile(path: string, record: CompletionRecord): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, serializeCompletionRecord(record));
	renameSync(tmp, path);
}

/** Returns undefined for a missing record and for one that cannot be parsed. */
export function readRecordFile(path: string): CompletionRecord | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	return parseCompletionRecord(raw);
}

export function deleteRecordFile(path: string): boolean {
	try {
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Record paths in the replay dir, sorted for a deterministic pass. */
export function listRecordFiles(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json") && !name.includes(".tmp."))
		.sort()
		.map((name) => join(dir, name));
}

export function isRecordStale(record: CompletionRecord, now: number, maxAgeMs: number): boolean {
	const created = Date.parse(record.createdAt);
	if (Number.isNaN(created)) return true;
	return now - created > maxAgeMs;
}

/** True when a live process is holding this record's claim. */
export function isClaimFresh(record: CompletionRecord, now: number, isPidAlive: (pid: number) => boolean): boolean {
	if (!record.claimToken) return false;
	const claimedAt = Date.parse(record.claimedAt ?? "");
	if (Number.isNaN(claimedAt) || now - claimedAt > COMPLETION_CLAIM_STALE_MS) return false;
	// A claim from a dead pid is already abandoned; do not wait out the window.
	if (typeof record.claimPid === "number" && !isPidAlive(record.claimPid)) return false;
	return true;
}

/** Stamp a new claim on a record. Mutates and returns the same object. */
export function claimRecord(record: CompletionRecord, token: string, now: number, pid: number): CompletionRecord {
	record.attempts += 1;
	record.claimToken = token;
	record.claimedAt = new Date(now).toISOString();
	record.claimPid = pid;
	return record;
}

// ---------------------------------------------------------------------------
// Failure counters
// ---------------------------------------------------------------------------

export function emptyFailureCounters(): FailureCountersFile {
	return { version: BG_COUNTERS_VERSION, entries: [] };
}

export function parseFailureCounters(raw: string): FailureCountersFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return emptyFailureCounters();
	}
	if (typeof parsed !== "object" || parsed === null) return emptyFailureCounters();
	const file = parsed as Record<string, unknown>;
	const entries = file.entries;
	if (!Array.isArray(entries)) return emptyFailureCounters();
	const out: FailureCounterEntry[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.signature !== "string" || typeof e.role !== "string") continue;
		if (typeof e.count !== "number" || typeof e.lastAt !== "string") continue;
		out.push({
			signature: e.signature,
			role: e.role,
			count: e.count,
			lastTaskId: typeof e.lastTaskId === "string" ? e.lastTaskId : "",
			lastAt: e.lastAt,
		});
	}
	return { version: BG_COUNTERS_VERSION, entries: out };
}

export function readFailureCounters(path: string): FailureCountersFile {
	try {
		return parseFailureCounters(readFileSync(path, "utf8"));
	} catch {
		return emptyFailureCounters();
	}
}

export function writeFailureCounters(path: string, file: FailureCountersFile): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`);
	renameSync(tmp, path);
}

export interface StreakInput {
	role: string;
	taskId: string;
	status: CompletionStatus;
	signature: string;
	threshold: number;
	now: number;
}

/**
 * Fold one settle into the streak table and report whether it crosses the
 * escalation threshold. Mutates `file`.
 *
 * A failure extends the role's streak when the error signature is identical,
 * and restarts it at one when the error changed — a new failure mode is not a
 * repeat of the old one. Anything that is not a failure (completed, or a task
 * the parent cancelled) clears the role's streaks, so a kill never counts
 * against the task that follows it.
 *
 * Escalation fires exactly once per streak, on the attempt that reaches the
 * threshold. Further identical failures keep counting but stay quiet until the
 * streak is broken and rebuilt, which keeps a looping failure from shouting at
 * the model on every settle.
 */
export function applySettleToStreaks(file: FailureCountersFile, input: StreakInput): CompletionEscalation | undefined {
	const failed = input.status === "failed" || input.status === "crashed";
	const cutoff = input.now - FAILURE_COUNTER_MAX_AGE_MS;
	file.entries = file.entries.filter((entry) => {
		if (entry.role !== input.role) return true;
		if (!failed) return false;
		const at = Date.parse(entry.lastAt);
		return !Number.isNaN(at) && at >= cutoff;
	});
	if (!failed) return undefined;

	const same = file.entries.find((entry) => entry.role === input.role && entry.signature === input.signature);
	if (same) {
		same.count += 1;
		same.lastTaskId = input.taskId;
		same.lastAt = new Date(input.now).toISOString();
	} else {
		// Different error (or first failure): the role's streak restarts here.
		file.entries = file.entries.filter((entry) => entry.role !== input.role);
		file.entries.push({
			signature: input.signature,
			role: input.role,
			count: 1,
			lastTaskId: input.taskId,
			lastAt: new Date(input.now).toISOString(),
		});
	}

	const current = file.entries.find((entry) => entry.role === input.role && entry.signature === input.signature);
	if (current && current.count === input.threshold) {
		return { consecutiveFailures: current.count, threshold: input.threshold, signature: current.signature };
	}
	return undefined;
}
