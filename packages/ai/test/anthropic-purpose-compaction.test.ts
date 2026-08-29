/**
 * Unit tests for the `purpose: "compaction"` field on
 * `SimpleStreamOptions` (Phase 3, item 12).
 *
 * When a summarisation call is made, the caller passes
 * `purpose: "compaction"`. The Anthropic provider must NOT share
 * the prompt cache with the user-facing session (the compaction
 * call is one-shot maintenance). The OpenAI provider has an
 * analogous `prompt_cache_key` namespace.
 *
 * These tests pin the contract at the `buildBaseOptions` level
 * (the choke point all providers go through) and document the
 * expected wire-level behaviour. A full end-to-end test would
 * mock the Anthropic fetch and assert the request body — that's
 * covered in `regression #007`.
 */
import { describe, expect, it } from "vitest";

import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { Context, Model } from "../src/types.ts";

function makeModel(): Model<any> {
	return {
		id: "claude-sonnet-4-5",
		name: "Test",
		api: "anthropic-messages" as any,
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		contextWindow: 200_000,
		maxTokens: 8192,
	} as Model<any>;
}

function makeContext(): Context {
	return {
		messages: [],
		systemPrompt: undefined,
		tools: undefined,
		estimatedTokens: 1000,
	} as unknown as Context;
}

describe("purpose: 'compaction' (Phase 3, item 12)", () => {
	it("SimpleStreamOptions accepts `purpose: 'compaction'`", () => {
		const opts = buildBaseOptions(makeModel(), makeContext(), {
			maxTokens: 8192,
			apiKey: "test",
			purpose: "compaction",
		});
		// The base options preserve the field. Providers read it from
		// here to decide cache behaviour.
		expect(opts.purpose).toBe("compaction");
	});

	it("SimpleStreamOptions accepts `purpose: 'session-title'`", () => {
		const opts = buildBaseOptions(makeModel(), makeContext(), {
			maxTokens: 8192,
			apiKey: "test",
			purpose: "session-title",
		});
		expect(opts.purpose).toBe("session-title");
	});

	it("SimpleStreamOptions allows `purpose` to be undefined (default user-facing call)", () => {
		const opts = buildBaseOptions(makeModel(), makeContext(), {
			maxTokens: 8192,
			apiKey: "test",
		});
		expect(opts.purpose).toBeUndefined();
	});

	it("`safetyMargin` is independent of `purpose` (both are part of the same context-management bundle)", () => {
		const opts = buildBaseOptions(makeModel(), makeContext(), {
			maxTokens: 8192,
			apiKey: "test",
			purpose: "compaction",
			safetyMargin: 1024,
		});
		expect(opts.purpose).toBe("compaction");
		expect(opts.safetyMargin).toBe(1024);
	});

	it("replay-prefix path produces the same base options shape whether or not `purpose` is set", () => {
		const withPurpose = buildBaseOptions(makeModel(), makeContext(), {
			maxTokens: 8192,
			apiKey: "test",
			purpose: "compaction",
			safetyMargin: 1024,
		});
		const withoutPurpose = buildBaseOptions(makeModel(), makeContext(), {
			maxTokens: 8192,
			apiKey: "test",
			safetyMargin: 1024,
		});
		// Both clamp the same way. The provider-side handling of
		// `purpose` is what differentiates (cache namespace vs not).
		expect(withPurpose.maxTokens).toBe(withoutPurpose.maxTokens);
	});
});
