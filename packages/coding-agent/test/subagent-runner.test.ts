/**
 * Bun-process runner behavior (plan 6.2).
 *
 * The runner spawns via Bun.spawn and kills the process tree on abort. The
 * abort/kill case is Bun-only (it spawns real processes); under the Node-based
 * vitest suite it skips and the runtime-gate tests run instead.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBunProcessRunner } from "../src/core/subagent/bun-process-runner.ts";
import { type BunApi, type BunReadableStream, type BunSubprocess, isBunRuntime } from "../src/core/subagent/runtime.ts";
import { HARD_KILL_EXIT_CODE } from "../src/core/subagent/shell.ts";

function signalNumber(signal: NodeJS.Signals): number {
	return constants.signals[signal] ?? 9;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Adapt a node child stream to the `BunReadableStream` reader shape.
 *
 * Fidelity gap vs real Bun (deliberate, documented): this fake resolves
 * `exited` on the child's 'close' event, which fires AFTER its stdio has
 * closed. Real Bun resolves `exited` at process exit while the pipes may still
 * be open (grandchildren inherit them), so process-level tests built on this
 * fake never exercise the post-exit drain — that path is pinned by the
 * synthetic scheduled-output fake below and by real-Bun tests in
 * subagent-shell.test.ts / subagent-stream.test.ts. Second divergence: a real
 * stream's `cancel()` resolves a pending `read()` with `{ done: true }`, while
 * this fake's `cancel()` leaves the read pending forever; `stream.ts` handles
 * both shapes.
 */
function wrapNodeStream(stream: Readable | null): BunReadableStream | null {
	if (!stream) return null;
	return {
		getReader: () => {
			const queue: Uint8Array[] = [];
			const waiters: Array<(result: { done: boolean; value?: Uint8Array }) => void> = [];
			let ended = false;
			const onData = (chunk: Buffer) => {
				const bytes = new Uint8Array(chunk);
				const waiter = waiters.shift();
				if (waiter) waiter({ done: false, value: bytes });
				else queue.push(bytes);
			};
			const onEnd = () => {
				ended = true;
				while (waiters.length > 0) waiters.shift()?.({ done: true });
			};
			stream.on("data", onData);
			stream.on("end", onEnd);
			stream.on("error", onEnd);
			return {
				read: () =>
					new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
						const next = queue.shift();
						if (next) {
							resolve({ done: false, value: next });
							return;
						}
						if (ended) {
							resolve({ done: true });
							return;
						}
						waiters.push(resolve);
					}),
				cancel: async () => {
					stream.off("data", onData);
					stream.off("end", onEnd);
					stream.off("error", onEnd);
					stream.destroy();
				},
				releaseLock: () => {},
			};
		},
	};
}

interface FakeRunnerBun {
	api: BunApi;
	spawnedPids: number[];
	killCalls: string[];
}

/**
 * A `BunApi` over `node:child_process` for the kill paths. `unkillable` models
 * a child that survives every signal (`exited` never resolves and `kill` only
 * records) so the bounded post-kill wait is pinned without needing a real
 * unkillable process. It carries a KNOWN bogus pid so the graceful-first kill
 * sequence is pinned against a real pid, not skipped as the pid-less shape.
 */
