/**
 * Cross-process lease over a single child session file.
 *
 * Why this exists: `steer`, `swap-model`, and `resume` each kill (or out-wait)
 * one child and dispatch a replacement that appends to the *same* JSONL session
 * file. Two writers on that file corrupt it. The in-process guards — the inline
 * run registry and the background row status — cannot see across processes, and
 * a redirect can legitimately be issued by a different pi process than the one
 * that started the run (a parent session reviving a background task's child, or
 * two sessions that adopted the same child session).
 *
 * Design, ported from the reference extension's `session-lease.js`:
 *
 * - The lease IS a directory: `<agent dir>/subagent-session-leases/<id>/`.
 *   Acquisition writes `lease.json` into a candidate directory and `renameSync`s
 *   it into place. Rename over an occupied name fails, so exactly one contender
 *   wins without a locking daemon or a pid-file race.
 * - `<id>` is sha256 of the canonicalized session path (`realpathSync.native`,
 *   case-folded on win32 where the filesystem is case-insensitive), so two
 *   spellings of one file map to one lease and a lease key never embeds a path.
 * - Breaking a lease requires *proof* the holder is gone: same hostname, the
 *   holder pid demonstrably dead (or alive but carrying a different process
 *   start identity, i.e. the pid was recycled), and — once the holder recorded
 *   the child it was writing with — that child demonstrably gone too. Anything
 *   short of proof is a conflict, never a takeover.
 * - Release is token-gated: the on-disk record must carry the token the handle
 *   was issued with, so a late release from a run that already lost its lease
 *   cannot delete a healthy one.
 *
 * File access is synchronous (`readFileSync`/`writeFileSync` beside the atomic
 * primitives), matching the sibling lock modules in this directory
 * (`background.ts`'s registry lock, `worktree-lock.ts`). Acquisition and release
 * must be atomic with respect to each other; a split sync/async lease API would
 * let two awaits interleave in exactly the way this module exists to prevent.
 *
 * Platform note: process start identity is only provable on Linux. On
 * win32/darwin it is `undefined` for foreign pids, so a lease held by a live pid
 * that happens to have been recycled reads as held and surfaces as a conflict
 * naming the holder. That is the safe direction: a false conflict costs one
 * retry, a false takeover corrupts a session.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";

/** Directory under the agent dir that holds every lease. */
export const SESSION_LEASES_DIR_NAME = "subagent-session-leases";
/** Name of the ownership record inside a lease directory. */
export const SESSION_LEASE_FILE = "lease.json";
/** Schema version of the on-disk ownership record. */
export const SESSION_LEASE_VERSION = 1;
/**
 * Bound on the stale-break loop. Each pass either wins the lease, proves the
 * holder live (conflict, throw), or renames a proven-stale lease aside; four
 * passes tolerate three simultaneous rivals without spinning.
 */
const MAX_ACQUIRE_ATTEMPTS = 4;
/** The only lease-directory basenames `releaseSessionLease` may remove. */
const LEASE_DIR_PATTERN = /^[0-9a-f]{64}$/;

export type SessionLeaseWriterState = "none" | "spawning" | "running";

/** The on-disk ownership record. */
export interface SessionLeaseOwner {
	version: 1;
	/** Random per acquisition. A release must present it to delete anything. */
	token: string;
	canonicalSessionFile: string;
	/** Run that holds the lease (the replacement dispatch). */
	runId: string;
	/** Run whose session is being revived (the redirected target). */
	sourceRunId: string;
	parentSessionId?: string;
	pid: number;
	hostname: string;
	/** Opaque start-time marker for `pid`; absent where unprovable. */
	processStartIdentity?: string;
	/** Whether the holder has a child writing the session, and what it is. */
	writerState: SessionLeaseWriterState;
	writerPid?: number;
	writerProcessStartIdentity?: string;
	acquiredAt: string;
	acquiredAtMs: number;
	updatedAtMs: number;
}

export interface AcquireSessionLeaseRequest {
	/** The child session file the lease guards. Need not exist yet. */
	sessionFile: string;
	runId: string;
	sourceRunId: string;
	parentSessionId?: string;
}

