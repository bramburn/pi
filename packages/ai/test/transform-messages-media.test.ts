import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type {
	Api,
	ImageContent,
	MediaType,
	Message,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "../src/types.ts";

/**
 * Media-swap safety: media attached while one model was active must not be
 * sent to a later model that lacks the modality. `transformMessages` runs on
 * every request build, so it is the gate that protects the context window
 * after a mid-session model swap.
 */

function makeModel(api: Api, input: MediaType[]): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

/** Video/PDF blocks enter the union via the coding-agent paste path's local cast. */
function mediaBlock(type: "image" | "video" | "pdf", data: string): ImageContent {
	return { type, mimeType: type === "pdf" ? "application/pdf" : `${type}/test`, data } as unknown as ImageContent;
}

function userMessageWithMedia(): UserMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: "look at these" },
			mediaBlock("image", "aW1n"),
			mediaBlock("video", "dmlk"),
			mediaBlock("pdf", "cGRm"),
		],
		timestamp: 1,
	};
}

function contentBlocks(message: Message): Array<TextContent | ImageContent> {
	if (message.role === "user" && Array.isArray(message.content)) return message.content;
	if (message.role === "toolResult") return message.content;
	throw new Error(`unexpected message shape: ${message.role}`);
}

describe("transformMessages media downgrade", () => {
	it("keeps all media for a video/pdf-capable model", () => {
		const model = makeModel("google-generative-ai", ["text", "image"]);
		const messages = [userMessageWithMedia()];

		const result = transformMessages(messages, model);
		const kinds = contentBlocks(result[0]).map((block) => (block as { type: string }).type);

		expect(kinds).toEqual(["text", "image", "video", "pdf"]);
	});

	it("replaces video/pdf with placeholders after a swap to an image-only model", () => {
		const gemini = makeModel("google-generative-ai", ["text", "image"]);
		const claude = makeModel("anthropic-messages", ["text", "image"]);
		const messages = [userMessageWithMedia()];

		const result = transformMessages(messages, claude);
		const blocks = contentBlocks(result[0]);
		const kinds = blocks.map((block) => (block as { type: string }).type);

		expect(kinds).toEqual(["text", "image", "text", "text"]);
		expect((blocks[2] as TextContent).text).toBe("(video omitted: model does not support video)");
		expect((blocks[3] as TextContent).text).toBe("(pdf omitted: model does not support PDFs)");

		// The same context must survive intact for a swap back to a capable model.
		const restored = transformMessages(messages, gemini);
		expect(contentBlocks(restored[0]).map((block) => (block as { type: string }).type)).toEqual([
			"text",
			"image",
			"video",
			"pdf",
		]);
	});

	it("does not mutate the stored history when downgrading", () => {
		const claude = makeModel("anthropic-messages", ["text", "image"]);
		const messages = [userMessageWithMedia()];

		transformMessages(messages, claude);

		expect(contentBlocks(messages[0]).map((block) => (block as { type: string }).type)).toEqual([
			"text",
			"image",
			"video",
			"pdf",
		]);
	});

	it("replaces all media with placeholders for a text-only model", () => {
		const model = makeModel("openai-completions", ["text"]);
		const result = transformMessages([userMessageWithMedia()], model);
		const blocks = contentBlocks(result[0]);

		expect(blocks.map((block) => (block as { type: string }).type)).toEqual(["text", "text", "text", "text"]);
		expect((blocks[1] as TextContent).text).toBe("(image omitted: model does not support images)");
		expect((blocks[2] as TextContent).text).toBe("(video omitted: model does not support video)");
		expect((blocks[3] as TextContent).text).toBe("(pdf omitted: model does not support PDFs)");
	});

	it("honors the registry over API capability", () => {
		// Gemini's API can serialize video, but the registry declares this model
		// text-only — the gate must respect the model's declared modalities.
		const model = makeModel("google-generative-ai", ["text"]);
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "watch" }, mediaBlock("video", "dmlk")], timestamp: 1 },
		];

		const blocks = contentBlocks(transformMessages(messages, model)[0]);
		expect(blocks.map((block) => (block as { type: string }).type)).toEqual(["text", "text"]);
		expect((blocks[1] as TextContent).text).toBe("(video omitted: model does not support video)");
	});

	it("collapses consecutive drops of the same kind into one placeholder", () => {
		const model = makeModel("anthropic-messages", ["text", "image"]);
		const messages: Message[] = [
			{
				role: "user",
				content: [
					mediaBlock("video", "dmlkMQ=="),
					mediaBlock("video", "dmlkMg=="),
					mediaBlock("pdf", "cGRm"),
					mediaBlock("pdf", "cGRmMg=="),
				],
				timestamp: 1,
			},
		];

		const blocks = contentBlocks(transformMessages(messages, model)[0]);
		expect(blocks.map((block) => (block as TextContent).text)).toEqual([
			"(video omitted: model does not support video)",
			"(pdf omitted: model does not support PDFs)",
		]);
	});

	it("downgrades tool result media with the tool placeholder", () => {
		const model = makeModel("anthropic-messages", ["text", "image"]);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "done" }, mediaBlock("video", "dmlk")],
				timestamp: 1,
			} as ToolResultMessage,
		];

		const blocks = contentBlocks(transformMessages(messages, model)[0]);
		expect(blocks.map((block) => (block as { type: string }).type)).toEqual(["text", "text"]);
		expect((blocks[1] as TextContent).text).toBe("(tool video omitted: model does not support video)");
	});
});