function createFakeRunnerBun(options: { unkillable?: boolean } = {}): FakeRunnerBun {
	const spawnedPids: number[] = [];
	const killCalls: string[] = [];

	const api: BunApi = {
		env: process.env,
		spawn: (argv, spawnOptions) => {
			const detached = (spawnOptions as { detached?: boolean } | undefined)?.detached;
			if (options.unkillable) {
				return {
					// Known but bogus (far above any OS pid range): the recorded kill
					// calls see a real pid, while the tree-kill syscalls the
					// escalation fires fail harmlessly with "no such process".
					pid: 99_999_999,
					stdout: null,
					stderr: null,
					signalCode: Promise.resolve(null),
					exited: new Promise<number>(() => {}),
					kill: (signal?: number | NodeJS.Signals) => {
						killCalls.push(String(signal ?? "SIGTERM"));
					},
				};
			}
			const child = nodeSpawn(argv[0], argv.slice(1), {
				cwd: spawnOptions?.cwd,
				env: spawnOptions?.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				detached,
			});
			spawnedPids.push(child.pid ?? -1);
			const proc: BunSubprocess = {
				pid: child.pid,
				stdout: wrapNodeStream(child.stdout),
				stderr: wrapNodeStream(child.stderr),
				signalCode: new Promise<string | null>((resolve) => {
					child.on("close", (_code, signal) => resolve(signal));
					child.on("error", () => resolve(null));
				}),
				exited: new Promise<number>((resolve) => {
					child.on("close", (code, signal) => {
						if (code !== null && code !== undefined) resolve(code);
						else if (signal) resolve(128 + signalNumber(signal));
						else resolve(-1);
					});
					child.on("error", () => resolve(-1));
				}),
				kill: (signal?: number | NodeJS.Signals) => {
					killCalls.push(String(signal ?? "SIGTERM"));
					child.kill(signal ?? "SIGTERM");
				},
			};
			return proc;
		},
		file: (path: string) => ({
			exists: async () => existsSync(path),
			text: async () => readFileSync(path, "utf8"),
			delete: async () => {
				rmSync(path, { force: true });
			},
		}),
		write: async (path: string, data: string | Uint8Array) => {
			writeFileSync(path, data);
			return typeof data === "string" ? data.length : data.length;
		},
		$: Object.assign(
			() => {
				throw new Error("fake BunApi.$ is not used by the runner suite");
			},
			{
				cwd: () => {
					throw new Error("fake BunApi.$ is not used by the runner suite");
				},
			},
		),
	};
	return { api, spawnedPids, killCalls };
}

/**
 * A stdout stand-in whose chunks arrive on a schedule and whose pipe then
 * never closes (a surviving grandchild holds it). Unlike `wrapNodeStream`, the
 * `exited` promise resolves on its own schedule while chunks are still in
 * flight — the real-Bun shape where process exit precedes pipe EOF.
 */
function createScheduledPipe(chunks: Array<{ text: string; afterMs: number }>): BunReadableStream {
	const encoder = new TextEncoder();
	let index = 0;
	const started = Date.now();
	return {
		getReader: () => ({
			read: () => {
				if (index >= chunks.length) {
					// A surviving grandchild: the pipe never reaches EOF.
					return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
				}
				const chunk = chunks[index];
				index += 1;
				const wait = Math.max(0, chunk.afterMs - (Date.now() - started));
				return new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
					setTimeout(() => resolve({ done: false, value: encoder.encode(chunk.text) }), wait);
				});
			},
			cancel: async () => {},
			releaseLock: () => {},
		}),
	};
}

/**
 * A `BunApi` whose spawn produces the scheduled-output fake above. Reuses the
 * boring file/write/$ surface of {@link createFakeRunnerBun}; only `spawn`
 * differs.
 */
function createScheduledOutputFake(output: Array<{ text: string; afterMs: number }>, exitAfterMs: number): BunApi {
	const { api } = createFakeRunnerBun({ unkillable: true });
	return {
		...api,
		spawn: () => ({
			pid: undefined,
			stdout: createScheduledPipe(output),
			stderr: null,
			signalCode: new Promise<string | null>((resolve) => {
				setTimeout(() => resolve(null), exitAfterMs);
			}),
			exited: new Promise<number>((resolve) => {
				setTimeout(() => resolve(0), exitAfterMs);
			}),
			kill: () => {},
		}),
	};
}

