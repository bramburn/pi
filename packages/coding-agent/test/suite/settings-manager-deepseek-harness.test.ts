/**
 * Unit tests for the DeepSeek Harness settings resolver.
 *
 * The resolver layers `DEFAULT_DEEPSEEK_HARNESS` → user values →
 * `MINIMAX_PROFILE` (only when provider is `minimax`/`minimax-cn`)
 * → per-model exact override → provider-wildcard override.
 *
 * These tests use an in-memory `SettingsManager` (no disk writes)
 * to keep the suite fast and hermetic. The disk write path is
 * exercised by the regression test that runs against a real
 * `~/.pi/settings.json`.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	InMemorySettingsStorage,
	SettingsManager,
} from "../../src/core/settings-manager.ts";
import { getAgentDir } from "../../src/config.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeManager(): Promise<{ manager: SettingsManager; cleanup: () => Promise<void> }> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-dh-test-"));
	const _agentDir = getAgentDir();
	const storage = new InMemorySettingsStorage();
	const manager = SettingsManager.fromStorage(storage, { projectTrusted: true });
	return {
		manager,
		cleanup: async () => {
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

describe("getDeepseekHarnessSettings", () => {
	it("returns defaults when nothing is configured", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			const s = manager.getDeepseekHarnessSettings();
			assert.equal(s.enabled, false);
			assert.equal(s.thresholdRatio, 0.8);
			assert.equal(s.retainRatio, 0.16);
			assert.equal(s.maxOverflowRetries, 2);
			assert.equal(s.toolResultPruneEveryN, 5);
			assert.equal(s.toolResultHeadChars, 4096);
			assert.equal(s.toolResultTailChars, 1024);
			assert.equal(s.toolResultThresholdChars, 8192);
			assert.equal(s.replayPrefixSummarisation, true);
			assert.equal(s.budgetedInstructions, true);
			assert.equal(s.maxBytesForInstructions, 20 * 1024);
			assert.equal(s.profile, "user");
		} finally {
			await cleanup();
		}
	});

	it("layers user values on top of the defaults", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			manager.setDeepseekHarnessEnabled(true);
			manager.setDeepseekHarnessField("thresholdRatio", 0.6);
			manager.setDeepseekHarnessField("maxOverflowRetries", 5);
			const s = manager.getDeepseekHarnessSettings();
			assert.equal(s.enabled, true);
			assert.equal(s.thresholdRatio, 0.6);
			assert.equal(s.maxOverflowRetries, 5);
			// Other fields keep their defaults.
			assert.equal(s.retainRatio, 0.16);
		} finally {
			await cleanup();
		}
	});

	it("layers the MiniMax profile when provider is minimax", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			manager.setDeepseekHarnessEnabled(true);
			const s = manager.getDeepseekHarnessSettings({
				provider: "minimax",
				id: "MiniMax-M2.7",
			});
			assert.equal(s.profile, "minimax");
			// MiniMax profile defaults (overrides the 0.8 default).
			assert.equal(s.thresholdRatio, 0.75);
			assert.equal(s.retainRatio, 0.18);
			assert.equal(s.maxOverflowRetries, 3);
			assert.equal(s.toolResultPruneEveryN, 3);
		} finally {
			await cleanup();
		}
	});

	it("layers the MiniMax profile when provider is minimax-cn", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			manager.setDeepseekHarnessEnabled(true);
			const s = manager.getDeepseekHarnessSettings({
				provider: "minimax-cn",
				id: "MiniMax-M2.5",
			});
			assert.equal(s.profile, "minimax");
			assert.equal(s.thresholdRatio, 0.75);
		} finally {
			await cleanup();
		}
	});

	it("does not layer the MiniMax profile for non-MiniMax providers", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			manager.setDeepseekHarnessEnabled(true);
			const s = manager.getDeepseekHarnessSettings({
				provider: "anthropic",
				id: "claude-sonnet-4-5",
			});
			assert.equal(s.profile, "user");
			assert.equal(s.thresholdRatio, 0.8);
		} finally {
			await cleanup();
		}
	});

	it("user override wins over the MiniMax profile", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			manager.setDeepseekHarnessEnabled(true);
			manager.setDeepseekHarnessField("thresholdRatio", 0.5);
			const s = manager.getDeepseekHarnessSettings({
				provider: "minimax",
				id: "MiniMax-M2.7",
			});
			// User's 0.5 wins over MiniMax profile's 0.75.
			assert.equal(s.thresholdRatio, 0.5);
		} finally {
			await cleanup();
		}
	});

	it("per-model exact override wins over the MiniMax profile", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			manager.setDeepseekHarnessEnabled(true);
			// User adds a per-model exact override.
			manager.setDeepseekHarnessField("modelPolicies", {
				"minimax/MiniMax-M2.7": { thresholdRatio: 0.5 },
			});
			const s = manager.getDeepseekHarnessSettings({
				provider: "minimax",
				id: "MiniMax-M2.7",
			});
			assert.equal(s.thresholdRatio, 0.5);
		} finally {
			await cleanup();
		}
	});

	it("per-model exact override wins for a different model in the same provider", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			manager.setDeepseekHarnessEnabled(true);
			manager.setDeepseekHarnessField("modelPolicies", {
				"minimax/MiniMax-M2.7": { thresholdRatio: 0.5 },
			});
			// A different model in the same provider keeps the MiniMax profile.
			const s = manager.getDeepseekHarnessSettings({
				provider: "minimax",
				id: "MiniMax-M3",
			});
			assert.equal(s.thresholdRatio, 0.75);
		} finally {
			await cleanup();
		}
	});

	it("provider-wildcard override wins when no exact override is set", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			manager.setDeepseekHarnessEnabled(true);
			manager.setDeepseekHarnessField("modelPolicies", {
				"minimax/*": { thresholdRatio: 0.6 },
			});
			const s = manager.getDeepseekHarnessSettings({
				provider: "minimax",
				id: "MiniMax-M3",
			});
			assert.equal(s.thresholdRatio, 0.6);
		} finally {
			await cleanup();
		}
	});

	it("master toggle stays off even if MiniMax profile sets enabled=true", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			// User has NOT enabled the bundle. The MiniMax profile's
			// enabled: true is ignored because the master is off.
			const s = manager.getDeepseekHarnessSettings({
				provider: "minimax",
				id: "MiniMax-M2.7",
			});
			assert.equal(s.enabled, false);
		} finally {
			await cleanup();
		}
	});

	it("getDeepseekHarnessEnabled returns false by default and the user value when set", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			assert.equal(manager.getDeepseekHarnessEnabled(), false);
			manager.setDeepseekHarnessEnabled(true);
			assert.equal(manager.getDeepseekHarnessEnabled(), true);
		} finally {
			await cleanup();
		}
	});

	it("setDeepseekHarnessField preserves sibling fields", async () => {
		const { manager, cleanup } = await makeManager();
		try {
			manager.setDeepseekHarnessEnabled(true);
			manager.setDeepseekHarnessField("thresholdRatio", 0.6);
			manager.setDeepseekHarnessField("maxOverflowRetries", 5);
			const s = manager.getDeepseekHarnessSettings();
			assert.equal(s.thresholdRatio, 0.6);
			assert.equal(s.maxOverflowRetries, 5);
			assert.equal(s.enabled, true);
			// Sibling fields keep their defaults.
			assert.equal(s.retainRatio, 0.16);
		} finally {
			await cleanup();
		}
	});
});
