import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { XAI_MODELS } from "../src/providers/xai.models.ts";
import { xaiProvider } from "../src/providers/xai.ts";
import type { Context, Model } from "../src/types.ts";

type CapturedRequest = {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
};

function completedResponse(): Response {
	const event = {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_xai_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequest(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions,
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		captured = {
			url: request.url,
			headers: request.headers,
			body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
		};
		return completedResponse();
	});

	const result = await xaiProvider().stream(model, context, options).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(captured).toBeDefined();
	return captured!;
}

describe("xAI Responses provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("excludes retired and redundant models from the built-in catalog", () => {
		for (const modelId of [
			"grok-3",
			"grok-3-fast",
			"grok-4.20-0309-non-reasoning",
			"grok-4.20-0309-reasoning",
			"grok-build-0.1",
			"grok-code-fast-1",
		]) {
			expect(Object.keys(XAI_MODELS)).not.toContain(modelId);
		}
	});

	it("exposes Grok 4.x on the Responses API with low/medium/high efforts", () => {
		// Which Grok versions upstream lists, and how many effort levels each declares,
		// both move between catalog builds (grok-4.5 gained xhigh). The invariant here
		// is routing plus the three core effort levels, not a per-version snapshot -
		// see https://github.com/bramburn/qi/issues/1. The legacy openai-completions
		// endpoint is reserved for older Grok releases that are retired from the catalog.
		const grok4 = Object.values(XAI_MODELS).filter((model) => model.id.startsWith("grok-4."));
		// Without this, an empty list would make every loop below vacuously pass.
		expect(grok4.length).toBeGreaterThan(0);
		for (const model of grok4) {
			expect(model.api, model.id).toBe("openai-responses");
			expect(getSupportedThinkingLevels(model), model.id).toEqual(expect.arrayContaining(["low", "medium", "high"]));
		}
		// At least one current Grok can still switch thinking off.
		expect(grok4.filter((model) => getSupportedThinkingLevels(model).includes("off")).length).toBeGreaterThan(0);
	});

	it("uses /responses with bearer auth and xAI-compatible request fields", async () => {
		const captured = await captureRequest(
			XAI_MODELS["grok-4.5"],
			{
				systemPrompt: "You are a careful coding assistant.",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{
				apiKey: "xai-test-token",
				sessionId: "pi-session-123",
				cacheRetention: "long",
				reasoningEffort: "medium",
			},
		);

		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.headers.get("authorization")).toBe("Bearer xai-test-token");
		expect(captured.headers.get("session_id")).toBe("pi-session-123");
		expect(captured.body).toMatchObject({
			model: "grok-4.5",
			store: false,
			stream: true,
			prompt_cache_key: "pi-session-123",
			reasoning: { effort: "medium" },
			include: ["reasoning.encrypted_content"],
		});
		expect(captured.body).not.toHaveProperty("prompt_cache_retention");
		expect(captured.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "developer",
					content: "You are a careful coding assistant.",
				}),
			]),
		);
	});
});
