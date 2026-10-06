/**
 * Tests for the repo-scoped worktree mutation lock (worktree-lock.ts, issue
 * #1054), against a real `git` in a throwaway repository plus direct lock-file
 * manipulation for the staleness and contention paths.
 *
 * Coverage: the concurrent same-slug create invariant (exactly one winner, the
 * loser fails in the critical section, the winner's worktree and branch
 * survive), stale-lock breaking (dead recorded pid), release-in-finally when
 * the guarded action throws, WorktreeLockError on a live holder that keeps the
 * lock past the wait budget, cross-worktree lock-path resolution (the lock
 * lives in the git COMMON dir, so a mutation from a linked worktree contends
 * with the main checkout), and removeWorktree/pruneWorktrees serialisation.
 *
 * Like subagent-worktree.test.ts, this suite runs under the Node-based vitest
 * runner where `globalThis.Bun` is absent; the mock below supplies a test
 * double for the one Bun surface the substrate and the lock use (the `Bun.$`
 * argv form, via shell.ts's runShell), backed by `node:child_process`. The
 * lock's own file IO (node:fs exclusive create, read, stat, unlink) is real
 * in tests — it is the behaviour under review.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BunApi, BunShell, BunShellCommand } from "../src/core/subagent/runtime.ts";
import { createWorktree, pruneWorktrees, removeWorktree } from "../src/core/subagent/worktree.ts";
import { resolveWorktreeLockPath, WorktreeLockError, withWorktreeLock } from "../src/core/subagent/worktree-lock.ts";

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
				if (!run) throw new Error("worktree lock test shell backend was not installed");
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
		throw new Error(`Bun.${name} is not used by the worktree lock and is not faked here`);
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
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-worktree-lock-"));
	tempDirs.push(root);
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot);
	mustGit(repoRoot, "init", "-q", ".");
	mustGit(repoRoot, "config", "user.name", "pi worktree lock test");
	mustGit(repoRoot, "config", "user.email", "pi-worktree-lock-test@invalid");
	writeFileSync(join(repoRoot, "seed.txt"), "seed line\n");
	writeFileSync(join(repoRoot, ".gitignore"), ".worktrees/\n");
	mustGit(repoRoot, "add", ".gitignore", "seed.txt");
	mustGit(repoRoot, "commit", "-q", "-m", "seed");
	return { repoRoot, seedCommit: mustGit(repoRoot, "rev-parse", "HEAD").trim() };
}

/** True when signal 0 reports this pid as definitively dead (ESRCH). */
function isDefinitelyDeadPid(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
	return false;
}

/**
 * A pid the OS guarantees is not a live process, for the stale-lock test.
 * Probes implausibly large pids first (unallocated on Linux and win32 alike);
 * falls back to a spawn-and-reap child, whose exit spawnSync has already
 * awaited. Verified with the same ESRCH semantics the lock uses, so the test
 * never mistakes a live process for a stale holder.
 */
function findDeadPid(): number {
	for (const pid of [999_999_999, 4_194_304, 1_048_576, 100_000]) {
		if (isDefinitelyDeadPid(pid)) return pid;
	}
	const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
	const pid = child.pid;
	if (pid !== undefined && isDefinitelyDeadPid(pid)) return pid;
	throw new Error("no dead pid available for the stale-lock test");
}

const gitAvailable = git(tmpdir(), "--version").exitCode === 0;

