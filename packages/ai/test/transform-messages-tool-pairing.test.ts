import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type {
	AssistantMessage,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../src/types.ts";

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function makeUser(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function makeAssistant(content: (TextContent | ToolCall)[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4.6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function makeToolCall(id: string, name = "bash"): ToolCall {
	return { type: "toolCall", id, name, arguments: { command: "ls" } };
}

function makeToolResult(toolCallId: string, text = "output"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

describe("transformMessages keeps tool results adjacent to their tool calls", () => {
	it("defers a user message between a tool call and its later result", () => {
		const messages: Message[] = [
			makeUser("run the command"),
			makeAssistant([makeToolCall("tc-1")]),
			makeUser("compacted summary"),
			makeToolResult("tc-1"),
		];

		const out = transformMessages(messages, makeModel());

		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		// The real result is used; no synthetic duplicate for tc-1.
		expect(out[2]).toMatchObject({ role: "toolResult", toolCallId: "tc-1", isError: false });
		expect(out[3]).toMatchObject({ role: "user", content: "compacted summary" });
	});

	it("keeps multiple results contiguous when a user message interposes", () => {
		const messages: Message[] = [
			makeAssistant([makeToolCall("tc-1"), makeToolCall("tc-2")]),
			makeToolResult("tc-1", "first output"),
			makeUser("steering message"),
			makeToolResult("tc-2", "second output"),
		];

		const out = transformMessages(messages, makeModel());

		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "user"]);
		expect(out[1]).toMatchObject({ role: "toolResult", toolCallId: "tc-1" });
		expect(out[2]).toMatchObject({ role: "toolResult", toolCallId: "tc-2" });
		expect(out[3]).toMatchObject({ role: "user", content: "steering message" });
	});

	it("still synthesizes a result when an interrupted call never resolves", () => {
		const messages: Message[] = [makeAssistant([makeToolCall("tc-1")]), makeUser("never mind, do something else")];

		const out = transformMessages(messages, makeModel());

		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
		expect(out[1]).toMatchObject({
			role: "toolResult",
			toolCallId: "tc-1",
			isError: true,
			content: [{ type: "text", text: "No result provided" }],
		});
		expect(out[2]).toMatchObject({ role: "user", content: "never mind, do something else" });
	});

	it("synthesizes only missing results before a following assistant message", () => {
		const messages: Message[] = [
			makeAssistant([makeToolCall("tc-1"), makeToolCall("tc-2")]),
			makeToolResult("tc-1"),
			makeUser("keep going"),
			makeAssistant([{ type: "text", text: "continuing" }]),
		];

		const out = transformMessages(messages, makeModel());

		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "toolResult", "user", "assistant"]);
		expect(out[2]).toMatchObject({
			role: "toolResult",
			toolCallId: "tc-2",
			isError: true,
			content: [{ type: "text", text: "No result provided" }],
		});
	});
});