export interface SessionLeaseHandle {
	leaseDir: string;
	/** Live view of the record. Mutated in place by {@link updateWriter}. */
	owner: SessionLeaseOwner;
	/**
	 * Record the child this lease is writing with, so a later contender can
	 * prove the child is gone before breaking the lease. Throws if the lease was
	 * lost (stolen after a mis-probed liveness check, or released elsewhere).
	 */
	updateWriter(writer: { state: SessionLeaseWriterState; pid?: number }): void;
	/** Release. Returns false if the lease was already lost. */
	release(): boolean;
}

/** Injectable seams for tests. Every field defaults to the real thing. */
export interface SessionLeaseOptions {
	rootDir?: string;
	now?: () => number;
	pid?: number;
	hostname?: string;
	token?: () => string;
	/** Overrides the platform probe for the acquiring process. */
	processStartIdentity?: string;
	isProcessAlive?: (pid: number) => boolean | undefined;
	getProcessStartIdentity?: (pid: number) => string | undefined;
}

export type SessionLeaseInspection =
	| { state: "free"; canonicalSessionFile: string; canonicalSessionId: string }
	| { state: "owned"; canonicalSessionFile: string; canonicalSessionId: string; owner: SessionLeaseOwner }
	| {
			state: "unreadable";
			canonicalSessionFile: string;
			canonicalSessionId: string;
	  };

/** Thrown when a lease is held by a process that is not provably gone. */
export class SessionLeaseConflictError extends Error {
	readonly owner: SessionLeaseOwner | undefined;

	constructor(message: string, owner: SessionLeaseOwner | undefined) {
		super(message);
		this.name = "SessionLeaseConflictError";
		this.owner = owner;
	}
}

/** Resolved lazily: `PI_CODING_AGENT_DIR` can change within a process. */
export function sessionLeaseRootDir(): string {
	return join(getAgentDir(), SESSION_LEASES_DIR_NAME);
}

function hashSessionKey(canonicalSessionFile: string): string {
	const key = process.platform === "win32" ? canonicalSessionFile.toLowerCase() : canonicalSessionFile;
	return createHash("sha256").update(key).digest("hex");
}

/**
 * Absolute, symlink-resolved, native-form path for a session file.
 *
 * Falls back to the plain resolved path when the file has no realpath (it has
 * not been created yet, or its directory is gone). The lease key is still
 * canonical for that spelling.
 */
export function canonicalSessionFilePath(sessionFile: string): string {
	const resolved = resolve(sessionFile);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function canonicalSessionId(canonicalSessionFile: string): string {
	return hashSessionKey(canonicalSessionFile);
}

/** Lease directory for a session file. */
export function sessionLeaseDir(sessionFile: string, rootDir: string = sessionLeaseRootDir()): string {
	return join(rootDir, canonicalSessionId(canonicalSessionFilePath(sessionFile)));
}

function leaseFilePath(leaseDir: string): string {
	return join(leaseDir, SESSION_LEASE_FILE);
}

/** Validate an untrusted on-disk record. Anything malformed reads as unreadable. */
function parseOwner(value: unknown): SessionLeaseOwner | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const owner = value as Record<string, unknown>;
	if (
		owner.version !== SESSION_LEASE_VERSION ||
		typeof owner.token !== "string" ||
		typeof owner.canonicalSessionFile !== "string" ||
		typeof owner.runId !== "string" ||
		typeof owner.sourceRunId !== "string" ||
		typeof owner.pid !== "number" ||
		!Number.isInteger(owner.pid) ||
		owner.pid <= 0 ||
		typeof owner.hostname !== "string" ||
		(owner.writerState !== "none" && owner.writerState !== "spawning" && owner.writerState !== "running") ||
		typeof owner.acquiredAt !== "string" ||
		typeof owner.acquiredAtMs !== "number" ||
		typeof owner.updatedAtMs !== "number"
	) {
		return undefined;
	}
	if (owner.parentSessionId !== undefined && typeof owner.parentSessionId !== "string") return undefined;
	if (owner.processStartIdentity !== undefined && typeof owner.processStartIdentity !== "string") return undefined;
	if (
		owner.writerPid !== undefined &&
		(typeof owner.writerPid !== "number" || !Number.isInteger(owner.writerPid) || owner.writerPid <= 0)
	) {
		return undefined;
	}
	if (owner.writerProcessStartIdentity !== undefined && typeof owner.writerProcessStartIdentity !== "string") {
		return undefined;
	}
	// A "running" writer without a pid is unbreakable-by-proof, so it is a
	// malformed record rather than a lease; and a writer pid on a lease that
	// claims no writer would be probed for nothing.
	if (owner.writerState === "running" && owner.writerPid === undefined) return undefined;
	if (
		owner.writerState !== "running" &&
		(owner.writerPid !== undefined || owner.writerProcessStartIdentity !== undefined)
	) {
		return undefined;
	}
	return owner as unknown as SessionLeaseOwner;
}