describe.skipIf(!gitAvailable)("worktree mutation lock", () => {
	it("serialises concurrent same-slug creates: one winner, one clean loser, no torn-down state", async () => {
		const repo = makeFixtureRepo();
		const results = await Promise.all([
			createWorktree(repo.repoRoot, "Race", repo.seedCommit, ".worktrees"),
			createWorktree(repo.repoRoot, "Race", repo.seedCommit, ".worktrees"),
		]);
		const winners = results.filter((r) => r.exitCode === 0);
		const losers = results.filter((r) => r.exitCode !== 0);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		const winner = winners[0];
		// The loser failed inside the critical section on a pre-check, not in
		// mid-`worktree add` failure cleanup — the race this lock removes.
		expect(losers[0].error).toMatch(/already exists/);
		// The winner's state survived the loser's attempt.
		expect(existsSync(winner.worktreePath)).toBe(true);
		expect(refExists(repo.repoRoot, "exp/race")).toBe(true);
		const listed = git(repo.repoRoot, "worktree", "list", "--porcelain");
		expect(listed.stdout.match(/exp\/race/g) ?? []).toHaveLength(1);
		// The lock is fully released by both calls.
		const lockPath = await resolveWorktreeLockPath(repo.repoRoot);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("lets concurrent creates of different slugs all succeed", async () => {
		const repo = makeFixtureRepo();
		const results = await Promise.all(
			["alpha", "bravo", "charlie"].map((slug) =>
				createWorktree(repo.repoRoot, slug, repo.seedCommit, ".worktrees"),
			),
		);
		for (const res of results) {
			expect(res.exitCode).toBe(0);
			expect(res.error).toBeUndefined();
		}
		for (const slug of ["alpha", "bravo", "charlie"]) {
			expect(refExists(repo.repoRoot, `exp/${slug}`)).toBe(true);
		}
	});

	it("breaks a stale lock whose recorded pid is dead and proceeds", async () => {
		const repo = makeFixtureRepo();
		const lockPath = await resolveWorktreeLockPath(repo.repoRoot);
		const deadPid = findDeadPid();
		writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: Date.now() - 60_000, token: "crashed-run" }));

		let ran = false;
		await withWorktreeLock(repo.repoRoot, () => {
			ran = true;
		});
		expect(ran).toBe(true);
		// The broken record was replaced by the new owner's, then released.
		expect(existsSync(lockPath)).toBe(false);
	});

	it("releases the lock in a finally even when the guarded action throws", async () => {
		const repo = makeFixtureRepo();
		const lockPath = await resolveWorktreeLockPath(repo.repoRoot);
		await expect(
			withWorktreeLock(repo.repoRoot, () => {
				throw new Error("guarded boom");
			}),
		).rejects.toThrow("guarded boom");
		expect(existsSync(lockPath)).toBe(false);
		// A second acquisition succeeds immediately, proving the lock is free.
		let ran = false;
		await withWorktreeLock(repo.repoRoot, () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	it("times out with WorktreeLockError against a live holder and never breaks its lock", async () => {
		const repo = makeFixtureRepo();
		const lockPath = await resolveWorktreeLockPath(repo.repoRoot);
		// process.pid is alive by definition — the strongest live-holder probe.
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "live-holder" }));

		const started = Date.now();
		let thrown: unknown;
		try {
			await withWorktreeLock(
				repo.repoRoot,
				() => {
					throw new Error("must not run");
				},
				{ waitMs: 250 },
			);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(WorktreeLockError);
		expect((thrown as Error).message).toContain("another run is mutating worktrees in this repo");
		expect((thrown as Error).message).toContain(`pid ${process.pid}`);
		// The waiter actually waited through the backoff instead of spinning.
		expect(Date.now() - started).toBeGreaterThanOrEqual(200);
		// The live holder was not broken.
		const kept = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
		expect(kept.token).toBe("live-holder");
	});

	it("resolves the same lock path from a linked worktree and the main checkout", async () => {
		const repo = makeFixtureRepo();
		const created = await createWorktree(repo.repoRoot, "Lock Path", repo.seedCommit, ".worktrees");
		expect(created.exitCode).toBe(0);
		// The lock lives in the git COMMON dir, so a mutation issued from the
		// linked worktree contends with the main checkout — the whole point of
		// resolving --git-common-dir instead of --git-dir.
		const mainLock = await resolveWorktreeLockPath(repo.repoRoot);
		const linkedLock = await resolveWorktreeLockPath(created.worktreePath);
		expect(linkedLock).toBe(mainLock);
		expect(mainLock).toContain("pi-worktree.lock");
		await removeWorktree(repo.repoRoot, created.worktreePath, true);
	});

	it("serialises removeWorktree against pruneWorktrees without corrupting state", async () => {
		const repo = makeFixtureRepo();
		const created = await createWorktree(repo.repoRoot, "Prune Race", repo.seedCommit, ".worktrees");
		expect(created.exitCode).toBe(0);
		const [removed, pruned] = await Promise.all([
			removeWorktree(repo.repoRoot, created.worktreePath, true),
			pruneWorktrees(repo.repoRoot),
		]);
		expect(removed.exitCode).toBe(0);
		expect(pruned.exitCode).toBe(0);
		expect(existsSync(created.worktreePath)).toBe(false);
		expect(refExists(repo.repoRoot, "exp/prune-race")).toBe(false);
		const lockPath = await resolveWorktreeLockPath(repo.repoRoot);
		expect(existsSync(lockPath)).toBe(false);
	});
});
