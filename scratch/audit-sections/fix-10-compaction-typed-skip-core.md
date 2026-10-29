<!-- Extracted from C:\Users\bramburn\AppData\Local\batch-review\runs\38d49d2310b2\gemini_gemini-4-argon_20261020_132559_4e1b\batch_results\FINAL_EXECUTIVE_AUDIT_REPORT.md -->

# pi: Comprehensive Code Review Audit Report

- **Generated At:** 2026-10-20 13:33:31
- **Run ID:** `gemini_gemini-4-argon_20261020_132559_4e1b`
- **Repository:** `C:\dev\pi`
- **Provider:** `GEMINI`
- **Auditing Model:** `gemini-4-argon`
- **Batch ID:** `batches/fe1pd21v32ebtd9ryduq0vmwlfcl904te502`
- **Caching Strategy:** `gemini_4_argon_implicit_95pct_discount` (Enabled: `True`)
- **Review Perspectives Evaluated:** 10
- **Total Input Tokens (Uncached/Total):** 1,112,709
- **Total Cached Read Tokens:** 0
- **Total Cache Creation Tokens:** 0
- **Total Output Tokens (incl. thinking):** 78,113
- **Estimated Non-Batch Cost:** $25.4745
- **Estimated Saving:** $23.2770 (91.4%)

---

### fix-10-compaction-typed-skip-core
> Full Report: [fix-10-compaction-typed-skip-core.md](./fix-10-compaction-typed-skip-core.md) | Tokens: in=84,727 cached_read=0 out=6,027

=== DIFF: packages/coding-agent/src/core/compaction/compaction.ts ===
Rationale: Introduce a typed discriminated result (`prepareCompactionResult` returning `CompactionPreparationOutcome` with `CompactionSkipReason`) in `packages/coding-agent/src/core/compaction/compaction.ts:907-964` to distinguish `already-compacted` (`:910`), `no-cut-point` (`:941`), and `nothing-to-summarize` (`:962-964`), while keeping `prepareCompaction` as the convenience wrapper for existing callers.

```diff
--- a/packages/coding-agent/src/core/compaction/compaction.ts
+++ b/packages/coding-agent/src/core/compaction/compaction.ts
@@ -904,13 +904,40 @@
 	settings: CompactionSettings;
 }
 
+export type CompactionSkipReason = "already-compacted" | "nothing-to-summarize" | "no-cut-point";
+
+export type CompactionPreparationOutcome =
+	| { skipped: false; preparation: CompactionPreparation }
+	| { skipped: true; skipReason: CompactionSkipReason; reason: string };
+
+export function formatCompactionSkipReason(skipReason: CompactionSkipReason): string {
+	switch (skipReason) {
+		case "already-compacted":
+			return "Already compacted (no new entries since last compaction)";
+		case "nothing-to-summarize":
+			return "Nothing to summarize (all entries since last compaction are within the retained recent-token window)";
+		case "no-cut-point":
+			return "No valid cut point found for compaction";
+	}
+}
+
 export function prepareCompaction(
 	pathEntries: SessionEntry[],
 	settings: CompactionSettings,
 ): CompactionPreparation | undefined {
+	const outcome = prepareCompactionResult(pathEntries, settings);
+	return outcome.skipped ? undefined : outcome.preparation;
+}
+
+export function prepareCompactionResult(
+	pathEntries: SessionEntry[],
+	settings: CompactionSettings,
+): CompactionPreparationOutcome {
 	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
-		return undefined;
+		return {
+			skipped: true,
+			skipReason: "already-compacted",
+			reason: formatCompactionSkipReason("already-compacted"),
+		};
 	}
 
 	let prevCompactionIndex = -1;
@@ -938,7 +965,11 @@
 	// Get UUID of first kept entry
 	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
 	if (!firstKeptEntry?.id) {
-		return undefined; // Session needs migration
+		return {
+			skipped: true,
+			skipReason: "no-cut-point",
+			reason: formatCompactionSkipReason("no-cut-point"),
+		};
 	}
 	const firstKeptEntryId = firstKeptEntry.id;
 
@@ -960,7 +991,11 @@
 	}
 
 	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
-		return undefined;
+		return {
+			skipped: true,
+			skipReason: "nothing-to-summarize",
+			reason: formatCompactionSkipReason("nothing-to-summarize"),
+		};
 	}
 
 	// Extract file operations from messages and previous compaction
@@ -974,15 +1009,18 @@
 	}
 
 	return {
-		firstKeptEntryId,
-		messagesToSummarize,
-		turnPrefixMessages,
-		isSplitTurn: cutPoint.isSplitTurn,
-		tokensBefore,
-		previousSummary,
-		fileOps,
-		settings,
+		skipped: false,
+		preparation: {
+			firstKeptEntryId,
+			messagesToSummarize,
+			turnPrefixMessages,
+			isSplitTurn: cutPoint.isSplitTurn,
+			tokensBefore,
+			previousSummary,
+			fileOps,
+			settings,
+		},
 	};
 }
```

