import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PI_SUMMARIZER_API_KEY_ENV,
	PI_SUMMARIZER_BASE_URL_ENV,
	PI_SUMMARIZER_CONTEXT_WINDOW_ENV,
	PI_SUMMARIZER_MODEL_ENV,
} from "../src/summariser-env.ts";
import { resolveSummariserModel, SUMMARISER_OVERRIDE_PROVIDER_ID } from "../src/summariser-model.ts";

const ENV_KEYS = [
	PI_SUMMARIZER_BASE_URL_ENV,
	PI_SUMMARIZER_MODEL_ENV,
	PI_SUMMARIZER_API_KEY_ENV,
	PI_SUMMARIZER_CONTEXT_WINDOW_ENV,
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
	for (const key of ENV_KEYS) delete process.env[key];
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const original = originalEnv[key];
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	vi.restoreAllMocks();
});

describe("resolveSummariserModel", () => {
	it("returns undefined when no PI_SUMMARIZER_* env vars are set (caller falls back to main model)", () => {
		expect(resolveSummariserModel()).toBeUndefined();
	});

	it("returns undefined when any required env var is missing", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		// PI_SUMMARIZER_API_KEY intentionally not set
		expect(resolveSummariserModel()).toBeUndefined();
	});

	it("returns a Model<openai-completions> + apiKey when the three required vars are set", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";

		const result = resolveSummariserModel();
		expect(result).toBeDefined();
		expect(result?.apiKey).toBe("sk-test");
		expect(result?.model.api).toBe("openai-completions");
		expect(result?.model.id).toBe("deepseek-chat");
		expect(result?.model.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(result?.model.provider).toBe(SUMMARISER_OVERRIDE_PROVIDER_ID);
		expect(result?.model.name).toBe("deepseek-chat (PI summariser override)");
		expect(result?.model.input).toEqual(["text"]);
		expect(result?.model.reasoning).toBe(false);
		expect(result?.model.contextWindow).toBe(128000);
		expect(result?.model.maxTokens).toBe(8192);
		expect(result?.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("returns the same provider id on repeated calls so re-registration replaces in place", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.example.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "my-local-llm";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";

		const first = resolveSummariserModel();
		const second = resolveSummariserModel();
		expect(second?.model.provider).toBe(first?.model.provider);
		expect(second?.model.provider).toBe(SUMMARISER_OVERRIDE_PROVIDER_ID);
	});

	it("threads PI_SUMMARIZER_CONTEXT_WINDOW into the model context window", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.example.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "my-local-llm";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";
		process.env[PI_SUMMARIZER_CONTEXT_WINDOW_ENV] = "200000";

		expect(resolveSummariserModel()?.model.contextWindow).toBe(200000);
	});

	it("falls back to 128000 when PI_SUMMARIZER_CONTEXT_WINDOW is unset or invalid", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.example.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "my-local-llm";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";

		delete process.env[PI_SUMMARIZER_CONTEXT_WINDOW_ENV];
		expect(resolveSummariserModel()?.model.contextWindow).toBe(128000);

		process.env[PI_SUMMARIZER_CONTEXT_WINDOW_ENV] = "abc";
		expect(resolveSummariserModel()?.model.contextWindow).toBe(128000);
	});

	it("normalizes a /chat/completions base URL before building the model", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.minimax.io/v1/chat/completions";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "MiniMax-M2.7";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";

		expect(resolveSummariserModel()?.model.baseUrl).toBe("https://api.minimax.io/v1");
	});
});
