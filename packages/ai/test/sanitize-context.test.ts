import { describe, expect, it } from "vitest";
import { sanitizeContext, sanitizeMessages } from "../src/api/transform-messages.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "../src/types.ts";

const FFFD = "\uFFFD";
const UNPAIRED_HIGH = "\uD834";
const UNPAIRED_LOW = "\uDD1E";

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

function makeUser(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function makeContext(messages: Message[], systemPrompt = "You are a helpful assistant."): Context {
	return { systemPrompt, messages };
}

describe("sanitizeMessages", () => {
	it("strips U+FFFD from a user message with string content", () => {
		const messages: Message[] = [makeUser(`Puppy ${FFFD} vaccination`)];
		const out = sanitizeMessages(messages);
		const m = out[0]!;
		if (m.role !== "user" || typeof m.content !== "string") throw new Error("expected user string");
		expect(m.content).toBe("Puppy vaccination");
		expect(m.content).not.toContain(FFFD);
	});

	it("strips U+FFFD and unpaired surrogates from user/assistant/toolResult text blocks", () => {
		const messages: Message[] = [
			makeUser([{ type: "text", text: `bad ${FFFD} char ${UNPAIRED_HIGH}` }]),
			makeAssistant([{ type: "text", text: `reply ${FFFD} ${UNPAIRED_LOW}` }]),
			makeToolResult([{ type: "text", text: `tool ${FFFD} output ${UNPAIRED_HIGH}` }]),
		];
		const out = sanitizeMessages(messages);

		const userBlock = (out[0] as { content: TextContent[] }).content[0]!;
		expect(userBlock.text).not.toContain(FFFD);
		expect(userBlock.text).not.toMatch(/[\uD800-\uDFFF]/);

		const asstBlockRaw = (out[1] as AssistantMessage).content[0]!;
		if (asstBlockRaw.type !== "text") throw new Error("expected text block");
		expect(asstBlockRaw.text).not.toContain(FFFD);
		expect(asstBlockRaw.text).not.toMatch(/[\uD800-\uDFFF]/);

		const trBlock = (out[2] as ToolResultMessage).content[0]!;
		if (trBlock.type !== "text") throw new Error("expected text block");
		expect(trBlock.text).not.toContain(FFFD);
		expect(trBlock.text).not.toMatch(/[\uD800-\uDFFF]/);
	});

	it("returns the same array reference when no sanitisation was needed", () => {
		const messages: Message[] = [makeUser("clean text"), makeAssistant([{ type: "text", text: "ok" }])];
		const out = sanitizeMessages(messages);
		expect(out).toBe(messages);
	});

	it("preserves a valid surrogate pair in text content", () => {
		const emoji = "𝄞"; // U+1D11E, surrogate pair \uD834\uDD1E
		const messages: Message[] = [makeUser(`play ${emoji} tune`)];
		const out = sanitizeMessages(messages);
		const m = out[0]!;
		if (m.role !== "user" || typeof m.content !== "string") throw new Error("expected user string");
		expect(m.content).toBe(`play ${emoji} tune`);
	});

	it("does not clone a message that did not need cleaning", () => {
		const clean = makeUser("clean");
		const dirty = makeUser(`bad ${FFFD} text`);
		const out = sanitizeMessages([clean, dirty]);
		expect(out[0]).toBe(clean);
		expect(out[1]).not.toBe(dirty);
	});
});

describe("sanitizeContext", () => {
	it("strips U+FFFD from the system prompt", () => {
		const ctx = makeContext([], `You ${FFFD} are helpful`);
		const out = sanitizeContext(ctx);
		expect(out.systemPrompt).toBe("You are helpful");
		expect(out.systemPrompt).not.toContain(FFFD);
	});

	it("strips U+FFFD from messages in the context", () => {
		const ctx = makeContext([makeUser(`hi ${FFFD} there`)]);
		const out = sanitizeContext(ctx);
		const m = out.messages[0]!;
		if (m.role !== "user" || typeof m.content !== "string") throw new Error("expected user string");
		expect(m.content).toBe("hi there");
	});

	it("strips U+FFFD from both the system prompt and the messages", () => {
		const ctx = makeContext(
			[makeUser(`user ${FFFD} text`)],
			`system ${FFFD} prompt`,
		);
		const out = sanitizeContext(ctx);
		expect(out.systemPrompt).toBe("system prompt");
		if (out.messages[0]!.role !== "user" || typeof out.messages[0]!.content !== "string") {
			throw new Error("expected user string");
		}
		expect(out.messages[0]!.content).toBe("user text");
	});

	it("returns the same Context reference when no sanitisation was needed", () => {
		const ctx = makeContext(
			[makeUser("clean text"), makeAssistant([{ type: "text", text: "ok" }])],
			"clean system prompt",
		);
		const out = sanitizeContext(ctx);
		expect(out).toBe(ctx);
	});

	it("returns a new Context reference but the same messages array when only the system prompt changed", () => {
		const messages: Message[] = [makeUser("clean")];
		const ctx = makeContext(messages, `dirty ${FFFD} prompt`);
		const out = sanitizeContext(ctx);
		expect(out).not.toBe(ctx);
		expect(out.messages).toBe(messages);
		expect(out.systemPrompt).toBe("dirty prompt");
	});

	it("is a drop-in replacement for the per-provider `transformMessages` sanitisation pass", () => {
		// Regression test for the BYPASS fix: a Context with U+FFFD in the
		// system prompt and in a user text block must come out fully clean
		// when sent through sanitizeContext (which is what pi-messages and
		// streamProxy now do, in lieu of running the per-provider
		// `transformMessages` shape transforms).
		const ctx = makeContext(
			[makeUser([{ type: "text", text: `top ${FFFD} text` }])],
			`sys ${FFFD} prompt`,
		);
		const out = sanitizeContext(ctx);
		expect(out.systemPrompt).not.toContain(FFFD);
		const block = (out.messages[0] as { content: TextContent[] }).content[0]!;
		expect(block.text).not.toContain(FFFD);
		// The Context shape itself is preserved.
		expect(typeof out.systemPrompt).toBe("string");
		expect(Array.isArray(out.messages)).toBe(true);
	});
});
