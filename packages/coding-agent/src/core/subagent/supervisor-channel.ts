/**
 * Supervisor channel (issue #1048, Stage 3): a child asking its parent a
 * question and getting an answer.
 *
 * The control inbox (`control.ts`) is push — the parent tells the child to do
 * something. This is pull: a child running headless in a detached process hits a
 * decision it should not guess at, and asks. There is no socket between the two
 * processes and no reason to add one: the child already shares a filesystem with
 * its parent, and a question that must survive either side crashing is a question
 * worth having on disk anyway.
 *
 * Layout, under `<taskDir>/supervisor/`:
 *   requests/<id>.json   a question the child posted (one file each)
 *   replies/<id>.json    the parent's answer, keyed by the request id
 *
 * A request with no reply file is *open*. Openness is derived from the two
 * directories rather than stored on the request, so a reply can never disagree
 * with its request about whether an answer exists: whichever side wrote last,
 * the pair is consistent on the next listing.
 *
 * Durability is the whole point, so an unanswered question is not lost when the
 * child exits — the settlement path raises whatever is still open, and a parent
 * that crashed mid-run sees the same list on disk when it comes back.
 *
 * Every function takes the directory as an explicit parameter. Nothing here
 * reads `process.env` except the two `*FromEnv` helpers, so tests point it at a
 * temp path and production passes the value the runner put in the child's
 * environment.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CONTROL_MAX_MESSAGE_BYTES, capControlText, parseJsonObject, writeJsonAtomically } from "./control.ts";

export const SUPERVISOR_DIR_NAME = "supervisor";
export const SUPERVISOR_REQUESTS_DIR_NAME = "requests";
export const SUPERVISOR_REPLIES_DIR_NAME = "replies";
export const SUPERVISOR_VERSION = 1;
/** Environment variable naming this run's supervisor dir for the child. */
export const SUPERVISOR_DIR_ENV = "PI_SUBAGENT_SUPERVISOR_DIR";

/** A question or answer longer than this is not going to be read carefully. */
export const SUPERVISOR_MAX_MESSAGE_BYTES = CONTROL_MAX_MESSAGE_BYTES;
/** Context is supporting material, so it gets a tighter bound. */
export const SUPERVISOR_MAX_CONTEXT_BYTES = 8 * 1024;

/** Default wait for an answer inside `contact_supervisor`. */
export const SUPERVISOR_DEFAULT_TIMEOUT_MS = 60_000;
/** Upper bound on a single wait — past this, ask again later rather than stall. */
export const SUPERVISOR_MAX_TIMEOUT_MS = 5 * 60_000;
export const SUPERVISOR_POLL_INTERVAL_MS = 500;

/** How many open requests a status or settlement line shows before collapsing. */
export const SUPERVISOR_MAX_LISTED = 3;

/** Answered pairs older than this are collected; open questions never are. */
export const SUPERVISOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface SupervisorRequest {
	version: number;
	id: string;
	question: string;
	/** Supporting detail: what was tried, what the options are. */
	context?: string;
	truncated?: boolean;
	createdAt: string;
	/** Task or run id the child knows itself by, for diagnostics. */
	targetId?: string;
	/** Writing process id. */
	pid?: number;
}

export interface SupervisorReply {
	version: number;
	requestId: string;
	answer: string;
	truncated?: boolean;
	createdAt: string;
}

export interface SupervisorRequestState {
	request: SupervisorRequest;
	/** True while no reply file exists for the request id. */
	open: boolean;
	reply?: SupervisorReply;
}

// ============================================================================
// Paths
// ============================================================================

export function supervisorDirFor(taskDir: string): string {
	return join(taskDir, SUPERVISOR_DIR_NAME);
}

export function supervisorRequestsDir(dir: string): string {
	return join(dir, SUPERVISOR_REQUESTS_DIR_NAME);
}

export function supervisorRepliesDir(dir: string): string {
	return join(dir, SUPERVISOR_REPLIES_DIR_NAME);
}

