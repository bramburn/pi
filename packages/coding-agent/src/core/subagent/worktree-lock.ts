/**
 * Repo-scoped writer lock for the worktree substrate (issue #1054).
 *
 * Problem: `createWorktree` pre-checks (`existsSync` on the target path,
 * `show-ref` on the branch) and then mutates via `git worktree add`, while
 * `removeWorktree`/`pruneWorktrees` delete worktree admin directories. Two
 * concurrent runs in the same repo interleave those steps: both pass the
 * pre-check for the same slug, one `worktree add` fails after partial work,
 * and its failure cleanup (`worktree remove --force` + `prune`) tears down
 * what the other call just created. A create racing a prune can likewise
 * delete an in-flight worktree's admin directory.
 *
 * Fix: one exclusive lock per repository, held across the whole
 * check-and-mutate body of every worktree mutation. The lock lives at
 * `<git common dir>/pi-worktree.lock` — the common dir, not the per-worktree
 * `.git` file, so a call running from any linked worktree and a call running
 * from the main checkout contend on the same file.
 *
 * Mechanism (adapted from the registry lock in experiment-registry.ts, no
 * new dependency): exclusive create `openSync(path, "wx")` plus a JSON owner
 * record `{pid, startedAt, token}` written through the held fd. On EEXIST the
 * record is read; a dead owning pid means the holder crashed, so the lock is
 * broken (verified unlink, then one immediate retry). A record that cannot be
 * parsed carries no pid to probe, so it becomes breakable only by age
 * (CORRUPT_LOCK_STALE_MS). Otherwise the waiter retries with a small backoff
 * until the wait budget (default 10s) runs out and then throws
 * WorktreeLockError naming the holder. Release unlinks only after re-reading
 * the record and matching the per-acquisition token — a stale-break takeover
 * replaces the record, so the original holder can never delete the new owner's
 * lock.
 *
 * Deliberate divergence from experiment-registry.ts: there is no
 * age-breaks-alive-holder rule here. Registry writes are synchronous and
 * bounded; a locked worktree mutation spawns git subprocesses and a
 * `worktree add` on a cold checkout can legitimately run long. Breaking a
 * live holder's lock after a fixed age would reintroduce exactly the
 * two-writer race this lock exists to prevent. Only a provably dead pid
 * (or an ancient unparseable file) breaks it.
 *
 * Not reentrant: no locked function may call another locked function, and
 * `createWorktree`'s internal failure cleanup uses the raw `git` helper for
 * precisely that reason. All current callers (experiment-tools.ts) acquire
 * and release per tool call, never nested.
 *
 * File IO uses `node:fs` deliberately, per AGENTS.md: the lock needs
 * exclusive-create (`openSync(path, "wx")`), a write through the held fd
 * (`writeSync`), and synchronous reads/stat stamps for the staleness and
 * takeover checks. `Bun.write`/`Bun.file` provide none of those.
 *
 * The git subprocess goes through `runShell` (shell.ts) — the same execution
 * mechanism worktree.ts uses. Calling it from here rather than importing
 * worktree.ts's private helper avoids an import cycle (worktree.ts imports
 * this module); the mock seam in the tests is runtime.ts, which both paths
 * share.
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { runShell } from "./shell.ts";

/** Lock file name inside the git common directory. */
export const WORKTREE_LOCK_FILE_NAME = "pi-worktree.lock";

/** Default wait budget before a contended lock is reported as held. */
export const DEFAULT_WORKTREE_LOCK_WAIT_MS = 10_000;

const RETRY_BASE_MS = 25;
const RETRY_MAX_MS = 250;
/**
 * An unparseable lock record carries no pid to probe, so it can only be
 * judged stale by file age. Generous: a just-created lock is briefly empty
 * (openSync "wx", then writeSync), and a fresh unparseable file is far more
 * likely mid-write than abandoned.
 */
const CORRUPT_LOCK_STALE_MS = 30_000;

/** Thrown when the lock stays held past the wait budget, or the repo cannot be locked. */
export class WorktreeLockError extends Error {
	readonly lockPath: string;
	constructor(message: string, lockPath: string) {
		super(message);
		this.name = "WorktreeLockError";
		this.lockPath = lockPath;
	}
}

/**
 * Owner record inside the lock file. `token` identifies one acquisition and is
 * checked before unlinking on release, so a process can never remove a lock
 * it no longer owns (stale-break takeover by another run).
 */
interface LockRecord {
	pid: number;
	startedAt: number;
	token: string;
}

/**
 * Resolve `<git common dir>/pi-worktree.lock` for `repoRoot`.
 *
 * `git rev-parse --git-common-dir` prints the common dir of a linked worktree
 * as the main checkout's `.git` directory, which is where all worktree admin
 * data lives — locking there serialises mutations from every worktree of the
 * repo. The output may be relative to the process cwd, so it is resolved
 * against `repoRoot` (the cwd the git ran in).
 */
