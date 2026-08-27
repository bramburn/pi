/**
 * Regression: read tool exemption from the pruner (decision matrix item 10).
 *
 * The `read` tool returns a `ToolResultMessage` with
 * `toolName: "read"`. The pruner skips rows with that tool name so
 * a truncated file is not re-truncated to a smaller preview (which
 * would just trigger another read).
 *
 * The harness's `skipToolNames` allowlist is the contract.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_PRUNER_CONFIG, pruneSession } from "../../../src/core/compaction/tool-result-pruner.ts";

describe("regression #006: pruner read exemption", () => {
	it("`read` tool results are never pruned even when the result is over-budget", () => {
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "r1",
				toolName: "read",
				content: [{ type: "text" as const, text: "x".repeat(50000) }],
				isError: false,
				timestamp: 1,
			},
		];
		const pruned = pruneSession(messages, DEFAULT_PRUNER_CONFIG);
		expect(pruned).toEqual(messages);
	});

	it("non-read tool results ARE pruned when over-budget", () => {
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "b1",
				toolName: "bash",
				content: [{ type: "text" as const, text: "x".repeat(50000) }],
				isError: false,
				timestamp: 1,
			},
		];
		const pruned = pruneSession(messages, DEFAULT_PRUNER_CONFIG);
		expect(pruned[0]).not.toEqual(messages[0]);
		const text = (pruned[0] as { content: { type: string; text: string }[] }).content[0].text;
		expect(text).toContain(DEFAULT_PRUNER_CONFIG.pruneMarker);
	});

	it("the `read` exemption is configurable via `skipToolNames`", () => {
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "r1",
				toolName: "read",
				content: [{ type: "text" as const, text: "x".repeat(50000) }],
				isError: false,
				timestamp: 1,
			},
		];
		// With `read` removed from the skip list, the result is pruned.
		const pruned = pruneSession(messages, {
			...DEFAULT_PRUNER_CONFIG,
			skipToolNames: [],
		});
		expect(pruned[0]).not.toEqual(messages[0]);
	});
});
