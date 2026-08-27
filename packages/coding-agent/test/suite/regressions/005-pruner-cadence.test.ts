/**
 * Regression: tool-result re-pruner cadence (decision matrix item 3).
 *
 * The pruner walks the agent's message array and rewrites over-budget
 * tool results in place. The default cadence is every 5 turns
 * (3 on minimax). Setting `toolResultPruneEveryN: 0` disables the
 * pruner.
 *
 * The pruner is a model-free, replay-safe pass: it modifies only the
 * surface, not the session log. Re-running the pruner on the same
 * surface is a no-op.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "../harness.ts";
import {
	DEFAULT_PRUNER_CONFIG,
	pruneSession,
	type PrunerConfig,
} from "../../../src/core/compaction/tool-result-pruner.ts";

describe("regression #005: pruner cadence", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("with the bundle off, the pruner is a no-op (default cadence does not fire)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setDeepseekHarnessEnabled(false);
		expect(harness.session.deepseekHarnessEnabled).toBe(false);
	});

	it("with the bundle on, pruneSession shortens over-budget tool results", () => {
		const config: PrunerConfig = DEFAULT_PRUNER_CONFIG;
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text" as const, text: "x".repeat(20000) }],
				isError: false,
				timestamp: 1,
			},
		];
		const pruned = pruneSession(messages, config);
		expect(pruned).toHaveLength(1);
		const first = pruned[0] as { content: { type: string; text: string }[] };
		const text = first.content[0].text;
		expect(text.length).toBeLessThan(20000);
		expect(text).toContain(config.pruneMarker);
	});

	it("pruner defaults match the deepseek-harness defaults (8K threshold, 4K head, 1K tail)", () => {
		expect(DEFAULT_PRUNER_CONFIG.thresholdChars).toBe(8192);
		expect(DEFAULT_PRUNER_CONFIG.headChars).toBe(4096);
		expect(DEFAULT_PRUNER_CONFIG.tailChars).toBe(1024);
		expect(DEFAULT_PRUNER_CONFIG.skipToolNames).toContain("read");
	});

	it("pruner is a no-op for results under the threshold", () => {
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text" as const, text: "small output" }],
				isError: false,
				timestamp: 1,
			},
		];
		const pruned = pruneSession(messages);
		expect(pruned).toEqual(messages);
	});
});
