/**
 * Hermetic integration tests for the worktree substrate (worktree.ts) against
 * a real `git` in a throwaway repository.
 *
 * The suite must run under the Node-based vitest runner, where `globalThis.Bun`
 * is absent and `runtime.ts`'s `getBun()` cannot execute anything. The mock
 * below supplies a test double for the one Bun surface the substrate uses (the
 * `Bun.$` argv form), backed by `node:child_process`. This is test-only
 * scaffolding for the Node suite — production code in src/core/subagent stays
 * Bun-only. Fixture git runs hermetically: `git init` in a temp dir, local
 * `user.name`/`user.email`, GIT_CONFIG_GLOBAL/SYSTEM disabled (set in
 * beforeAll), no network, no global git config writes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BunApi, BunShell, BunShellCommand } from "../src/core/subagent/runtime.ts";
import { cherryPickFromBranch, createWorktree, removeWorktree, sanitizeSlug } from "../src/core/subagent/worktree.ts";

type SyncSpawn = typeof spawnSync;

/**
 * Built before any module in this file's graph loads (vi.hoisted is moved above
 * the imports) so the `vi.mock` factory can hand it out immediately. The spawn
 * backend arrives via the module-level assignment below and is only read at
 * command-run time, i.e. during tests.
 */
const fakeRuntime = vi.hoisted((): { bridge: { spawnSync?: SyncSpawn }; api: BunApi } => {
	const bridge: { spawnSync?: SyncSpawn } = {};

	function wordsOf(strings: TemplateStringsArray, values: unknown[]): string[] {
		// Only the argv-spread form runShell uses (`shell`${[cmd, ...args]}`) is
		// emulated; literal shell text is not parsed.
		const words: string[] = [];
		for (let i = 0; i < strings.length; i++) {
			const literal = strings[i] ?? "";
			if (literal !== "") words.push(literal);
			if (i < values.length) {
				const value = values[i];
				if (Array.isArray(value)) words.push(...value.map((item) => String(item)));
				else words.push(String(value));
			}
		}
		return words;
	}

	function commandAt(
		words: string[],
		cwd: string | undefined,
		env: Record<string, string> | undefined,
	): BunShellCommand {
		const command: BunShellCommand = {
			quiet: () => command,
			env: (vars) => commandAt(words, cwd, { ...env, ...vars }),
			// `.nothrow()` semantics: resolve with the exit code, never reject.
			nothrow: async () => {
				const run = bridge.spawnSync;
				if (!run) throw new Error("worktree test shell backend was not installed");
				const result = run(words[0] ?? "", words.slice(1), {
					cwd,
					env: { ...process.env, ...env },
					encoding: "buffer",
					windowsHide: true,
				});
				const spawnError = result.error;
				const stdout: Uint8Array = spawnError ? new Uint8Array() : result.stdout;
				const stderr: Uint8Array = spawnError ? new TextEncoder().encode(String(spawnError)) : result.stderr;
				return {
					exitCode: result.status ?? 127,
					stdout,
					stderr,
					text: async () => new TextDecoder().decode(stdout),
				};
			},
		};
		return command;
	}

	function shellAt(cwd?: string): BunShell {
		const call = (strings: TemplateStringsArray, ...values: unknown[]): BunShellCommand =>
			commandAt(wordsOf(strings, values), cwd, undefined);
		return Object.assign(call, { cwd: (path: string) => shellAt(path) });
	}

	const notFaked = (name: string): never => {
		throw new Error(`Bun.${name} is not used by the worktree substrate and is not faked here`);
	};
	const api: BunApi = {
		spawn: () => notFaked("spawn"),
		file: () => notFaked("file"),
		write: () => notFaked("write"),
		env: {},
		$: shellAt(),
	};
	return { bridge, api };
});

vi.mock("../src/core/subagent/runtime.ts", () => ({
	getBun: () => fakeRuntime.api,
	isBunRuntime: () => true,
}));

fakeRuntime.bridge.spawnSync = spawnSync;

interface FixtureRepo {
	repoRoot: string;
	seedCommit: string;
}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const tempDirs: string[] = [];

const savedEnv: Record<string, string | undefined> = {};
const gitEnvOverrides: Record<string, string> = {
	// Keep fixture and substrate git runs off the user's global/system config.
	GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
	GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

beforeAll(() => {
	for (const [key, value] of Object.entries(gitEnvOverrides)) {
		savedEnv[key] = process.env[key];
		process.env[key] = value;
	}
});

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): CommandResult {
	const result = spawnSync("git", args, { cwd, encoding: "buffer", windowsHide: true });
	if (result.error) {
		return { exitCode: 127, stdout: "", stderr: String(result.error) };
	}
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout.toString("utf8"),
		stderr: result.stderr.toString("utf8"),
	};
}

function mustGit(cwd: string, ...args: string[]): string {
	const result = git(cwd, ...args);
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
		);
	}
	return result.stdout;
}

