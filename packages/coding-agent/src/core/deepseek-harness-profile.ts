/**
 * Built-in defaults for the MiniMax provider family.
 *
 * Loaded by `SettingsManager.getDeepseekHarnessSettings()` when the
 * active model is `minimax` or `minimax-cn`. The settings resolver
 * layers this on top of the user's `deepseekHarness` settings, then
 * per-model and provider-wildcard overrides win.
 *
 * Rationale: MiniMax is on the Anthropic-compatible API and is
 * cache-friendly. Compaction is cheap; we can compact earlier and
 * more often, and the pruner is more aggressive because the cache
 * hit rate on a long session is the dominant cost driver.
 *
 * The `enabled: true` field here is a NO-OP — the master switch in
 * `SettingsManager.getDeepseekHarnessSettings` is the user's own
 * `deepseekHarness.enabled` (or the default `false`). The profile
 * only kicks in when the user has opted in to the bundle.
 */
import type { DeepseekHarnessSettings } from "./settings-manager.ts";

export const MINIMAX_PROFILE: Partial<DeepseekHarnessSettings> = {
	thresholdRatio: 0.75,
	retainRatio: 0.18,
	maxOverflowRetries: 3,
	toolResultPruneEveryN: 3,
	toolResultHeadChars: 4096,
	toolResultTailChars: 1024,
	toolResultThresholdChars: 8192,
	replayPrefixSummarisation: true,
	budgetedInstructions: true,
};
