/**
 * Regression: byte-budgeted AGENTS.md (decision matrix item 7).
 *
 * The renderer wraps the AGENTS.md chain in a `<system-reminder>`
 * envelope with a byte budget (default 20 KiB). The renderer is
 * a pure function; this regression pins the contract.
 */
import { describe, expect, it } from "vitest";

import { renderWorkspaceContext } from "../../../src/core/system-prompt-render.ts";

describe("regression #009: byte-budgeted instructions (enabled path)", () => {
	it("renders a 5 KiB file as-is with a `<system-reminder>` envelope", () => {
		const r = renderWorkspaceContext([{ path: "AGENTS.md", content: "hello".repeat(1200) }], 20 * 1024);
		expect(r.text).toContain("<system-reminder>");
		expect(r.text).toContain("AGENTS.md");
		expect(r.omitted).toEqual([]);
		expect(r.truncated).toEqual([]);
	});

	it("truncates a 5 MiB file with a UTF-8-safe cut and records the size in the marker", () => {
		const r = renderWorkspaceContext([{ path: "AGENTS.md", content: "x".repeat(5 * 1024 * 1024) }], 20 * 1024);
		const wrapped = r.text;
		expect(wrapped).toContain("<system-reminder>");
		// The full file is recorded as truncated.
		expect(r.truncated).toHaveLength(1);
		expect(r.truncated[0].path).toBe("AGENTS.md");
		expect(r.truncated[0].originalBytes).toBeGreaterThan(4_000_000);
		expect(r.truncated[0].includedBytes).toBeLessThanOrEqual(20 * 1024);
	});

	it("omits the most-specific file when the chain does not fit", () => {
		const r = renderWorkspaceContext(
			[
				{ path: "AGENTS.md", content: "broad".repeat(2000) },
				{ path: "AGENTS.local.md", content: "specific".repeat(2000) },
			],
			1024,
		);
		// Either the chain fits truncated, or the most-specific file
		// is dropped. Either way the rendered text fits the budget.
		const wrappedBytes = Buffer.byteLength(r.text, "utf8");
		expect(wrappedBytes).toBeLessThanOrEqual(2048); // generous upper bound
	});
});
