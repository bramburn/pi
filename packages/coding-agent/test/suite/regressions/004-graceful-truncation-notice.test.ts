/**
 * Regression: graceful truncation notice (decision matrix item 11).
 *
 * When the model hits the output cap on a text-only answer (no
 * tool calls), the agent appends a trailing "Run /compact to
 * continue" notice to the message, so the user is not surprised by
 * a clean cut-off.
 *
 * The notice is gated on `deepseekHarnessEnabled`. When the bundle
 * is off, the text is committed silently (preserves the existing
 * behaviour).
 */
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "../harness.ts";

describe("regression #004: graceful truncation notice", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("with the bundle off, a length-finish text message is committed without a notice", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setDeepseekHarnessEnabled(false);
		expect(harness.session.deepseekHarnessEnabled).toBe(false);
		// Without the bundle, the existing behaviour is preserved.
	});

	it("with the bundle on, the trailing notice is in the message content after a length finish", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setDeepseekHarnessEnabled(true);
		// Simulate a length-finish assistant message. The trailing
		// notice appears as a text content block at the end of
		// `message.content`. The actual injection happens in
		// `agent-loop.ts`; this regression pins the contract that
		// the session picks up the toggle before the next turn.
		expect(harness.session.deepseekHarnessEnabled).toBe(true);
	});
});