Verifying test: `packages/coding-agent/test/suite/compaction-skip-typed.test.ts` (asserts `prepareCompactionResult` returns `{ skipped: true, skipReason: "already-compacted" | "nothing-to-summarize" | "no-cut-point" }` and `prepareCompaction` returns `undefined` for those cases).

=== DIFF: packages/coding-agent/src/core/agent-session.ts ===
Rationale: Emit `compaction_end` with `skipped: true`, `skipReason`, and reason-specific text (no `errorMessage`) in `compact()` (`packages/coding-agent/src/core/agent-session.ts:2245`) and `_runBackgroundCompaction()` (`:2480`), pre-check feasibility before launching threshold background compaction (`:769-777`, `:2399`, `:2809-2812`), and latch the branch leaf ID so threshold compaction does not re-fire on every prompt until the branch grows (`:2581`).

```diff
--- a/packages/coding-agent/src/core/agent-session.ts
+++ b/packages/coding-agent/src/core/agent-session.ts
@@ -39,6 +39,8 @@
 import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
 import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
 import {
+	type CompactionPreparationOutcome,
 	type CompactionResult,
+	type CompactionSkipReason,
 	calculateContextTokens,
 	collectEntriesForBranchSummary,
 	compact,
@@ -47,6 +49,7 @@
 	estimateTokens,
 	generateBranchSummary,
 	prepareCompaction,
+	prepareCompactionResult,
 	pruneSession,
 	shouldCompact,
 } from "./compaction/index.ts";
@@ -162,6 +165,9 @@
 			aborted: boolean;
 			willRetry: boolean;
 			errorMessage?: string;
+			skipped?: boolean;
+			skipReason?: CompactionSkipReason;
+			skipMessage?: string;
 			/** True when the compaction ran in the background (hot-swap apply). */
 			background?: boolean;
 	  }
@@ -361,6 +367,12 @@
 	// part of `isCompacting` so neither the prompt() gate nor the TUI input
 	// queue treat it as blocking.
 	private _backgroundCompaction: { abortController: AbortController; reason: "manual" | "threshold" } | undefined =
 		undefined;
+	/**
+	 * Leaf entry id (or `"__empty__"`) at which a threshold compaction check
+	 * determined there was nothing to compact. Prevents threshold background
+	 * compaction from re-firing on every prompt until the branch grows.
+	 */
+	private _thresholdCompactionSkippedAtLeafId: string | null | undefined = undefined;
 	private _pendingBackgroundCompaction:
 		| {
 				reason: "manual" | "threshold";
@@ -2215,13 +2227,26 @@
 	// =========================================================================
 	// Compaction
 	// =========================================================================
+
+	private _getEffectiveCompactionSettings() {
+		const settings = { ...this.settingsManager.getCompactionSettings() };
+		const dh = this.settingsManager.getDeepseekHarnessSettings(this.model ?? undefined);
+		if (dh.enabled) {
+			settings.thresholdRatio = settings.thresholdRatio ?? dh.thresholdRatio;
+			settings.retainRatio = settings.retainRatio ?? dh.retainRatio;
+			if (settings.retainRatio && this.model && this.model.contextWindow > 0) {
+				settings.keepRecentTokens = Math.floor(this.model.contextWindow * settings.retainRatio);
+			}
+		}
+		return settings;
+	}
 
 	/**
 	 * Manually compact the session context.
 	 * Aborts current agent operation first.
 	 *
 	 * Interactive mode uses {@link compactInBackground} instead; this blocking
 	 * path remains for RPC and extension callers that await the result.
 	 * @param customInstructions Optional instructions for the compaction summary
 	 */
-	async compact(customInstructions?: string): Promise<CompactionResult> {
+	async compact(customInstructions?: string): Promise<CompactionResult | undefined> {
 		this._abortBackgroundCompaction();
 		await this.abort();
 		this._compactionAbortController = new AbortController();
@@ -2235,27 +2260,25 @@
 			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);
 
 			const pathEntries = this.sessionManager.getBranch();
-			const settings = this.settingsManager.getCompactionSettings();
-
-			// When the DeepSeek Harness bundle is enabled, layer the
-			// ratio-based policy on top of the legacy absolute-token
-			// settings. The harness module's `shouldCompact` and
-			// `findCutPoint` use whichever values are present.
-			const dh = this.settingsManager.getDeepseekHarnessSettings(this.model ?? undefined);
-			if (dh.enabled) {
-				settings.thresholdRatio = settings.thresholdRatio ?? dh.thresholdRatio;
-				settings.retainRatio = settings.retainRatio ?? dh.retainRatio;
-				if (settings.retainRatio && this.model && this.model.contextWindow > 0) {
-					settings.keepRecentTokens = Math.floor(this.model.contextWindow * settings.retainRatio);
-				}
-			}
-
-			const preparation = prepareCompaction(pathEntries, settings);
-			if (!preparation) {
-				// Check why we can't compact
-				const lastEntry = pathEntries[pathEntries.length - 1];
-				if (lastEntry?.type === "compaction") {
-					throw new Error("Already compacted");
-				}
-				throw new Error("Nothing to compact (session too small)");
+			const settings = this._getEffectiveCompactionSettings();
+
+			const prepOutcome: CompactionPreparationOutcome = prepareCompactionResult(pathEntries, settings);
+			if (prepOutcome.skipped) {
+				const leafKey = pathEntries.length > 0 ? (pathEntries[pathEntries.length - 1].id ?? null) : "__empty__";
+				this._thresholdCompactionSkippedAtLeafId = leafKey;
+				this._compactionAbortController = undefined;
+				this._emit({
+					type: "compaction_end",
+					reason: "manual",
+					result: undefined,
+					aborted: false,
+					willRetry: false,
+					skipped: true,
+					skipReason: prepOutcome.skipReason,
+					skipMessage: prepOutcome.reason,
+				});
+				return undefined;
 			}
+			const preparation = prepOutcome.preparation;
 
 			let extensionCompaction: CompactionResult | undefined;
 			let fromExtension = false;
@@ -2324,6 +2347,7 @@
 			}
 
 			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
+			this._thresholdCompactionSkippedAtLeafId = undefined;
 			const newEntries = this.sessionManager.getEntries();
 			const sessionContext = this.sessionManager.buildSessionContext();
 			this.agent.state.messages = sessionContext.messages;
@@ -2404,6 +2428,20 @@
 		) {
 			return;
 		}
+		const pathEntries = this.sessionManager.getBranch();
+		const leafKey = pathEntries.length > 0 ? (pathEntries[pathEntries.length - 1].id ?? null) : "__empty__";
+		if (this._thresholdCompactionSkippedAtLeafId !== undefined && this._thresholdCompactionSkippedAtLeafId === leafKey) {
+			return;
+		}
+		const settings = this._getEffectiveCompactionSettings();
+		const prepOutcome = prepareCompactionResult(pathEntries, settings);
+		if (prepOutcome.skipped) {
+			this._thresholdCompactionSkippedAtLeafId = leafKey;
+			return;
+		}
+		this._thresholdCompactionSkippedAtLeafId = undefined;
 		void this._launchBackgroundCompaction("threshold", undefined).catch(() => {
 			// Errors are surfaced via the compaction_end event.
 		});
@@ -2446,24 +2484,26 @@
 
 			const pathEntries = snapshot.pathEntries;
 			const previousCompactionId = snapshot.previousCompactionId;
-			const settings = this.settingsManager.getCompactionSettings();
-
-			// DeepSeek Harness ratio policy layering, same as compact().
-			const dh = this.settingsManager.getDeepseekHarnessSettings(this.model ?? undefined);
-			if (dh.enabled) {
-				settings.thresholdRatio = settings.thresholdRatio ?? dh.thresholdRatio;
-				settings.retainRatio = settings.retainRatio ?? dh.retainRatio;
-				if (settings.retainRatio && this.model && this.model.contextWindow > 0) {
-					settings.keepRecentTokens = Math.floor(this.model.contextWindow * settings.retainRatio);
-				}
-			}
-
-			const preparation = prepareCompaction(pathEntries, settings);
-			if (!preparation) {
-				const lastEntry = pathEntries[pathEntries.length - 1];
-				if (lastEntry?.type === "compaction") {
-					throw new Error("Already compacted");
-				}
-				throw new Error("Nothing to compact (session too small)");
+			const settings = this._getEffectiveCompactionSettings();
+
+			const prepOutcome = prepareCompactionResult(pathEntries, settings);
+			if (prepOutcome.skipped) {
+				const leafKey = pathEntries.length > 0 ? (pathEntries[pathEntries.length - 1].id ?? null) : "__empty__";
+				this._thresholdCompactionSkippedAtLeafId = leafKey;
+				this._emit({
+					type: "compaction_end",
+					reason,
+					result: undefined,
+					aborted: false,
+					willRetry: false,
+					skipped: true,
+					skipReason: prepOutcome.skipReason,
+					skipMessage: prepOutcome.reason,
+					background: true,
+				});
+				return undefined;
 			}
+			const preparation = prepOutcome.preparation;
 
 			let extensionCompaction: CompactionResult | undefined;
 			let fromExtension = false;
@@ -2618,6 +2658,7 @@
 			pending.fromExtension,
 			pending.result.usage,
 		);
+		this._thresholdCompactionSkippedAtLeafId = undefined;
 		const newEntries = this.sessionManager.getEntries();
 		const sessionContext = this.sessionManager.buildSessionContext();
 		this.agent.state.messages = sessionContext.messages;
```

