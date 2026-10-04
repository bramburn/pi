/**
 * Integrated dispatch evidence (plan 4.6, audit round 2): the real tool
 * execute → analytics spans → BunProcessRunner → real spawned child →
 * summary back through the tool contract. The Bun-gated cases skip under
 * Node vitest and run under `bun --bun run vitest`; the registration smoke
 * runs everywhere.
 */
import { describe, expect, it } from "vitest";
import { createBunProcessRunner } from "../src/core/subagent/bun-process-runner.ts";
import { isBunRuntime } from "../src/core/subagent/runtime.ts";
import { createSubagentToolDefinition } from "../src/core/subagent/subagent-tool.ts";

const CHILD_OK = [
	'const msg = { role: "assistant", content: [{ type: "text", text: "integrated child summary" }],',
	'\tusage: { input: 1, output: 2, totalTokens: 3 }, model: "fake/model" };',
	'process.stdout.write(JSON.stringify({ type: "message_end", message: msg }) + "\\n");',
].join("\n");

const CHILD_FAIL = 'process.stderr.write("child exploded"); process.exit(3);';

describe("subagent tool integrated dispatch (real child)", () => {
	it.runIf(isBunRuntime())(
		"dispatches through the tool to a real child process and returns the summary",
		async () => {
			const tool = createSubagentToolDefinition(process.cwd(), {
				runner: createBunProcessRunner({
					resolveInvocation: () => ({ command: process.execPath, args: ["-e", CHILD_OK] }),
				}),
			});
			const result = await tool.execute(
				"it1",
				{ role: "scout", instructions: "find it" },
				undefined,
				undefined,
				undefined as never,
			);
			expect((result as { isError?: boolean }).isError).toBeFalsy();
			expect((result.content[0] as { text: string }).text).toContain("integrated child summary");
		},
		20_000,
	);

	it.runIf(isBunRuntime())(
		"maps a failing real child to an error result",
		async () => {
			const tool = createSubagentToolDefinition(process.cwd(), {
				runner: createBunProcessRunner({
					resolveInvocation: () => ({ command: process.execPath, args: ["-e", CHILD_FAIL] }),
				}),
			});
			const result = await tool.execute(
				"it2",
				{ role: "worker", instructions: "go" },
				undefined,
				undefined,
				undefined as never,
			);
			expect((result as { isError?: boolean }).isError).toBe(true);
			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Subagent ");
			expect(text).toContain("child exploded");
		},
		20_000,
	);

	it("constructs the tool with the default runner shape (registration smoke)", () => {
		const tool = createSubagentToolDefinition(process.cwd(), {});
		expect(tool.name).toBe("subagent");
	});
});
