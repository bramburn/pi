/**
 * REQ-I01 (worktree isolation), REQ-I02 (per-tool `concurrentSafe` /
 * parallel serialisation = REQ-C01) and REQ-P02 (detached-child admission).
 *
 * Like subagent-worktree.test.ts, this suite runs under the Node-based vitest
 * runner where `globalThis.Bun` is absent: the mock below supplies a test
 * double for the one Bun surface the worktree substrate uses (the `Bun.$`
 * argv form, via shell.ts's runShell), backed by `node:child_process`. Real
 * git runs in throwaway repositories for the isolation tests; the capability
 * and admission tests need no git at all.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@bramburn/qi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetBackgroundRegistryForTests } from "../src/core/subagent/background.ts";
import type { BunApi, BunShell, BunShellCommand } from "../src/core/subagent/runtime.ts";
import {
	checkDetachedAdmission,
	createSubagentToolDefinition,
	isConcurrentSafeToolSet,
	isSpecConcurrentSafe,
	SUBAGENT_TOOL_CONCURRENT_SAFE,
	subagentSchema,
} from "../src/core/subagent/subagent-tool.ts";
import {
	createEmptyUsage,
	type SubagentResult,
	type SubagentRunner,
	type SubagentRunRequest,
} from "../src/core/subagent/types.ts";

type SyncSpawn = typeof spawnSync;

const fakeRuntime = vi.hoisted((): { bridge: { spawnSync?: SyncSpawn }; api: BunApi } => {
	const bridge: { spawnSync?: SyncSpawn } = {};

	function wordsOf(strings: TemplateStringsArray, values: unknown[]): string[] {
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
			nothrow: async () => {
				const run = bridge.spawnSync;
				if (!run) throw new Error("isolation test shell backend was not installed");
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
		throw new Error(`Bun.${name} is not used by the isolation substrate and is not faked here`);
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

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const gitEnvOverrides: Record<string, string> = {
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

// Point the background-registry singleton (consulted by the shared concurrency
// accounting on every dispatch) at a throwaway agent dir — never the real
// ~/.pi/agent — and drop it between tests so no state leaks.
let suiteAgentDir: string | undefined;
let prevAgentDir: string | undefined;

beforeEach(() => {
	suiteAgentDir = mkdtempSync(join(tmpdir(), "qi-subagent-iso-agent-"));
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = suiteAgentDir;
	_resetBackgroundRegistryForTests();
});

afterEach(() => {
	_resetBackgroundRegistryForTests();
	if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	if (suiteAgentDir !== undefined) rmSync(suiteAgentDir, { recursive: true, force: true });
	suiteAgentDir = undefined;
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

function initTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "qi-subagent-iso-"));
	tempDirs.push(dir);
	execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
	writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
	execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
	return dir;
}

function okResult(req: SubagentRunRequest): SubagentResult {
	return {
		role: req.spec.role,
		task: req.task,
		exitCode: 0,
		aborted: false,
		finalOutput: "ok",
		stderr: "",
		usage: createEmptyUsage(),
		messages: [],
	};
}

describe("REQ-I02: AgentTool.concurrentSafe and parallel serialisation", () => {
	it("accepts concurrentSafe on AgentTool and classifies built-in tools", () => {
		const dummyTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read file",
			parameters: Type.Object({}),
			concurrentSafe: true,
			execute: async () => ({ content: [], details: undefined }),
		};
		expect(dummyTool.concurrentSafe).toBe(true);
		expect(SUBAGENT_TOOL_CONCURRENT_SAFE.read).toBe(true);
		expect(SUBAGENT_TOOL_CONCURRENT_SAFE.edit).toBe(false);
		expect(SUBAGENT_TOOL_CONCURRENT_SAFE.write).toBe(false);
		expect(SUBAGENT_TOOL_CONCURRENT_SAFE.bash).toBe(false);
		expect(isConcurrentSafeToolSet(["read", "grep"])).toBe(true);
		expect(isConcurrentSafeToolSet(["read", "edit"])).toBe(false);
		expect(isConcurrentSafeToolSet(undefined)).toBe(false);
		expect(isConcurrentSafeToolSet([])).toBe(false);
		// An extension-provided lookup overrides the built-in table per name.
		expect(isSpecConcurrentSafe({ tools: ["frobnicate"] }, (name) => name === "frobnicate")).toBe(true);
		expect(isSpecConcurrentSafe({ tools: ["frobnicate"] })).toBe(false);
	});

	it("serialises parallel tasks that include mutating tools and runs read-only tasks concurrently", async () => {
		let active = 0;
		let maxActive = 0;
		const runner: SubagentRunner = {
			async run(req) {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((r) => setTimeout(r, 30));
				active -= 1;
				return okResult(req);
			},
		};

		const def = createSubagentToolDefinition(process.cwd(), { runner });

		// Mutating tools (edit) -> serialised (maxActive === 1) — REQ-C01.
		maxActive = 0;
		await def.execute(
			"call-mut",
			{
				tasks: [
					{ role: "w1", instructions: "edit a", tools: ["read", "edit"] },
					{ role: "w2", instructions: "edit b", tools: ["read", "edit"] },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(maxActive).toBe(1);

		// Read-only tools (read, grep) -> concurrent (maxActive === 2).
		maxActive = 0;
		await def.execute(
			"call-ro",
			{
				tasks: [
					{ role: "r1", instructions: "read a", tools: ["read", "grep"] },
					{ role: "r2", instructions: "read b", tools: ["read", "ls"] },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(maxActive).toBe(2);

		// An omitted `tools` inherits the full coding set (bash/edit/write), so
		// the batch is not concurrent-safe and serialises — REQ-C01's default.
		maxActive = 0;
		await def.execute(
			"call-default",
			{
				tasks: [
					{ role: "d1", instructions: "default a" },
					{ role: "d2", instructions: "default b" },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(maxActive).toBe(1);
	});

	it("runs a worktree-isolated batch concurrently even with mutating tools", async () => {
		let active = 0;
		let maxActive = 0;
		const runner: SubagentRunner = {
			async run(req) {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((r) => setTimeout(r, 30));
				active -= 1;
				return okResult(req);
			},
		};
		const repo = initTempGitRepo();
		const def = createSubagentToolDefinition(repo, { runner });
		await def.execute(
			"call-iso-batch",
			{
				tasks: [
					{ role: "i1", instructions: "one", tools: ["read", "edit"], isolation: "worktree" },
					{ role: "i2", instructions: "two", tools: ["read", "edit"], isolation: "worktree" },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(maxActive).toBe(2);
	});
});

describe("REQ-I01: isolation schema and worktree plumbing", () => {
	afterEach(() => {
		// tempDirs are cleaned in afterAll.
	});

	it("validates isolation: 'none' | 'worktree' in subagentSchema", () => {
		expect(
			Value.Check(subagentSchema, {
				role: "worker",
				instructions: "do work",
				isolation: "worktree",
			}),
		).toBe(true);
		expect(
			Value.Check(subagentSchema, {
				role: "worker",
				instructions: "do work",
				isolation: "invalid",
			}),
		).toBe(false);
		expect(Value.Check(subagentSchema, { role: "worker", instructions: "do work", allowDetachedShell: true })).toBe(
			true,
		);
	});

	it("spawns inside an isolated git worktree, discloses its path in finalOutput, and cleans up on settle", async () => {
		const repo = initTempGitRepo();

		let observedCwd = "";
		let existedDuringRun = false;
		const runner: SubagentRunner = {
			async run(req: SubagentRunRequest) {
				observedCwd = req.cwd;
				existedDuringRun = existsSync(req.cwd);
				return {
					...okResult(req),
					finalOutput: "done in worktree",
				};
			},
		};

		const def = createSubagentToolDefinition(repo, { runner });
		const res = await def.execute(
			"call-wt",
			{ role: "iso-worker", instructions: "implement feature", isolation: "worktree" },
			undefined,
			undefined,
			{} as never,
		);

		expect(existedDuringRun).toBe(true);
		expect(observedCwd).not.toBe(repo);
		expect(observedCwd).toContain(".worktrees");
		const text = res.content[0]?.type === "text" ? res.content[0].text : "";
		expect(text).toContain("[Worktree:");
		expect(text).toContain(observedCwd);
		// Worktree is cleaned up on settle (REQ-I01.3).
		expect(existsSync(observedCwd)).toBe(false);
	});

	it("never silently downgrades when worktree creation fails", async () => {
		const nonGitDir = mkdtempSync(join(tmpdir(), "qi-non-git-"));
		tempDirs.push(nonGitDir);

		let spawned = false;
		const runner: SubagentRunner = {
			async run() {
				spawned = true;
				throw new Error("should not spawn");
			},
		};

		const def = createSubagentToolDefinition(nonGitDir, { runner });
		await expect(
			def.execute(
				"call-wt-fail",
				{ role: "iso-worker", instructions: "try worktree", isolation: "worktree" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/Worktree isolation failed.*never silently downgrades/i);
		expect(spawned).toBe(false);
	});
});

describe("REQ-P02: detached background child admission check", () => {
	it("refuses background: true with default or shell tool sets unless allowDetachedShell: true", async () => {
		let spawned = false;
		const runner: SubagentRunner = {
			async run(req) {
				spawned = true;
				return okResult(req);
			},
		};

		const def = createSubagentToolDefinition(process.cwd(), { runner });
		await expect(
			def.execute(
				"call-bg-refused",
				{ role: "bg-worker", instructions: "run in bg", background: true },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/Detached subagent admission refused.*allowDetachedShell: true/i);
		expect(spawned).toBe(false);
	});

	it("admits background: true when tools are narrowed to read-only or allowDetachedShell is true", () => {
		expect(
			checkDetachedAdmission([{ role: "scout", instructions: "scan", tools: ["read", "grep"] }], false),
		).toBeUndefined();
		expect(
			checkDetachedAdmission([{ role: "worker", instructions: "build", allowDetachedShell: true }], false),
		).toBeUndefined();
		expect(
			checkDetachedAdmission([{ role: "worker", instructions: "build", tools: ["read", "bash"] }], false),
		).toMatch(/Detached subagent admission refused/);
		// The top-level opt-in admits every spec in the batch.
		expect(checkDetachedAdmission([{ role: "worker", instructions: "build" }], true)).toBeUndefined();
	});

	it("admits an allowDetachedShell background dispatch end to end", async () => {
		const runner: SubagentRunner = {
			async run(req) {
				return okResult(req);
			},
		};
		const def = createSubagentToolDefinition(process.cwd(), { runner });
		const res = await def.execute(
			"call-bg-admitted",
			{ role: "bg-worker", instructions: "run in bg", background: true, allowDetachedShell: true },
			undefined,
			undefined,
			{} as never,
		);
		expect(res.details?.background).toBe(true);
	});
});