function refExists(repoRoot: string, branch: string): boolean {
	return git(repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0;
}

function makeFixtureRepo(): FixtureRepo {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-worktree-"));
	tempDirs.push(root);
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot);
	mustGit(repoRoot, "init", "-q", ".");
	mustGit(repoRoot, "config", "user.name", "pi worktree test");
	mustGit(repoRoot, "config", "user.email", "pi-worktree-test@invalid");
	writeFileSync(join(repoRoot, "seed.txt"), "seed line\n");
	writeFileSync(join(repoRoot, ".gitignore"), ".worktrees/\n");
	mustGit(repoRoot, "add", ".gitignore", "seed.txt");
	mustGit(repoRoot, "commit", "-q", "-m", "seed");
	return { repoRoot, seedCommit: mustGit(repoRoot, "rev-parse", "HEAD").trim() };
}

const gitAvailable = git(tmpdir(), "--version").exitCode === 0;

describe("approach-name validation", () => {
	it("sanitizeSlug rejects empty, dot, dot-dot, path separators, and invalid refnames", () => {
		for (const bad of ["", ".", "..", "a/b", "a\\b", "a..b", ".hidden", "x.", "x.lock"]) {
			expect(() => sanitizeSlug(bad), `expected ${JSON.stringify(bad)} to be rejected`).toThrow();
		}
		expect(sanitizeSlug("My Approach!")).toBe("my-approach");
	});

	it("createWorktree rejects an invalid approach name up front", async () => {
		const res = await createWorktree("/nonexistent-repo", "..", "HEAD", ".worktrees");
		expect(res.exitCode).not.toBe(0);
		expect(res.error).toContain("invalid approach name");
		expect(res.worktreePath).toBe("");
		expect(res.branch).toBe("");
	});
});

describe.skipIf(!gitAvailable)("worktree substrate in a throwaway git repo", () => {
	it("createWorktree/removeWorktree round-trip removes the worktree and the exp/<slug> branch", async () => {
		const repo = makeFixtureRepo();
		const created = await createWorktree(repo.repoRoot, "Round Trip", repo.seedCommit, ".worktrees");
		expect(created.error).toBeUndefined();
		expect(created.exitCode).toBe(0);
		expect(created.branch).toBe("exp/round-trip");
		expect(existsSync(created.worktreePath)).toBe(true);
		expect(refExists(repo.repoRoot, created.branch)).toBe(true);

		const removed = await removeWorktree(repo.repoRoot, created.worktreePath, true);
		expect(removed.exitCode).toBe(0);
		expect(existsSync(created.worktreePath)).toBe(false);
		expect(refExists(repo.repoRoot, created.branch)).toBe(false);

		// The slug is reusable: no stale branch blocks a second `worktree add -b`.
		const again = await createWorktree(repo.repoRoot, "Round Trip", repo.seedCommit, ".worktrees");
		expect(again.error).toBeUndefined();
		expect(again.exitCode).toBe(0);
		expect(existsSync(again.worktreePath)).toBe(true);
		const removedAgain = await removeWorktree(repo.repoRoot, again.worktreePath, true);
		expect(removedAgain.exitCode).toBe(0);
	});

	it("createWorktree failure cleans up the half-created branch and worktree", async () => {
		const repo = makeFixtureRepo();
		// Force `git worktree add` to fail AFTER creating the branch: a file sits
		// where a directory must be ("could not create leading directories").
		// Verified: git leaves `exp/<slug>` behind on this failure mode.
		writeFileSync(join(repo.repoRoot, "blocker"), "not a directory\n");
		const failed = await createWorktree(repo.repoRoot, "half-created", repo.seedCommit, join("blocker", "sub"));
		expect(failed.exitCode).not.toBe(0);
		expect(failed.error).toContain("worktree add");
		expect(refExists(repo.repoRoot, "exp/half-created")).toBe(false);
		expect(existsSync(failed.worktreePath)).toBe(false);
		expect(git(repo.repoRoot, "worktree", "list", "--porcelain").stdout).not.toContain("half-created");

		// Nothing was left behind, so the slug works once the base is fixed.
		const retry = await createWorktree(repo.repoRoot, "half-created", repo.seedCommit, ".worktrees");
		expect(retry.exitCode).toBe(0);
		const removed = await removeWorktree(repo.repoRoot, retry.worktreePath, true);
		expect(removed.exitCode).toBe(0);
	});

	it("cherryPickFromBranch aborts a conflicting cherry-pick cleanly", async () => {
		const repo = makeFixtureRepo();
		const created = await createWorktree(repo.repoRoot, "conflict", repo.seedCommit, ".worktrees");
		expect(created.exitCode).toBe(0);

		// The experiment changes the seeded line.
		writeFileSync(join(created.worktreePath, "seed.txt"), "experiment change\n");
		mustGit(created.worktreePath, "add", "seed.txt");
		mustGit(created.worktreePath, "commit", "-q", "-m", "experiment change");
		const pickHead = mustGit(created.worktreePath, "rev-parse", "HEAD").trim();

		// Main advances over the same line, so the cherry-pick conflicts.
		writeFileSync(join(repo.repoRoot, "seed.txt"), "main change\n");
		mustGit(repo.repoRoot, "add", "seed.txt");
		mustGit(repo.repoRoot, "commit", "-q", "-m", "main change");

		const res = await cherryPickFromBranch(repo.repoRoot, created.branch, pickHead);
		expect(res.exitCode).not.toBe(0);
		expect(res.error).toContain("cherry-pick");

		// The failure must not leave a cherry-pick in progress behind.
		expect(git(repo.repoRoot, "status", "--porcelain").stdout).toBe("");
		expect(git(repo.repoRoot, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD").exitCode).not.toBe(0);
	});
});
