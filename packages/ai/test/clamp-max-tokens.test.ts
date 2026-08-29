/**
 * Unit tests for `clampMaxTokensToContext` — the safety-margin parameter
 * added in DeepSeek Harness Phase 1, item 5.
 *
 * When `safetyMargin` is supplied, it overrides the module-level
 * `CONTEXT_SAFETY_TOKENS` constant. The agent loop passes `1024` when
 * the bundle is on, `4096` when off.
 */
import { describe, expect, it } from "vitest";

import { buildBaseOptions, CONTEXT_SAFETY_TOKENS, clampMaxTokensToContext } from "../src/api/simple-options.ts";
import type { Context, Model } from "../src/types.ts";

function makeModel(contextWindow: number, maxTokens: number): Model<any> {
	return {
		id: "test-model",
		name: "Test",
		api: "anthropic-messages" as any,
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		contextWindow,
		maxTokens,
	} as Model<any>;
}

function makeContext(estimatedTokens: number): Context {
	return {
		messages: [],
		systemPrompt: undefined,
		tools: undefined,
		get estimatedTokens(): number {
			return estimatedTokens;
		},
	} as unknown as Context;
}

describe("clampMaxTokensToContext (Phase 1, item 5)", () => {
	it("module default is 1024 tokens (backed by the recovery loop)", () => {
		expect(CONTEXT_SAFETY_TOKENS).toBe(1024);
	});

	it("with a small safetyMargin and a near-full context, maxTokens is shrunken accordingly", () => {
		const model = makeModel(200_000, 8192);
		const ctx = makeContext(195_000);
		// With safetyMargin=1024, available = 200_000 - 195_000 - 1024 = 3976.
		// maxTokens=8192 is clamped to 3976 (min 1).
		expect(clampMaxTokensToContext(model, ctx, 8192, { safetyMargin: 1024 })).toBe(3976);
	});

	it("with the legacy safetyMargin=4096, the same input clamps to a smaller value", () => {
		const model = makeModel(200_000, 8192);
		const ctx = makeContext(195_000);
		// available = 200_000 - 195_000 - 4096 = 904.
		expect(clampMaxTokensToContext(model, ctx, 8192, { safetyMargin: 4096 })).toBe(904);
	});

	it("with safetyMargin=0, the requested maxTokens is kept when below the budget", () => {
		const model = makeModel(200_000, 8192);
		const ctx = makeContext(150_000);
		// safetyMargin=0 → available = 200_000 - 150_000 - 0 = 50_000. The
		// requested 8192 fits, so the clamp is a no-op (we never raise the
		// requested maxTokens to the full available budget).
		expect(clampMaxTokensToContext(model, ctx, 8192, { safetyMargin: 0 })).toBe(8192);
	});

	it("with no options, the module default is used (1024)", () => {
		const model = makeModel(200_000, 8192);
		const ctx = makeContext(195_000);
		// safetyMargin=1024 (module default) → 200_000 - 195_000 - 1024 = 3976.
		expect(clampMaxTokensToContext(model, ctx, 8192)).toBe(3976);
	});

	it("maxTokens < available keeps the requested value", () => {
		const model = makeModel(200_000, 8192);
		const ctx = makeContext(100_000);
		// available = 200_000 - 100_000 - 1024 = 98_976. maxTokens=8192 < 98_976.
		expect(clampMaxTokensToContext(model, ctx, 8192, { safetyMargin: 1024 })).toBe(8192);
	});

	it("contextWindow=0 returns the requested maxTokens (no clamp possible)", () => {
		const model = makeModel(0, 8192);
		const ctx = makeContext(100_000);
		expect(clampMaxTokensToContext(model, ctx, 8192, { safetyMargin: 1024 })).toBe(8192);
	});

	it("buildBaseOptions propagates options.safetyMargin to clampMaxTokensToContext", () => {
		const model = makeModel(200_000, 8192);
		const ctx = makeContext(195_000);
		// safetyMargin=1024 (bundle on) → 3976.
		const opts = buildBaseOptions(model, ctx, { maxTokens: 8192, apiKey: "test", safetyMargin: 1024 });
		expect(opts.maxTokens).toBe(3976);
	});

	it("buildBaseOptions without safetyMargin uses the module default (1024)", () => {
		const model = makeModel(200_000, 8192);
		const ctx = makeContext(195_000);
		const opts = buildBaseOptions(model, ctx, { maxTokens: 8192, apiKey: "test" });
		expect(opts.maxTokens).toBe(3976);
	});
});