export function supervisorRequestPath(dir: string, id: string): string {
	return join(supervisorRequestsDir(dir), `${encodeURIComponent(id)}.json`);
}

export function supervisorReplyPath(dir: string, id: string): string {
	return join(supervisorRepliesDir(dir), `${encodeURIComponent(id)}.json`);
}

/** Create the two subdirectories. Idempotent. */
export function ensureSupervisorDir(dir: string): void {
	mkdirSync(supervisorRequestsDir(dir), { recursive: true });
	mkdirSync(supervisorRepliesDir(dir), { recursive: true });
}

/** Supervisor dir named by the environment, if any. */
export function supervisorDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env[SUPERVISOR_DIR_ENV];
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

export function hasSupervisorDir(env: NodeJS.ProcessEnv = process.env): boolean {
	return supervisorDirFromEnv(env) !== undefined;
}

/** Request ids sort chronologically by their timestamp prefix. */
export function newSupervisorRequestId(): string {
	return `sup_${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

// ============================================================================
// Parsing
// ============================================================================

function preview(text: string, maxChars: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars)}…`;
}

export function parseSupervisorRequest(raw: string): SupervisorRequest | undefined {
	const parsed = parseJsonObject(raw);
	if (!parsed || parsed.version !== SUPERVISOR_VERSION) return undefined;
	const { id, question, createdAt } = parsed;
	if (typeof id !== "string" || id === "") return undefined;
	if (typeof question !== "string" || question === "") return undefined;
	if (typeof createdAt !== "string" || createdAt === "") return undefined;
	const request: SupervisorRequest = {
		version: SUPERVISOR_VERSION,
		id,
		question,
		...(typeof parsed.context === "string" && parsed.context !== "" ? { context: parsed.context } : {}),
		...(parsed.truncated === true ? { truncated: true } : {}),
		createdAt,
		...(typeof parsed.targetId === "string" && parsed.targetId !== "" ? { targetId: parsed.targetId } : {}),
		...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
	};
	return request;
}

export function serializeSupervisorRequest(request: SupervisorRequest): string {
	return `${JSON.stringify(request, undefined, 2)}\n`;
}

export function parseSupervisorReply(raw: string): SupervisorReply | undefined {
	const parsed = parseJsonObject(raw);
	if (!parsed || parsed.version !== SUPERVISOR_VERSION) return undefined;
	const { requestId, answer, createdAt } = parsed;
	if (typeof requestId !== "string" || requestId === "") return undefined;
	if (typeof answer !== "string") return undefined;
	if (typeof createdAt !== "string" || createdAt === "") return undefined;
	return {
		version: SUPERVISOR_VERSION,
		requestId,
		answer,
		...(parsed.truncated === true ? { truncated: true } : {}),
		createdAt,
	};
}

// ============================================================================
// Writes
// ============================================================================

/** Post a question. Returns the stored request and whether either field was cut. */
export function postSupervisorRequest(
	dir: string,
	input: { question: string; context?: string; id?: string; targetId?: string },
): { request: SupervisorRequest; truncated: boolean } {
	const question = capControlText(input.question ?? "", SUPERVISOR_MAX_MESSAGE_BYTES);
	const context =
		input.context === undefined || input.context === ""
			? undefined
			: capControlText(input.context, SUPERVISOR_MAX_CONTEXT_BYTES);
	const truncated = question.truncated || (context?.truncated ?? false);
	const request: SupervisorRequest = {
		version: SUPERVISOR_VERSION,
		id: input.id ?? newSupervisorRequestId(),
		question: question.text,
		...(context === undefined ? {} : { context: context.text }),
		...(truncated ? { truncated: true } : {}),
		createdAt: new Date().toISOString(),
		...(input.targetId === undefined || input.targetId === "" ? {} : { targetId: input.targetId }),
		pid: process.pid,
	};
	writeJsonAtomically(supervisorRequestPath(dir, request.id), serializeSupervisorRequest(request));
	return { request, truncated };
}

