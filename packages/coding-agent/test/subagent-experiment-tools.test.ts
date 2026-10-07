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
import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { addExperiment, type ExperimentRow } from "../src/core/subagent/experiment-registry.ts";
import {
	buildTestArgv,
	createExperimentToolDefinitions,
	type TestRunnerPlan,
} from "../src/core/subagent/experiment-tools.ts";
import type { BunApi, BunReadableStream, BunShell, BunSubprocess } from "../src/core/subagent/runtime.ts";
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

const dollarStub = (() => {
	throw new Error("Bun.$ is not provided by the test fake; pass a timeout so runShell takes the spawn path");
}) as unknown as BunShell;

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
