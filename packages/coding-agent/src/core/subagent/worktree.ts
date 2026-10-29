/**
 * Worktree substrate — thin wrapper around the `git` CLI.
 *
 * Every public function spawns a single `git` subprocess via the Bun shell
 * helpers (no libgit2). Output is captured verbatim and returned alongside the
 * exit code.
 *
 * The caller is responsible for any retries or wrapping. Errors are surfaced
 * via { exitCode, stdout, stderr, error } — never thrown — so the experiment
 * tools can render a useful error message to the agent. `error` carries the
 * command plus stderr context whenever the command failed or its output was
 * cut short (`complete: false`). The one exception is lock contention: the
 * worktree mutations (`createWorktree`, `removeWorktree`, `pruneWorktrees`)
 * run inside `withWorktreeLock` (worktree-lock.ts, issue #1054) and propagate
 * `WorktreeLockError` when another run holds the repo lock past its wait
 * budget — contention is not a git outcome that can be rendered as repo state.
 *
 * Worktrees live under `<repo>/<worktreeBase>/<slug>` where `worktreeBase`
 * comes from `subagent.worktreeBase` (default ".worktrees"). The registry and
 * per-experiment logs stay in `.pi-experiments/` (see experiment-registry.ts).
 *
 * Not every record in `<common dir>/worktrees/` belongs to this repository: a
 * `.git` directory copied wholesale carries the source repo's registry with it
 * and neither `git worktree list` nor `git worktree prune` notices (see
 * {@link classifyRecord}). `listWorktrees()` hides those records and
 * `pruneWorktrees()` deletes them.
 *
 * File IO here is `node:fs`, not `Bun.file`: this module's integration suites
 * run under the Node-based vitest runner where `globalThis.Bun` is absent (only
 * the `Bun.$` surface is faked, via runtime.ts), and the substrate needs to be
 * the code under test rather than a Bun-hosted variant of it. Same reasoning as
 * worktree-lock.ts.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { DEFAULT_SUBAGENT_SETTINGS } from "../defaults.ts";
import { runShell } from "./shell.ts";
import { withWorktreeLock } from "./worktree-lock.ts";

export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** False when the output read was cut short (a surviving grandchild held the pipe). */
	complete?: boolean;
	/** Failure context — set whenever `exitCode` is not 0 or `complete` is false. */
	error?: string;
}

export interface WorktreeCreateResult extends GitResult {
	worktreePath: string;
	branch: string;
}

export interface WorktreeDiffResult {
	filesChanged: number;
	insertions: number;
	deletions: number;
	commits: Array<{ sha: string; subject: string }>;
	diff: string;
	raw: GitResult;
}

/**
 * Run one `git` command. Never throws: a failure is a non-zero `exitCode` plus
 * `error` carrying the command and stderr context. `complete` is false when the
 * output read was cut short (a surviving grandchild held the pipe) — the result
 * is then untrustworthy and `error` says so.
 */
async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
	const options: Parameters<typeof runShell>[2] = { cwd };
	if (signal) options.signal = signal;
	const res = await runShell("git", args, options);
	const result: GitResult = {
		exitCode: res.exitCode,
		stdout: res.stdout,
		stderr: res.stderr,
		complete: res.complete,
	};
	if (!res.complete || res.exitCode !== 0) {
		const detail = res.stderr.trim() || res.stdout.trim() || "(no output)";
		result.error = !res.complete
			? `git ${args[0] ?? ""} output was truncated before the process finished; the result is incomplete. Last output: ${detail}`
			: `git ${args.join(" ")} failed (exit ${res.exitCode}): ${detail}`;
	}
	return result;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const res = await git(["rev-parse", "--is-inside-work-tree"], cwd);
	return res.exitCode === 0 && res.stdout.trim() === "true";
}

export async function currentHead(cwd: string): Promise<string> {
	const res = await git(["rev-parse", "HEAD"], cwd);
	if (res.exitCode !== 0) {
		throw new Error(`git rev-parse HEAD failed: ${res.stderr.trim() || res.stdout.trim()}`);
	}
	return res.stdout.trim();
}

