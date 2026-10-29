/**
 * `shell.ts` behavior that pins the pipe/process core fixes:
 *
 * 1. Spawn-path output arriving after 500ms must still be captured in full
 *    (the drain grace may only bound the post-exit wait, never the child's
 *    whole lifetime).
 * 2. A throwing `onChunk` consumer must not stop pump consumption.
 * 3. Args with spaces or shell metacharacters arrive as single argv elements
 *    on both backends, and a non-zero exit resolves instead of throwing.
 * 4. `shell: true` with a non-empty `args` array rejects instead of silently
 *    dropping the args.
 * 5. Kill escalation is graceful-first with a known pid: SIGTERM precedes any
 *    SIGKILL, and SIGKILL fires only on the escalation.
 * 6. (Real Bun) the post-exit drain keeps partial output from a
 *    grandchild-held pipe and reports `complete: false`.
 *
 * The suite runs under Node vitest, where no Bun global exists, so a fake
 * `BunApi` backed by `node:child_process` is injected through `ShellOptions.bun`.
 * The fake forwards argv verbatim (no shell), so the probe child reports its
 * real OS-level argv; the `$` fake additionally enforces Bun.$'s one-array
 * interpolation contract, so rebuilding the argv as a string fails loudly.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:os";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	type BunApi,
	type BunReadableStream,
	type BunShell,
	type BunShellCommand,
	type BunShellResult,
	type BunSubprocess,
	isBunRuntime,
} from "../src/core/subagent/runtime.ts";
import { createKillController, runShell } from "../src/core/subagent/shell.ts";
import { createStreamPump } from "../src/core/subagent/stream.ts";

/** Prints its own argv (minus node and the -e script) as JSON. */
const PROBE_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

function signalNumber(signal: NodeJS.Signals): number {
	return constants.signals[signal] ?? 9;
}

/**
 * Adapt a node child stream to the `BunReadableStream` reader shape.
 *
 * Fidelity gap vs real Bun (deliberate, documented): this fake resolves
 * `exited` on the child's 'close' event, which fires AFTER its stdio has
 * closed. Real Bun resolves `exited` at process exit while the pipes may still
 * be open (grandchildren inherit them), so process-level tests built on this
 * fake never exercise the post-exit drain — that path is pinned by the
 * synthetic never-closing pipe below and by the real-Bun grandchild test in
 * this file. Second divergence: a real stream's `cancel()` resolves a pending
 * `read()` with `{ done: true }`, while this fake's `cancel()` leaves the read
 * pending forever; `stream.ts` handles both shapes.
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

interface FakeBun {
	api: BunApi;
	spawnedPids: number[];
	killCalls: string[];
}

/**
 * A `BunApi` over `node:child_process`: argv is forwarded verbatim to the OS
 * (no shell), matching `Bun.spawn`'s argv contract.
 */
