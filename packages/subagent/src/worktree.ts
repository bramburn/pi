/**
 * Worktree substrate — thin wrapper around the `git` CLI.
 *
 * Every public function spawns a single `git` subprocess. No libgit2.
 * Output is captured verbatim and returned alongside the exit code.
 *
 * The caller is responsible for any retries or wrapping. Errors are
 * surfaced via { exitCode, stdout, stderr } — never thrown — so the
 * extension's tools can render a useful error message to the agent.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXPERIMENTS_DIR_NAME, experimentsDir } from "./registry.ts";

export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
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

function runGit(args: string[], cwd?: string): Promise<GitResult> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, {
			cwd: cwd ?? process.cwd(),
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("error", (err) => {
			resolve({ exitCode: 127, stdout, stderr: stderr + (stderr ? "\n" : "") + err.message });
		});
		proc.on("close", (code) => {
			resolve({ exitCode: code ?? 0, stdout, stderr });
		});
	});
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const res = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
	return res.exitCode === 0 && res.stdout.trim() === "true";
}

export async function currentHead(cwd: string): Promise<string> {
	const res = await runGit(["rev-parse", "HEAD"], cwd);
	if (res.exitCode !== 0) {
		throw new Error(`git rev-parse HEAD failed: ${res.stderr.trim() || res.stdout.trim()}`);
	}
	return res.stdout.trim();
}

function sanitizeSlug(slug: string): string {
	return slug
		.replace(/[^a-z0-9._-]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

export async function createWorktree(
	repoRoot: string,
	approachSlug: string,
	parentCommit: string,
): Promise<WorktreeCreateResult> {
	const dir = experimentsDir(repoRoot);
	const slug = sanitizeSlug(approachSlug);
	const worktreePath = join(dir, slug);
	const branch = `exp/${slug}`;

	if (existsSync(worktreePath)) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: `worktree path already exists: ${worktreePath}. Pick a different approach_name or run experiment_discard first.`,
			worktreePath,
			branch,
		};
	}

	// `git worktree add -b <branch> <path> <commit>` creates the branch and the worktree in one step.
	const res = await runGit(["worktree", "add", "-b", branch, worktreePath, parentCommit], repoRoot);
	return { ...res, worktreePath, branch };
}

export async function removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<GitResult> {
	const args = ["worktree", "remove", worktreePath];
	if (force) args.push("--force");
	return runGit(args, repoRoot);
}

export async function pruneWorktrees(repoRoot: string): Promise<GitResult> {
	return runGit(["worktree", "prune"], repoRoot);
}

export async function listWorktrees(repoRoot: string): Promise<GitResult> {
	return runGit(["worktree", "list", "--porcelain"], repoRoot);
}

/**
 * Diff the experiment worktree against its parent commit. Returns stats and the
 * list of commits made on the experiment branch.
 */
export async function diffVsParent(worktreePath: string, parentCommit: string): Promise<WorktreeDiffResult> {
	// numstat: <insertions>\t<deletions>\t<path>
	const numstat = await runGit(["diff", "--numstat", `${parentCommit}..HEAD`], worktreePath);
	const nameOnly = await runGit(["diff", "--name-only", `${parentCommit}..HEAD`], worktreePath);
	const commits = await runGit(
		["log", "--reverse", "--pretty=format:%H%x09%s", `${parentCommit}..HEAD`],
		worktreePath,
	);
	const fullDiff = await runGit(["diff", `${parentCommit}..HEAD`], worktreePath);

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
		raw: { exitCode: numstat.exitCode, stdout: numstat.stdout, stderr: numstat.stderr },
	};
}

/**
 * Cherry-pick a single commit from the experiment branch into the parent worktree.
 * Returns the new commit hash on success.
 */
export async function cherryPickFromBranch(
	repoRoot: string,
	_experimentBranch: string,
	targetCommit: string,
): Promise<GitResult & { newCommit?: string }> {
	const res = await runGit(["cherry-pick", targetCommit], repoRoot);
	if (res.exitCode !== 0) return res;
	const head = await runGit(["rev-parse", "HEAD"], repoRoot);
	return { ...res, newCommit: head.exitCode === 0 ? head.stdout.trim() : undefined };
}

/**
 * Squash all commits since parentCommit into a single new commit on the parent worktree.
 * If no commits exist, the operation is a no-op.
 */
export async function squashSinceParent(
	repoRoot: string,
	experimentBranch: string,
	parentCommit: string,
	squashMessage: string,
): Promise<GitResult & { newCommit?: string; wasNoOp?: boolean }> {
	// Count commits on the experiment branch since parentCommit.
	const log = await runGit(["log", "--oneline", `${parentCommit}..${experimentBranch}`], repoRoot);
	if (log.exitCode !== 0) return log;
	if (!log.stdout.trim()) {
		return { exitCode: 0, stdout: "(no commits to squash)", stderr: "", wasNoOp: true };
	}

	// `git merge --squash` stages the experiment's changes into the main worktree
	// without auto-committing. We then commit with the supplied message. This is
	// the canonical cross-branch squash and works regardless of what HEAD is.
	const merge = await runGit(["merge", "--squash", experimentBranch], repoRoot);
	if (merge.exitCode !== 0) return merge;

	const commit = await runGit(["commit", "-m", squashMessage], repoRoot);
	if (commit.exitCode !== 0) return commit;

	const head = await runGit(["rev-parse", "HEAD"], repoRoot);
	return {
		...commit,
		newCommit: head.exitCode === 0 ? head.stdout.trim() : undefined,
	};
}

export function experimentsRootPath(repoRoot: string): string {
	return join(repoRoot, EXPERIMENTS_DIR_NAME);
}
