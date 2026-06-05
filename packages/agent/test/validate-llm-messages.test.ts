import {
	type AssistantMessage,
	type Message,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { validateLlmMessages } from "../src/agent-loop.ts";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMsg(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMsg(toolCallIds: string[] = []): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (toolCallIds.length === 0) {
		content.push({ type: "text", text: "hello" });
	}
	for (const id of toolCallIds) {
		content.push({ type: "toolCall", id, name: "test_tool", arguments: {} });
	}
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolResultMsg(toolCallId: string, toolName = "test_tool"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("validateLlmMessages", () => {
	it("passes for empty messages", () => {
		expect(() => validateLlmMessages([])).not.toThrow();
	});

	it("passes for valid user-assistant-toolResult sequence", () => {
		const messages: Message[] = [
			userMsg("do something"),
			assistantMsg(["call_1"]),
			toolResultMsg("call_1"),
		];
		expect(() => validateLlmMessages(messages)).not.toThrow();
	});

	it("passes when last message is user", () => {
		const messages: Message[] = [userMsg("hello")];
		expect(() => validateLlmMessages(messages)).not.toThrow();
	});

	it("passes when last message is toolResult", () => {
		const messages: Message[] = [
			userMsg("do it"),
			assistantMsg(["call_1"]),
			toolResultMsg("call_1"),
		];
		expect(() => validateLlmMessages(messages)).not.toThrow();
	});

	it("throws when toolResult has no matching assistant toolCall", () => {
		const messages: Message[] = [
			userMsg("do it"),
			assistantMsg([]), // no tool calls
			toolResultMsg("orphaned_call"),
		];
		expect(() => validateLlmMessages(messages)).toThrowError(
			/Extension produced invalid message sequence.*orphaned_call/s,
		);
	});

	it("throws when last message is assistant", () => {
		const messages: Message[] = [
			userMsg("hello"),
			assistantMsg([]),
		];
		expect(() => validateLlmMessages(messages)).toThrowError(
			/Extension produced invalid message sequence.*last message has role "assistant"/s,
		);
	});

	it("passes for multiple valid tool calls", () => {
		const messages: Message[] = [
			userMsg("do things"),
			assistantMsg(["call_1", "call_2"]),
			toolResultMsg("call_1"),
			toolResultMsg("call_2"),
			userMsg("more"),
		];
		expect(() => validateLlmMessages(messages)).not.toThrow();
	});
});