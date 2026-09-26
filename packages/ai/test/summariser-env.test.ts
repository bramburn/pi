import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PI_SUMMARIZER_API_KEY_ENV,
	PI_SUMMARIZER_BASE_URL_ENV,
	PI_SUMMARIZER_MODEL_ENV,
	resolveSummariserEnv,
} from "../src/summariser-env.ts";

const ENV_KEYS = [PI_SUMMARIZER_BASE_URL_ENV, PI_SUMMARIZER_MODEL_ENV, PI_SUMMARIZER_API_KEY_ENV] as const;

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