export async function resolveWorktreeLockPath(repoRoot: string): Promise<string> {
	const res = await runShell("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot });
	const out = res.stdout.trim();
	if (res.exitCode !== 0 || out === "" || res.complete === false) {
		const detail = res.stderr.trim() || res.stdout.trim() || "(no output)";
		throw new WorktreeLockError(
			`cannot lock worktree mutations: git rev-parse --git-common-dir failed in ${repoRoot} (exit ${res.exitCode}): ${detail}`,
			"",
		);
	}
	return join(resolvePath(repoRoot, out), WORKTREE_LOCK_FILE_NAME);
}

/**
 * Cheap cross-platform liveness probe (same shape as experiment-registry, one
 * deliberate tightening): `process.kill(pid, 0)` throws ESRCH for a dead pid
 * (libuv maps signal 0 to an OpenProcess existence check on Windows) and
 * EPERM for "alive but not ours". Only ESRCH — and a non-positive or
 * non-integer pid, which kill() can never reach — counts as dead; any other
 * error is treated as alive so an unprobeable pid never justifies breaking a
 * live holder's lock.
 */
function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRecord(text: string): LockRecord | undefined {
	try {
		const parsed = JSON.parse(text) as Record<string, unknown> | null;
		if (!parsed || typeof parsed !== "object") return undefined;
		const { pid, startedAt, token } = parsed;
		if (typeof pid !== "number" || typeof startedAt !== "number" || typeof token !== "string") return undefined;
		return { pid, startedAt, token };
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

function readSnapshot(path: string): LockSnapshot | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined; // lock is gone
	}
	let size: number;
	let mtimeMs: number;
	try {
		const st = statSync(path);
		size = st.size;
		mtimeMs = st.mtimeMs;
	} catch {
		return undefined; // vanished between read and stat
	}
	// The stamp is read after the content: if a replacement slips in between,
	// the mixed snapshot can only fail the later verification, so it fails
	// closed (same ordering argument as experiment-registry.inspectLock).
	return { text, size, mtimeMs };
}

/**
 * Unlink a stale lock, but only while the path provably still holds the exact
 * content the staleness decision was made on (text + size + mtime). Without
 * the check, competitor A's decision on lock T1 could unlink competitor C's
 * freshly acquired T2 — two writers in the critical section. The residual
 * one-syscall gap (no compare-and-swap delete on win32) is accepted and
 * documented in experiment-registry.breakLockIfUnchanged, which this mirrors.
 */
function breakLockIfUnchanged(path: string, decided: LockSnapshot): void {
	const now = readSnapshot(path);
	if (now === undefined) return;
	if (now.text !== decided.text || now.size !== decided.size || now.mtimeMs !== decided.mtimeMs) return;
	try {
		unlinkSync(path);
	} catch {
		/* already gone */
	}
}

function heldMessage(record: LockRecord | undefined, lockPath: string): string {
	const holder = record ? `pid ${record.pid} since ${new Date(record.startedAt).toISOString()}` : "unknown pid";
	return `another run is mutating worktrees in this repo (${holder}) [${lockPath}]`;
}

/**
 * Acquire the exclusive lock, waiting up to `waitMs`. Returns the
 * per-acquisition token that release() must match.
 */
async function acquireLock(lockPath: string, waitMs: number): Promise<string> {
	const deadline = Date.now() + waitMs;
	let brokeStaleLock = false;
	let delay = RETRY_BASE_MS;
	while (true) {
		const token = crypto.randomUUID();
		try {
			const fd = openSync(lockPath, "wx");
			try {
				writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }));
			} finally {
				closeSync(fd);
			}
			return token;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		// Contended: decide whether the holder is gone.
		const snapshot = readSnapshot(lockPath);
		if (snapshot === undefined) {
			// Someone just released — retry promptly, but never spin.
			if (Date.now() >= deadline) throw new WorktreeLockError(heldMessage(undefined, lockPath), lockPath);
			await sleep(delay);
			delay = Math.min(delay * 2, RETRY_MAX_MS);
			continue;
		}
		const record = parseRecord(snapshot.text);
		const stale =
			record !== undefined ? !isProcessAlive(record.pid) : Date.now() - snapshot.mtimeMs > CORRUPT_LOCK_STALE_MS;
		if (stale && !brokeStaleLock) {
			// Break at most once per acquisition, then wait for a live holder.
			brokeStaleLock = true;
			breakLockIfUnchanged(lockPath, snapshot);
			continue;
		}
		if (Date.now() >= deadline) {
			throw new WorktreeLockError(heldMessage(record, lockPath), lockPath);
		}
		await sleep(delay);
		delay = Math.min(delay * 2, RETRY_MAX_MS);
	}
}

/**
 * Release our lock — never remove one that changed hands while we held it.
 * The token is a per-acquisition crypto UUID, so a match proves the file at
 * the path is still ours; the pid check is belt-and-braces against a
 * hand-forged record.
 */
function releaseLock(lockPath: string, token: string): void {
	const snapshot = readSnapshot(lockPath);
	if (snapshot === undefined) return;
	const record = parseRecord(snapshot.text);
	if (!record || record.token !== token || record.pid !== process.pid) return;
	try {
		unlinkSync(lockPath);
	} catch {
		/* already gone */
	}
}

/**
 * Run `action` while holding the repo's worktree-mutation lock.
 *
 * A contended lock is waited on (backoff, default 10s budget via
 * `opts.waitMs`) and then throws WorktreeLockError naming the holder. A lock
 * whose recorded pid is dead is broken once and retried immediately. The lock
 * is released in a finally, including when the action throws.
 *
 * Throws (rather than returning a failure value) — unlike the git wrappers in
 * worktree.ts — because contention is not a git outcome the caller can render
 * as a repo state; it means "another run owns this repo right now".
 */
export async function withWorktreeLock<T>(
	repoRoot: string,
	action: () => Promise<T> | T,
	opts?: { waitMs?: number },
): Promise<T> {
	const lockPath = await resolveWorktreeLockPath(repoRoot);
	const token = await acquireLock(lockPath, opts?.waitMs ?? DEFAULT_WORKTREE_LOCK_WAIT_MS);
	try {
		return await action();
	} finally {
		releaseLock(lockPath, token);
	}
}
