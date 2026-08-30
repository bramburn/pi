import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model, TextContent, ToolResultMessage } from "../src/types.ts";

const FFFD = "\uFFFD";

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

function makeAssistant(content: TextContent[]): AssistantMessage {
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
		stopReason: "stop",
		timestamp: 0,
	};
}

function makeToolResult(content: TextContent[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "search",
		content,
		isError: false,
		timestamp: 0,
	};
}

describe("transformMessages sanitizes invalid text", () => {
	it("strips U+FFFD from a user message with string content", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: `Puppy Vaccination UK ${FFFD} A First-Year Vaccine Plan`, timestamp: 0 },
		];
		const [out] = transformMessages(messages, model);
		expect(out.role).toBe("user");
		if (out.role === "user" && typeof out.content === "string") {
			expect(out.content).toBe("Puppy Vaccination UK A First-Year Vaccine Plan");
			expect(out.content).not.toContain(FFFD);
		} else {
			throw new Error("expected user string content");
		}
	});

	it("strips U+FFFD from user message text blocks", () => {
		const model = makeModel();
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: `bad ${FFFD} char` }],
				timestamp: 0,
			},
		];
		const [out] = transformMessages(messages, model);
		if (out.role === "user" && Array.isArray(out.content)) {
			const block = out.content[0];
			expect(block.type).toBe("text");
			if (block.type === "text") {
				expect(block.text).toBe("bad  char".replace(/ {2,}/g, " "));
				expect(block.text).not.toContain(FFFD);
			}
		} else {
			throw new Error("expected user array content");
		}
	});

	it("strips U+FFFD from assistant message text blocks", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: 0 },
			makeAssistant([{ type: "text", text: `reply ${FFFD} with mojibake` }]),
		];
		const out = transformMessages(messages, model);
		const assistant = out[1];
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		const block = assistant.content[0];
		if (block.type !== "text") throw new Error("expected text block");
		expect(block.text).toBe("reply with mojibake");
		expect(block.text).not.toContain(FFFD);
	});

	it("strips U+FFFD from tool result text blocks", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: 0 },
			makeAssistant([{ type: "text", text: "calling tool" }]),
			makeToolResult([{ type: "text", text: `tool said ${FFFD} something` }]),
		];
		const out = transformMessages(messages, model);
		const toolResult = out[2];
		if (toolResult.role !== "toolResult") throw new Error("expected toolResult");
		const block = toolResult.content[0];
		if (block.type !== "text") throw new Error("expected text block");
		expect(block.text).toBe("tool said something");
		expect(block.text).not.toContain(FFFD);
	});

	it("preserves clean text without changing object identity (no needless clone)", () => {
		const model = makeModel();
		const textBlock: TextContent = { type: "text", text: "perfectly clean text" };
		const messages: Message[] = [
			{
				role: "user",
				content: [textBlock],
				timestamp: 0,
			},
		];
		const [out] = transformMessages(messages, model);
		if (out.role !== "user" || !Array.isArray(out.content)) throw new Error("expected user array");
		// Same reference — sanitizer should not clone when nothing changed.
		expect(out.content[0]).toBe(textBlock);
	});

	it("preserves a valid surrogate pair in text content", () => {
		const model = makeModel();
		const emoji = "𝄞"; // U+1D11E, surrogate pair \uD834\uDD1E
		const messages: Message[] = [{ role: "user", content: `play ${emoji} tune`, timestamp: 0 }];
		const [out] = transformMessages(messages, model);
		if (out.role === "user" && typeof out.content === "string") {
			expect(out.content).toBe(`play ${emoji} tune`);
		} else {
			throw new Error("expected user string content");
		}
	});
});