function readLeaseOwner(leaseDir: string): SessionLeaseOwner | undefined {
	try {
		return parseOwner(JSON.parse(readFileSync(leaseFilePath(leaseDir), "utf8")) as unknown);
	} catch {
		return undefined;
	}
}

/** Current lease state for a session file, without acquiring anything. */
export function inspectSessionLease(
	sessionFile: string,
	rootDir: string = sessionLeaseRootDir(),
): SessionLeaseInspection {
	const canonicalSessionFile = canonicalSessionFilePath(sessionFile);
	const id = canonicalSessionId(canonicalSessionFile);
	const leaseDir = join(rootDir, id);
	if (!existsSync(leaseDir)) return { state: "free", canonicalSessionFile, canonicalSessionId: id };
	const owner = readLeaseOwner(leaseDir);
	return owner
		? { state: "owned", canonicalSessionFile, canonicalSessionId: id, owner }
		: { state: "unreadable", canonicalSessionFile, canonicalSessionId: id };
}

function conflictMessage(canonicalSessionFile: string, owner: SessionLeaseOwner | undefined): string {
	if (!owner) {
		return `Session file '${canonicalSessionFile}' is claimed by a lease whose record is missing or unreadable, so it cannot be verified as free. Refusing to reclaim it without proof the previous holder is gone. Remove the lease directory under ${SESSION_LEASES_DIR_NAME}/ only once you know no child is writing that session.`;
	}
	const parent = owner.parentSessionId ? `, parent session '${owner.parentSessionId}'` : "";
	return `Session file '${owner.canonicalSessionFile}' is already leased to run '${owner.runId}' (reviving '${owner.sourceRunId}'${parent}, pid ${owner.pid} on ${owner.hostname}, acquired ${owner.acquiredAt}). Wait for that redirect to finish, or dispatch a fresh run instead of resuming.`;
}

/**
 * Tri-state on purpose: `undefined` means the probe could not tell, which must
 * never justify stealing a lease. Only a definite `false` does.
 */
function processIsAlive(pid: number): boolean | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

/**
 * Start-time marker that distinguishes two processes sharing one pid.
 *
 * Linux: index 19 of the fields following the paren-delimited `comm` in
 * `/proc/<pid>/stat` — field 22, `starttime`, in clock ticks since boot. The
 * slice past the last `)` is required because `comm` may contain spaces.
 *
 * win32/darwin: no in-process API exposes a process start time without spawning
 * `ps` or WMI per dispatch. Returns `undefined`; see the platform note above.
 */
function defaultGetProcessStartIdentity(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd === -1) return undefined;
		const fields = stat
			.slice(commandEnd + 1)
			.trim()
			.split(/\s+/);
		const startTicks = fields[19];
		return startTicks ? `linux:${startTicks}` : undefined;
	} catch {
		return undefined;
	}
}

interface StaleOptions {
	hostname: string;
	isProcessAlive: (pid: number) => boolean | undefined;
	getProcessStartIdentity: (pid: number) => string | undefined;
}

