import type { AssistantMessage } from "@bramburn/qi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage) => Promise<boolean>;
	// Threshold compaction is started in the background since the hot-swap
	// refactor: _checkCompaction -> _startThresholdBackgroundCompaction ->
	// (feasibility pre-check) -> _launchBackgroundCompaction. The regression is
	// pinned at the launch seam so the test fails if either the threshold
	// decision or the feasibility pre-check stops firing for a genuinely
	// compactable session.
	_launchBackgroundCompaction: (
		reason: "manual" | "threshold",
		customInstructions: string | undefined,
	) => Promise<unknown>;
};

function createZeroUsageAssistant(harness: Harness): AssistantMessage {
	const model = harness.getModel();
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("issue #8328 zero-usage auto-compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createCompactionHarness(): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 20 }],
			settings: { compaction: { enabled: true, reserveTokens: 10 } },
		});
		harnesses.push(harness);
		// New contract: the threshold path runs a feasibility pre-check against
		// the session branch before launching, so the branch must be genuinely
		// compactable (keep the retained window below the seeded history).
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		return harness;
	}

	/**
	 * Seed the session branch (the source the feasibility pre-check reads) and
	 * mirror it into agent state (the source the zero-usage threshold estimate
	 * reads), so both halves of the threshold decision see the same history —
	 * the same invariant the live prompt flow maintains.
	 */
	function seedBranch(harness: Harness, assistant: AssistantMessage, userText: string): void {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now() - 1,
		});
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	it("uses the message estimate when no assistant has reported usage", async () => {
		const harness = await createCompactionHarness();
		const assistant = createZeroUsageAssistant(harness);
		seedBranch(harness, assistant, "x".repeat(400));
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const launchSpy = vi.spyOn(sessionInternals, "_launchBackgroundCompaction").mockResolvedValue(undefined);

		await sessionInternals._checkCompaction(assistant);

		// 400 chars of user text is over the threshold for the 100-token window
		// with only zero usage reported, so the message estimate must drive the
		// threshold compaction all the way to launch.
		expect(launchSpy).toHaveBeenCalledOnce();
		expect(launchSpy).toHaveBeenCalledWith("threshold", undefined);
	});

	it("does not compact when the zero-usage message estimate is below the threshold", async () => {
		const harness = await createCompactionHarness();
		const assistant = createZeroUsageAssistant(harness);
		seedBranch(harness, assistant, "short");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const launchSpy = vi.spyOn(sessionInternals, "_launchBackgroundCompaction").mockResolvedValue(undefined);

		await sessionInternals._checkCompaction(assistant);

		expect(launchSpy).not.toHaveBeenCalled();
	});
});
