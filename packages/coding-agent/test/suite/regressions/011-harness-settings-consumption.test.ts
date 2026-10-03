/**
 * Regression: the DeepSeek Harness compaction/pruner knobs are
 * *consumed*, not merely resolved.
 *
 * The settings resolver test (`settings-manager-deepseek-harness.test.ts`)
 * proves the values come back from `getDeepseekHarnessSettings`. It
 * cannot notice that a value is never read by production code, which
 * was the defect this suite covers:
 *
 * - `thresholdRatio` was never read by `shouldCompact`.
 * - `retainRatio` only reached the manual `/compact` path, so
 *   auto-compaction always retained the flat 20000 tokens.
 * - `toolResultThresholdChars` / `toolResultHeadChars` /
 *   `toolResultTailChars` were never passed to the pruner, which
 *   always ran with `DEFAULT_PRUNER_CONFIG`.
 *
 * These tests assert the *effect* of each knob.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PRUNER_CONFIG, pruneSession } from "../../../src/core/compaction/tool-result-pruner.ts";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithHarnessInternals = {
	_effectiveCompactionSettings: () => {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		thresholdRatio?: number;
		retainRatio?: number;
	};
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

interface CapturedPreparation {
	keepRecentTokens: number;
	thresholdRatio: number | undefined;
	retainRatio: number | undefined;
	reason: string;
}

/**
 * A harness whose session is large enough to compact under any
 * `keepRecentTokens` this suite configures. The session is seeded
 * directly on the session manager so no provider turn runs and the
 * auto-compaction threshold cannot fire while seeding.
 *
 * `contextWindow: 1000` keeps `floor(contextWindow * retainRatio)`
 * small enough that two large user turns produce a real cut point.
 */
async function createCaptureHarness(retainRatio: number, captured: CapturedPreparation[]): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
		settings: { deepseekHarness: { enabled: true, thresholdRatio: 0.75, retainRatio } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", (event) => {
					captured.push({
						keepRecentTokens: event.preparation.settings.keepRecentTokens,
						thresholdRatio: event.preparation.settings.thresholdRatio,
						retainRatio: event.preparation.settings.retainRatio,
						reason: event.reason,
					});
					return {
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		],
	});
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "x".repeat(4000) }],
		timestamp: now - 4000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("a".repeat(400)));
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "y".repeat(4000) }],
		timestamp: now - 2000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("b".repeat(400)));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

function sizedResultTool(budget: number): AgentTool {
	return {
		name: "sized_result",
		label: "Sized result",
		description: "Returns a fixed-size result",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "z".repeat(budget) }], details: {} }),
	};
}

function toolResultText(harness: Harness): string {
	const result = harness.session.messages.find((message) => message.role === "toolResult") as
		| { content: { type: string; text: string }[] }
		| undefined;
	return result?.content[0]?.text ?? "";
}

