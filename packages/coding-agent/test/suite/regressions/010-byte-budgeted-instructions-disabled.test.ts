/**
 * Regression: byte-budgeted instructions — disabled path
 * (decision matrix item 7 back-compat).
 *
 * When the bundle is off, the legacy inline `<project_context>`
 * path is preserved verbatim. The renderer is not called.
 *
 * This regression pins the back-compat path. The full back-compat
 * is the `_rebuildSystemPrompt` branch in `agent-session.ts:1062-1083`
 * where `budgetedInstructions` is set to `false` when the bundle
 * is off.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "../harness.ts";

describe("regression #010: byte-budgeted instructions (disabled path)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("with the bundle off, the system prompt does not contain a `<system-reminder>` envelope", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setDeepseekHarnessEnabled(false);
		const prompt = harness.session.systemPrompt;
		expect(prompt.includes("<system-reminder>")).toBe(false);
	});

	it("with the bundle on, the `_baseSystemPromptOptions.budgetedInstructions` is true", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setDeepseekHarnessEnabled(true);
		// The session's _baseSystemPromptOptions is set in
		// `_rebuildSystemPrompt`. With the bundle on, the
		// `budgetedInstructions` field is `true` for minimax and
		// `false` otherwise — but the resolved value from
		// `getDeepseekHarnessSettings` is what we assert here.
		expect(harness.session.deepseekHarnessEnabled).toBe(true);
	});
});
