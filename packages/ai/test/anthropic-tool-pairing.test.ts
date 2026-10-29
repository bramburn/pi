import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Context, Model, ToolCall, ToolResultMessage, UserMessage } from "../src/types.ts";

interface WireContentBlock {
	type: string;
	text?: string;
	tool_use_id?: string;
	is_error?: boolean;
}

interface WireMessage {
	role: string;
	content: string | WireContentBlock[];
}

interface AnthropicPayload {
	messages: WireMessage[];
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

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

function makeToolCallAssistant(toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } } satisfies ToolCall],
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

function makeToolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "output" }],
		isError: false,
		timestamp: 0,
	};
}

function contentBlocks(message: WireMessage): WireContentBlock[] {
	return Array.isArray(message.content) ? message.content : [];
}

async function capturePayload(context: Context): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const stream = streamSimple(makeModel(), context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected payload capture before request");
	return capturedPayload;
}

describe("Anthropic request tool pairing", () => {
	it("keeps tool_result immediately after tool_use when a user message interposes", async () => {
		// The shape produced by a compaction summary re-projected between a tool
		// call and its result (MiniMax 400 (2013) before the fix).
		const payload = await capturePayload({
			messages: [
				makeUser("run the command"),
				makeToolCallAssistant("call_1"),
				makeUser("compacted summary"),
				makeToolResult("call_1"),
			],
		});

		expect(payload.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);

		// tool_result is in the message directly after the tool_use...
		const resultBlock = contentBlocks(payload.messages[2])[0];
		expect(resultBlock.type).toBe("tool_result");
		expect(resultBlock.tool_use_id).toBe("call_1");
		expect(resultBlock.is_error).toBe(false);

		// ...and the interposed user message follows it instead of splitting the
		// pair. Exactly one tool_result: the synthetic duplicate regression would
		// produce two blocks for call_1.
		const toolResults = payload.messages
			.flatMap((message) => contentBlocks(message))
			.filter((block) => block.type === "tool_result");
		expect(toolResults).toHaveLength(1);

		const trailing = contentBlocks(payload.messages[3]);
		expect(trailing.some((block) => block.type === "text" && block.text === "compacted summary")).toBe(true);
	});

	it("still fills a trailing tool call without a result", async () => {
		const payload = await capturePayload({
			messages: [makeUser("run the command"), makeToolCallAssistant("call_1"), makeUser("never mind")],
		});

		expect(payload.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
		const resultBlock = contentBlocks(payload.messages[2])[0];
		expect(resultBlock.type).toBe("tool_result");
		expect(resultBlock.tool_use_id).toBe("call_1");
		expect(resultBlock.is_error).toBe(true);
	});
});
