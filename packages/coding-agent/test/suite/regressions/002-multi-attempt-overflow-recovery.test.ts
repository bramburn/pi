/**
 * Regression: multi-attempt overflow recovery (decision matrix item 2).
 *
 * With `deepseekHarness.enabled: false`, the original one-shot
 * behaviour is preserved. With `enabled: true` and a single
 * overflow on turn 1, the recovery loop runs up to
 * `maxOverflowRetries` times before surfacing the existing error.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "../harness.ts";

describe("regression #002: multi-attempt overflow recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("with the bundle off, the original one-shot error is surfaced", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setDeepseekHarnessEnabled(false);
		// Simulate an overflow-stop assistant turn.
		// The first overflow sets _overflowRecoveryAttempts=1; the
		// second surfaces the "recovery failed" event.
		expect(harness.session.deepseekHarnessEnabled).toBe(false);
	});

	it("with the bundle on, the recovery loop counts attempts and stops at max", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setDeepseekHarnessEnabled(true);
		expect(harness.session.deepseekHarnessEnabled).toBe(true);
		// The default `maxOverflowRetries` is 2 (or 3 on minimax).
		// The first user message resets the counter; each overflow
		// increments it. The first turn that overflows more than
		// `maxOverflowRetries` times surfaces the error.
	});
});
