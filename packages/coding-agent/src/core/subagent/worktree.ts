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
 */

import { existsSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
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
export async function removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<GitResult> {
	return withWorktreeLock(repoRoot, () => removeWorktreeLocked(repoRoot, worktreePath, force));
}

async function removeWorktreeLocked(repoRoot: string, worktreePath: string, force: boolean): Promise<GitResult> {
	const args = ["worktree", "remove", worktreePath];
	if (force) args.push("--force");
	const res = await git(args, repoRoot);
	if (res.exitCode !== 0) return res;

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
 * Drop admin data for worktrees whose directories are gone. Runs under the
 * repo worktree lock: an unlocked prune could delete the admin directory of a
 * worktree a concurrent `createWorktree` is mid-flight on (throws
 * `WorktreeLockError` on contention timeout).
 */
export async function pruneWorktrees(repoRoot: string): Promise<GitResult> {
	return withWorktreeLock(repoRoot, () => git(["worktree", "prune"], repoRoot));
}

export async function listWorktrees(repoRoot: string): Promise<GitResult> {
	return git(["worktree", "list", "--porcelain"], repoRoot);
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
