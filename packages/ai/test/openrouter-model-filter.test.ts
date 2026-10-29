import { describe, expect, it } from "vitest";
import { shouldIncludeOpenRouterModel } from "../scripts/openrouter-model-filter.ts";

describe("shouldIncludeOpenRouterModel", () => {
	it("includes models advertising tools", () => {
		expect(shouldIncludeOpenRouterModel({ id: "x/y", supported_parameters: ["tools", "reasoning"] })).toBe(true);
	});

	it("drops models whose supported_parameters lack tools", () => {
		// openrouter/fusion has empty supported_parameters live (verified 2026-10-20).
		expect(shouldIncludeOpenRouterModel({ id: "openrouter/fusion", supported_parameters: [] })).toBe(false);
		expect(shouldIncludeOpenRouterModel({ id: "x/y", supported_parameters: ["reasoning"] })).toBe(false);
		expect(shouldIncludeOpenRouterModel({ id: "x/y" })).toBe(false);
	});

	it("keeps allowlisted ids even when tools are not advertised", () => {
		// Metadata-lag fix: verified tool-capable ids bypass the tools filter.
		const exempt = new Set(["alias/tool-capable"]);
		expect(
			shouldIncludeOpenRouterModel({ id: "alias/tool-capable", supported_parameters: ["reasoning"] }, exempt),
		).toBe(true);
		expect(shouldIncludeOpenRouterModel({ id: "alias/other", supported_parameters: ["reasoning"] }, exempt)).toBe(
			false,
		);
		// Allowlist wins over an explicit tools advertisement only in one direction:
		// a model with tools passes regardless of the allowlist.
		expect(shouldIncludeOpenRouterModel({ id: "alias/other", supported_parameters: ["tools"] }, exempt)).toBe(true);
	});
});