function processDemonstrablyGone(pid: number, startIdentity: string | undefined, options: StaleOptions): boolean {
	const alive = options.isProcessAlive(pid);
	if (alive === false) return true;
	// Unknown liveness, or a live pid with no recorded start time: not gone.
	if (alive !== true || !startIdentity) return false;
	const current = options.getProcessStartIdentity(pid);
	return current !== undefined && current !== startIdentity;
}

function demonstrablyStale(owner: SessionLeaseOwner, options: StaleOptions): boolean {
	if (owner.hostname !== options.hostname) return false;
	if (!processDemonstrablyGone(owner.pid, owner.processStartIdentity, options)) return false;
	// The holder is gone. The child it was writing with is a separate process
	// that can outlive it, so a lease that recorded a writer is only breakable
	// once that writer is proven gone as well. "spawning" has no pid to probe
	// yet — the child may still be coming up — so it is never breakable.
	if (owner.writerState === "spawning") return false;
	if (owner.writerState === "none") return true;
	return (
		owner.writerPid !== undefined &&
		processDemonstrablyGone(owner.writerPid, owner.writerProcessStartIdentity, options)
	);
}

/**
 * Claim `leaseDir` for `owner`. Returns false only when the directory was
 * already taken; every other failure throws. The candidate directory is named
 * after the owner's token, so simultaneous rivals never collide on one temp
 * path, and it is always cleaned up.
 */
