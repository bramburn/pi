/**
 * File control inbox for subagent runs (issue #1047).
 *
 * The management actions the parent session already has — `steer`, `interrupt`,
 * `stop` — are in-memory today: they reach a run through this process's runner
 * handle or the registry's pid, and a parent that dies mid-action leaves the
 * child with no idea the request was ever made. This module puts the same
 * requests on disk, one directory per run, so a request survives the process
 * that wrote it and a child that is watching picks it up on its own clock.
 *
 * On disk, under the run's task dir (`subagent-bg/<taskId>/`):
 *
 * control/
 * requests/<id>.json pending request, written atomically (tmp + rename)
 * applied/<id>.json the same request after a watcher claimed it (rename is
 * the claim: an exclusive move, so a request is delivered exactly once)
 * receipts.jsonl append-only ledger of state transitions per request id
 *
 * A request walks `requested` → `scheduled` → `queued` → `delivered | failed`.
 * The parent writes `requested` when it files the request and `scheduled` once
 * it has arranged the delivery it knows about (an in-process redirect, or a
 * queue slot for a task that has not started). The child watcher writes
 * `queued` when it claims the file and the terminal state after it applies the
 * operation. Nothing here waits on another process: every function is
 * synchronous, path-parameterised, and tolerant of a directory the other side
 * has not created yet.
 *
 * Steer text is byte-bounded (CONTROL_MAX_MESSAGE_BYTES) because the request
 * file is read back into a model prompt. Over-long text is truncated and the
 * truncation is recorded on the request and in its receipt, so the operator
 * learns the message arrived shortened rather than guessing.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Directory name under a run's task dir. */
export const CONTROL_DIR_NAME = "control";
/** Pending requests, one JSON file each. */
export const CONTROL_REQUESTS_DIR_NAME = "requests";
/** Claimed requests. Presence here means a watcher has taken the request. */
export const CONTROL_APPLIED_DIR_NAME = "applied";
/** Append-only receipt ledger, one JSON object per line. */
export const CONTROL_RECEIPTS_FILE = "receipts.jsonl";

export const CONTROL_VERSION = 1;

/**
 * Env var naming the control dir for a child process. The parent sets it when
 * it launches a run that should watch for file control; the child-side watcher
 * reads it. Deliberately not derived from the agent dir: a child must not have
 * to guess which task row is its own.
 */
export const CONTROL_DIR_ENV = "PI_SUBAGENT_CONTROL_DIR";

/** Upper bound on the steer text carried by one request, in UTF-8 bytes. */
export const CONTROL_MAX_MESSAGE_BYTES = 50 * 1024;

/** Requests older than this in `applied/` are collected by prune. */
export const CONTROL_APPLIED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Receipt lines kept by a prune pass. Older transitions are dropped. */
export const CONTROL_RECEIPTS_MAX_LINES = 500;

/** Control operations a watching child can apply to its own session. */
export type ControlAction = "steer" | "interrupt" | "stop";

/** Lifecycle state of one control request, as recorded in the ledger. */
export type ControlReceiptState = "requested" | "scheduled" | "queued" | "delivered" | "failed";

const CONTROL_ACTIONS: readonly ControlAction[] = ["steer", "interrupt", "stop"];
const CONTROL_STATES: readonly ControlReceiptState[] = ["requested", "scheduled", "queued", "delivered", "failed"];

/** One filed control request. */
export interface ControlRequest {
	version: number;
	/** Request id, also the file name. Unique per control dir. */
	id: string;
	action: ControlAction;
	createdAt: string;
	/** Steer instruction. Absent for `interrupt` / `stop`, which carry no text. */
	text?: string;
	/** True when `text` was shortened to fit CONTROL_MAX_MESSAGE_BYTES. */
	truncated?: boolean;
	/** Run or task this request targets, when the writer knew it. */
	targetId?: string;
	/** Process that filed the request — diagnostics only, never load-bearing. */
	pid?: number;
}

