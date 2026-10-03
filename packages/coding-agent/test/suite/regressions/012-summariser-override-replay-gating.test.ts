/**
 * Regression: the PI_SUMMARIZER_* env override disables replay-prefix
 * summarisation.
 *
 * With `deepseekHarness.enabled` + `replayPrefixSummarisation: true`,
 * auto-compaction sends the live conversation as the request prefix
 * (structured toolCall/toolResult blocks) with the summarisation
 * instruction appended as a new user message. The PI_SUMMARIZER_* override
 * model is a text-only OpenAI-compatible completions endpoint
 * (`input: ["text"]` in packages/ai/src/summariser-model.ts), so those
 * structured blocks are unrepresentable there: while the override is the
 * request model, compaction must silently use the legacy `<conversation>`
 * text path even though the replay-prefix flag is on. With no override,
 * the replay prefix is unchanged.
 *
 * Why a sibling of 011 rather than a case inside it: 011 proves harness
 * knobs are *consumed* with env-free fixtures; this proves a knob is
 * *overridden* by the summariser env override and needs deliberate env
 * stubbing plus request-shape capture — a different interaction surface.
 *
 * The request shape is observed through a capturing
 * `agent.streamFunction` stub, so no test hits the network even with the
 * override env vars set (the stub intercepts before any provider call).
 */
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	PI_SUMMARIZER_API_KEY_ENV,
	PI_SUMMARIZER_BASE_URL_ENV,
	PI_SUMMARIZER_MODEL_ENV,
	SUMMARISER_OVERRIDE_PROVIDER_ID,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const ENV_KEYS = [PI_SUMMARIZER_BASE_URL_ENV, PI_SUMMARIZER_MODEL_ENV, PI_SUMMARIZER_API_KEY_ENV] as const;

interface CapturedRequest {
	model: { id: string; provider: string };
	messages: unknown[];
}

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

/**
 * Seed a compactable session containing a toolCall/toolResult pair so the
 * two summarisation request shapes are distinguishable: the replay prefix
 * preserves the pair as structured blocks, the legacy path serialises it
 * into the `<conversation>` text block.
 *
 * `contextWindow: 1000` with the default `retainRatio` 0.16 keeps
 * `keepRecentTokens` at 160 so the cut lands before the tool pair and the
 * pair ends up in `messagesToSummarize`.
 */
async function createToolPairHarness(): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
		settings: { deepseekHarness: { enabled: true, replayPrefixSummarisation: true } },
	});
	const now = Date.now();
	const toolCall = fauxToolCall("probe_tool", {});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "x".repeat(4000) }],
		timestamp: now - 4000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage(toolCall, { stopReason: "toolUse" }));
	harness.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: "probe_tool",
		content: [{ type: "text", text: "probe output" }],
		isError: false,
		timestamp: now - 3500,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "y".repeat(4000) }],
		timestamp: now - 2000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("b".repeat(400)));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

/**
 * Replace the agent stream with a capture stub that records the
 * summarisation request and answers with a canned summary.
 */
function captureSummarisation(harness: Harness): {
	ref: { captured: CapturedRequest | undefined };
	run: () => Promise<boolean>;
} {
	const ref: { captured: CapturedRequest | undefined } = { captured: undefined };
	harness.session.agent.streamFunction = (model, context) => {
		ref.captured = { model: { id: model.id, provider: model.provider }, messages: context.messages };
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage("captured summary"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	const internals = harness.session as unknown as SessionWithCompactionInternals;
	return { ref, run: () => internals._runAutoCompaction("threshold", false) };
}

describe("regression #012: PI_SUMMARIZER_* override gates replay-prefix summarisation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		// Restore the ambient-free state the harness scrub establishes: the
		// override vars are only set deliberately inside a test.
		for (const key of ENV_KEYS) delete process.env[key];
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("ignores replayPrefixSummarisation while the override is active (legacy text path)", async () => {
		process.env[PI_SUMMARIZER_BASE_URL_ENV] = "https://stub.invalid/v1";
		process.env[PI_SUMMARIZER_MODEL_ENV] = "stub-summariser";
		process.env[PI_SUMMARIZER_API_KEY_ENV] = "stub-key";

		const harness = await createToolPairHarness();
		harnesses.push(harness);
		const { ref, run } = captureSummarisation(harness);

		await run();

		// The auto path returns "a queued run continued" (false when nothing
		// was queued), so assert the compaction effect instead.
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		// The override model is the request target — otherwise this test
		// would pass vacuously.
		expect(ref.captured?.model.id).toBe("stub-summariser");
		expect(ref.captured?.model.provider).toBe(SUMMARISER_OVERRIDE_PROVIDER_ID);
		// The replay prefix flag was ON in settings, but the request must be
		// the legacy single `<conversation>` text message with no structured
		// toolCall blocks.
		const messages = ref.captured?.messages ?? [];
		expect(messages).toHaveLength(1);
		expect(JSON.stringify(messages)).not.toContain('"type":"toolCall"');
		expect(JSON.stringify(messages)).toContain("<conversation>");
	});

	it("still sends the structured replay prefix when no override is configured", async () => {
		const harness = await createToolPairHarness();
		harnesses.push(harness);
		const { ref, run } = captureSummarisation(harness);

		await run();

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(ref.captured?.model.provider).not.toBe(SUMMARISER_OVERRIDE_PROVIDER_ID);
		const messages = ref.captured?.messages ?? [];
		// Structured replay prefix: the conversation messages (user, assistant
		// toolCall, toolResult) plus the appended summarisation instruction.
		expect(messages.length).toBeGreaterThan(1);
		expect(JSON.stringify(messages)).toContain('"type":"toolCall"');
		expect(JSON.stringify(messages)).toContain('"role":"toolResult"');
		expect(JSON.stringify(messages)).toContain("conversation to summarize");
	});
});