describe("regression #011: DeepSeek Harness settings are consumed", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("with the bundle off, the effective settings carry no ratio knobs", async () => {
		const harness = await createHarness({
			settings: { compaction: { reserveTokens: 16384, keepRecentTokens: 20000 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithHarnessInternals;

		expect(internals._effectiveCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
	});

	it("with the bundle on, the effective settings are ratio-derived", async () => {
		const harness = await createHarness({
			settings: { deepseekHarness: { enabled: true, thresholdRatio: 0.75, retainRatio: 0.25 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithHarnessInternals;
		const contextWindow = harness.getModel().contextWindow;

		const settings = internals._effectiveCompactionSettings();
		expect(settings.thresholdRatio).toBe(0.75);
		expect(settings.retainRatio).toBe(0.25);
		expect(settings.keepRecentTokens).toBe(Math.floor(contextWindow * 0.25));
		expect(settings.keepRecentTokens).not.toBe(20000);
	});

	it("manual and auto compaction derive the same keepRecentTokens", async () => {
		// Two ratios so the derivation is proven, not hardcoded.
		for (const retainRatio of [0.5, 0.7]) {
			const manualCapture: CapturedPreparation[] = [];
			const manualHarness = await createCaptureHarness(retainRatio, manualCapture);
			harnesses.push(manualHarness);
			await manualHarness.session.compact();

			const autoCapture: CapturedPreparation[] = [];
			const autoHarness = await createCaptureHarness(retainRatio, autoCapture);
			harnesses.push(autoHarness);
			await (autoHarness.session as unknown as SessionWithHarnessInternals)._runAutoCompaction("threshold", false);

			const manual = manualCapture.find((entry) => entry.reason === "manual");
			const auto = autoCapture.find((entry) => entry.reason === "threshold");
			const expected = Math.floor(autoHarness.getModel().contextWindow * retainRatio);

			// The auto path used to keep the flat 20000; the manual path
			// already derived the ratio. Both must now agree.
			expect(manual?.keepRecentTokens).toBe(expected);
			expect(auto?.keepRecentTokens).toBe(expected);
			expect(manual?.keepRecentTokens).toBe(auto?.keepRecentTokens);
			expect(manual?.retainRatio).toBe(retainRatio);
			expect(auto?.retainRatio).toBe(retainRatio);
			expect(manual?.thresholdRatio).toBe(0.75);
			expect(auto?.thresholdRatio).toBe(0.75);
		}
	});

	it("an unknown context window keeps the flat keepRecentTokens", async () => {
		const harness = await createHarness({
			settings: { deepseekHarness: { enabled: true, retainRatio: 0.25 } },
			models: [{ id: "faux-1", contextWindow: 0, maxTokens: 100 }],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithHarnessInternals;

		const settings = internals._effectiveCompactionSettings();
		expect(settings.retainRatio).toBe(0.25);
		// Never 0 and never NaN: the window is unknown, so the legacy
		// absolute value stands.
		expect(settings.keepRecentTokens).toBe(20000);
	});

	it("the pruner receives the configured char budgets", async () => {
		// 1000 chars: above the configured 500-char threshold, below the
		// 8192-char default. Only the configured budget can prune it.
		const budget = 1000;
		const big = "z".repeat(budget);
		const harness = await createHarness({
			settings: {
				deepseekHarness: {
					enabled: true,
					toolResultPruneEveryN: 1,
					toolResultThresholdChars: 500,
					toolResultHeadChars: 100,
					toolResultTailChars: 20,
				},
			},
			tools: [sizedResultTool(budget)],
			initialActiveToolNames: ["sized_result"],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("sized_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run the sized tool");

		const text = toolResultText(harness);
		// Head/tail come from the configured 100/20 chars, not the
		// defaults 4096/1024. Length is not asserted exactly because the
		// marker is a fixed string but its position is what matters here.
		expect(text.startsWith(big.slice(0, 100))).toBe(true);
		expect(text.endsWith(big.slice(-20))).toBe(true);
		expect(text.length).toBeLessThan(big.length);
		expect(text).toContain(DEFAULT_PRUNER_CONFIG.pruneMarker);

		// Control: the default budget (8192 threshold) does not touch a
		// 1000-char result, so its head is the whole string. That is the
		// behaviour the session used to get unconditionally.
		const original = {
			role: "toolResult" as const,
			toolCallId: "t1",
			toolName: "sized_result",
			content: [{ type: "text" as const, text: big }],
			isError: false,
			timestamp: 1,
		};
		const untouched = pruneSession([original], DEFAULT_PRUNER_CONFIG);
		const untouchedText = (untouched[0] as { content: { type: string; text: string }[] }).content[0].text;
		expect(untouchedText).toBe(big);
		expect(untouchedText.length).not.toBe(text.length);
	});

	it("the default budget leaves the same result untouched", async () => {
		const harness = await createHarness({
			settings: { deepseekHarness: { enabled: true, toolResultPruneEveryN: 1 } },
			tools: [sizedResultTool(1000)],
			initialActiveToolNames: ["sized_result"],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("sized_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run the sized tool");

		expect(toolResultText(harness)).toBe("z".repeat(1000));
	});

	it("with the bundle off, the pruner never runs", async () => {
		const harness = await createHarness({
			settings: {
				deepseekHarness: {
					enabled: false,
					toolResultPruneEveryN: 1,
					toolResultThresholdChars: 500,
					toolResultHeadChars: 100,
					toolResultTailChars: 20,
				},
			},
			tools: [sizedResultTool(1000)],
			initialActiveToolNames: ["sized_result"],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("sized_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run the sized tool");

		expect(toolResultText(harness)).toBe("z".repeat(1000));
	});
});
