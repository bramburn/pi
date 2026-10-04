/**
 * Bun-process runner behavior (plan 6.2).
 *
 * The runner spawns via Bun.spawn and kills the process tree on abort. The
 * abort/kill case is Bun-only (it spawns real processes); under the Node-based
 * vitest suite it skips and the runtime-gate tests run instead.
 */

import { describe, expect, it } from "vitest";
import { createBunProcessRunner } from "../src/core/subagent/bun-process-runner.ts";
import { isBunRuntime } from "../src/core/subagent/runtime.ts";

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
});
