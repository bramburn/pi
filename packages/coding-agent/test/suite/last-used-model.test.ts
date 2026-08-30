import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession lastUsedModel tracking", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("setModel updates lastUsedModel without touching the global default", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);

		const next = harness.getModel("faux-2") as Model<string>;
		await harness.session.setModel(next);

		expect(harness.settingsManager.getLastUsedModel()).toEqual({
			provider: next.provider,
			modelId: next.id,
		});
		// setModel is session-only by default; the global default is only updated
		// when callers explicitly pass { persist: true }.
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
		expect(harness.settingsManager.getDefaultProvider()).toBeUndefined();
	});

	it("cycleModel updates lastUsedModel", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);

		const modelOne = harness.getModel("faux-1") as Model<string>;
		const modelTwo = harness.getModel("faux-2") as Model<string>;
		harness.session.setScopedModels([{ model: modelOne }, { model: modelTwo }] as Array<{
			model: Model<string>;
			thinkingLevel?: ThinkingLevel;
		}>);

		await harness.session.cycleModel("forward");

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.settingsManager.getLastUsedModel()).toEqual({
			provider: modelTwo.provider,
			modelId: "faux-2",
		});
	});

	it("subsequent setModel calls overwrite lastUsedModel", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const first = harness.getModel("faux-1") as Model<string>;
		const second = harness.getModel("faux-2") as Model<string>;
		const third = harness.getModel("faux-3") as Model<string>;

		await harness.session.setModel(first);
		expect(harness.settingsManager.getLastUsedModel()?.modelId).toBe("faux-1");

		await harness.session.setModel(second);
		expect(harness.settingsManager.getLastUsedModel()?.modelId).toBe("faux-2");

		await harness.session.setModel(third);
		expect(harness.settingsManager.getLastUsedModel()?.modelId).toBe("faux-3");
	});
});
