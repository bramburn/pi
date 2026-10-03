import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PI_SUMMARIZER_API_KEY_ENV,
	PI_SUMMARIZER_BASE_URL_ENV,
	PI_SUMMARIZER_CONTEXT_WINDOW_ENV,
	PI_SUMMARIZER_MODEL_ENV,
	resolveSummariserEnv,
} from "../src/summariser-env.ts";

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

describe("resolveSummariserEnv", () => {
	it("returns undefined when no PI_SUMMARIZER_* env vars are set (fall back to main model)", () => {
		expect(resolveSummariserEnv()).toBeUndefined();
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("returns undefined and warns when only PI_SUMMARIZER_BASE_URL + PI_SUMMARIZER_MODEL are set", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		expect(resolveSummariserEnv()).toBeUndefined();
		expect(console.warn).toHaveBeenCalledTimes(1);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(PI_SUMMARIZER_API_KEY_ENV));
	});

	it("returns undefined and warns when only PI_SUMMARIZER_API_KEY is set", () => {
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";
		expect(resolveSummariserEnv()).toBeUndefined();
		expect(console.warn).toHaveBeenCalledTimes(1);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(PI_SUMMARIZER_BASE_URL_ENV));
	});

	it("treats empty-string values as missing (no partial set accepted)", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "   ";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";
		expect(resolveSummariserEnv()).toBeUndefined();
		expect(console.warn).toHaveBeenCalledTimes(1);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(PI_SUMMARIZER_BASE_URL_ENV));
	});

	it("returns the override when the three required vars are set", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";
		const result = resolveSummariserEnv();
		expect(result).toEqual({
			baseUrl: "https://api.deepseek.com/v1",
			model: "deepseek-chat",
			apiKey: "sk-test",
		});
		expect(console.warn).not.toHaveBeenCalled();
	});

	it("trims whitespace around each env value before returning", () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "  https://api.deepseek.com/v1  ";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "\tdeepseek-chat\n";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = " sk-test ";
		expect(resolveSummariserEnv()).toEqual({
			baseUrl: "https://api.deepseek.com/v1",
			model: "deepseek-chat",
			apiKey: "sk-test",
		});
	});
});

describe("resolveSummariserEnv base URL normalization", () => {
	function resolveWithBaseUrl(baseUrl: string) {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = baseUrl;
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";
		return resolveSummariserEnv();
	}

	it("strips trailing slashes from the base URL", () => {
		expect(resolveWithBaseUrl("https://api.deepseek.com/v1/")?.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(resolveWithBaseUrl("https://api.deepseek.com/v1///")?.baseUrl).toBe("https://api.deepseek.com/v1");
	});

	it("strips one trailing /chat/completions suffix (case-insensitive)", () => {
		expect(resolveWithBaseUrl("https://api.minimax.io/v1/chat/completions")?.baseUrl).toBe(
			"https://api.minimax.io/v1",
		);
		expect(resolveWithBaseUrl("https://api.minimax.io/v1/CHAT/Completions")?.baseUrl).toBe(
			"https://api.minimax.io/v1",
		);
	});

	it("strips a trailing slash combined with a /chat/completions suffix", () => {
		expect(resolveWithBaseUrl("https://api.minimax.io/v1/chat/completions/")?.baseUrl).toBe(
			"https://api.minimax.io/v1",
		);
	});

	it("strips exactly one suffix when the path already doubles /chat/completions", () => {
		// One suffix is removed; a URL that literally contains the suffix twice
		// keeps one, matching the "strip ONE trailing suffix" contract.
		expect(resolveWithBaseUrl("https://api.minimax.io/v1/chat/completions/chat/completions")?.baseUrl).toBe(
			"https://api.minimax.io/v1/chat/completions",
		);
	});

	it("leaves a plain versioned base URL unchanged", () => {
		expect(resolveWithBaseUrl("https://api.deepseek.com/v1")?.baseUrl).toBe("https://api.deepseek.com/v1");
	});
});

describe("resolveSummariserEnv context window", () => {
	function resolveWithContextWindow(value: string | undefined) {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://api.deepseek.com/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "deepseek-chat";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "sk-test";
		if (value === undefined) delete process.env[PI_SUMMARIZER_CONTEXT_WINDOW_ENV];
		else process.env[PI_SUMMARIZER_CONTEXT_WINDOW_ENV] = value;
		return resolveSummariserEnv();
	}

	it("returns the parsed positive integer", () => {
		expect(resolveWithContextWindow("200000")?.contextWindow).toBe(200000);
	});

	it("trims whitespace around the value", () => {
		expect(resolveWithContextWindow("  65536 ")?.contextWindow).toBe(65536);
	});

	it("ignores invalid values (empty, zero, negative, non-integer, non-numeric)", () => {
		expect(resolveWithContextWindow(undefined)?.contextWindow).toBeUndefined();
		expect(resolveWithContextWindow("")?.contextWindow).toBeUndefined();
		expect(resolveWithContextWindow("0")?.contextWindow).toBeUndefined();
		expect(resolveWithContextWindow("-5")?.contextWindow).toBeUndefined();
		expect(resolveWithContextWindow("12.5")?.contextWindow).toBeUndefined();
		expect(resolveWithContextWindow("abc")?.contextWindow).toBeUndefined();
		expect(resolveWithContextWindow("1e5")?.contextWindow).toBeUndefined();
	});
});
