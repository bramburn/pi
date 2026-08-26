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
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { MINIMAX_PROFILE } from "../../src/core/deepseek-harness-profile.ts";

describe("MINIMAX_PROFILE", () => {
	it("has the expected threshold and retain ratios", () => {
		assert.equal(MINIMAX_PROFILE.thresholdRatio, 0.75);
		assert.equal(MINIMAX_PROFILE.retainRatio, 0.18);
	});

	it("has 3 overflow retries (cache-friendly provider)", () => {
		assert.equal(MINIMAX_PROFILE.maxOverflowRetries, 3);
	});

	it("has 3-turn pruner cadence (more aggressive than default 5)", () => {
		assert.equal(MINIMAX_PROFILE.toolResultPruneEveryN, 3);
	});

	it("matches the deepseek-harness pruner defaults (8K/4K/1K)", () => {
		assert.equal(MINIMAX_PROFILE.toolResultThresholdChars, 8192);
		assert.equal(MINIMAX_PROFILE.toolResultHeadChars, 4096);
		assert.equal(MINIMAX_PROFILE.toolResultTailChars, 1024);
	});

	it("enables replay-prefix summarisation and byte-budgeted instructions", () => {
		assert.equal(MINIMAX_PROFILE.replayPrefixSummarisation, true);
		assert.equal(MINIMAX_PROFILE.budgetedInstructions, true);
	});

	it("does not override the master enabled flag (Partial<> contract)", () => {
		// The `enabled` field is intentionally absent from the profile
		// because the master switch is always the user's setting.
		// Verifying with `Partial<DeepseekHarnessSettings>` in the
		// type signature is the strongest guarantee we can encode; the
		// runtime check below documents the intent.
		assert.equal("enabled" in MINIMAX_PROFILE, false);
	});
});