describe("BunProcessRunner", () => {
	it("constructs without touching the runtime and exposes run()", () => {
		const runner = createBunProcessRunner({ resolveInvocation: () => ({ command: "unused", args: [] }) });
		expect(typeof runner.run).toBe("function");
	});

	it("fails with a clear error when run() is called outside Bun", async () => {
		if (isBunRuntime()) return;
		const runner = createBunProcessRunner({ resolveInvocation: () => ({ command: "unused", args: [] }) });
		await expect(
			runner.run({ spec: { role: "r", instructions: "x" }, task: "x", cwd: process.cwd() }, undefined),
		).rejects.toThrow(/bun/i);
	});

	it.runIf(isBunRuntime())(
		"abort kills the child and reports an aborted result",
		async () => {
			const runner = createBunProcessRunner({
				resolveInvocation: () => ({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] }),
			});
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 300);
			const started = Date.now();
			const result = await runner.run(
				{ spec: { role: "hang", instructions: "" }, task: "hang", cwd: process.cwd() },
				controller.signal,
			);
			expect(result.aborted).toBe(true);
			expect(result.exitCode).not.toBe(0);
			expect(Date.now() - started).toBeLessThan(10_000);
		},
		20_000,
	);

	it.runIf(isBunRuntime())(
		"maps a child's JSONL transcript into events and result",
		async () => {
			const childCode = `const m={role:"assistant",content:[{type:"text",text:"child done"}],usage:{input:5,output:7,totalTokens:12},model:"fake/model"};process.stdout.write(JSON.stringify({type:"message_end",message:m})+String.fromCharCode(10))`;
			const runner = createBunProcessRunner({
				resolveInvocation: () => ({ command: process.execPath, args: ["-e", childCode] }),
			});
			const events: string[] = [];
			const result = await runner.run(
				{ spec: { role: "solo", instructions: "say child done" }, task: "t", cwd: process.cwd() },
				undefined,
				(event) => events.push(event.type),
			);
			expect(result.exitCode).toBe(0);
			expect(result.finalOutput).toBe("child done");
			expect(result.usage.turns).toBe(1);
			expect(events).toEqual(["spawned", "message_end", "exit"]);
		},
		20_000,
	);

	it("timeoutMs kills the child and reports the timeout with the process actually dead", async () => {
		const fake = createFakeRunnerBun();
		const runner = createBunProcessRunner({
			resolveInvocation: () => ({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }),
			bun: fake.api,
		});
		const started = Date.now();
		const result = await runner.run(
			{ spec: { role: "sleeper", instructions: "" }, task: "sleep", cwd: process.cwd(), timeoutMs: 200 },
			undefined,
		);
		expect(result.aborted).toBe(true);
		expect(result.errorMessage).toMatch(/timed out/i);
		expect(result.exitCode).not.toBe(0);
		expect(Date.now() - started).toBeLessThan(10_000);
		const pid = fake.spawnedPids[0];
		expect(pid).toBeGreaterThan(0);
		expect(isProcessAlive(pid)).toBe(false);
	}, 20_000);

	it("a child that survives even a force-kill cannot hang the run", async () => {
		const fake = createFakeRunnerBun({ unkillable: true });
		const runner = createBunProcessRunner({
			resolveInvocation: () => ({ command: "ghost", args: [] }),
			bun: fake.api,
			killGraceMs: 50,
		});
		const started = Date.now();
		const result = await runner.run(
			{ spec: { role: "ghost", instructions: "" }, task: "hang", cwd: process.cwd(), timeoutMs: 20 },
			undefined,
		);
		// Before the bounded post-kill wait this hung forever on `proc.exited`.
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result.aborted).toBe(true);
		expect(result.errorMessage).toMatch(/timed out/i);
		expect(result.exitCode).toBe(HARD_KILL_EXIT_CODE);
		// The signal sequence pins graceful-first WITH a known pid: SIGTERM goes
		// first (pre-fix the first kill was already the hard tree kill when the
		// pid was known) and SIGKILL appears exactly once, from the escalation.
		expect(fake.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
	}, 15_000);

	it("a final JSONL line without a trailing newline arriving during the drain is not dropped", async () => {
		// The real-Bun shape the node fakes cannot produce: `exited` resolves
		// while the pipe is still delivering. The first event is a complete line;
		// the second lacks the trailing newline and arrives inside the post-exit
		// drain window, so it sits in the parser buffer until `flush`. The old
		// ordering (flush before the pump release) saw an empty buffer and
		// dropped the run's last event: messages would be 1 and finalOutput
		// "first".
		const line = (text: string) =>
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					usage: { input: 1, output: 1, totalTokens: 2 },
					model: "fake/model",
				},
			});
		const api = createScheduledOutputFake(
			[
				{ text: `${line("first")}\n`, afterMs: 0 },
				{ text: line("second"), afterMs: 150 },
			],
			60,
		);
		const runner = createBunProcessRunner({
			resolveInvocation: () => ({ command: "ghost", args: [] }),
			bun: api,
		});
		const events: string[] = [];
		const result = await runner.run(
			{ spec: { role: "tail", instructions: "" }, task: "t", cwd: process.cwd() },
			undefined,
			(event) => events.push(event.type),
		);
		expect(result.exitCode).toBe(0);
		expect(result.messages).toHaveLength(2);
		expect(result.finalOutput).toBe("second");
		expect(events).toEqual(["spawned", "message_end", "message_end", "exit"]);
	}, 10_000);
});
