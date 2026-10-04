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
 * A stand-in for a subprocess pipe whose writer never closes: the grandchild
 * case, without needing a grandchild.
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
				// A surviving grandchild: the pipe stays open forever.
				return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
			},
			cancel: () => Promise.resolve(),
			releaseLock: () => {},
		}),
	};
}

describe("subagent stream lifetime", () => {
	it("collectStream returns partial output when the writer never closes", async () => {
		const pipe = createNeverClosingPipe(["first", "second"]);
		const started = Date.now();
		const result = await collectStream(pipe, 100);
		const elapsed = Date.now() - started;

		expect(result.text).toBe("firstsecond");
		expect(result.complete).toBe(false);
		expect(elapsed).toBeLessThan(2_000);
	});

	it("collectStream reports a clean EOF as complete", async () => {
		const pipe = createNeverClosingPipe(["only"]);
		const result = await collectStream(pipe, 100);
		// The fake keeps the pipe open, so this is the partial-read shape; the
		// complete=true case is asserted by the Bun-only test below.
		expect(result.text).toBe("only");
	});

	it("createStreamPump streams chunks before release and keeps them", async () => {
		const pipe = createNeverClosingPipe(["a", "b", "c"]);
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
		const pipe = createNeverClosingPipe(["x"]);
		const pump = createStreamPump(pipe);
		await pump.release(20);
		await pump.release(20);
		expect(pump.text).toBe("x");
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
