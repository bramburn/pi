import type { AgentTool } from "@bramburn/qi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@bramburn/qi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Polls until `predicate` holds. Always yields first so in-flight microtasks and IO can progress. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 1));
		if (predicate()) return;
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitUntil timed out");
		}
	}
}

describe("AgentSession background compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("applies a background compaction immediately when idle", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "background hot swap summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const result = await harness.session.compactInBackground();

		expect(result?.summary).toBe("background hot swap summary");
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
		expect(harness.session.isBackgroundCompacting).toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({
			type: "compaction_start",
			reason: "manual",
			background: true,
		});
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			aborted: false,
			background: true,
		});
	});

	it("hot-swaps a completed background compaction into the next LLM request at a turn boundary", async () => {
		const startBackground = createDeferred();
		const releaseTool = createDeferred();
		const gateTool: AgentTool = {
			name: "gate",
			label: "Gate",
			description: "Blocks until released",
			parameters: Type.Object({}),
			execute: async () => {
				startBackground.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "gated" }], details: {} };
			},
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			tools: [gateTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "hot swap summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		let secondRequest = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }),
			(context) => {
				secondRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after swap");
			},
		]);

		const promptPromise = harness.session.prompt("run the gate tool");
		await startBackground.promise;
		const backgroundPromise = harness.session.compactInBackground();
		await waitUntil(() => !harness.session.isBackgroundCompacting);
		releaseTool.resolve();
		const backgroundResult = await backgroundPromise;
		await promptPromise;

		expect(backgroundResult?.summary).toBe("hot swap summary");
		expect(secondRequest).toContain("hot swap summary");
		expect(harness.session.getLastAssistantText()).toBe("finished after swap");
	});

	it("does not block prompt() while a background compaction runs", async () => {
		const handlerEntered = createDeferred();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						if (event.signal.aborted) return { cancel: true };
						handlerEntered.resolve();
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("response while compacting")]);

		const backgroundPromise = harness.session.compactInBackground();
		await handlerEntered.promise;

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		expect(harness.session.getLastAssistantText()).toBe("response while compacting");
		harness.session.abortCompaction();
		await expect(backgroundPromise).resolves.toBeUndefined();
	});

	it("replaces an in-flight background compaction with a newer one", async () => {
		let calls = 0;
		const firstHandlerEntered = createDeferred();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						calls++;
						if (calls === 1) {
							if (event.signal.aborted) return { cancel: true };
							firstHandlerEntered.resolve();
							return await new Promise<{ cancel: true }>((resolve) => {
								event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							});
						}
						return {
							compaction: {
								summary: "second summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const first = harness.session.compactInBackground("first");
		await firstHandlerEntered.promise;
		const second = harness.session.compactInBackground("second");

		await expect(first).resolves.toBeUndefined();
		const result = await second;
		expect(result?.summary).toBe("second summary");
		expect(
			harness.eventsOfType("compaction_end").filter((event) => event.aborted && event.background),
		).not.toHaveLength(0);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("discards a completed background compaction when the branch changed underneath the snapshot", async () => {
		const handlerEntered = createDeferred();
		const releaseSummary = createDeferred();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						handlerEntered.resolve();
						await releaseSummary.promise;
						return {
							compaction: {
								summary: "stale summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const targetId = harness.sessionManager.getEntries()[0]!.id;

		const backgroundPromise = harness.session.compactInBackground();
		await handlerEntered.promise;
		await harness.session.navigateTree(targetId);
		releaseSummary.resolve();

		await expect(backgroundPromise).resolves.toBeUndefined();
		expect(harness.session.messages.every((message) => message.role !== "compactionSummary")).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "manual",
			aborted: true,
			background: true,
		});
	});

	it("starts a threshold-triggered background compaction without blocking the run", async () => {
		const handlerEntered = createDeferred();
		const releaseSummary = createDeferred();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 50 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 50_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						handlerEntered.resolve();
						await releaseSummary.promise;
						return {
							compaction: {
								summary: "threshold summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const assistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 60_000,
			timestamp: Date.now() - 500,
		});
		assistant.content = [{ type: "text", text: "large prior response" }];
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 1000,
		});
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let firstRequest = "";
		harness.setResponses([
			(context) => {
				firstRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("answer");
			},
		]);

		await harness.session.prompt("hi");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({
			type: "compaction_start",
			reason: "threshold",
			background: true,
		});
		expect(firstRequest).not.toContain("threshold summary");
		await handlerEntered.promise;
		releaseSummary.resolve();
		await waitUntil(() => harness.session.messages[0]?.role === "compactionSummary");
		expect(JSON.stringify(harness.session.messages)).toContain("threshold summary");
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			background: true,
		});
	});

	it("keeps steering queued during background summarization in the swapped context", async () => {
		const firstToolStarted = createDeferred();
		const releaseFirstTool = createDeferred();
		const secondToolStarted = createDeferred();
		const releaseSecondTool = createDeferred();
		const handlerEntered = createDeferred();
		const releaseSummary = createDeferred();
		const makeGateTool = (name: string, started: { resolve: () => void }, release: Promise<void>): AgentTool => ({
			name,
			label: name,
			description: "Blocks until released",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await release;
				return { content: [{ type: "text", text: `${name} done` }], details: {} };
			},
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			tools: [
				makeGateTool("gate_one", firstToolStarted, releaseFirstTool.promise),
				makeGateTool("gate_two", secondToolStarted, releaseSecondTool.promise),
			],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						handlerEntered.resolve();
						await releaseSummary.promise;
						return {
							compaction: {
								summary: "steering swap summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		let thirdRequest = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("gate_one", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("gate_two", {}), { stopReason: "toolUse" }),
			(context) => {
				thirdRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after swap");
			},
		]);

		const promptPromise = harness.session.prompt("run both gates");
		await firstToolStarted.promise;
		releaseFirstTool.resolve();
		await secondToolStarted.promise;
		const backgroundPromise = harness.session.compactInBackground();
		await handlerEntered.promise;
		await harness.session.steer("change direction");
		releaseSummary.resolve();
		await waitUntil(() => !harness.session.isBackgroundCompacting);
		releaseSecondTool.resolve();
		const backgroundResult = await backgroundPromise;
		await promptPromise;

		expect(backgroundResult?.summary).toBe("steering swap summary");
		expect(thirdRequest).toContain("change direction");
		expect(thirdRequest).toContain("steering swap summary");
		expect(harness.session.getLastAssistantText()).toBe("finished after swap");
	});

	it("does not overwrite a completed-but-pending background compaction at agent_end", async () => {
		const handlerEntered = createDeferred();
		const releaseSummary = createDeferred();
		let handlerCalls = 0;
		let backgroundPromise: Promise<CompactionResult | undefined> | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 50 }],
			// Threshold = contextWindow - reserveTokens = 1_000 tokens: the seeded
			// pre-run context (~100 tokens of assistant usage) stays under it, while
			// the final response's usage estimate lands over it at agent_end.
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 99_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						handlerCalls++;
						if (handlerCalls === 1) {
							handlerEntered.resolve();
							await releaseSummary.promise;
							return {
								compaction: {
									summary: "first manual summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							};
						}
						// Any second invocation indicates the overwrite bug: the
						// agent_end threshold check launched a competing compaction
						// while the first result was still pending.
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		// The final response both starts the manual background compaction and holds
		// it until its result is pending: summarisation completes while streaming,
		// so the hot-swap must wait for run end, and the response usage keeps the
		// context over threshold for the agent_end check.
		harness.setResponses([
			async () => {
				backgroundPromise = harness.session.compactInBackground();
				await handlerEntered.promise;
				releaseSummary.resolve();
				// Resolves once `_backgroundCompaction` clears, which is exactly when
				// `_pendingBackgroundCompaction` takes over.
				await waitUntil(() => !harness.session.isBackgroundCompacting);
				return fauxAssistantMessage("x".repeat(12_000));
			},
		]);

		await harness.session.prompt("hi");
		expect(backgroundPromise).toBeDefined();
		const result = await backgroundPromise;

		// agent_end runs the threshold check while the completed result is still
		// pending; a second launch would call the handler again and orphan the
		// settle promise this awaits.
		expect(handlerCalls).toBe(1);
		expect(
			harness.eventsOfType("compaction_start").filter((event) => event.background && event.reason === "threshold"),
		).toHaveLength(0);
		expect(result?.summary).toBe("first manual summary");
		expect(JSON.stringify(harness.session.messages)).toContain("first manual summary");
	});

	it("lets overflow recovery abort a background compaction and win", async () => {
		let calls = 0;
		const firstHandlerEntered = createDeferred();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						calls++;
						if (calls === 1) {
							if (event.signal.aborted) return { cancel: true };
							firstHandlerEntered.resolve();
							return await new Promise<{ cancel: true }>((resolve) => {
								event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							});
						}
						return {
							compaction: {
								summary: "overflow compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});

		const backgroundPromise = harness.session.compactInBackground();
		await firstHandlerEntered.promise;
		await sessionInternals._checkCompaction(overflowMessage);

		await expect(backgroundPromise).resolves.toBeUndefined();
		expect(
			harness.eventsOfType("compaction_end").filter((event) => event.aborted && event.background),
		).not.toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
		expect(JSON.stringify(harness.session.messages)).toContain("overflow compacted");
	});
});
