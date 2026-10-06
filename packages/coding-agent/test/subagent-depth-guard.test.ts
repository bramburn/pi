import { describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS, type ResolvedSubagentSettings } from "../src/core/defaults.ts";
import { createSubagentToolDefinition } from "../src/core/subagent/subagent-tool.ts";
import type { SubagentResult, SubagentRunner, SubagentRunRequest } from "../src/core/subagent/types.ts";
import { createEmptyUsage } from "../src/core/subagent/types.ts";

/**
 * REQ-D01 / REQ-D02 — delegation depth guard.
 *
 * The fork bomb this closes: every child is a separate `pi` process with its own
 * `totalSpawnCount` starting at zero, and the default child tool set includes
 * `subagent`, so a child could keep delegating. Depth is the only bound that
 * crosses the process boundary.
 */

function capturingRunner(capture: { depths: number[] }): SubagentRunner {
	return {
		async run(request: SubagentRunRequest): Promise<SubagentResult> {
			capture.depths.push(request.depth ?? 0);
			return {
				role: request.spec.role,
				task: request.task,
				exitCode: 0,
				aborted: false,
				finalOutput: "ok",
				stderr: "",
				usage: createEmptyUsage(),
				messages: [],
			};
		},
	};
}

function settingsWith(maxDepth: number): () => ResolvedSubagentSettings {
	return () => ({ ...DEFAULT_SUBAGENT_SETTINGS, maxDepth });
}

// execute(toolCallId, params, signal, onUpdate, context)
const CALL_ARGS = [undefined, undefined, undefined as never] as const;

describe("delegation depth guard (REQ-D01)", () => {
	it("spawns a child at depth 1 from the top-level session", async () => {
		const capture = { depths: [] as number[] };
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: capturingRunner(capture),
			subagentSettings: settingsWith(1),
			depth: 0,
		});
		await tool.execute("d1", { role: "scout", instructions: "look" }, ...CALL_ARGS);
		expect(capture.depths).toEqual([1]);
	});

	it("refuses to spawn past maxDepth and names the limit", async () => {
		const capture = { depths: [] as number[] };
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: capturingRunner(capture),
			subagentSettings: settingsWith(1),
			depth: 1,
		});
		await expect(tool.execute("d2", { role: "scout", instructions: "look" }, ...CALL_ARGS)).rejects.toThrow(
			/depth limit reached/i,
		);
		// The message must tell the model what to do instead, not just refuse.
		await expect(tool.execute("d2b", { role: "scout", instructions: "look" }, ...CALL_ARGS)).rejects.toThrow(
			/subagent\.maxDepth/,
		);
		expect(capture.depths).toEqual([]);
	});

	it("refuses every spawn mode at depth, not just single", async () => {
		const capture = { depths: [] as number[] };
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: capturingRunner(capture),
			subagentSettings: settingsWith(1),
			depth: 1,
		});
		await expect(
			tool.execute(
				"d3",
				{
					tasks: [
						{ role: "a", instructions: "x" },
						{ role: "b", instructions: "y" },
					],
				},
				...CALL_ARGS,
			),
		).rejects.toThrow(/depth limit reached/i);
		await expect(
			tool.execute(
				"d4",
				{
					chain: [
						{ role: "a", instructions: "x" },
						{ role: "b", instructions: "y" },
					],
				},
				...CALL_ARGS,
			),
		).rejects.toThrow(/depth limit reached/i);
		expect(capture.depths).toEqual([]);
	});

	it("maxDepth 0 forbids delegation from the top-level session", async () => {
		const capture = { depths: [] as number[] };
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: capturingRunner(capture),
			subagentSettings: settingsWith(0),
			depth: 0,
		});
		await expect(tool.execute("d5", { role: "scout", instructions: "look" }, ...CALL_ARGS)).rejects.toThrow(
			/depth limit reached/i,
		);
		expect(capture.depths).toEqual([]);
	});

	it("permits grandchildren when maxDepth is raised", async () => {
		const capture = { depths: [] as number[] };
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: capturingRunner(capture),
			subagentSettings: settingsWith(2),
			depth: 1,
		});
		await tool.execute("d6", { role: "scout", instructions: "look" }, ...CALL_ARGS);
		expect(capture.depths).toEqual([2]);
	});

	it("defaults to depth 0 when the harness supplies none", async () => {
		const capture = { depths: [] as number[] };
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: capturingRunner(capture),
			subagentSettings: settingsWith(1),
		});
		await tool.execute("d7", { role: "scout", instructions: "look" }, ...CALL_ARGS);
		expect(capture.depths).toEqual([1]);
	});
});
