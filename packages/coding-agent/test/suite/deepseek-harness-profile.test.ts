/**
 * Unit tests for the `MINIMAX_PROFILE` constant.
 *
 * The profile is the built-in default that the resolver layers on
 * top of the user's `deepseekHarness` settings when the active
 * model is `minimax` or `minimax-cn`. Per-model and provider-wildcard
 * user overrides still win.
 *
 * Note: the `enabled` field in `MINIMAX_PROFILE` is intentionally
 * absent — the master toggle is always the user's
 * `deepseekHarness.enabled` (or the default `false`). The profile
 * only kicks in when the user has opted in.
 */
import { describe, expect, it } from "vitest";

import { MINIMAX_PROFILE } from "../../src/core/deepseek-harness-profile.ts";

describe("MINIMAX_PROFILE", () => {
	it("has the expected threshold and retain ratios", () => {
		expect(MINIMAX_PROFILE.thresholdRatio).toBe(0.75);
		expect(MINIMAX_PROFILE.retainRatio).toBe(0.18);
	});

	it("has 3 overflow retries (cache-friendly provider)", () => {
		expect(MINIMAX_PROFILE.maxOverflowRetries).toBe(3);
	});

	it("has 3-turn pruner cadence (more aggressive than default 5)", () => {
		expect(MINIMAX_PROFILE.toolResultPruneEveryN).toBe(3);
	});

	it("matches the deepseek-harness pruner defaults (8K/4K/1K)", () => {
		expect(MINIMAX_PROFILE.toolResultThresholdChars).toBe(8192);
		expect(MINIMAX_PROFILE.toolResultHeadChars).toBe(4096);
		expect(MINIMAX_PROFILE.toolResultTailChars).toBe(1024);
	});

	it("enables replay-prefix summarisation and byte-budgeted instructions", () => {
		expect(MINIMAX_PROFILE.replayPrefixSummarisation).toBe(true);
		expect(MINIMAX_PROFILE.budgetedInstructions).toBe(true);
	});

	it("does not override the master enabled flag (Partial<> contract)", () => {
		// The `enabled` field is intentionally absent from the profile
		// because the master switch is always the user's setting.
		// Verifying with `Partial<DeepseekHarnessSettings>` in the
		// type signature is the strongest guarantee we can encode; the
		// runtime check below documents the intent.
		expect("enabled" in MINIMAX_PROFILE).toBe(false);
	});
});
