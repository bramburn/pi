import { fauxAssistantMessage } from "@bramburn/qi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	CompactionSkippedError,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	prepareCompactionResult,
} from "../../src/core/compaction/index.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("compaction typed skip result and threshold latch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("distinguishes already-compacted, no-cut-point, and nothing-to-summarize in prepareCompactionResult", () => {
		const compactionTail: SessionEntry[] = [
			{
				type: "compaction",
				id: "c-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "prev",
				firstKeptEntryId: "m-1",
				tokensBefore: 1000,
			},
		];
		const r1 = prepareCompactionResult(compactionTail, DEFAULT_COMPACTION_SETTINGS);
		expect(r1).toEqual({
			skipped: true,
			skipReason: "already-compacted",
			reason: "Already compacted (no new entries since last compaction)",
		});
		expect(prepareCompaction(compactionTail, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();

		const emptyEntries: SessionEntry[] = [];
		const r2 = prepareCompactionResult(emptyEntries, DEFAULT_COMPACTION_SETTINGS);
		expect(r2).toEqual({
			skipped: true,
			skipReason: "no-cut-point",
			reason: "No valid cut point found for compaction",
		});
		expect(prepareCompaction(emptyEntries, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();

		const smallSession: SessionEntry[] = [
			{
				type: "message",
				id: "m-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: [{ type: "text", text: "short prompt" }],
					timestamp: Date.now(),
				},
			},
		];
		const r3 = prepareCompactionResult(smallSession, DEFAULT_COMPACTION_SETTINGS);
		expect(r3).toEqual({
			skipped: true,
			skipReason: "nothing-to-summarize",
			reason: "Nothing to summarize (all entries since last compaction are within the retained recent-token window)",
		});
		expect(prepareCompaction(smallSession, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
	});

	it("emits skipped compaction_end without errorMessage, rejects blocking compact() with CompactionSkippedError, and resolves compactInBackground() undefined", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hi there")]);
		await harness.session.prompt("hello");

		// ADR-0005 / R28: the blocking path rejects with a typed skip after
		// emitting the terminal skipped event (no errorMessage).
		const rejection = await harness.session.compact().catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(CompactionSkippedError);
		expect((rejection as CompactionSkippedError).skipReason).toBe("nothing-to-summarize");
		expect((rejection as CompactionSkippedError).name).toBe("CompactionSkippedError");
		// The message must match the hot-swap extension's skip-downgrade regex (R28).
		expect((rejection as CompactionSkippedError).message).toMatch(
			/Nothing to compact|Already compacted|nothing to summarize|no valid cut point/i,
		);
		const manualEnds = harness.eventsOfType("compaction_end");
		expect(manualEnds).toHaveLength(1);
		expect(manualEnds[0]).toMatchObject({
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			skipped: true,
			skipReason: "nothing-to-summarize",
		});
		expect(manualEnds[0].errorMessage).toBeUndefined();
		expect(manualEnds[0].skipMessage).toContain("Nothing to summarize");

		// ADR-0005 / R28: the background path resolves undefined on skip.
		const bgResult = await harness.session.compactInBackground();
		expect(bgResult).toBeUndefined();
		const allEnds = harness.eventsOfType("compaction_end");
		expect(allEnds).toHaveLength(2);
		expect(allEnds[1]).toMatchObject({
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			skipped: true,
			skipReason: "nothing-to-summarize",
			background: true,
		});
		expect(allEnds[1].errorMessage).toBeUndefined();
	});

	it("latches threshold compaction skip and does not re-fire until the branch grows", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await harness.session.prompt("small turn");

		const triggerThreshold = () =>
			(
				harness.session as unknown as { _startThresholdBackgroundCompaction: () => void }
			)._startThresholdBackgroundCompaction();

		triggerThreshold();
		triggerThreshold();

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);

		const readLatch = () =>
			(harness.session as unknown as { _thresholdCompactionSkippedAtLeafId: string | null | undefined })
				._thresholdCompactionSkippedAtLeafId;

		const latchedLeaf = readLatch();
		expect(latchedLeaf).toBe(harness.sessionManager.getLeafId());

		// Advancing the branch changes the leaf id so a fresh check is permitted.
		await harness.session.prompt("second small turn");
		expect(harness.sessionManager.getLeafId()).not.toBe(latchedLeaf);

		triggerThreshold();
		expect(readLatch()).toBe(harness.sessionManager.getLeafId());
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("still throws and emits errorMessage when a genuine summarization failure occurs", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// Lower keepRecentTokens so prepareCompaction succeeds on a multi-turn session.
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await harness.session.prompt("first message with enough tokens to exceed keepRecentTokens=1");
		await harness.session.prompt("second message to keep as recent tail");

		// Force the summarization stream call to fail.
		const originalStreamFn = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = () => {
			throw new Error("Simulated provider network failure");
		};

		try {
			await expect(harness.session.compact()).rejects.toThrow("Simulated provider network failure");
			const ends = harness.eventsOfType("compaction_end");
			expect(ends).toHaveLength(1);
			expect(ends[0].skipped).toBeUndefined();
			expect(ends[0].errorMessage).toContain("Compaction failed: Simulated provider network failure");
		} finally {
			harness.session.agent.streamFunction = originalStreamFn;
		}
	});
});
