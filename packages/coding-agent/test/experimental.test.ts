import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.QI_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.QI_EXPERIMENTAL;
		} else {
			process.env.QI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when QI_EXPERIMENTAL is unset", () => {
		delete process.env.QI_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when QI_EXPERIMENTAL is empty", () => {
		process.env.QI_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when QI_EXPERIMENTAL is set to 1", () => {
		process.env.QI_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when QI_EXPERIMENTAL is set to 0", () => {
		process.env.QI_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when QI_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.QI_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