Verifying test: `packages/coding-agent/test/suite/compaction-skip-typed.test.ts` (asserts blocking `compact()` and `compactInBackground()` emit `compaction_end` with `skipped: true`, `skipReason`, `errorMessage: undefined`, and do not throw; asserts threshold latch suppresses repeated background compaction launches until new entries are appended; asserts genuine summarization failures still throw and emit `errorMessage`).

=== DIFF: packages/coding-agent/test/suite/compaction-skip-typed.test.ts ===
Rationale: Add regression test suite covering typed skip outcomes in `prepareCompactionResult`, non-throwing skip events in `compact()` and `compactInBackground()`, threshold skip latching across turns, and genuine failure propagation.

```diff
--- /dev/null
+++ b/packages/coding-agent/test/suite/compaction-skip-typed.test.ts
@@ -0,0 +1,196 @@
+import { describe, expect, it } from "vitest";
+import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
+import {
+	DEFAULT_COMPACTION_SETTINGS,
+	prepareCompaction,
+	prepareCompactionResult,
+} from "../../src/core/compaction/index.ts";
+import type { SessionEntry } from "../../src/core/session-manager.ts";
+import { createSuiteHarness } from "./harness.ts";
+
+describe("compaction typed skip result and threshold latch", () => {
+	it("distinguishes already-compacted, no-cut-point, and nothing-to-summarize in prepareCompactionResult", () => {
+		const compactionTail: SessionEntry[] = [
+			{
+				type: "compaction",
+				id: "c-1",
+				parentId: null,
+				timestamp: new Date().toISOString(),
+				summary: "prev",
+				firstKeptEntryId: "m-1",
+				tokensBefore: 1000,
+			},
+		];
+		const r1 = prepareCompactionResult(compactionTail, DEFAULT_COMPACTION_SETTINGS);
+		expect(r1).toEqual({
+			skipped: true,
+			skipReason: "already-compacted",
+			reason: "Already compacted (no new entries since last compaction)",
+		});
+		expect(prepareCompaction(compactionTail, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
+
+		const emptyEntries: SessionEntry[] = [];
+		const r2 = prepareCompactionResult(emptyEntries, DEFAULT_COMPACTION_SETTINGS);
+		expect(r2).toEqual({
+			skipped: true,
+			skipReason: "no-cut-point",
+			reason: "No valid cut point found for compaction",
+		});
+		expect(prepareCompaction(emptyEntries, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
+
+		const smallSession: SessionEntry[] = [
+			{
+				type: "message",
+				id: "m-1",
+				parentId: null,
+				timestamp: new Date().toISOString(),
+				message: {
+					role: "user",
+					content: [{ type: "text", text: "short prompt" }],
+					timestamp: Date.now(),
+				},
+			},
+		];
+		const r3 = prepareCompactionResult(smallSession, DEFAULT_COMPACTION_SETTINGS);
+		expect(r3).toEqual({
+			skipped: true,
+			skipReason: "nothing-to-summarize",
+			reason: "Nothing to summarize (all entries since last compaction are within the retained recent-token window)",
+		});
+		expect(prepareCompaction(smallSession, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
+	});
+
+	it("emits skipped compaction_end without errorMessage or throwing on manual compact() and compactInBackground()", async () => {
+		const harness = await createSuiteHarness();
+		try {
+			await harness.Prompt("hello");
+
+			const events: Extract<AgentSessionEvent, { type: "compaction_end" }>[] = [];
+			const unsub = harness.session.subscribe((ev) => {
+				if (ev.type === "compaction_end") {
+					events.push(ev);
+				}
+			});
+
+			const blockingResult = await harness.session.compact();
+			expect(blockingResult).toBeUndefined();
+			expect(events).toHaveLength(1);
+			expect(events[0]).toMatchObject({
+				type: "compaction_end",
+				reason: "manual",
+				result: undefined,
+				aborted: false,
+				skipped: true,
+				skipReason: "nothing-to-summarize",
+			});
+			expect(events[0].errorMessage).toBeUndefined();
+
+			const bgResult = await harness.session.compactInBackground();
+			expect(bgResult).toBeUndefined();
+			expect(events).toHaveLength(2);
+			expect(events[1]).toMatchObject({
+				type: "compaction_end",
+				reason: "manual",
+				result: undefined,
+				aborted: false,
+				skipped: true,
+				skipReason: "nothing-to-summarize",
+				background: true,
+			});
+			expect(events[1].errorMessage).toBeUndefined();
+
+			unsub();
+		} finally {
+			await harness.cleanup();
+		}
+	});
+
+	it("latches threshold compaction skip and does not re-fire until the branch grows", async () => {
+		const harness = await createSuiteHarness();
+		try {
+			await harness.Prompt("small turn");
+
+			const startEvents: Extract<AgentSessionEvent, { type: "compaction_start" }>[] = [];
+			const endEvents: Extract<AgentSessionEvent, { type: "compaction_end" }>[] = [];
+			const unsub = harness.session.subscribe((ev) => {
+				if (ev.type === "compaction_start") startEvents.push(ev);
+				if (ev.type === "compaction_end") endEvents.push(ev);
+			});
+
+			// Directly trigger threshold background check while session is below keepRecentTokens
+			const triggerThreshold = () =>
+				(harness.session as unknown as { _startThresholdBackgroundCompaction: () => void })
+					._startThresholdBackgroundCompaction();
+
+			triggerThreshold();
+			triggerThreshold();
+
+			expect(startEvents).toHaveLength(0);
+			expect(endEvents).toHaveLength(0);
+
+			const latchedLeaf = (
+				harness.session as unknown as { _thresholdCompactionSkippedAtLeafId: string | null | undefined }
+			)._thresholdCompactionSkippedAtLeafId;
+			expect(latchedLeaf).toBe(harness.session.sessionManager.getLeafId());
+
+			// Advancing the branch changes the leaf id so a fresh check is permitted
+			await harness.Prompt("second small turn");
+			expect(harness.session.sessionManager.getLeafId()).not.toBe(latchedLeaf);
+
+			triggerThreshold();
+			expect(
+				(harness.session as unknown as { _thresholdCompactionSkippedAtLeafId: string | null | undefined })
+					._thresholdCompactionSkippedAtLeafId,
+			).toBe(harness.session.sessionManager.getLeafId());
+			expect(startEvents).toHaveLength(0);
+
+			unsub();
+		} finally {
+			await harness.cleanup();
+		}
+	});
+
+	it("still throws and emits errorMessage when a genuine summarization failure occurs", async () => {
+		const harness = await createSuiteHarness();
+		try {
+			// Lower keepRecentTokens so prepareCompaction succeeds on a multi-turn session
+			harness.session.settingsManager.setCompactionKeepRecentTokens(1);
+			await harness.Prompt("first message with enough tokens to exceed keepRecentTokens=1");
+			await harness.Prompt("second message to keep as recent tail");
+
+			// Force the summarization stream call to fail
+			const originalStreamFn = harness.session.agent.streamFunction;
+			harness.session.agent.streamFunction = () => {
+				throw new Error("Simulated provider network failure");
+			};
+
+			const endEvents: Extract<AgentSessionEvent, { type: "compaction_end" }>[] = [];
+			const unsub = harness.session.subscribe((ev) => {
+				if (ev.type === "compaction_end") endEvents.push(ev);
+			});
+
+			try {
+				await expect(harness.session.compact()).rejects.toThrow("Simulated provider network failure");
+				expect(endEvents).toHaveLength(1);
+				expect(endEvents[0].skipped).toBeUndefined();
+				expect(endEvents[0].errorMessage).toContain("Compaction failed: Simulated provider network failure");
+			} finally {
+				harness.session.agent.streamFunction = originalStreamFn;
+				unsub();
+			}
+		} finally {
+			await harness.cleanup();
+		}
+	});
+});
```

Verifying test: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/compaction-skip-typed.test.ts` (from `packages/coding-agent`).

---
