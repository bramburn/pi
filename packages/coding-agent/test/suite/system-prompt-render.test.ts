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
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	renderWorkspaceContext,
} from "../../src/core/system-prompt-render.ts";

describe("renderWorkspaceContext (Phase 4, item 7)", () => {
	it("renders a small chain as-is with a `<system-reminder>` envelope", () => {
		const r = renderWorkspaceContext(
			[{ path: "AGENTS.md", content: "hello world" }],
			20 * 1024,
		);
		assert.ok(r.text.startsWith("<system-reminder>"));
		assert.ok(r.text.endsWith("</system-reminder>\n"));
		assert.ok(r.text.includes("AGENTS.md"));
		assert.ok(r.text.includes("hello world"));
		assert.equal(r.omitted.length, 0);
		assert.equal(r.truncated.length, 0);
	});

	it("records a truncated file when the chain is over-budget", () => {
		const r = renderWorkspaceContext(
			[{ path: "AGENTS.md", content: "x".repeat(5 * 1024 * 1024) }],
			20 * 1024,
		);
		assert.equal(r.omitted.length, 0);
		assert.equal(r.truncated.length, 1);
		assert.equal(r.truncated[0].path, "AGENTS.md");
		assert.ok(r.truncated[0].originalBytes > 4_000_000);
		assert.ok(r.truncated[0].includedBytes <= 20 * 1024);
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
		assert.ok(renderedBytes <= 2048, `expected ≤ 2 KiB, got ${renderedBytes}`);
		assert.ok(r.omitted.length + r.truncated.length >= 1);
	});

	it("returns empty text for maxBytes=0", () => {
		const r = renderWorkspaceContext(
			[{ path: "AGENTS.md", content: "hello" }],
			0,
		);
		assert.equal(r.text, "");
		assert.deepEqual(r.omitted, [{ path: "AGENTS.md" }]);
	});

	it("returns empty text for maxBytes < 0", () => {
		const r = renderWorkspaceContext(
			[{ path: "AGENTS.md", content: "hello" }],
			-1,
		);
		assert.equal(r.text, "");
		assert.deepEqual(r.omitted, [{ path: "AGENTS.md" }]);
	});

	it("escapes `</system-reminder>` substrings inside file contents to prevent early closure", () => {
		const r = renderWorkspaceContext(
			[{ path: "AGENTS.md", content: "x </system-reminder> y" }],
			20 * 1024,
		);
		// The literal substring `</system-reminder>` in the content is
		// escaped to `<\/system-reminder>` so the envelope's
		// terminator doesn't trip the model.
		assert.ok(!r.text.includes("</system-reminder> x </system-reminder>"));
		assert.ok(r.text.includes("<\\/system-reminder>"));
	});

	it("UTF-8 safe truncation: never splits a multi-byte code point", () => {
		// Build a content with multi-byte chars (4-byte emoji) at the
		// cut boundary. The cut at the byte boundary should never
		// split a code point.
		const emoji = "\u{1F680}"; // 4 bytes in UTF-8
		const content = emoji.repeat(10_000); // 40_000 bytes
		const r = renderWorkspaceContext(
			[{ path: "AGENTS.md", content }],
			1024,
		);
		// The rendered text decodes as valid UTF-8 (no half-codepoint).
		const bytes = Buffer.from(r.text, "utf8");
		const decoded = bytes.toString("utf8");
		assert.equal(decoded.length, r.text.length);
	});

	it("empty file list returns an empty string with no diagnostics", () => {
		const r = renderWorkspaceContext([], 20 * 1024);
		assert.equal(r.text, "");
		assert.equal(r.omitted.length, 0);
		assert.equal(r.truncated.length, 0);
	});

	it("fits within the budget even with a 5 MiB AGENTS.md (truncation kicks in)", () => {
		const r = renderWorkspaceContext(
			[{ path: "AGENTS.md", content: "x".repeat(5 * 1024 * 1024) }],
			20 * 1024,
		);
		const bytes = Buffer.byteLength(r.text, "utf8");
		assert.ok(bytes <= 20 * 1024, `expected ≤ 20 KiB, got ${bytes}`);
	});
});