/** One state transition for a request, appended to the ledger. */
export interface ControlReceipt {
	version: number;
	/** The request this line is about. */
	id: string;
	action: ControlAction;
	state: ControlReceiptState;
	at: string;
	/** Who wrote it: `parent` files requests, `child` applies them. */
	by: "parent" | "child";
	note?: string;
}

/** A request paired with the newest state recorded for it. */
export interface ControlPendingRequest {
	request: ControlRequest;
	state: ControlReceiptState | undefined;
	/** True when the request file is still in `requests/` (not yet claimed). */
	pending: boolean;
	note?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function controlDirFor(taskDir: string): string {
	return join(taskDir, CONTROL_DIR_NAME);
}

/** Requests directory for a control dir. */
export function controlRequestsDir(dir: string): string {
	return join(dir, CONTROL_REQUESTS_DIR_NAME);
}

/** Claimed/applied directory for a control dir. */
export function controlAppliedDir(dir: string): string {
	return join(dir, CONTROL_APPLIED_DIR_NAME);
}

export function controlReceiptsPath(dir: string): string {
	return join(dir, CONTROL_RECEIPTS_FILE);
}

export function controlRequestPath(dir: string, id: string): string {
	return join(controlRequestsDir(dir), `${encodeURIComponent(id)}.json`);
}

export function controlAppliedPath(dir: string, id: string): string {
	return join(controlAppliedDir(dir), `${encodeURIComponent(id)}.json`);
}

/** The control dir named by the environment, when one is set. */
export function controlDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env[CONTROL_DIR_ENV];
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** True when this process was launched with a control dir to watch. */
export function hasControlDir(env: NodeJS.ProcessEnv = process.env): boolean {
	return controlDirFromEnv(env) !== undefined;
}

export function ensureControlDir(dir: string): void {
	mkdirSync(controlRequestsDir(dir), { recursive: true });
	mkdirSync(controlAppliedDir(dir), { recursive: true });
}

// ---------------------------------------------------------------------------
// Text bound
// ---------------------------------------------------------------------------

/**
 * Trim `text` to `maxBytes` UTF-8 bytes without splitting a code point, and
 * report whether anything was dropped. The marker is part of the returned text,
 * so the caller never has to remember to add it.
 */
export function capControlText(
	text: string,
	maxBytes: number = CONTROL_MAX_MESSAGE_BYTES,
): { text: string; truncated: boolean; droppedBytes: number } {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return { text, truncated: false, droppedBytes: 0 };
	const marker = "\n… [truncated for the control inbox]";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	// Walk code points, not UTF-16 units, so a surrogate pair is never cut in
	// half. Buffer.byteLength on the kept prefix is the authority.
	let kept = "";
	let used = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (used + size > budget) break;
		kept += char;
		used += size;
	}
	return { text: `${kept}${marker}`, truncated: true, droppedBytes: bytes - used };
}

