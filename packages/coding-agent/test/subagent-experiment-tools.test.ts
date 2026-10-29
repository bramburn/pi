/**
 * experiment_test filter delivery contract.
 *
 * The filter used to be interpolated into a shell line with POSIX single-quote
 * escaping — broken and injectable on win32, where `cmd.exe /c` does not treat
 * `'` as a quote (`"x & del /f ..."` ran arbitrary commands). It is now a
 * single argv element passed through `runShell`'s argv path. These tests pin
 * both halves: `buildTestArgv` keeps the filter one argv element, and the argv
 * reaches a real child process literally with no shell metacharacter
 * interpretation.
 *
 * `Bun` is faked at the runtime.ts seam (`vi.mock`) because the vitest suite
 * runs under Node. The fake forwards argv verbatim to a real child via
 * `node:child_process` with `shell: false` — the same no-shell OS exec
 * semantics as `Bun.spawn`.
 */
import { execFileSync, spawn as spawnChild, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { addExperiment, type ExperimentRow, getExperiment } from "../src/core/subagent/experiment-registry.ts";
import {
	buildTestArgv,
	createExperimentToolDefinitions,
	type TestRunnerPlan,
} from "../src/core/subagent/experiment-tools.ts";
import type {
	BunApi,
	BunReadableStream,
	BunShell,
	BunShellCommand,
	BunSubprocess,
} from "../src/core/subagent/runtime.ts";
import { runShell } from "../src/core/subagent/shell.ts";

const bunRef = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("../src/core/subagent/runtime.ts", () => ({
	getBun: () => bunRef.current,
	isBunRuntime: () => true,
}));

interface FakeBunState {
	/** Every argv received by the fake `Bun.spawn`. */
	captures: string[][];
	/** When true, run the child for real via node:child_process (no shell). */
	forward: boolean;
	/** stdout used when `forward` is false. */
	stdout: string;
}

function oneShotStream(text: string): BunReadableStream {
	let sent = false;
	return {
		getReader() {
			return {
				async read(): Promise<{ done: boolean; value?: Uint8Array }> {
					if (sent) return { done: true };
					sent = true;
					return { done: false, value: new TextEncoder().encode(text) };
				},
				async cancel(): Promise<void> {},
				releaseLock(): void {},
			};
		},
	};
}

function wrapNodeStream(stream: Readable): BunReadableStream {
	const queue: Uint8Array[] = [];
	const encoder = new TextEncoder();
	let ended = false;
	let failure: unknown;
	let wake: (() => void) | undefined;
	const notify = () => {
		const fn = wake;
		wake = undefined;
		fn?.();
	};
	stream.on("data", (chunk: Buffer | string) => {
		queue.push(typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk));
		notify();
	});
	stream.on("end", () => {
		ended = true;
		notify();
	});
	stream.on("error", (err: Error) => {
		failure = err;
		ended = true;
		notify();
	});
	return {
		getReader() {
			return {
				async read(): Promise<{ done: boolean; value?: Uint8Array }> {
					for (;;) {
						const next = queue.shift();
						if (next !== undefined) return { done: false, value: next };
						if (failure !== undefined) throw failure;
						if (ended) return { done: true };
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				},
				async cancel(): Promise<void> {
					stream.destroy();
				},
				releaseLock(): void {},
			};
		},
	};
}

/**
 * Working `Bun.$` argv fake backed by `spawnSync` (no shell). The spawn-path
 * fake below covers tests that pass a timeout; this one serves the argv paths
 * that go through `Bun.$` — `git rev-parse`, `git worktree`, `git merge` — so
 * the worktree-substrate tests can run real git in this suite too.
 */
function dollarWordsOf(strings: TemplateStringsArray, values: unknown[]): string[] {
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

function dollarCommandAt(words: string[], cwd: string | undefined, env: Record<string, string>): BunShellCommand {
	const command: BunShellCommand = {
		quiet: () => command,
		env: (vars) => dollarCommandAt(words, cwd, { ...env, ...vars }),
		nothrow: async () => {
			const result = spawnSync(words[0] ?? "", words.slice(1), {
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

function dollarShellAt(cwd?: string, env: Record<string, string> = {}): BunShell {
	const call = (strings: TemplateStringsArray, ...values: unknown[]): BunShellCommand =>
		dollarCommandAt(dollarWordsOf(strings, values), cwd, env);
	return Object.assign(call, { cwd: (path: string) => dollarShellAt(path, env) });
}

const dollarStub = dollarShellAt();

function makeFakeBun(state: FakeBunState): BunApi {
	return {
		spawn(command: string[]): BunSubprocess {
			state.captures.push([...command]);
			if (!state.forward) {
				return {
					pid: undefined,
					stdout: oneShotStream(state.stdout),
					stderr: oneShotStream(""),
					signalCode: Promise.resolve(null),
					exited: Promise.resolve(0),
					kill: (): void => {},
				};
			}
			const child = spawnChild(command[0], command.slice(1), {
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				windowsHide: true,
			});
			return {
				pid: child.pid,
				stdout: child.stdout ? wrapNodeStream(child.stdout) : null,
				stderr: child.stderr ? wrapNodeStream(child.stderr) : null,
				signalCode: Promise.resolve(null),
				exited: new Promise<number>((resolve) => {
					child.on("close", (code) => resolve(code ?? 0));
					child.on("error", () => resolve(127));
				}),
				kill: (signal?: number | NodeJS.Signals): void => {
					child.kill(signal ?? "SIGTERM");
				},
			};
		},
		file(path: string) {
			return {
				exists: async () => existsSync(path),
				text: async () => readFileSync(path, "utf8"),
				delete: async () => {
					rmSync(path, { force: true });
				},
			};
		},
		write: async (path: string, data: string | Uint8Array) => {
			writeFileSync(path, data);
			return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
		},
		env: { ...process.env },
		$: dollarStub,
	};
}

const state: FakeBunState = { captures: [], forward: false, stdout: "" };
bunRef.current = makeFakeBun(state);

describe("buildTestArgv", () => {
	it("passes the filter as a single argv element for flag-style runners", () => {
		const plan: TestRunnerPlan = { name: "bun", argv: ["bun", "test"], filterFlag: "-t" };
		expect(buildTestArgv(plan, "my test")).toEqual(["bun", "test", "-t", "my test"]);
		expect(buildTestArgv(plan, "x & echo injected")).toEqual(["bun", "test", "-t", "x & echo injected"]);
	});

	it("passes the filter after -- for npm", () => {
		const plan: TestRunnerPlan = { name: "npm", argv: ["npm", "test"], filterFlag: "--" };
		expect(buildTestArgv(plan, "a b")).toEqual(["npm", "test", "--", "a b"]);
	});

	it("omits filter arguments when no filter is given", () => {
		const plan: TestRunnerPlan = { name: "vitest", argv: ["npx", "vitest", "run"], filterFlag: "-t" };
		expect(buildTestArgv(plan, undefined)).toEqual(["npx", "vitest", "run"]);
	});
});

describe("filter delivery to a real child (argv, no shell)", () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-exp-probe-"));
	const probePath = join(tempRoot, "probe.cjs");
	writeFileSync(probePath, 'process.stdout.write(JSON.stringify(process.argv) + "\\n");');

	afterAll(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it.each(["a b", "x & echo injected"])("delivers %j as a single literal argv element", async (filter) => {
		state.forward = true;
		state.captures.length = 0;
		const plan: TestRunnerPlan = { name: "probe", argv: [process.execPath, probePath], filterFlag: "-t" };
		const argv = buildTestArgv(plan, filter);
		const result = await runShell(argv[0], argv.slice(1), { cwd: tempRoot, timeoutMs: 15_000 });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		// Exactly one stdout line: a shell interpretation of `&` or a space-split
		// argument would add output or corrupt the JSON.
		const lines = result.stdout.trim().split(/\r?\n/);
		expect(lines).toHaveLength(1);
		const childArgv: string[] = JSON.parse(lines[0]);
		expect(childArgv.slice(2)).toEqual(["-t", filter]);
		// The argv handed to the process API is the same array, unquoted.
		expect(state.captures).toEqual([[process.execPath, probePath, "-t", filter]]);
	});
});

describe("experiment_test tool wiring", () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-exp-wiring-"));

	afterAll(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it.each(["a b", "x & echo injected"])("runs the detected runner with %j as one argv element", async (filter) => {
		state.forward = false;
		state.stdout = "1 pass\n0 fail\n";
		state.captures.length = 0;

		const registryCwd = join(tempRoot, `reg-${filter.replace(/\W+/g, "_")}`);
		const worktree = join(registryCwd, "wt");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, "bun.lock"), "");
		const now = new Date().toISOString();
		const row: ExperimentRow = {
			id: `exp-20260101120000-${filter.replace(/\W+/g, "_")}`,
			hypothesis: "filters reach the runner literally",
			approach: "filter-probe",
			worktreePath: worktree,
			branch: "exp/filter-probe",
			parentCommit: "0123456789abcdef",
			startedInCwd: registryCwd,
			status: "scaffolded",
			result: {},
			merged: false,
			createdAt: now,
			updatedAt: now,
		};
		addExperiment(registryCwd, row);

		const defs = createExperimentToolDefinitions(registryCwd, {});
		const result = await defs.experiment_test.execute(
			"tc",
			{ experiment_id: row.id, filter },
			undefined,
			undefined,
			undefined as never,
		);
		// A shell-line regression would surface here as ["cmd.exe", "/c", ...] or
		// ["/bin/sh", "-c", ...] instead of the plain runner argv.
		expect(state.captures).toEqual([["bun", "test", "-t", filter]]);
		expect((result.content[0] as { text: string }).text).toContain("passed: 1");
	});
});

// ---------------------------------------------------------------------------
// REQ-I04 — composite experiment mutations: typed failures, honoured
// keep_branch, and one repo-lock acquisition across the whole body.
// ---------------------------------------------------------------------------

describe("REQ-I04 composite experiment mutations", () => {
	const gitRepos: string[] = [];

	afterAll(() => {
		while (gitRepos.length > 0) {
			const dir = gitRepos.pop();
			if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeGitRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-exp-i04-"));
		gitRepos.push(dir);
		execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "exp@example.com"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "exp test"], { cwd: dir, stdio: "ignore" });
		// Pre-ignore every untracked artefact the tools create, so the merge
		// clean-tree gate sees a clean repo even though the registry and the
		// stray directory exist.
		writeFileSync(join(dir, ".gitignore"), ".pi-experiments/\n.worktrees/\nnot-a-worktree/\n");
		writeFileSync(join(dir, "README.md"), "# fixture\n");
		execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "seed"], { cwd: dir, stdio: "ignore" });
		return dir;
	}

	function gitOut(cwd: string, ...args: string[]): { exitCode: number; stdout: string } {
		const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
		return { exitCode: result.status ?? 1, stdout: (result.stdout ?? "").toString() };
	}

	const head = (cwd: string): string => gitOut(cwd, "rev-parse", "HEAD").stdout.trim();

	it("REQ-I04.2: a failed worktree removal throws and never marks the row merged", async () => {
		// The clean-tree gate goes through the spawn path (canned clean output);
		// every git argv path in the merge body runs for real via the `Bun.$` fake.
		state.forward = false;
		state.stdout = "";
		state.captures.length = 0;
		const repo = makeGitRepo();
		// A real branch with a real commit so `git merge --no-ff` succeeds and
		// the failure lands exactly where the defect was: the removal.
		execFileSync("git", ["checkout", "-b", "exp/broken"], { cwd: repo, stdio: "ignore" });
		writeFileSync(join(repo, "feature.txt"), "change\n");
		execFileSync("git", ["add", "feature.txt"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "feature"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
		// row.worktreePath points at a plain directory git cannot remove as a
		// worktree — the removal failure the old bare `catch {}` swallowed.
		const notAWorktree = join(repo, "not-a-worktree");
		mkdirSync(notAWorktree, { recursive: true });
		writeFileSync(join(notAWorktree, "stray.txt"), "not a worktree\n");

		const now = new Date().toISOString();
		const row: ExperimentRow = {
			id: "exp-20260101120000-broken",
			hypothesis: "removal failure must surface",
			approach: "broken",
			worktreePath: notAWorktree,
			branch: "exp/broken",
			parentCommit: head(repo),
			startedInCwd: repo,
			status: "completed",
			outputPath: join(repo, ".pi-experiments", "broken.jsonl"),
			result: {},
			merged: false,
			createdAt: now,
			updatedAt: now,
		};
		addExperiment(repo, row);

		const defs = createExperimentToolDefinitions(repo, {});
		await expect(
			defs.experiment_merge.execute(
				"tc",
				{ experiment_id: row.id, strategy: "merge" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/git worktree remove/i);

		const after = getExperiment(repo, row.id);
		expect(after?.status).not.toBe("merged");
		expect(after?.merged).toBe(false);
	});

	it("REQ-I04.5: experiment_discard keeps exp/<slug> + the WHY commit by default and deletes both with keep_branch: false", async () => {
		state.forward = true; // the WHY add/commit runs through the spawn path
		state.stdout = "";
		state.captures.length = 0;
		const repo = makeGitRepo();
		const defs = createExperimentToolDefinitions(repo, {});

		const start = (await defs.experiment_start.execute(
			"tc",
			{ hypothesis: "keep me", approach_name: "keeper" },
			undefined,
			undefined,
			undefined as never,
		)) as { details: { id: string; worktree_path: string } };
		const worktree = start.details.worktree_path;
		expect(existsSync(worktree)).toBe(true);
		writeFileSync(join(worktree, "note.txt"), "experiment note\n");
		execFileSync("git", ["add", "note.txt"], { cwd: worktree, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "experiment change"], { cwd: worktree, stdio: "ignore" });

		await defs.experiment_discard.execute(
			"tc",
			{ experiment_id: start.details.id, reason: "not good enough" },
			undefined,
			undefined,
			undefined as never,
		);

		// Worktree gone, branch kept WITH the WHY commit — archaeology works now.
		expect(existsSync(worktree)).toBe(false);
		expect(gitOut(repo, "show-ref", "--verify", "--quiet", "refs/heads/exp/keeper").exitCode).toBe(0);
		const log = gitOut(repo, "log", "--oneline", "refs/heads/exp/keeper", "-2").stdout;
		expect(log).toContain("record discard reason");
		expect(getExperiment(repo, start.details.id)?.status).toBe("discarded");

		// keep_branch: false deletes the branch inside the same composite.
		const second = (await defs.experiment_start.execute(
			"tc",
			{ hypothesis: "drop me", approach_name: "dropper" },
			undefined,
			undefined,
			undefined as never,
		)) as { details: { id: string; worktree_path: string } };
		await defs.experiment_discard.execute(
			"tc",
			{ experiment_id: second.details.id, keep_branch: false, reason: "wrong approach" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(existsSync(second.details.worktree_path)).toBe(false);
		expect(gitOut(repo, "show-ref", "--verify", "--quiet", "refs/heads/exp/dropper").exitCode).not.toBe(0);
		expect(getExperiment(repo, second.details.id)?.status).toBe("discarded");
	});

	it("REQ-I04.1: experiment_discard acquires the repo worktree lock exactly once for the whole composite", async () => {
		state.forward = true;
		state.stdout = "";
		state.captures.length = 0;
		const repo = makeGitRepo();
		const defs = createExperimentToolDefinitions(repo, {});
		const start = (await defs.experiment_start.execute(
			"tc",
			{ hypothesis: "one lock", approach_name: "locked" },
			undefined,
			undefined,
			undefined as never,
		)) as { details: { id: string; worktree_path: string } };
		writeFileSync(join(start.details.worktree_path, "note.txt"), "change\n");
		execFileSync("git", ["add", "note.txt"], { cwd: start.details.worktree_path, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "change"], { cwd: start.details.worktree_path, stdio: "ignore" });

		// The lock module takes openSync/unlinkSync as builtin named imports;
		// mutating the CJS exports object and calling syncBuiltinESMExports()
		// (node:module) is the way to reach those bindings from a test.
		const req = createRequire(import.meta.url);
		const nodeFs = req("node:fs") as typeof import("node:fs");
		const syncBuiltinESMExports = req("node:module").syncBuiltinESMExports as () => void;
		const realOpenSync = nodeFs.openSync;
		const realUnlinkSync = nodeFs.unlinkSync;
		const lockOpens: string[] = [];
		const lockUnlinks: string[] = [];
		const openSpy = vi.spyOn(nodeFs, "openSync").mockImplementation(((...args: Parameters<typeof realOpenSync>) => {
			if (String(args[0]).endsWith("pi-worktree.lock")) lockOpens.push(String(args[0]));
			return realOpenSync(...args);
		}) as typeof realOpenSync);
		const unlinkSpy = vi.spyOn(nodeFs, "unlinkSync").mockImplementation(((
			path: Parameters<typeof realUnlinkSync>[0],
		) => {
			if (String(path).endsWith("pi-worktree.lock")) lockUnlinks.push(String(path));
			return realUnlinkSync(path);
		}) as typeof realUnlinkSync);
		syncBuiltinESMExports();
		try {
			await defs.experiment_discard.execute(
				"tc",
				{ experiment_id: start.details.id, reason: "locking check" },
				undefined,
				undefined,
				undefined as never,
			);
		} finally {
			openSpy.mockRestore();
			unlinkSpy.mockRestore();
			syncBuiltinESMExports();
		}

		// One acquisition for WHY-commit + remove + prune + branch delete: two
		// acquisitions (the old remove-then-prune split) would show 2 here.
		expect(lockOpens).toHaveLength(1);
		expect(lockUnlinks).toHaveLength(1);
		expect(lockOpens[0]).toBe(lockUnlinks[0]);
	});
});