function createLeaseDirectory(leaseDir: string, owner: SessionLeaseOwner): boolean {
	const tempDir = `${leaseDir}.candidate-${owner.token}`;
	mkdirSync(join(leaseDir, ".."), { recursive: true, mode: 0o700 });
	rmSync(tempDir, { recursive: true, force: true });
	mkdirSync(tempDir, { mode: 0o700 });
	try {
		writeFileSync(leaseFilePath(tempDir), JSON.stringify(owner, null, 2), { encoding: "utf8", mode: 0o600 });
		try {
			renameSync(tempDir, leaseDir);
			return true;
		} catch (err) {
			// Rename onto an occupied directory fails with EPERM/EACCES on Windows
			// and ENOTEMPTY/EEXIST on POSIX. Either way, somebody else won.
			if (existsSync(leaseDir)) return false;
			throw err;
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function writeOwnerAtomically(leaseDir: string, owner: SessionLeaseOwner): void {
	const target = leaseFilePath(leaseDir);
	const temp = `${target}.tmp-${owner.token.replace(/[^A-Za-z0-9._-]/g, "-")}`;
	rmSync(temp, { force: true });
	writeFileSync(temp, JSON.stringify(owner, null, 2), { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(temp, target);
	} finally {
		rmSync(temp, { force: true });
	}
}

/**
 * Acquire the lease for `request.sessionFile`.
 *
 * Throws {@link SessionLeaseConflictError} when the file is held by a process
 * that is not provably gone, or when the holding record is unreadable (an
 * unreadable lease cannot be verified stale, and silently reclaiming it is how
 * two writers end up on one file).
 */
export function acquireSessionLease(
	request: AcquireSessionLeaseRequest,
	options: SessionLeaseOptions = {},
): SessionLeaseHandle {
	const canonicalSessionFile = canonicalSessionFilePath(request.sessionFile);
	const rootDir = options.rootDir ?? sessionLeaseRootDir();
	const leaseDir = join(rootDir, canonicalSessionId(canonicalSessionFile));
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const host = options.hostname ?? osHostname();
	const getIdentity = options.getProcessStartIdentity ?? defaultGetProcessStartIdentity;
	// A start epoch derived from uptime is unique enough for our own process
	// (whose pid is live and therefore unrecyclable while we hold it) and is
	// never attributed to a foreign pid.
	const processStartIdentity =
		options.processStartIdentity ??
		getIdentity(pid) ??
		(pid === process.pid ? `runtime:${Math.round(Date.now() - process.uptime() * 1000)}` : undefined);
	const acquiredAtMs = now();
	const owner: SessionLeaseOwner = {
		version: SESSION_LEASE_VERSION,
		token: options.token?.() ?? crypto.randomUUID(),
		canonicalSessionFile,
		runId: request.runId,
		sourceRunId: request.sourceRunId,
		...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
		pid,
		hostname: host,
		...(processStartIdentity === undefined ? {} : { processStartIdentity }),
		writerState: "none",
		acquiredAt: new Date(acquiredAtMs).toISOString(),
		acquiredAtMs,
		updatedAtMs: acquiredAtMs,
	};
	const staleOptions: StaleOptions = {
		hostname: host,
		isProcessAlive: options.isProcessAlive ?? processIsAlive,
		getProcessStartIdentity: getIdentity,
	};

	for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
		if (createLeaseDirectory(leaseDir, owner)) {
			return makeHandle(leaseDir, owner, getIdentity, now);
		}
		const existing = readLeaseOwner(leaseDir);
		if (!existing || !demonstrablyStale(existing, staleOptions)) {
			throw new SessionLeaseConflictError(conflictMessage(canonicalSessionFile, existing), existing);
		}
		// The tombstone is named after the stale token and retained: every rival
		// that observed this stale lease targets the same occupied destination, so
		// only the first can rename it, and a later rival cannot mistake a
		// successor's fresh lease for the corpse it came to collect.
		const tombstone = `${leaseDir}.stale-${existing.token.replace(/[^A-Za-z0-9._-]/g, "-")}`;
		try {
			renameSync(leaseDir, tombstone);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || existsSync(tombstone)) continue;
			throw err;
		}
	}

	const remaining = readLeaseOwner(leaseDir);
	throw new SessionLeaseConflictError(conflictMessage(canonicalSessionFile, remaining), remaining);
}

function makeHandle(
	leaseDir: string,
	owner: SessionLeaseOwner,
	getIdentity: (pid: number) => string | undefined,
	now: () => number,
): SessionLeaseHandle {
	const issuedToken = owner.token;
	const handle: SessionLeaseHandle = {
		leaseDir,
		owner,
		updateWriter(writer) {
			const current = readLeaseOwner(leaseDir);
			if (!current || current.token !== issuedToken) {
				throw new Error(
					`Session lease for run '${owner.runId}' was lost (stolen or released) before its writer was recorded. Not writing through a lease we may no longer own.`,
				);
			}
			const writerIdentity =
				writer.state === "running" && writer.pid !== undefined ? getIdentity(writer.pid) : undefined;
			const next: SessionLeaseOwner = { ...owner, writerState: writer.state, updatedAtMs: now() };
			// Spread copies a stale writer from the mutated `owner`; clear both
			// before re-adding only what the new state permits.
			delete next.writerPid;
			delete next.writerProcessStartIdentity;
			if (writer.state === "running" && writer.pid !== undefined) {
				next.writerPid = writer.pid;
				if (writerIdentity !== undefined) next.writerProcessStartIdentity = writerIdentity;
			}
			writeOwnerAtomically(leaseDir, next);
			delete owner.writerPid;
			delete owner.writerProcessStartIdentity;
			Object.assign(owner, next);
		},
		release: () => releaseSessionLease(handle),
	};
	return handle;
}

/**
 * Release a lease. Deletes the lease directory only when the record on disk
 * still carries this handle's token, so a run that already lost its lease
 * cannot wipe a healthy successor's. Returns whether the directory is gone.
 */
export function releaseSessionLease(handle: SessionLeaseHandle): boolean {
	// Belt-and-braces: a lease dir is always a sha256 hex name under our own
	// root. Refuse to `rm` anything else rather than trust the handle.
	const base = handle.leaseDir.split(/[\\/]/).pop() ?? "";
	if (!LEASE_DIR_PATTERN.test(base)) return false;
	const current = readLeaseOwner(handle.leaseDir);
	if (!current || current.token !== handle.owner.token) return false;
	rmSync(handle.leaseDir, { recursive: true, force: true });
	return !existsSync(handle.leaseDir);
}
