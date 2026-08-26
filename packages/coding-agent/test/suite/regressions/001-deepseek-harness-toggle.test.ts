/**
 * Regression: the "DeepSeek Harness" toggle surface is non-breaking
 * and observable end-to-end.
 *
 * With `deepseekHarness.enabled: false` (the default), a normal
 * agent run is byte-identical to today. With `enabled: true`, the
 * session's in-memory mirror flips and the agent completes a
 * simple prompt without error. The sub-pipelines (overflow
 * recovery, pruner, replay prefix, byte-budgeted instructions)
 * are not exercised in this regression — they are tested in
 * their per-phase suites.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "../harness.ts";

describe("regression #001: DeepSeek Harness toggle surface", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("default-off leaves the session's mirror at false and the agent runs cleanly", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// The harness's SettingsManager does not set the toggle, so
		// the resolved value should be false.
		expect(harness.session.deepseekHarnessEnabled).toBe(false);

		// A trivial agent run completes without error and the
		// mirror stays false.
		harness.setResponses([{ role: "assistant", content: [{ type: "text", text: "ok" }] }]);
		await harness.session.prompt("hello");
		expect(harness.session.deepseekHarnessEnabled).toBe(false);
	});

	it("enabled=true via the public setter flips the session's mirror and persists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.setDeepseekHarnessEnabled(true);
		expect(harness.session.deepseekHarnessEnabled).toBe(true);

		// The agent still runs cleanly. The next turn reads the
		// new value.
		harness.setResponses([{ role: "assistant", content: [{ type: "text", text: "ok" }] }]);
		await harness.session.prompt("hello");
		expect(harness.session.deepseekHarnessEnabled).toBe(true);

		// Disabling flips the mirror back.
		harness.session.setDeepseekHarnessEnabled(false);
		expect(harness.session.deepseekHarnessEnabled).toBe(false);
	});
});
