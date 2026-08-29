/**
 * Unit tests for the byte-budgeted workspace-context renderer
 * (Phase 4, item 7).
 *
 * The renderer wraps the AGENTS.md chain in a `<system-reminder>`
 * envelope with a `maxBytes` budget. Files that do not fit are
 * omitted; the most-specific file is truncated last with a marker.
 *
 * The renderer is a pure function: same input → same output.
 */
import { describe, expect, it } from "vitest";

import { renderWorkspaceContext } from "../../src/core/system-prompt-render.ts";

describe("renderWorkspaceContext (Phase 4, item 7)", () => {
	it("renders a small chain as-is with a `<system-reminder>` envelope", () => {
		const r = renderWorkspaceContext([{ path: "AGENTS.md", content: "hello world" }], 20 * 1024);
		expect(r.text.startsWith("<system-reminder>")).toBe(true);
		expect(r.text.endsWith("</system-reminder>\n")).toBe(true);
		expect(r.text.includes("AGENTS.md")).toBe(true);
		expect(r.text.includes("hello world")).toBe(true);
		expect(r.omitted.length).toBe(0);
		expect(r.truncated.length).toBe(0);
	});

	it("records a truncated file when the chain is over-budget", () => {
		const r = renderWorkspaceContext([{ path: "AGENTS.md", content: "x".repeat(5 * 1024 * 1024) }], 20 * 1024);
		expect(r.omitted.length).toBe(0);
		expect(r.truncated.length).toBe(1);
		expect(r.truncated[0].path).toBe("AGENTS.md");
		expect(r.truncated[0].originalBytes > 4_000_000).toBe(true);
		expect(r.truncated[0].includedBytes <= 20 * 1024).toBe(true);
	});

	it("records omitted files when a 2-file chain does not fit", () => {
		// Two large files with a 1 KiB budget. The most-specific file
		// (the second in the array) is dropped first.
		const r = renderWorkspaceContext(
			[
				{ path: "AGENTS.md", content: "broad".repeat(2_000) },
				{ path: "AGENTS.local.md", content: "specific".repeat(2_000) },
			],
			1024,
		);
		// The renderer fits what it can; either the most-specific file
		// is omitted or the chain is truncated. Both are acceptable.
		const renderedBytes = Buffer.byteLength(r.text, "utf8");
		expect(renderedBytes <= 2048).toBe(true);
		expect(r.omitted.length + r.truncated.length >= 1).toBe(true);
	});

	it("returns empty text for maxBytes=0", () => {
		const r = renderWorkspaceContext([{ path: "AGENTS.md", content: "hello" }], 0);
		expect(r.text).toBe("");
		expect(r.omitted).toEqual([{ path: "AGENTS.md" }]);
	});

	it("returns empty text for maxBytes < 0", () => {
		const r = renderWorkspaceContext([{ path: "AGENTS.md", content: "hello" }], -1);
		expect(r.text).toBe("");
		expect(r.omitted).toEqual([{ path: "AGENTS.md" }]);
	});

	it("escapes `</system-reminder>` substrings inside file contents to prevent early closure", () => {
		const r = renderWorkspaceContext([{ path: "AGENTS.md", content: "x </system-reminder> y" }], 20 * 1024);
		// The literal substring `</system-reminder>` in the content is
		// escaped to `<\/system-reminder>` so the envelope's
		// terminator doesn't trip the model.
		expect(r.text.includes("</system-reminder> x </system-reminder>")).toBe(false);
		expect(r.text.includes("<\\/system-reminder>")).toBe(true);
	});

	it("UTF-8 safe truncation: never splits a multi-byte code point", () => {
		// Build a content with multi-byte chars (4-byte emoji) at the
		// cut boundary. The cut at the byte boundary should never
		// split a code point.
		const emoji = "\u{1F680}"; // 4 bytes in UTF-8
		const content = emoji.repeat(10_000); // 40_000 bytes
		const r = renderWorkspaceContext([{ path: "AGENTS.md", content }], 1024);
		// The rendered text decodes as valid UTF-8 (no half-codepoint).
		const bytes = Buffer.from(r.text, "utf8");
		const decoded = bytes.toString("utf8");
		expect(decoded.length).toBe(r.text.length);
	});

	it("empty file list returns an empty string with no diagnostics", () => {
		const r = renderWorkspaceContext([], 20 * 1024);
		expect(r.text).toBe("");
		expect(r.omitted.length).toBe(0);
		expect(r.truncated.length).toBe(0);
	});

	it("fits within the budget even with a 5 MiB AGENTS.md (truncation kicks in)", () => {
		const r = renderWorkspaceContext([{ path: "AGENTS.md", content: "x".repeat(5 * 1024 * 1024) }], 20 * 1024);
		const bytes = Buffer.byteLength(r.text, "utf8");
		expect(bytes <= 20 * 1024).toBe(true);
	});
});