/**
 * Normalise an approach name into the `<slug>` used for the worktree directory
 * and the `exp/<slug>` branch.
 *
 * Rule: letters, digits, `.`, `_`, `-` survive; any other run of characters
 * collapses to `-`; leading/trailing `-` trimmed; lowercased. The input is
 * rejected (throws) when it is empty, `.`, or `..`, or contains a path
 * separator (`/` or `\`) — those would escape the worktree base or name
 * nothing at all — and when it normalises into a string git refuses as a
 * refname component: leading `.`, embedded `..`, trailing `.`, or trailing
 * `.lock` (the `git check-ref-format --branch` rules that survive the character
 * filter).
 */
export function sanitizeSlug(slug: string): string {
	if (slug === "" || slug === "." || slug === ".." || slug.includes("/") || slug.includes("\\")) {
		throw new Error(
			`invalid approach name ${JSON.stringify(slug)}: empty, ".", "..", and names containing "/" or "\\" are not allowed`,
		);
	}
	const cleaned = slug
		.replace(/[^a-z0-9._-]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	if (
		cleaned === "" ||
		cleaned.startsWith(".") ||
		cleaned.includes("..") ||
		cleaned.endsWith(".") ||
		cleaned.endsWith(".lock")
	) {
		throw new Error(
			`approach name ${JSON.stringify(slug)} normalises to ${JSON.stringify(cleaned)}, which git rejects as a branch name`,
		);
	}
	return cleaned;
}

/**
 * Create a worktree on a fresh `exp/<slug>` branch at `parentCommit`.
 *
 * The whole check-and-mutate body (path pre-check, branch pre-check, `git
 * worktree add`, failure cleanup) runs under the repo worktree lock, so a
 * concurrent create/remove/prune in the same repo can neither slip a
 * duplicate `exp/<slug>` branch past the pre-checks nor tear down this call's
 * admin directory mid-flight. The lock is not reentrant, which is why the
 * cleanup below uses the raw `git` helper instead of `removeWorktree`/
 * `pruneWorktrees`. Slug sanitising happens before the lock because it
 * touches no repo state. Throws `WorktreeLockError` if the lock stays held
 * past its wait budget.
 */
export async function createWorktree(
	repoRoot: string,
	approachSlug: string,
	parentCommit: string,
	worktreeBase: string = DEFAULT_SUBAGENT_SETTINGS.worktreeBase,
): Promise<WorktreeCreateResult> {
	let slug: string;
	try {
		slug = sanitizeSlug(approachSlug);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { exitCode: 1, stdout: "", stderr: message, complete: true, error: message, worktreePath: "", branch: "" };
	}
	return withWorktreeLock(repoRoot, () => createWorktreeLocked(repoRoot, slug, parentCommit, worktreeBase));
}

async function createWorktreeLocked(
	repoRoot: string,
	slug: string,
	parentCommit: string,
	worktreeBase: string,
): Promise<WorktreeCreateResult> {
	const worktreePath = resolvePath(repoRoot, worktreeBase, slug);
	const branch = `exp/${slug}`;

	if (existsSync(worktreePath)) {
		const message = `worktree path already exists: ${worktreePath}. Pick a different approach_name or run experiment_discard first.`;
		return { exitCode: 1, stdout: "", stderr: message, complete: true, error: message, worktreePath, branch };
	}

	// A stale `exp/<slug>` branch (e.g. left behind by an interrupted run) would
	// make `worktree add -b` fail after doing partial work. Fail fast instead.
	const branchCheck = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
	if (branchCheck.exitCode === 0) {
		const message = `branch ${branch} already exists. Pick a different approach_name or delete the stale branch first.`;
		return { exitCode: 1, stdout: "", stderr: message, complete: true, error: message, worktreePath, branch };
	}

	// `git worktree add -b <branch> <path> <commit>` creates the branch and the
	// worktree in one step. On failure it can leave the fresh branch (and a
	// half-created worktree) behind — e.g. "could not create leading
	// directories" fails after the branch exists — so clean up whatever this
	// call created. The branch did not exist before this call (checked above),
	// so removing both is safe.
	const res = await git(["worktree", "add", "-b", branch, worktreePath, parentCommit], repoRoot);
	if (res.exitCode !== 0) {
		await git(["worktree", "remove", "--force", worktreePath], repoRoot);
		await git(["worktree", "prune"], repoRoot);
		await git(["branch", "-D", branch], repoRoot);
	}
	return { ...res, worktreePath, branch };
}

/**
 * Remove an experiment worktree and then its `exp/<slug>` branch, where the
 * slug is the worktree directory name (see {@link createWorktree}). Deleting
 * the branch keeps slugs reusable — otherwise a later experiment with the same
 * name fails at `git worktree add -b`. The branch is only deleted when it is
 * exactly `exp/<basename>` and the worktree removal succeeded (the branch is
 * checked out in the worktree until then).
 *
 * Runs under the repo worktree lock (see `createWorktree`), so it cannot race
 * a concurrent create or prune. Throws `WorktreeLockError` on lock contention
 * timeout.
 */
export async function removeWorktree(
	repoRoot: string,
	worktreePath: string,
	force: boolean,
	deleteBranch: boolean = true,
): Promise<GitResult> {
	return withWorktreeLock(repoRoot, () => removeWorktreeLocked(repoRoot, worktreePath, force, deleteBranch));
}

/**
 * The locked-body half of {@link removeWorktree}, exported so a composite
 * mutation (see {@link discardWorktree}, REQ-I04.1) can run remove + prune +
 * branch handling inside ONE `withWorktreeLock` acquisition — this function
 * takes no lock itself (the lock is not reentrant).
 *
 * `deleteBranch` (REQ-I04.5): pass `false` to keep `exp/<slug>` after the
 * worktree is removed — `experiment_discard`'s `keep_branch` default relies on
 * it, and without the flag the branch was always deleted before the caller
 * could honour its own setting.
 */
export async function removeWorktreeLocked(
	repoRoot: string,
	worktreePath: string,
	force: boolean,
	deleteBranch: boolean = true,
): Promise<GitResult> {
	const args = ["worktree", "remove", worktreePath];
	if (force) args.push("--force");
	const res = await git(args, repoRoot);
	if (res.exitCode !== 0) return res;
	if (!deleteBranch) return res;

	const branch = `exp/${basename(worktreePath)}`;
	const branchCheck = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
	if (branchCheck.exitCode !== 0) return res;
	const deleted = await git(["branch", "-D", branch], repoRoot);
	if (deleted.exitCode !== 0) {
		return {
			...res,
			exitCode: deleted.exitCode,
			error: `worktree removed but branch ${branch} was not deleted: ${deleted.error ?? deleted.stderr.trim()}`,
		};
	}
	return res;
}

/**
 * Composite discard mutation: remove the worktree, prune stale worktree admin
 * dirs, and (when `keepBranch` is false) delete `exp/<slug>` — all inside a
 * single repo-lock acquisition, so no concurrent `createWorktree` can
 * interleave between remove and prune (REQ-I04.1).
 */
export async function discardWorktree(
	repoRoot: string,
	worktreePath: string,
	opts: { force: boolean; keepBranch: boolean },
): Promise<GitResult> {
	return withWorktreeLock(repoRoot, async () => {
		const removed = await removeWorktreeLocked(repoRoot, worktreePath, opts.force, !opts.keepBranch);
		if (removed.exitCode !== 0 || removed.complete === false) return removed;
		// Prune is best-effort: a failed prune leaves stale admin dirs behind but
		// must not turn a successful removal into a reported failure.
		await git(["worktree", "prune"], repoRoot);
		return removed;
	});
}

/**
 * Resolve `<common dir>/worktrees` for `repoRoot`, or `undefined` when the
 * common dir cannot be derived. The registry is `<common dir>/worktrees/<name>`,
 * so a copied `.git` reproduces the source repo's record names verbatim.
 */
async function worktreesRegistryDir(repoRoot: string): Promise<string | undefined> {
	const res = await git(["rev-parse", "--git-common-dir"], repoRoot);
	if (res.exitCode !== 0 || res.complete === false) return undefined;
	const out = res.stdout.trim();
	if (out === "") return undefined;
	// The output may be relative to the process cwd, so resolve against repoRoot
	// first (same as resolveWorktreeLockPath), then canonicalise.
	return join(canonicalPath(resolvePath(repoRoot, out)), "worktrees");
}

/** `realpathSync` where the path exists, plain resolution where it does not. */
function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolvePath(path);
	}
}