/** Request ids are sortable and collision-free within a control dir. */
export function newControlRequestId(action: ControlAction): string {
	return `${action}_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Parsing (tolerant: a corrupt file must never break a listing)
// ---------------------------------------------------------------------------

function isControlAction(value: unknown): value is ControlAction {
	return typeof value === "string" && (CONTROL_ACTIONS as readonly string[]).includes(value);
}

function isControlState(value: unknown): value is ControlReceiptState {
	return typeof value === "string" && (CONTROL_STATES as readonly string[]).includes(value);
}

/** Undefined for anything that is not a request this build can honour. */
export function parseControlRequest(raw: string): ControlRequest | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const rec = parsed as Record<string, unknown>;
	if (rec.version !== CONTROL_VERSION) return undefined;
	if (typeof rec.id !== "string" || rec.id === "") return undefined;
	if (!isControlAction(rec.action)) return undefined;
	if (typeof rec.createdAt !== "string") return undefined;
	const request: ControlRequest = {
		version: CONTROL_VERSION,
		id: rec.id,
		action: rec.action,
		createdAt: rec.createdAt,
	};
	if (typeof rec.text === "string") request.text = rec.text;
	if (rec.truncated === true) request.truncated = true;
	if (typeof rec.targetId === "string") request.targetId = rec.targetId;
	if (typeof rec.pid === "number") request.pid = rec.pid;
	return request;
}

export function serializeControlRequest(request: ControlRequest): string {
	return `${JSON.stringify(request, null, "\t")}\n`;
}

export function parseControlReceipt(raw: string): ControlReceipt | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const rec = parsed as Record<string, unknown>;
	if (rec.version !== CONTROL_VERSION) return undefined;
	if (typeof rec.id !== "string" || rec.id === "") return undefined;
	if (!isControlAction(rec.action)) return undefined;
	if (!isControlState(rec.state)) return undefined;
	if (typeof rec.at !== "string") return undefined;
	const receipt: ControlReceipt = {
		version: CONTROL_VERSION,
		id: rec.id,
		action: rec.action,
		state: rec.state,
		at: rec.at,
		by: rec.by === "child" ? "child" : "parent",
	};
	if (typeof rec.note === "string") receipt.note = rec.note;
	return receipt;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Tolerant JSON object parse: undefined for invalid JSON, arrays, and
 * non-objects. Shared by the control inbox and the supervisor channel.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	return parsed as Record<string, unknown>;
}

/** Atomic write: temp file in the target dir, then rename over the request. */
export function writeJsonAtomically(path: string, payload: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, payload);
	renameSync(tmp, path);
}

/**
 * Append one receipt line. The ledger is append-only, so a single line is the
 * atomic unit — no lock, no rewrite. A missing or unwritable directory is not
 * a reason to lose the transition the caller just took: the append is retried
 * once after creating the tree, and a second failure is swallowed and reported
 * through the return value so the caller can decide whether it matters.
 */
export function appendControlReceipt(dir: string, receipt: ControlReceipt): boolean {
	const line = `${JSON.stringify(receipt)}\n`;
	const path = controlReceiptsPath(dir);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			appendFileSync(path, line);
			return true;
		} catch {
			try {
				mkdirSync(dir, { recursive: true });
			} catch {
				return false;
			}
		}
	}
	return false;
}

/** Record a state transition for a request. Returns the written receipt. */
export function recordControlState(
	dir: string,
	input: { id: string; action: ControlAction; state: ControlReceiptState; by: "parent" | "child"; note?: string },
): ControlReceipt {
	const receipt: ControlReceipt = {
		version: CONTROL_VERSION,
		id: input.id,
		action: input.action,
		state: input.state,
		at: new Date().toISOString(),
		by: input.by,
	};
	if (input.note !== undefined && input.note !== "") receipt.note = input.note;
	appendControlReceipt(dir, receipt);
	return receipt;
}

export interface NewControlRequestInput {
	action: ControlAction;
	/** Steer text. Ignored for `interrupt` / `stop`. */
	text?: string;
	/** Reuse a previously filed id when retrying a write that failed. */
	id?: string;
	targetId?: string;
}

export interface FiledControlRequest {
	request: ControlRequest;
	truncated: boolean;
	droppedBytes: number;
}

/**
 * File a request in the inbox and record it as `requested`.
 *
 * The text bound happens here, before the write, so an oversized steer cannot
 * reach disk. Returns the request as stored.
 */
export function writeControlRequest(dir: string, input: NewControlRequestInput): FiledControlRequest {
	const id = input.id ?? newControlRequestId(input.action);
	const request: ControlRequest = {
		version: CONTROL_VERSION,
		id,
		action: input.action,
		createdAt: new Date().toISOString(),
		pid: process.pid,
	};
	let truncated = false;
	let droppedBytes = 0;
	if (input.action === "steer") {
		const capped = capControlText(input.text ?? "");
		request.text = capped.text;
		truncated = capped.truncated;
		droppedBytes = capped.droppedBytes;
		if (capped.truncated) request.truncated = true;
	}
	if (input.targetId !== undefined) request.targetId = input.targetId;
	ensureControlDir(dir);
	writeJsonAtomically(controlRequestPath(dir, id), serializeControlRequest(request));
	recordControlState(dir, {
		id,
		action: request.action,
		state: "requested",
		by: "parent",
		...(truncated ? { note: `message truncated to ${CONTROL_MAX_MESSAGE_BYTES} bytes` } : {}),
	});
	return { request, truncated, droppedBytes };
}

/**
 * Take a pending request for delivery: an exclusive rename out of `requests/`.
 * False means the request is gone — another claimer won, or it never existed.
 */
export function claimControlRequest(dir: string, id: string): ControlRequest | undefined {
	const from = controlRequestPath(dir, id);
	let raw: string;
	try {
		raw = readFileSync(from, "utf8");
	} catch {
		return undefined;
	}
	const request = parseControlRequest(raw);
	if (request === undefined) return undefined;
	mkdirSync(controlAppliedDir(dir), { recursive: true });
	const to = controlAppliedPath(dir, id);
	try {
		renameSync(from, to);
	} catch {
		// Lost the race (or the file vanished): the winner owns delivery.
		return undefined;
	}
	writeJsonAtomically(to, serializeControlRequest(request));
	return request;
}

/** True while a request file is still waiting to be claimed. */
export function isRequestPending(dir: string, id: string): boolean {
	return existsSync(controlRequestPath(dir, id));
}

/** Drop a request the caller decided not to deliver (a failed dispatch). */
export function discardControlRequest(dir: string, id: string): boolean {
	try {
		unlinkSync(controlRequestPath(dir, id));
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listJsonFiles(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.filter((name) => name.endsWith(".json") && !name.includes(".tmp.")).sort();
}

/** Requests still pending, oldest first. Unreadable files are skipped. */
export function listControlRequests(dir: string): ControlRequest[] {
	const found: ControlRequest[] = [];
	for (const name of listJsonFiles(controlRequestsDir(dir))) {
		let request: ControlRequest | undefined;
		try {
			request = parseControlRequest(readFileSync(join(controlRequestsDir(dir), name), "utf8"));
		} catch {
			request = undefined;
		}
		if (request !== undefined) found.push(request);
	}
	return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Requests already claimed by a watcher, oldest first. */
export function listClaimedControlRequests(dir: string): ControlRequest[] {
	const found: ControlRequest[] = [];
	for (const name of listJsonFiles(controlAppliedDir(dir))) {
		let request: ControlRequest | undefined;
		try {
			request = parseControlRequest(readFileSync(join(controlAppliedDir(dir), name), "utf8"));
		} catch {
			request = undefined;
		}
		if (request !== undefined) found.push(request);
	}
	return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The whole ledger, in file order. Corrupt lines are dropped. */
export function readControlReceipts(dir: string): ControlReceipt[] {
	let raw: string;
	try {
		raw = readFileSync(controlReceiptsPath(dir), "utf8");
	} catch {
		return [];
	}
	const out: ControlReceipt[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		const receipt = parseControlReceipt(line);
		if (receipt !== undefined) out.push(receipt);
	}
	return out;
}

/** Newest recorded state per request id. */
export function controlReceiptStates(dir: string): Map<string, ControlReceipt> {
	const states = new Map<string, ControlReceipt>();
	for (const receipt of readControlReceipts(dir)) {
		const existing = states.get(receipt.id);
		// File order is write order, so the later line always wins. A ledger
		// rewritten by prune keeps that property.
		if (existing === undefined || existing.at <= receipt.at) states.set(receipt.id, receipt);
	}
	return states;
}

/**
 * Everything the parent wants to show for one run: pending requests with their
 * newest state, then already-claimed ones. Ordered oldest first.
 */
export function summarizeControlRequests(dir: string): ControlPendingRequest[] {
	const states = controlReceiptStates(dir);
	const rows: ControlPendingRequest[] = [];
	for (const request of listControlRequests(dir)) {
		const receipt = states.get(request.id);
		rows.push({
			request,
			state: receipt?.state,
			pending: true,
			...(receipt?.note === undefined ? {} : { note: receipt.note }),
		});
	}
	for (const request of listClaimedControlRequests(dir)) {
		const receipt = states.get(request.id);
		rows.push({
			request,
			state: receipt?.state,
			pending: false,
			...(receipt?.note === undefined ? {} : { note: receipt.note }),
		});
	}
	return rows;
}

/** `status` rendering for one run's inbox. Empty string when there is nothing. */
export function formatControlRequestsForStatus(dir: string): string {
	const rows = summarizeControlRequests(dir);
	if (rows.length === 0) return "";
	const lines = rows.map((row) =>
		[
			`control id=${row.request.id}`,
			`action=${row.request.action}`,
			`state=${row.state ?? "requested"}`,
			row.pending ? "awaiting child" : "claimed by child",
			row.request.truncated === true ? "truncated" : "",
			row.note === undefined ? "" : `note=${row.note}`,
			`filed=${row.request.createdAt}`,
		]
			.filter(Boolean)
			.join(" "),
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

export interface ControlPruneOptions {
	/** Applied requests older than this are deleted. Default 24h. */
	maxAgeMs?: number;
	/** Receipt lines kept when the ledger is rewritten. Default 500. */
	maxReceiptLines?: number;
	/** Clock injection for tests. */
	now?: () => number;
}

export interface ControlPruneResult {
	requestsRemoved: number;
	receiptLinesDropped: number;
}

/**
 * Collect the debris a long-lived run leaves behind: claimed request files past
 * their usefulness, and the head of a ledger that has outgrown its bound. The
 * ledger rewrite is atomic, so a reader never sees a half-truncated file.
 *
 * Pending requests are never touched — they are somebody's delivery guarantee.
 */
export function pruneControlDir(dir: string, options: ControlPruneOptions = {}): ControlPruneResult {
	const now = (options.now ?? Date.now)();
	const maxAgeMs = options.maxAgeMs ?? CONTROL_APPLIED_MAX_AGE_MS;
	const maxLines = options.maxReceiptLines ?? CONTROL_RECEIPTS_MAX_LINES;
	const result: ControlPruneResult = { requestsRemoved: 0, receiptLinesDropped: 0 };

	for (const name of listJsonFiles(controlAppliedDir(dir))) {
		const path = join(controlAppliedDir(dir), name);
		let request: ControlRequest | undefined;
		try {
			request = parseControlRequest(readFileSync(path, "utf8"));
		} catch {
			request = undefined;
		}
		// An unparseable file has no owner; a request with no readable age has
		// to be trusted to its timestamp, so a missing one is kept.
		const created = request === undefined ? undefined : Date.parse(request.createdAt);
		if (request === undefined) {
			try {
				unlinkSync(path);
				result.requestsRemoved += 1;
			} catch {
				// Leave it; a later pass or a human can deal with it.
			}
			continue;
		}
		if (created !== undefined && !Number.isNaN(created) && now - created > maxAgeMs) {
			try {
				unlinkSync(path);
				result.requestsRemoved += 1;
			} catch {
				// Raced with another collector. Fine.
			}
		}
	}

	const receipts = readControlReceipts(dir);
	if (receipts.length > maxLines) {
		const kept = receipts.slice(receipts.length - maxLines);
		result.receiptLinesDropped = receipts.length - kept.length;
		const payload = `${kept.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`;
		try {
			writeJsonAtomically(controlReceiptsPath(dir), payload);
		} catch {
			// The old ledger stays authoritative rather than being replaced by a
			// half-written one.
			result.receiptLinesDropped = 0;
		}
	}
	return result;
}
