import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@bramburn/qi-ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@bramburn/qi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

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

function seedCompactableSession(harness: Harness): void {
	const model = harness.getModel();
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(100),
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

/**
 * Replace the stream function with one that records which model the
 * summarisation request was routed to, then returns a canned summary.
 */
function captureSummaryModel(harness: Harness): { summarisedWith: () => Model<any> | undefined } {
	let requestedModel: Model<any> | undefined;
	harness.session.agent.streamFunction = (model: Model<any>, _context: Context, _options?: SimpleStreamOptions) => {
		requestedModel = model;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage("summary"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: createUsage(10),
				},
			});
		});
		return stream;
	};
	return { summarisedWith: () => requestedModel };
}

describe("compaction model preference", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createTwoModelHarness(): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1000, maxTokens: 100 },
				{ id: "faux-cheap", contextWindow: 1000, maxTokens: 100 },
			],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		return harness;
	}

	it("summarises with the current model when no preference is set", async () => {
		const harness = await createTwoModelHarness();
		seedCompactableSession(harness);
		const { summarisedWith } = captureSummaryModel(harness);

		await harness.session.compact();

		expect(summarisedWith()?.id).toBe("faux-1");
	});

	it("summarises with the configured compaction model", async () => {
		const harness = await createTwoModelHarness();
		seedCompactableSession(harness);
		const cheap = harness.getModel("faux-cheap");
		if (!cheap) throw new Error("faux-cheap not registered");
		harness.settingsManager.setCompactionModel({ provider: cheap.provider, modelId: cheap.id });
		const { summarisedWith } = captureSummaryModel(harness);

		await harness.session.compact();

		expect(summarisedWith()?.id).toBe("faux-cheap");
		expect(summarisedWith()?.provider).toBe(cheap.provider);
	});

	it("falls back to the current model when the configured model is unavailable", async () => {
		const harness = await createTwoModelHarness();
		seedCompactableSession(harness);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		harness.settingsManager.setCompactionModel({ provider: "faux", modelId: "gone-model" });
		const { summarisedWith } = captureSummaryModel(harness);

		await harness.session.compact();

		expect(summarisedWith()?.id).toBe("faux-1");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Compaction model faux/gone-model is not available"),
		);
	});
});
