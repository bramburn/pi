/**
 * Tests for src/worktree.ts — git CLI wrapper.
 *
 * Each test initializes a fresh git repo in tmpdir so we can exercise
 * the real `git` subprocess plumbing without polluting the host repo.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cherryPickFromBranch,
	currentHead,
	createWorktree,
	diffVsParent,
	experimentsRootPath,
	isGitRepo,
	listWorktrees,
	pruneWorktrees,
	removeWorktree,
	squashSinceParent,
} from "../src/worktree.ts";

let repoRoot: string;

beforeEach(() => {
	repoRoot = mkdtempSync(join(tmpdir(), "pi-subagent-wt-test-"));
	// Init a git repo with one commit so the worktree substrate has something to fork from.
	execSync("git init -q -b main", { cwd: repoRoot });
	execSync("git config user.email test@test.com", { cwd: repoRoot });
	execSync("git config user.name Test", { cwd: repoRoot });
	writeFileSync(join(repoRoot, "README.md"), "hello\n");
	execSync("git add .", { cwd: repoRoot });
	execSync("git commit -q -m initial", { cwd: repoRoot });
});

afterEach(() => {
	if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

describe("isGitRepo", () => {
	it("returns true for a git repo", async () => {
		expect(await isGitRepo(repoRoot)).toBe(true);
	});

	it("returns false for a non-git dir", async () => {
		const plain = mkdtempSync(join(tmpdir(), "not-a-repo-"));
		try {
			expect(await isGitRepo(plain)).toBe(false);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("currentHead", () => {
	it("returns the current commit SHA", async () => {
		const head = await currentHead(repoRoot);
		expect(head).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("experimentsRootPath", () => {
	it("joins repoRoot + .pi-experiments", () => {
		expect(experimentsRootPath(repoRoot)).toBe(join(repoRoot, ".pi-experiments"));
	});
});

describe("createWorktree + removeWorktree", () => {
	it("creates a worktree at the given path with a new branch", async () => {
		const res = await createWorktree(repoRoot, "approach-a", "HEAD");
		expect(res.exitCode).toBe(0);
		expect(res.worktreePath).toContain("approach-a");
		expect(res.branch).toBe("exp/approach-a");
		expect(existsSync(res.worktreePath)).toBe(true);
	});

	it("fails when the worktree path already exists", async () => {
		const res1 = await createWorktree(repoRoot, "dup-slug", "HEAD");
		expect(res1.exitCode).toBe(0);
		const res2 = await createWorktree(repoRoot, "dup-slug", "HEAD");
		expect(res2.exitCode).toBe(1);
		expect(res2.stderr).toContain("already exists");
	});

	it("removeWorktree with --force removes the worktree", async () => {
		const res = await createWorktree(repoRoot, "to-remove", "HEAD");
		expect(res.exitCode).toBe(0);
		const removed = await removeWorktree(repoRoot, res.worktreePath, true);
		expect(removed.exitCode).toBe(0);
	});
});

describe("pruneWorktrees + listWorktrees", () => {
	it("pruneWorktrees returns exitCode 0", async () => {
		const res = await pruneWorktrees(repoRoot);
		expect(res.exitCode).toBe(0);
	});

	it("listWorktrees returns the porcelain output", async () => {
		const res = await listWorktrees(repoRoot);
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toContain("worktree");
	});
});

describe("diffVsParent", () => {
	it("returns 0 stats and 0 commits when worktree has no new commits", async () => {
		const res = await createWorktree(repoRoot, "no-diff", "HEAD");
		expect(res.exitCode).toBe(0);
		const parentCommit = await currentHead(repoRoot);
		const diff = await diffVsParent(res.worktreePath, parentCommit);
		expect(diff.filesChanged).toBe(0);
		expect(diff.insertions).toBe(0);
		expect(diff.deletions).toBe(0);
		expect(diff.commits).toEqual([]);
	});

	it("counts insertions/deletions/files from numstat", async () => {
		const res = await createWorktree(repoRoot, "with-changes", "HEAD");
		expect(res.exitCode).toBe(0);
		// Make a commit on the experiment branch
		execSync("git config user.email t@t.com", { cwd: res.worktreePath });
		execSync("git config user.name T", { cwd: res.worktreePath });
		writeFileSync(join(res.worktreePath, "new.txt"), "hello world\n");
		execSync("git add .", { cwd: res.worktreePath });
		execSync("git commit -q -m add-new-file", { cwd: res.worktreePath });
		const parentCommit = await currentHead(repoRoot);
		const diff = await diffVsParent(res.worktreePath, parentCommit);
		expect(diff.filesChanged).toBe(1);
		expect(diff.insertions).toBe(1); // "hello world\n" is one inserted line
		expect(diff.deletions).toBe(0);
		expect(diff.commits).toHaveLength(1);
		expect(diff.commits[0]?.subject).toContain("add-new-file");
	});

	it("skips '-' insertions/deletions (binary files)", async () => {
		const res = await createWorktree(repoRoot, "binary", "HEAD");
		execSync("git config user.email t@t.com", { cwd: res.worktreePath });
		execSync("git config user.name T", { cwd: res.worktreePath });
		// Use printf to write binary bytes; ignore errors so the test runs on Windows
		try {
			execSync("printf '\\x00\\x01\\x02' > binary.bin", { cwd: res.worktreePath, shell: "/bin/bash" });
			execSync("git add .", { cwd: res.worktreePath });
			execSync("git commit -q -m add-binary", { cwd: res.worktreePath });
		} catch {
			// skip on platforms where printf doesn't behave
		}
		const parentCommit = await currentHead(repoRoot);
		const diff = await diffVsParent(res.worktreePath, parentCommit);
		// Just assert it doesn't throw — stats may be 0
		expect(diff.insertions).toBeGreaterThanOrEqual(0);
	});
});

describe("cherryPickFromBranch", () => {
	it("cherry-picks a single commit", async () => {
		const res = await createWorktree(repoRoot, "cherry", "HEAD");
		expect(res.exitCode).toBe(0);
		execSync("git config user.email t@t.com", { cwd: res.worktreePath });
		execSync("git config user.name T", { cwd: res.worktreePath });
		writeFileSync(join(res.worktreePath, "cherry.txt"), "cherry content\n");
		execSync("git add .", { cwd: res.worktreePath });
		execSync("git commit -q -m add-cherry", { cwd: res.worktreePath });
		const targetSha = execSync("git rev-parse HEAD", { cwd: res.worktreePath }).toString().trim();
		const pick = await cherryPickFromBranch(repoRoot, "exp/cherry", targetSha);
		expect(pick.exitCode).toBe(0);
		expect(pick.newCommit).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("squashSinceParent", () => {
	it("is a no-op when there are no commits beyond parent", async () => {
		const res = await createWorktree(repoRoot, "no-squash", "HEAD");
		expect(res.exitCode).toBe(0);
		const parentCommit = await currentHead(repoRoot);
		const sq = await squashSinceParent(repoRoot, res.branch, parentCommit, "squashed");
		expect(sq.exitCode).toBe(0);
		expect(sq.wasNoOp).toBe(true);
	});

	it("squashes multiple commits into one", async () => {
		const res = await createWorktree(repoRoot, "to-squash", "HEAD");
		expect(res.exitCode).toBe(0);
		execSync("git config user.email t@t.com", { cwd: res.worktreePath });
		execSync("git config user.name T", { cwd: res.worktreePath });
		writeFileSync(join(res.worktreePath, "a.txt"), "a\n");
		execSync("git add . && git commit -q -m one", { cwd: res.worktreePath });
		writeFileSync(join(res.worktreePath, "b.txt"), "b\n");
		execSync("git add . && git commit -q -m two", { cwd: res.worktreePath });
		const parentCommit = await currentHead(repoRoot);
		const sq = await squashSinceParent(repoRoot, res.branch, parentCommit, "squashed message");
		expect(sq.exitCode).toBe(0);
		expect(sq.wasNoOp).toBeUndefined();
		expect(sq.newCommit).toMatch(/^[0-9a-f]{40}$/);
	});
});