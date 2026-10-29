import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	type CompactionEntry,
	type CustomMessageEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";

function user(id: string, parentId: string | null, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistantToolCall(
	id: string,
	parentId: string | null,
	toolCallId: string,
	toolName: string,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

function toolResult(
	id: string,
	parentId: string | null,
	toolCallId: string,
	toolName: string,
	text = "done",
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 1,
		},
	};
}

function customMessage(id: string, parentId: string | null, content: string): CustomMessageEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		customType: "pi-goal-event",
		content,
		display: false,
	};
}

function compaction(id: string, parentId: string | null, summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

describe("tool call / tool result pairing in projected context", () => {
	it("re-projected compaction summary does not split a tool call from its result", () => {
		// Real session shape: auto-compaction persisted its entry between the
		// assistant tool call message and its tool result; a second compaction
		// re-projects the old summary at its physical position.
		const entries: SessionEntry[] = [
			user("1", null, "first"),
			assistantToolCall("2", "1", "call_a", "update_goal"),
			compaction("3", "2", "first summary", "2"),
			toolResult("4", "3", "call_a", "update_goal"),
			user("5", "4", "second"),
			compaction("6", "5", "second summary", "2"),
			user("7", "6", "third"),
		];

		const messages = buildSessionContext(entries).messages;

		expect(messages.map((m) => m.role)).toEqual([
			"compactionSummary",
			"assistant",
			"toolResult",
			"compactionSummary",
			"user",
			"user",
		]);
		// The tool result directly follows its tool call, with no user-role
		// message (the old compaction summary) in between.
		expect(messages[1]).toMatchObject({ role: "assistant" });
		expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call_a" });
		// Content is preserved: the old summary moved after the pair.
		expect(messages[0]).toMatchObject({ role: "compactionSummary", summary: "second summary" });
		expect(messages[3]).toMatchObject({ role: "compactionSummary", summary: "first summary" });
	});

	it("custom message between a tool call and its result moves after the result", () => {
		const entries: SessionEntry[] = [
			user("1", null, "first"),
			assistantToolCall("2", "1", "call_a", "bash"),
			customMessage("3", "2", "<pi_goal_event/>"),
			toolResult("4", "3", "call_a", "bash"),
			user("5", "4", "second"),
		];

		const messages = buildSessionContext(entries).messages;

		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "custom", "user"]);
		expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call_a" });
	});

	it("orphaned tool result whose call was compacted away becomes a user message", () => {
		// The cut point landed on a custom message between the tool call and its
		// result: the kept span has the result but not its call.
		const entries: SessionEntry[] = [
			user("1", null, "first"),
			assistantToolCall("2", "1", "call_a", "update_goal"),
			customMessage("3", "2", "goal checkpoint"),
			toolResult("4", "3", "call_a", "update_goal", "goal marked complete"),
			compaction("5", "4", "summary", "3"),
		];

		const messages = buildSessionContext(entries).messages;

		expect(messages.map((m) => m.role)).toEqual(["compactionSummary", "custom", "user"]);
		// The tool result content survives as plain user content instead of a
		// dangling tool_result block that providers reject.
		expect(messages[2]).toMatchObject({
			role: "user",
			content: expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining("goal marked complete") }),
			]),
		});
	});

	it("healthy tool pair sequence passes through unchanged", () => {
		const entries: SessionEntry[] = [
			user("1", null, "first"),
			assistantToolCall("2", "1", "call_a", "bash"),
			toolResult("3", "2", "call_a", "bash"),
			user("4", "3", "second"),
		];

		const messages = buildSessionContext(entries).messages;

		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
	});
});
