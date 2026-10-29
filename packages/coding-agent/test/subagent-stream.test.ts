/**
 * Regression test for the subprocess pipe lifetime hang.
 *
 * A subagent is a `pi` process that runs its own tools. Those grandchildren
 * inherit the child's stdout, so the pipe can outlive the child. Under Bun this
 * is observable: after `exited` resolves, `await new Response(proc.stdout).text()`
 * never settles, and `proc.stdout.cancel()` throws `Cannot cancel a locked
 * ReadableStream` because the pending `Response` still holds the lock. The
 * reference extension has the same latent hang.
 *
 * Two layers here:
 *  1. Fake pipes, so the assertion runs under the vitest/Node suite.
 *  2. A real process that leaks a grandchild, skipped unless the runtime is Bun
 *     (the runner is Bun-only, and this suite is not).
 */

import { describe, expect, it } from "vitest";
import { getBun, isBunRuntime } from "../src/core/subagent/runtime.ts";
import { collectStream, createStreamPump } from "../src/core/subagent/stream.ts";

/**
 * A stand-in for a subprocess pipe. `close: false` models a surviving
 * grandchild (the pipe stays open forever); `close: true` models a clean EOF.
 */
function createFakePipe(
	chunks: string[],
	close: boolean,
): {
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
				if (close) return Promise.resolve({ done: true });
				// A surviving grandchild: the pipe stays open forever.
				return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
			},
			cancel: () => Promise.resolve(),
			releaseLock: () => {},
		}),
	};
}

/**
 * A stand-in for a pipe that delivers raw byte chunks. Needed to split a
 * multibyte character across a chunk boundary, which {@link createFakePipe}
 * (a string encoded per chunk) cannot express. `close: false` models a
 * surviving grandchild (the pipe stays open forever); `close: true` models a
 * clean EOF.
 */
function createFakeBytePipe(
	chunks: Uint8Array[],
	close: boolean,
): {
	getReader: () => {
		read: () => Promise<{ done: boolean; value?: Uint8Array }>;
		cancel: (reason?: unknown) => Promise<void>;
		releaseLock: () => void;
	};
} {
	let index = 0;
	return {
		getReader: () => ({
			read: () => {
				if (index < chunks.length) {
					const value = chunks[index];
					index += 1;
					return Promise.resolve({ done: false, value });
				}
				if (close) return Promise.resolve({ done: true });
				return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
			},
			cancel: () => Promise.resolve(),
			releaseLock: () => {},
		}),
	};
}

describe("subagent stream lifetime", () => {
	it("collectStream returns partial output when the writer never closes", async () => {
		const pipe = createFakePipe(["first", "second"], false);
		const started = Date.now();
		const result = await collectStream(pipe, 100);
		const elapsed = Date.now() - started;

		expect(result.text).toBe("firstsecond");
		expect(result.complete).toBe(false);
		expect(elapsed).toBeLessThan(2_000);
	});

	it("collectStream reports a clean EOF as complete", async () => {
		const pipe = createFakePipe(["only"], true);
		const result = await collectStream(pipe, 100);
		expect(result.text).toBe("only");
		expect(result.complete).toBe(true);
	});

	it("createStreamPump streams chunks before release and keeps them", async () => {
		const pipe = createFakePipe(["a", "b", "c"], false);
		const seen: string[] = [];
		const pump = createStreamPump(pipe, (chunk) => seen.push(chunk));

		// Chunks are delivered as they arrive, which is what keeps onUpdate
		// firing while a subagent is still running.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(seen).toEqual(["a", "b", "c"]);

		await pump.release(50);
		expect(pump.text).toBe("abc");
		expect(pump.complete).toBe(false);
	});

	it("release is idempotent", async () => {
		const pipe = createFakePipe(["x"], false);
		const pump = createStreamPump(pipe);
		await pump.release(20);
		await pump.release(20);
		expect(pump.text).toBe("x");
	});

	it("a multibyte character split across two chunks arrives intact", async () => {
		// "a\u20ACb" with the euro sign's three UTF-8 bytes split across the chunk
		// boundary (chunk 1 ends mid-character). Verified under Bun: the streaming
		// decode buffers the partial sequence and the completing bytes in chunk 2
		// deliver the character.
		const bytes = new TextEncoder().encode("a\u20ACb");
		const pipe = createFakeBytePipe([bytes.slice(0, 3), bytes.slice(3)], true);
		const result = await collectStream(pipe, 100);
		expect(result.text).toBe("a\u20ACb");
		expect(result.complete).toBe(true);
	});

	it("a trailing partial multibyte character surfaces at EOF (decoder flush)", async () => {
		// The stream ENDS mid-character ("a" plus 2 of the euro sign's 3 UTF-8
		// bytes): only the EOF flush can emit anything for the buffered bytes.
		// Verified under Bun: `decoder.decode()` flushes them as U+FFFD, so they
		// surface instead of vanishing — without the flush the text is just "a".
		// (A character COMPLETED by a later chunk does not depend on the flush:
		// the streaming decode already delivers it, pinned by the test above.)
		const bytes = new TextEncoder().encode("a\u20AC");
		const pipe = createFakeBytePipe([bytes.slice(0, 3)], true);
		const result = await collectStream(pipe, 100);
		expect(result.text).toBe("a\uFFFD");
		expect(result.complete).toBe(true);
	});

	it("release resolves cleanly when releaseLock throws with a pending read", async () => {
		// The cancel-with-pending-read shape: `cancel()` does not settle the
		// pending `read()` and `releaseLock()` throws like a real locked reader.
		// Pre-guard this rejected `release()` from inside its finally; now the
		// lock teardown is best-effort and the partial output is kept.
		const encoder = new TextEncoder();
		let sent = false;
		const pipe = {
			getReader: () => ({
				read: () => {
					if (!sent) {
						sent = true;
						return Promise.resolve({ done: false, value: encoder.encode("kept") });
					}
					return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
				},
				cancel: () => Promise.resolve(),
				releaseLock: () => {
					throw new Error("Cannot release a locked stream");
				},
			}),
		};
		const pump = createStreamPump(pipe);
		await expect(pump.release(20)).resolves.toBeUndefined();
		expect(pump.text).toBe("kept");
		expect(pump.complete).toBe(false);
	});

	it.runIf(isBunRuntime())(
		"a real grandchild-holding process does not hang collectStream",
		async () => {
			const started = Date.now();
			const proc = getBun().spawn(["bash", "-c", "sleep 30 & echo leaked-partial; exit 0"], {
				stdout: "pipe",
				stderr: "ignore",
				stdin: "ignore",
			});
			const exitCode = await proc.exited;
			const collected = await collectStream(proc.stdout, 500);
			const elapsed = Date.now() - started;

			expect(exitCode).toBe(0);
			expect(collected.text).toContain("leaked-partial");
			expect(elapsed).toBeLessThan(5_000);
		},
		15_000,
	);

	it.runIf(isBunRuntime())(
		"a real closing process reports complete",
		async () => {
			const proc = getBun().spawn(["bash", "-c", "echo done; exit 3"], {
				stdout: "pipe",
				stderr: "ignore",
				stdin: "ignore",
			});
			const collected = await collectStream(proc.stdout, 2_000);
			const exitCode = await proc.exited;
			expect(collected.text.trim()).toBe("done");
			expect(collected.complete).toBe(true);
			expect(exitCode).toBe(3);
		},
		15_000,
	);
});