/**
 * Comparable form of a path: canonicalised, forward-slash separated, and
 * case-folded on Windows. The pointers being compared come from two different
 * writers (git wrote the gitfile, the filesystem resolves it), so neither the
 * separator style nor the drive-letter case is guaranteed to match.
 */
function pathKey(path: string): string {
	const normalised = canonicalPath(path).replace(/\\/g, "/");
	return process.platform === "win32" ? normalised.toLowerCase() : normalised;
}

function isInside(key: string, dirKey: string): boolean {
	return key === dirKey || key.startsWith(`${dirKey}/`);
}

/** First non-empty line of a file, or `undefined` when it is missing/not a file. */
function readPointerFile(path: string): string | undefined {
	try {
		if (!statSync(path).isFile()) return undefined;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (trimmed !== "") return trimmed;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Where a worktree's `.git` gitfile says its admin record lives, i.e. the
 * reverse pointer (`gitdir: <common dir>/worktrees/<name>`). `worktreeDir`
 * resolves a relative pointer; git writes absolute paths in practice.
 */
function reversePointerOf(worktreeDir: string): string | undefined {
	const line = readPointerFile(join(worktreeDir, ".git"));
	if (line === undefined) return undefined;
	const target = /^gitdir:[ \t]*(.+)$/.exec(line)?.[1]?.trim();
	if (!target) return undefined;
	return resolvePath(worktreeDir, target);
}

/**
 * A worktree record is only trustworthy when the pointer *back* from the
 * worktree resolves into this repository's registry directory:
 *
 *   <common dir>/worktrees/<name>/gitdir  ->  <worktree>/.git                (forward)
 *   <worktree>/.git      ->  gitdir: <common dir>/worktrees/<name>           (reverse)
 *
 * `git worktree list` reads only the forward pointer and `git worktree prune`
 * validates it by checking that the file it names exists — which it does, in
 * the *other* repository. So a record copied along with `.git` survives prune
 * forever and shows up in this repo's inventory. `foreign` is the reverse
 * pointer landing outside our registry; `unknown` means a pointer could not be
 * read (a deleted worktree, which is git's own prune case) or resolved into our
 * registry under a different name, and is never hidden or deleted.
 */
type RecordOwnership = "own" | "foreign" | "unknown";

function ownershipFromReversePointer(
	reverse: string | undefined,
	registryKey: string,
	adminPath: string | undefined,
): RecordOwnership {
	if (reverse === undefined) return "unknown";
	if (!isInside(pathKey(reverse), registryKey)) return "foreign";
	// The list side has no record name to compare against: any pointer inside
	// our registry is ours.
	if (adminPath === undefined) return "own";
	// Inside our registry but not the record we started from: only reachable via
	// a hand-edited pointer. Leave it to a human.
	return pathKey(reverse) === pathKey(adminPath) ? "own" : "unknown";
}

/** Ownership of a worktree directory as listed by `git worktree list`. */
function ownershipOfWorktreeDir(worktreeDir: string, registryKey: string): RecordOwnership {
	// The main checkout has a `.git` directory, not a gitfile: not a record.
	return ownershipFromReversePointer(reversePointerOf(worktreeDir), registryKey, undefined);
}

/** Ownership of one `<common dir>/worktrees/<name>` admin directory. */
function ownershipOfAdminRecord(adminPath: string, registryKey: string): RecordOwnership {
	const forward = readPointerFile(join(adminPath, "gitdir"));
	if (forward === undefined) return "unknown";
	// The admin `gitdir` file is a bare path (no `gitdir:` prefix) naming the
	// worktree's `.git` file, so the worktree directory is its parent.
	return ownershipFromReversePointer(reversePointerOf(dirname(forward)), registryKey, adminPath);
}

/**
 * Drop admin records whose worktree points back into a different repository.
 * Returns the record names removed. Runs inside the caller's
 * `withWorktreeLock` acquisition, so it cannot race a create.
 */
async function dropForeignRecords(repoRoot: string): Promise<string[]> {
	const registry = await worktreesRegistryDir(repoRoot);
	if (registry === undefined) return [];
	const registryKey = pathKey(registry);
	let names: string[];
	try {
		names = readdirSync(registry);
	} catch {
		return []; // no registry directory: nothing owned by anyone else
	}
	const dropped: string[] = [];
	for (const name of names) {
		const adminPath = join(registry, name);
		if (ownershipOfAdminRecord(adminPath, registryKey) !== "foreign") continue;
		try {
			rmSync(adminPath, { recursive: true, force: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[subagent-worktree] prune: could not remove record ${name} (${adminPath}): ${message}`);
			continue;
		}
		console.warn(
			`[subagent-worktree] prune: removed worktree record ${name} (gitdir points into another repository)`,
		);
		dropped.push(name);
	}
	return dropped;
}

/**
 * Drop admin data for worktrees whose directories are gone (git's own prune),
 * then drop records that belong to a *different* repository, which git cannot
 * see (see {@link RecordOwnership}). Runs under the repo worktree lock: an
 * unlocked prune could delete the admin directory of a worktree a concurrent
 * `createWorktree` is mid-flight on (throws `WorktreeLockError` on contention
 * timeout).
 */
export async function pruneWorktrees(repoRoot: string): Promise<GitResult> {
	return withWorktreeLock(repoRoot, async () => {
		const res = await git(["worktree", "prune"], repoRoot);
		const dropped = await dropForeignRecords(repoRoot);
		if (dropped.length === 0) return res;
		// git writes prune's own removals to stdout with `-v`; the foreign records
		// are not git's removals, so they go to the diagnostic channel instead.
		const note = dropped.map((name) => `prune: removed foreign worktree record ${name}`).join("\n");
		const stderr = res.stderr.trim() === "" ? `${note}\n` : `${res.stderr.trimEnd()}\n${note}\n`;
		return { ...res, stderr };
	});
}

/** One `git worktree list --porcelain` record: its lines plus the `worktree` path. */
interface WorktreeRecord {
	worktreePath: string | undefined;
	lines: string[];
}

function parsePorcelainList(text: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let current: string[] = [];
	const flush = (): void => {
		if (current.length === 0) return;
		const head = current[0] ?? "";
		records.push({
			worktreePath: head.startsWith("worktree ") ? head.slice("worktree ".length) : undefined,
			lines: current,
		});
		current = [];
	};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") flush();
		else current.push(line);
	}
	flush();
	return records;
}

function serializePorcelainList(records: WorktreeRecord[]): string {
	let out = "";
	for (const record of records) out += `${record.lines.join("\n")}\n\n`;
	return out;
}

/**
 * `git worktree list --porcelain`, minus the records that belong to another
 * repository (see {@link RecordOwnership}). A record whose reverse pointer
 * cannot be read stays, so a deleted worktree is still reported for git's own
 * prune to handle. When nothing is hidden the git output is returned verbatim.
 */
export async function listWorktrees(repoRoot: string): Promise<GitResult> {
	const res = await git(["worktree", "list", "--porcelain"], repoRoot);
	if (res.exitCode !== 0 || res.complete === false) return res;
	const registry = await worktreesRegistryDir(repoRoot);
	if (registry === undefined) return res;
	const registryKey = pathKey(registry);
	const kept: WorktreeRecord[] = [];
	let hidden = 0;
	for (const record of parsePorcelainList(res.stdout)) {
		if (record.worktreePath !== undefined && ownershipOfWorktreeDir(record.worktreePath, registryKey) === "foreign") {
			hidden += 1;
			console.warn(
				`[subagent-worktree] list: hid worktree record ${record.worktreePath} (gitdir points into another repository)`,
			);
			continue;
		}
		kept.push(record);
	}
	if (hidden === 0) return res;
	return { ...res, stdout: serializePorcelainList(kept) };
}

/**
 * Diff the experiment worktree against its parent commit. Returns stats and the
 * list of commits made on the experiment branch.
 */
export async function diffVsParent(worktreePath: string, parentCommit: string): Promise<WorktreeDiffResult> {
	// numstat: <insertions>\t<deletions>\t<path>
	const numstat = await git(["diff", "--numstat", `${parentCommit}..HEAD`], worktreePath);
	const nameOnly = await git(["diff", "--name-only", `${parentCommit}..HEAD`], worktreePath);
	const commits = await git(["log", "--reverse", "--pretty=format:%H%x09%s", `${parentCommit}..HEAD`], worktreePath);
	const fullDiff = await git(["diff", `${parentCommit}..HEAD`], worktreePath);

	const filesChanged = nameOnly.exitCode === 0 ? nameOnly.stdout.split("\n").filter(Boolean).length : 0;

	let insertions = 0;
	let deletions = 0;
	if (numstat.exitCode === 0) {
		for (const line of numstat.stdout.split("\n")) {
			const [ins, del] = line.split("\t");
			if (!ins || !del || ins === "-" || del === "-") continue;
			insertions += Number.parseInt(ins, 10) || 0;
			deletions += Number.parseInt(del, 10) || 0;
		}
	}

	const commitList: Array<{ sha: string; subject: string }> = [];
	if (commits.exitCode === 0) {
		for (const line of commits.stdout.split("\n")) {
			if (!line) continue;
			const tab = line.indexOf("\t");
			if (tab === -1) continue;
			commitList.push({ sha: line.slice(0, tab), subject: line.slice(tab + 1) });
		}
	}

	return {
		filesChanged,
		insertions,
		deletions,
		commits: commitList,
		diff: fullDiff.exitCode === 0 ? fullDiff.stdout : fullDiff.stderr,
		raw: numstat,
	};
}

/**
 * Cherry-pick a single commit from the experiment branch into the parent
 * worktree. Returns the new commit hash on success. On failure any in-progress
 * cherry-pick is aborted first (best effort) so a conflict cannot leave
 * CHERRY_PICK_HEAD and a conflicted index behind and block later git
 * operations.
 */
export async function cherryPickFromBranch(
	repoRoot: string,
	_experimentBranch: string,
	targetCommit: string,
): Promise<GitResult & { newCommit?: string }> {
	const res = await git(["cherry-pick", targetCommit], repoRoot);
	if (res.exitCode !== 0) {
		const inProgress = await git(["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], repoRoot);
		if (inProgress.exitCode === 0) {
			const abort = await git(["cherry-pick", "--abort"], repoRoot);
			if (abort.exitCode !== 0) {
				const detail = abort.stderr.trim() || abort.stdout.trim() || "(no output)";
				return {
					...res,
					error: `${res.error ?? "git cherry-pick failed"}; git cherry-pick --abort also failed (exit ${abort.exitCode}): ${detail}`,
				};
			}
		}
		return res;
	}
	const head = await git(["rev-parse", "HEAD"], repoRoot);
	return { ...res, newCommit: head.exitCode === 0 ? head.stdout.trim() : undefined };
}

/**
 * Squash all commits since parentCommit into a single new commit on the parent
 * worktree. If no commits exist, the operation is a no-op.
 */
export async function squashSinceParent(
	repoRoot: string,
	experimentBranch: string,
	parentCommit: string,
	squashMessage: string,
): Promise<GitResult & { newCommit?: string; wasNoOp?: boolean }> {
	// Count commits on the experiment branch since parentCommit.
	const log = await git(["log", "--oneline", `${parentCommit}..${experimentBranch}`], repoRoot);
	if (log.exitCode !== 0) return log;
	if (!log.stdout.trim()) {
		return { exitCode: 0, stdout: "(no commits to squash)", stderr: "", complete: true, wasNoOp: true };
	}

	// `git merge --squash` stages the experiment's changes into the main
	// worktree without auto-committing. We then commit with the supplied
	// message. This is the canonical cross-branch squash and works regardless
	// of what HEAD is.
	const merge = await git(["merge", "--squash", experimentBranch], repoRoot);
	if (merge.exitCode !== 0) return merge;

	const commit = await git(["commit", "-m", squashMessage], repoRoot);
	if (commit.exitCode !== 0) return commit;

	const head = await git(["rev-parse", "HEAD"], repoRoot);
	return {
		...commit,
		newCommit: head.exitCode === 0 ? head.stdout.trim() : undefined,
	};
}