function createFakeBun(): FakeBun {
	const spawnedPids: number[] = [];
	const killCalls: string[] = [];

	const startNodeChild = (
		argv: string[],
		opts: { cwd?: string; env?: Record<string, string | undefined>; detached?: boolean },
	): ChildProcess => {
		const child = nodeSpawn(argv[0], argv.slice(1), {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: opts.detached,
		});
		spawnedPids.push(child.pid ?? -1);
		return child;
	};

	const makeShell = (cwd: string | undefined): BunShell =>
		Object.assign(
			(strings: TemplateStringsArray, ...values: unknown[]): BunShellCommand => {
				// Bun.$ spreads and escapes a single interpolated argv array
				// (verified under Bun). Any other interpolation shape means the
				// caller rebuilt a command line by hand — fail loudly instead of
				// emulating quoting this module must never do.
				if (
					strings.length !== 2 ||
					strings[0] !== "" ||
					strings[1] !== "" ||
					values.length !== 1 ||
					!Array.isArray(values[0])
				) {
					throw new Error(
						"fake BunShell only supports shell with one interpolated argv array ([command, ...args])",
					);
				}
				const argv = (values[0] as string[]).map(String);
				let envOverride: Record<string, string> | undefined;
				const command: BunShellCommand = {
					quiet: () => command,
					env: (vars) => {
						envOverride = { ...vars };
						return command;
					},
					nothrow: () =>
						new Promise<BunShellResult>((resolve) => {
							const child = startNodeChild(argv, { cwd, env: envOverride });
							const stdout: Buffer[] = [];
							const stderr: Buffer[] = [];
							child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
							child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
							const finish = (exitCode: number) => {
								const out = new Uint8Array(Buffer.concat(stdout));
								const err = new Uint8Array(Buffer.concat(stderr));
								resolve({
									exitCode,
									stdout: out,
									stderr: err,
									text: async () => new TextDecoder().decode(out),
								});
							};
							child.on("close", (code, signal) => {
								if (code !== null && code !== undefined) finish(code);
								else if (signal) finish(128 + signalNumber(signal));
								else finish(-1);
							});
							child.on("error", () => finish(-1));
						}),
				};
				return command;
			},
			{ cwd: (path: string): BunShell => makeShell(path) },
		);

	const api: BunApi = {
		env: process.env,
		spawn: (argv, spawnOptions) => {
			const detached = (spawnOptions as { detached?: boolean } | undefined)?.detached;
			const child = startNodeChild(argv, { cwd: spawnOptions?.cwd, env: spawnOptions?.env, detached });
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
		file: () => {
			throw new Error("fake BunApi.file is not used by the shell suite");
		},
		write: () => {
			throw new Error("fake BunApi.write is not used by the shell suite");
		},
		$: makeShell(undefined),
	};

	return { api, spawnedPids, killCalls };
}

/**
 * A stand-in for a pipe whose writer never closes: the surviving-grandchild
 * shape, without needing a grandchild.
 */
function createNeverClosingPipe(chunks: string[]): {
	getReader: () => {
		read: () => Promise<{ done: boolean; value?: Uint8Array }>;
		cancel: (reason?: unknown) => Promise<void>;
		releaseLock: () => void;
	};
} {
	const encoder = new TextEncoder();
	let index = 0;
	return {
		getReader: () => ({
			read: () => {
				if (index < chunks.length) {
					const value = encoder.encode(chunks[index]);
					index += 1;
					return Promise.resolve({ done: false, value });
				}
				return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
			},
			cancel: () => Promise.resolve(),
			releaseLock: () => {},
		}),
	};
}

describe("subagent shell argv and output", () => {
	it("spawn path delivers 'a b' and 'c;echo injected' as single argv elements", async () => {
		const fake = createFakeBun();
		const result = await runShell(process.execPath, ["-e", PROBE_ARGV, "a b", "c;echo injected"], {
			cwd: process.cwd(),
			timeoutMs: 5_000,
			bun: fake.api,
		});
		expect(result.exitCode).toBe(0);
		expect(result.complete).toBe(true);
		const printed = JSON.parse(result.stdout) as string[];
		expect(printed).toHaveLength(2);
		expect(printed).toEqual(["a b", "c;echo injected"]);
	});

	it("$ path delivers 'a b' and 'c;echo injected' as single argv elements", async () => {
		const fake = createFakeBun();
		const result = await runShell(process.execPath, ["-e", PROBE_ARGV, "a b", "c;echo injected"], {
			cwd: process.cwd(),
			bun: fake.api,
		});
		expect(result.exitCode).toBe(0);
		const printed = JSON.parse(result.stdout) as string[];
		expect(printed).toHaveLength(2);
		expect(printed).toEqual(["a b", "c;echo injected"]);
	});

	it("a non-zero exit resolves with the exit code on both backends instead of throwing", async () => {
		const fake = createFakeBun();
		const spawnPath = await runShell(process.execPath, ["-e", "process.exit(3)"], {
			cwd: process.cwd(),
			timeoutMs: 5_000,
			bun: fake.api,
		});
		expect(spawnPath.exitCode).toBe(3);
		const dollarPath = await runShell(process.execPath, ["-e", "process.exit(4)"], {
			cwd: process.cwd(),
			bun: fake.api,
		});
		expect(dollarPath.exitCode).toBe(4);
	});

	it("spawn path captures output that arrives after 500ms in full", async () => {
		const fake = createFakeBun();
		const code = "process.stdout.write('head'); setTimeout(() => process.stdout.write('tail'), 700)";
		const result = await runShell(process.execPath, ["-e", code], {
			cwd: process.cwd(),
			timeoutMs: 5_000,
			bun: fake.api,
		});
		// Before the pump-then-exit fix the 500ms drain grace raced the child's
		// whole lifetime and silently dropped 'tail' (complete=false).
		expect(result.stdout).toBe("headtail");
		expect(result.complete).toBe(true);
		expect(result.exitCode).toBe(0);
	}, 15_000);

	it("shell: true with a non-empty args array rejects instead of dropping the args", async () => {
		const fake = createFakeBun();
		await expect(runShell("echo", ["hi"], { cwd: process.cwd(), shell: true, bun: fake.api })).rejects.toThrow(
			/args/,
		);
	});

	it.runIf(isBunRuntime())("real Bun backends keep both probe args as single argv elements", async () => {
		for (const options of [{ cwd: process.cwd(), timeoutMs: 5_000 }, { cwd: process.cwd() }]) {
			const result = await runShell(process.execPath, ["-e", PROBE_ARGV, "a b", "c;echo injected"], options);
			expect(result.exitCode).toBe(0);
			const printed = JSON.parse(result.stdout) as string[];
			expect(printed.slice(-2)).toEqual(["a b", "c;echo injected"]);
		}
	});

	it.runIf(isBunRuntime())(
		"real Bun: a grandchild holding the pipes open past exit is drained and cut at the grace",
		async () => {
			const started = Date.now();
			// bash exits immediately; the backgrounded sleep inherits both pipes
			// and holds them open past the child's exit — the real-Bun shape the
			// node fakes cannot produce (their `exited` resolves post-stdio).
			const result = await runShell("bash", ["-c", "sleep 5 & echo leaked-partial; exit 0"], {
				cwd: process.cwd(),
				timeoutMs: 5_000,
			});
			expect(result.exitCode).toBe(0);
			// Output written before the exit and read during the post-exit drain
			// is kept: the drain grace bounds the wait, not the child's lifetime.
			expect(result.stdout).toContain("leaked-partial");
			// The grandchild held the pipe, so the drain was cut short at the
			// grace instead of reaching EOF on its own.
			expect(result.complete).toBe(false);
			expect(result.timedOut).toBe(false);
			expect(Date.now() - started).toBeLessThan(5_000);
		},
		15_000,
	);
});

describe("subagent kill escalation", () => {
	it("killOnce is graceful-first and SIGKILL fires only on escalation", async () => {
		// A KNOWN pid, so graceful-first is pinned end to end: pre-fix the first
		// kill was already the hard tree kill (SIGKILL / `taskkill /F`) whenever
		// the pid was known, and `proc.kill("SIGTERM")` only ran otherwise.
		const killCalls: string[] = [];
		const proc: BunSubprocess = {
			// Known but bogus (far above any OS pid range): the tree-kill syscalls
			// `killHard` fires fail harmlessly with "no such process".
			pid: 99_999_999,
			stdout: null,
			stderr: null,
			signalCode: new Promise<string | null>(() => {}),
			exited: new Promise<number>(() => {}),
			kill: (signal?: number | NodeJS.Signals) => {
				killCalls.push(String(signal ?? "SIGTERM"));
			},
		};
		const kills = createKillController(proc, 600);
		// Graceful first: SIGTERM only, and a second killOnce stays idempotent.
		kills.killOnce();
		expect(killCalls).toEqual(["SIGTERM"]);
		kills.killOnce();
		expect(killCalls).toEqual(["SIGTERM"]);
		// Still no SIGKILL before the grace expires.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(killCalls).toEqual(["SIGTERM"]);
		// The escalation is the only source of SIGKILL, and it comes after SIGTERM.
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(killCalls).toEqual(["SIGTERM", "SIGKILL"]);
		kills.dispose();
	});
});

describe("subagent pump consumer isolation", () => {
	it("a throwing onChunk does not stop consumption of later chunks", async () => {
		const pipe = createNeverClosingPipe(["a", "b", "c"]);
		const seen: string[] = [];
		const pump = createStreamPump(pipe, (chunk) => {
			seen.push(chunk);
			if (seen.length === 1) throw new Error("consumer boom");
		});
		await pump.release(50);
		// Before the fix the consumer exception tripped the read loop's catch
		// and deadheaded the pipe after the first chunk.
		expect(seen).toEqual(["a", "b", "c"]);
		expect(pump.text).toBe("abc");
	});
});