/**
 * Answer a request. Returns undefined when the question is not there — replying
 * to an id that never existed (or that pruning has since collected) is a mistake
 * the caller should hear about, not a reply silently written to a file no one
 * will ever read.
 */
export function writeSupervisorReply(dir: string, requestId: string, answer: string): SupervisorReply | undefined {
	if (!readSupervisorRequest(dir, requestId)) return undefined;
	const capped = capControlText(answer ?? "", SUPERVISOR_MAX_MESSAGE_BYTES);
	const reply: SupervisorReply = {
		version: SUPERVISOR_VERSION,
		requestId,
		answer: capped.text,
		...(capped.truncated ? { truncated: true } : {}),
		createdAt: new Date().toISOString(),
	};
	writeJsonAtomically(supervisorReplyPath(dir, requestId), JSON.stringify(reply, undefined, 2));
	return reply;
}

// ============================================================================
// Reads
// ============================================================================

function readTextSafe(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function jsonFileNames(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.filter((name) => name.endsWith(".json") && !name.includes(".tmp.")).sort();
}

/** Read one request by id. */
export function readSupervisorRequest(dir: string, id: string): SupervisorRequest | undefined {
	const raw = readTextSafe(supervisorRequestPath(dir, id));
	return raw === undefined ? undefined : parseSupervisorRequest(raw);
}

export function readSupervisorReply(dir: string, requestId: string): SupervisorReply | undefined {
	const raw = readTextSafe(supervisorReplyPath(dir, requestId));
	return raw === undefined ? undefined : parseSupervisorReply(raw);
}

/** All requests, oldest first. Corrupt files are skipped. */
export function listSupervisorRequests(dir: string): SupervisorRequest[] {
	const found: SupervisorRequest[] = [];
	for (const name of jsonFileNames(supervisorRequestsDir(dir))) {
		const request = parseSupervisorRequest(readTextSafe(join(supervisorRequestsDir(dir), name)) ?? "");
		if (request) found.push(request);
	}
	return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Every request paired with its answer, oldest first. */
export function listSupervisorRequestStates(dir: string): SupervisorRequestState[] {
	return listSupervisorRequests(dir).map((request) => {
		const reply = readSupervisorReply(dir, request.id);
		return { request, open: reply === undefined, ...(reply === undefined ? {} : { reply }) };
	});
}

/** Questions still waiting for an answer, oldest first. */
export function listOpenSupervisorRequests(dir: string): SupervisorRequest[] {
	return listSupervisorRequestStates(dir)
		.filter((entry) => entry.open)
		.map((entry) => entry.request);
}

export function countOpenSupervisorRequests(dir: string): number {
	return listOpenSupervisorRequests(dir).length;
}

/**
 * Wait for an answer to appear. Resolves with the reply, or undefined when the
 * deadline passes or the signal aborts — an unanswered question stays open on
 * disk either way, so a timeout is not a failure.
 */
export async function waitForSupervisorReply(
	dir: string,
	requestId: string,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		signal?: AbortSignal;
		sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	} = {},
): Promise<SupervisorReply | undefined> {
	const timeoutMs = clampTimeout(options.timeoutMs ?? SUPERVISOR_DEFAULT_TIMEOUT_MS);
	const intervalMs = Math.max(1, options.intervalMs ?? SUPERVISOR_POLL_INTERVAL_MS);
	const sleep = options.sleep ?? abortableSleep;

	// Answered before we started waiting, or by another poller: no wait at all.
	const existing = readSupervisorReply(dir, requestId);
	if (existing) return existing;

	let elapsed = 0;
	while (elapsed < timeoutMs) {
		if (options.signal?.aborted) return undefined;
		const step = Math.min(intervalMs, timeoutMs - elapsed);
		await sleep(step, options.signal);
		const reply = readSupervisorReply(dir, requestId);
		if (reply) return reply;
		if (options.signal?.aborted) return undefined;
		elapsed += step;
	}
	return readSupervisorReply(dir, requestId);
}

function clampTimeout(ms: number): number {
	if (!Number.isFinite(ms) || ms <= 0) return SUPERVISOR_DEFAULT_TIMEOUT_MS;
	return Math.min(Math.floor(ms), SUPERVISOR_MAX_TIMEOUT_MS);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ============================================================================
// Status formatting
// ============================================================================

/**
 * Lines describing open questions, for `status` output and for the settlement
 * notification. Collapses to a count past SUPERVISOR_MAX_LISTED so a child that
 * asked forty questions cannot flood the parent's context. Empty string when
 * there is nothing to raise.
 */
export function formatOpenSupervisorRequests(dir: string): string {
	const open = listOpenSupervisorRequests(dir);
	if (open.length === 0) return "";
	const listed = open.slice(0, SUPERVISOR_MAX_LISTED);
	const lines = listed.map(
		(request) =>
			`unanswered question from child: id=${request.id} asked=${request.createdAt} ` +
			`q="${preview(request.question, 160)}"`,
	);
	if (open.length > listed.length) {
		lines.push(`+${open.length - listed.length} more unanswered question(s) under ${dir}`);
	}
	return lines.join("\n");
}

/** One-line summary, for where a count is wanted rather than the questions. */
export function summarizeOpenSupervisorRequests(dir: string): string {
	const open = listOpenSupervisorRequests(dir);
	if (open.length === 0) return "";
	const first = open[0];
	return `${open.length} unanswered question(s), e.g. id=${first.id} "${preview(first.question, 80)}"`;
}

// ============================================================================
// Pruning
// ============================================================================

export interface SupervisorPruneResult {
	requestsRemoved: number;
	repliesRemoved: number;
}

/**
 * Collect answered question/answer pairs past their age bound. Open questions
 * are never removed — they are the durable record of something the parent still
 * owes, and dropping one would silently lose what post-crash replay raises.
 */
export function pruneSupervisorDir(
	dir: string,
	options: { maxAgeMs?: number; now?: () => number } = {},
): SupervisorPruneResult {
	const maxAgeMs = options.maxAgeMs ?? SUPERVISOR_MAX_AGE_MS;
	const now = options.now?.() ?? Date.now();
	let requestsRemoved = 0;
	let repliesRemoved = 0;
	if (!existsSync(dir)) return { requestsRemoved, repliesRemoved };

	for (const entry of listSupervisorRequestStates(dir)) {
		// Only pairs with both halves present are collectable, and only once the
		// answer itself is old enough that nobody is still polling for it.
		if (entry.open || !entry.reply) continue;
		const answerAge = now - Date.parse(entry.reply.createdAt);
		const questionAge = now - Date.parse(entry.request.createdAt);
		if (!Number.isFinite(answerAge) || !Number.isFinite(questionAge)) continue;
		if (answerAge <= maxAgeMs || questionAge <= maxAgeMs) continue;
		try {
			unlinkSync(supervisorRequestPath(dir, entry.request.id));
			requestsRemoved += 1;
		} catch {
			// A concurrent prune got there first.
		}
	}

	for (const name of jsonFileNames(supervisorRepliesDir(dir))) {
		const path = join(supervisorRepliesDir(dir), name);
		const reply = parseSupervisorReply(readTextSafe(path) ?? "");
		if (!reply) {
			// Unparseable: nothing can be waiting on it.
			try {
				unlinkSync(path);
				repliesRemoved += 1;
			} catch {
				/* ignore */
			}
			continue;
		}
		const age = now - Date.parse(reply.createdAt);
		if (!Number.isFinite(age) || age <= maxAgeMs) continue;
		// Keep a reply whose question is still on disk: the pair is pruned
		// together or not at all.
		if (readSupervisorRequest(dir, reply.requestId)) continue;
		try {
			unlinkSync(path);
			repliesRemoved += 1;
		} catch {
			/* ignore */
		}
	}
	return { requestsRemoved, repliesRemoved };
}
