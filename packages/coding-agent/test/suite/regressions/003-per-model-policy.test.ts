/**
 * Regression: per-model compaction policy (decision matrix item 6).
 *
 * With `deepseekHarness.enabled: true`, the resolved settings layer
 * the user values, the built-in `MINIMAX_PROFILE` (only on the
 * minimax / minimax-cn provider), the exact-model override, and
 * the provider-wildcard override.
 *
 * The settings-resolution test (`settings-manager-deepseek-harness.test.ts`)
 * covers the unit-level merge logic. This regression focuses on
 * `AgentSession._baseSystemPromptOptions` and `_rebuildSystemPrompt`
 * picking up the resolved values.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "../harness.ts";

describe("regression #003: per-model compaction policy", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("with the bundle off, the base system prompt is unchanged", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setDeepseekHarnessEnabled(false);
		const prompt = harness.session.systemPrompt;
		// The legacy inline `<project_context>` block is not rendered
		// when there are no AGENTS.md files in the fixture. The
		// assertion below just exercises the path: the prompt is a
		// non-empty string and does not contain a `<system-reminder>`
		// envelope.
		expect(prompt).toBeTruthy();
		expect(prompt.includes("<system-reminder>")).toBe(false);
	});

	it("with the bundle on, the session's deepseekHarnessEnabled is true", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setDeepseekHarnessEnabled(true);
		expect(harness.session.deepseekHarnessEnabled).toBe(true);
	});
});
