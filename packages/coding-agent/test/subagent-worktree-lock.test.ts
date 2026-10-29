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
 * The final suite covers the foreign-record handling that reuses this fixture
 * machinery: worktree records that came along with a copied `.git` directory
 * and so belong to a different repository (issue #2).
 *
 * Like subagent-worktree.test.ts, this suite runs under the Node-based vitest
 * runner where `globalThis.Bun` is absent; the mock below supplies a test
 * double for the one Bun surface the substrate and the lock use (the `Bun.$`
 * argv form, via shell.ts's runShell), backed by `node:child_process`. The
 * lock's own file IO (node:fs exclusive create, read, stat, unlink) is real
 * in tests — it is the behaviour under review.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BunApi, BunShell, BunShellCommand } from "../src/core/subagent/runtime.ts";
import { createWorktree, listWorktrees, pruneWorktrees, removeWorktree } from "../src/core/subagent/worktree.ts";
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

// ---------------------------------------------------------------------------
// REQ-I04.3 / REQ-I04.4 — the error carries its own diagnostics.
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable)("worktree lock diagnostics (REQ-I04.3, REQ-I04.4)", () => {
	it("a lock path that cannot be resolved reports reason 'unresolved', null lockPath, and the repo root", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-lock-unresolved-"));
		tempDirs.push(root);
		const notARepo = join(root, "no-git");
		mkdirSync(notARepo, { recursive: true });

		let caught: unknown;
		try {
			await resolveWorktreeLockPath(notARepo);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(WorktreeLockError);
		const lockError = caught as WorktreeLockError;
		expect(lockError.reason).toBe("unresolved");
		// Never an empty string presented as a known location (REQ-I04.3).
		expect(lockError.lockPath).toBeNull();
		expect(lockError.repoRoot).toBe(notARepo);
	});

	it("a contention that outlives the one permitted stale break reports the spent budget (REQ-I04.4)", async () => {
		const repo = makeFixtureRepo();
		const lockPath = await resolveWorktreeLockPath(repo.repoRoot);
		writeFileSync(lockPath, JSON.stringify({ pid: findDeadPid(), startedAt: Date.now(), token: "stale-a" }));

		// Emulate a rival re-creating the stale lock immediately after the one
		// permitted break: the unlink never actually removes the file, so the
		// acquisition spends its stale-break budget and must then say so instead
		// of naming the dead holder as if it were live.
		// The lock module takes `unlinkSync` as a builtin named import; mutating the
		// CJS exports object and calling syncBuiltinESMExports() is the documented
		// way to reach those bindings from a test.
		const req = createRequire(import.meta.url);
		const nodeFs = req("node:fs") as typeof import("node:fs");
		const syncBuiltinESMExports = req("node:module").syncBuiltinESMExports as () => void;
		const realUnlinkSync = nodeFs.unlinkSync;
		const unlinkSpy = vi.spyOn(nodeFs, "unlinkSync").mockImplementation(((
			path: Parameters<typeof realUnlinkSync>[0],
		) => {
			if (String(path) === lockPath) return; // stays in place, as if re-created
			return realUnlinkSync(path);
		}) as typeof realUnlinkSync);
		syncBuiltinESMExports();
		try {
			let caught: unknown;
			try {
				await withWorktreeLock(repo.repoRoot, () => "ok", { waitMs: 600 });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(WorktreeLockError);
			const lockError = caught as WorktreeLockError;
			expect(lockError.reason).toBe("contended");
			expect(lockError.message).toContain("stale-break budget (1) was spent");
			expect(lockError.lockPath).toBe(lockPath);
			expect(lockError.repoRoot).toBe(repo.repoRoot);
		} finally {
			unlinkSpy.mockRestore();
			syncBuiltinESMExports();
		}
	});
});

// ---------------------------------------------------------------------------
// Issue #2 — worktree records that arrived with a copied `.git` belong to the
// source repository, and neither `git worktree list` nor `git worktree prune`
// can tell. Real `git` against two temp repos here, because the whole point is
// that the git-level checks pass for a foreign record.
// ---------------------------------------------------------------------------

/** git prints worktree paths with forward slashes, even on Windows. */
function toGitPathFormat(path: string): string {
	return path.replace(/\\/g, "/");
}

function listedWorktreePaths(stdout: string): string[] {
	return stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

function commonDir(repoRoot: string): string {
	return resolvePath(repoRoot, mustGit(repoRoot, "rev-parse", "--git-common-dir").trim());
}

interface CopiedGitFixture {
	/** The repository the worktree was really created in. */
	sourceRepo: string;
	/** The repository made by copying `sourceRepo`'s `.git` directory. */
	copyRepo: string;
	/** The linked worktree, which lives under `sourceRepo`. */
	worktreePath: string;
	/** Registry record name copied into `copyRepo`: `<common dir>/worktrees/<name>`. */
	recordName: string;
}

function makeCopiedGitRepo(): CopiedGitFixture {
	const source = makeFixtureRepo();
	const worktreePath = join(source.repoRoot, ".worktrees", "copied");
	mustGit(source.repoRoot, "worktree", "add", "-b", "exp/copied", worktreePath, source.seedCommit);

	const copyRoot = mkdtempSync(join(tmpdir(), "pi-subagent-worktree-copy-"));
	tempDirs.push(copyRoot);
	const copyRepo = join(copyRoot, "repo");
	mkdirSync(copyRepo);
	cpSync(join(source.repoRoot, ".git"), join(copyRepo, ".git"), { recursive: true });
	return { sourceRepo: source.repoRoot, copyRepo, worktreePath, recordName: "copied" };
}

describe.skipIf(!gitAvailable)("foreign worktree records (issue #2)", () => {
	it("git itself lists a copied record and refuses to prune it", () => {
		// The premise the handling exists for. If git ever starts validating the
		// reverse pointer, this test says so instead of the handling silently
		// becoming dead code.
		const fixture = makeCopiedGitRepo();
		const raw = mustGit(fixture.copyRepo, "worktree", "list", "--porcelain");
		expect(listedWorktreePaths(raw)).toContain(toGitPathFormat(fixture.worktreePath));
		const pruned = git(fixture.copyRepo, "worktree", "prune", "-n", "--verbose");
		expect(pruned.exitCode).toBe(0);
		expect(pruned.stdout.trim()).toBe("");
		expect(existsSync(join(commonDir(fixture.copyRepo), "worktrees", fixture.recordName))).toBe(true);
	});

	it("listWorktrees() hides a record whose worktree points into another repository", async () => {
		const fixture = makeCopiedGitRepo();
		const listed = await listWorktrees(fixture.copyRepo);
		expect(listed.exitCode).toBe(0);
		expect(listed.stdout).not.toContain(toGitPathFormat(fixture.worktreePath));
		// Only the copy's own main checkout remains.
		expect(listedWorktreePaths(listed.stdout)).toEqual([toGitPathFormat(fixture.copyRepo)]);
	});

	it("pruneWorktrees() drops the foreign record and leaves the source repository intact", async () => {
		const fixture = makeCopiedGitRepo();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const pruned = await pruneWorktrees(fixture.copyRepo);
			expect(pruned.exitCode).toBe(0);
			expect(pruned.stderr).toContain(fixture.recordName);
			expect(warn.mock.calls.flat().join(" ")).toContain(fixture.recordName);
		} finally {
			warn.mockRestore();
		}
		expect(existsSync(join(commonDir(fixture.copyRepo), "worktrees", fixture.recordName))).toBe(false);
		const listed = await listWorktrees(fixture.copyRepo);
		expect(listedWorktreePaths(listed.stdout)).toEqual([toGitPathFormat(fixture.copyRepo)]);

		// The source repository still owns the worktree: same record, same
		// checkout, still clean. Deleting the copy's record must not reach across.
		const sourceList = mustGit(fixture.sourceRepo, "worktree", "list", "--porcelain");
		expect(listedWorktreePaths(sourceList)).toContain(toGitPathFormat(fixture.worktreePath));
		expect(existsSync(join(commonDir(fixture.sourceRepo), "worktrees", fixture.recordName))).toBe(true);
		expect(mustGit(fixture.worktreePath, "status", "--porcelain").trim()).toBe("");
		expect(toGitPathFormat(mustGit(fixture.worktreePath, "rev-parse", "--show-toplevel").trim())).toBe(
			toGitPathFormat(fixture.worktreePath),
		);
	});

	it("keeps a linked worktree the copy created itself", async () => {
		const fixture = makeCopiedGitRepo();
		const own = await createWorktree(
			fixture.copyRepo,
			"Own",
			mustGit(fixture.copyRepo, "rev-parse", "HEAD").trim(),
			".worktrees",
		);
		expect(own.exitCode).toBe(0);
		expect(own.error).toBeUndefined();

		const listed = await listWorktrees(fixture.copyRepo);
		expect(listedWorktreePaths(listed.stdout)).toContain(toGitPathFormat(own.worktreePath));

		await pruneWorktrees(fixture.copyRepo);
		expect(existsSync(join(commonDir(fixture.copyRepo), "worktrees", "own"))).toBe(true);
		expect(existsSync(own.worktreePath)).toBe(true);
		expect(existsSync(join(commonDir(fixture.copyRepo), "worktrees", fixture.recordName))).toBe(false);
	});
});
