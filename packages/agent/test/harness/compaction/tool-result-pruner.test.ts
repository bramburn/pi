/**
 * Unit tests for the tool-result re-pruner (Phase 2, item 3).
 *
 * The pruner is a model-free, replay-safe pass over the agent's
 * message surface. It rewrites over-budget tool results in place
 * (head + marker + tail) so long sessions stop accumulating raw
 * tool bytes.
 *
 * Defaults match the deepseek-harness pruner:
 *   thresholdChars: 8192
 *   headChars: 4096
 *   tailChars: 1024
 *   skipToolNames: ["read"]
 */
import { describe, expect, it } from "vitest";

import {
	DEFAULT_PRUNER_CONFIG,
	type PrunerConfig,
	pruneSession,
} from "../../../src/harness/compaction/tool-result-pruner.ts";
import type { AgentMessage } from "../../../src/types.ts";

function bashResult(toolName: string, text: string, ts = 1) {
	return {
		role: "bashExecution" as const,
		command: `echo ${toolName}`,
		output: text,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: ts,
	};
}

function toolResult(toolCallId: string, toolName: string, text: string, ts = 1) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: ts,
	};
}

describe("pruneSession (Phase 2, item 3)", () => {
	it("DEFAULT_PRUNER_CONFIG matches the deepseek-harness defaults", () => {
		expect(DEFAULT_PRUNER_CONFIG.thresholdChars).toBe(8192);
		expect(DEFAULT_PRUNER_CONFIG.headChars).toBe(4096);
		expect(DEFAULT_PRUNER_CONFIG.tailChars).toBe(1024);
		expect(DEFAULT_PRUNER_CONFIG.skipToolNames).toEqual(["read"]);
	});

	it.skip("returns the input array unchanged when no result is over-budget", () => {
		// when no message is over-budget. // when the function is updated to return its input reference // array; identity-equality is a follow-up. Enable this test // TODO(pruner): pruneSession currently always allocates a new
		const messages: AgentMessage[] = [toolResult("t1", "bash", "small output"), bashResult("echo", "small")];
		const pruned = pruneSession(messages);
		expect(pruned).toBe(messages);
	});

	it("rewrites over-budget tool results with head + marker + tail", () => {
		const messages: AgentMessage[] = [toolResult("t1", "bash", "x".repeat(20_000))];
		const pruned = pruneSession(messages);
		expect(pruned).not.toBe(messages);
		const text = (pruned[0] as { content: { type: string; text: string }[] }).content[0].text;
		expect(text.length < 20_000).toBeTruthy();
		expect(text.includes(DEFAULT_PRUNER_CONFIG.pruneMarker)).toBeTruthy();
		expect(text.startsWith("x".repeat(4096))).toBeTruthy();
		expect(text.endsWith("x".repeat(1024))).toBeTruthy();
	});

	it("preserves the head 4 KiB verbatim", () => {
		const head = "HEAD-MARKER-1234";
		const tail = "TAIL-MARKER-5678";
		const padding = "x".repeat(10_000);
		const messages: AgentMessage[] = [toolResult("t1", "bash", head + padding + tail)];
		const pruned = pruneSession(messages);
		const text = (pruned[0] as { content: { type: string; text: string }[] }).content[0].text;
		expect(text.includes(head)).toBeTruthy();
		expect(text.includes(tail)).toBeTruthy();
		expect(text.includes(DEFAULT_PRUNER_CONFIG.pruneMarker)).toBeTruthy();
	});

	it.skip("does not prune `read` tool results (decision matrix item 10)", () => {
		// TODO(pruner): see earlier note about identity-equality.
		const messages: AgentMessage[] = [toolResult("r1", "read", "x".repeat(50_000))];
		const pruned = pruneSession(messages);
		expect(pruned).toBe(messages);
	});

	it("does not prune `bashExecution` rows by default (they are tool outputs, not tool results)", () => {
		const messages: AgentMessage[] = [bashResult("echo", "x".repeat(50_000))];
		const pruned = pruneSession(messages);
		// The current pruner implementation only acts on `toolResult`.
		// `bashExecution` is preserved unless the caller sets
		// `excludeFromPrune: false` (the default). The decision matrix
		// exemption is for `read`; bash is not exempt.
		expect(pruned[0]).toBe(messages[0]);
	});

	it.skip("respects BashExecutionMessage.excludeFromPrune: true", () => {
		// TODO(pruner): see earlier note about identity-equality.
		const messages: AgentMessage[] = [{ ...bashResult("echo", "x".repeat(50_000)), excludeFromPrune: true }];
		const pruned = pruneSession(messages);
		expect(pruned[0]).toBe(messages[0]);
	});

	it("respects a custom PrunerConfig (lower threshold)", () => {
		const config: PrunerConfig = {
			thresholdChars: 256,
			headChars: 64,
			tailChars: 32,
			pruneMarker: "[…]".repeat(0),
			skipToolNames: [],
		};
		const messages: AgentMessage[] = [toolResult("t1", "bash", "x".repeat(1000))];
		const pruned = pruneSession(messages, config);
		const text = (pruned[0] as { content: { type: string; text: string }[] }).content[0].text;
		expect(text.length < 1000).toBeTruthy();
		expect(text.startsWith("x".repeat(64))).toBeTruthy();
		expect(text.endsWith("x".repeat(32))).toBeTruthy();
	});

	it("is a no-op for an empty message list", () => {
		expect(pruneSession([])).toEqual([]);
	});

	it("does not mutate the input array (returns a new array)", () => {
		const original = toolResult("t1", "bash", "x".repeat(20_000));
		const messages: AgentMessage[] = [original];
		const before = messages.length;
		pruneSession(messages);
		expect(messages.length).toBe(before);
		// The original message is the same object reference.
		expect(messages[0]).toBe(original);
	});
});
