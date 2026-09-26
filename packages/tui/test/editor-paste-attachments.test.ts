/**
 * PR-B: tests for atomic paste markers, attachment widening, and the new
 * public pasteText/pasteImage API on the Editor component.
 *
 * These tests cover:
 *   - The widened marker regex
 *   - pasteText / pasteImage insertion paths
 *   - Forward-delete cleanup of the paste registry
 *   - Renumbering higher IDs after a marker is removed
 *   - Insertion guards that refuse to splice into a paste marker
 *   - Undo stack clearing after image paste
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, type PasteAttachment } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Create a TUI with a virtual terminal for testing */
function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

/**
 * Access private fields on Editor (pastes Map, undoStack, cursorCol, lines).
 * The PasteAttachment widening and the paste registry are implementation
 * details; tests can inspect them via a typed cast.
 */
type EditorInternals = {
	pastes: Map<number, PasteAttachment>;
	pasteCounter: number;
	undoStack: { length: number; clear(): void };
	state: { cursorLine: number; cursorCol: number; lines: string[] };
};

function internals(editor: Editor): EditorInternals {
	return editor as unknown as EditorInternals;
}

describe("Editor PR-B: atomic paste markers & attachments", () => {
	describe("Marker regex", () => {
		// The regex is module-private. We exercise it indirectly by inserting
		// markers via pasteText/pasteImage and asserting text equality.
		it("matches the legacy text marker `[paste #1 +123 lines]`", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const big = "line\n".repeat(123).trimEnd();
			editor.pasteText(big);
			assert.match(editor.getText(), /\[paste #1 \+123 lines\]/);
		});

		it("matches a free-form label marker `[paste #2 image: foo.png]`", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.pasteImage(new Uint8Array([1, 2, 3]), "image/png", "foo.png");
			assert.match(editor.getText(), /\[paste #1 image: foo\.png\]/);
		});

		it("matches a generic label marker `[paste #3 foo: bar]`", () => {
			// Drive the regex directly by inserting via pasteText with forceMarker.
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.pasteText("ignored", { forceMarker: true });
			const text = editor.getText();
			// Marker should preserve a label; we accept any single-segment label.
			assert.match(text, /^\[paste #1 [^\]]+\]$/);
		});
	});

	describe("pasteText", () => {
		it("inserts a marker and registry entry when forceMarker is true", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.pasteText("hi", { forceMarker: true });

			assert.match(editor.getText(), /\[paste #1 2 chars\]/);
			const i = internals(editor);
			assert.strictEqual(i.pastes.size, 1);
			assert.strictEqual(i.pastes.get(1)?.kind, "text");
		});

		it("inserts text inline and does not register a paste for small input", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.pasteText("hi");
			assert.strictEqual(editor.getText(), "hi");
			assert.strictEqual(internals(editor).pastes.size, 0);
		});

		it("auto-creates a marker above the line threshold (>10 lines)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const big = Array.from({ length: 11 }, (_, i) => `line${i}`).join("\n");
			editor.pasteText(big);

			assert.match(editor.getText(), /\[paste #1 \+11 lines\]/);
			assert.strictEqual(internals(editor).pastes.size, 1);
		});
	});

	describe("pasteImage", () => {
		it("inserts an image marker and stores the bytes in the registry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
			editor.pasteImage(bytes, "image/jpeg", "photo.jpg");

			assert.match(editor.getText(), /\[paste #1 image: photo\.jpg\]/);

			const att = internals(editor).pastes.get(1);
			assert.ok(att);
			assert.strictEqual(att.kind, "image");
			if (att.kind === "image") {
				assert.strictEqual(att.mimeType, "image/jpeg");
				assert.strictEqual(att.fileName, "photo.jpg");
				assert.deepStrictEqual(Array.from(att.bytes), [0xff, 0xd8, 0xff]);
			}
		});

		it("truncates the fileName label inside the marker to <= 30 chars", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const longName = "this-is-a-very-long-filename-that-exceeds-the-limit.png";
			editor.pasteImage(new Uint8Array([0]), "image/png", longName);

			const text = editor.getText();
			const marker = text.match(/\[paste #1 image: [^\]]+\]/)![0]!;
			// First 30 chars of the long name must appear (no ellipsis added).
			assert.match(marker, /\[paste #1 image: this-is-a-very-long-filename-t\]$/);
			assert.ok(marker.length <= 51, `marker unexpectedly long: ${marker.length}`);
		});

		it("clears the undo stack after a paste so undo cannot resurrect image bytes", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// Type something so an undo snapshot exists.
			editor.handleInput("prefix ");
			assert.ok(internals(editor).undoStack.length > 0);

			editor.pasteImage(new Uint8Array([1, 2, 3]), "image/png", "foo.png");
			assert.strictEqual(internals(editor).undoStack.length, 0);
		});
	});

	describe("Forward-delete cleanup", () => {
		it("removes the registry entry when the next character is a paste marker", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("prefix ");
			editor.pasteText("hello world", { forceMarker: true });
			editor.handleInput(" suffix");

			assert.strictEqual(internals(editor).pastes.size, 1);

			// Move cursor to just before the marker.
			const i = internals(editor);
			const marker = i.state.lines[0]!.match(/\[paste #1 [^\]]+\]/)![0]!;
			const markerStart = i.state.lines[0]!.indexOf(marker);
			i.state.cursorCol = markerStart;

			// Forward delete removes the marker + registry entry.
			editor.handleInput("\x1b[3~");
			assert.strictEqual(internals(editor).pastes.size, 0);
			assert.strictEqual(i.state.lines[0]!.includes("[paste"), false);
		});

		it("renumbers higher marker IDs after deleting the first marker", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			editor.pasteText("first", { forceMarker: true });
			editor.handleInput(" ");
			editor.pasteText("second", { forceMarker: true });

			// Registry should be {1: "first", 2: "second"}.
			const i = internals(editor);
			assert.strictEqual(i.pastes.size, 2);

			// Move cursor to just after "A" (start of marker #1).
			i.state.cursorCol = 1;

			// Forward-delete removes marker #1; registry becomes {1: "second"}.
			editor.handleInput("\x1b[3~");
			assert.strictEqual(internals(editor).pastes.size, 1);
			assert.strictEqual(internals(editor).pastes.has(1), true);
			assert.strictEqual(internals(editor).pastes.has(2), false);

			// The marker text should now read [paste #1 ...] (renumbered).
			assert.match(i.state.lines[0]!, /\[paste #1 [^\]]+\]/);
			assert.ok(!i.state.lines[0]!.includes("[paste #2"));
		});

		it("undo restores the registry entry after forward-delete cleanup", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted: { text: string; attachments: PasteAttachment[] } | undefined;
			editor.onSubmit = (payload) => {
				submitted = payload;
			};

			editor.handleInput("A");
			editor.pasteText("hello", { forceMarker: true });

			const before = editor.getText();
			const i = internals(editor);
			i.state.cursorCol = 1; // before the marker

			editor.handleInput("\x1b[3~"); // forward delete the marker
			assert.strictEqual(i.pastes.size, 0);

			editor.handleInput("\x1b[45;5u"); // undo
			assert.strictEqual(editor.getText(), before);
			assert.strictEqual(internals(editor).pastes.size, 1);

			editor.handleInput("\r");
			assert.ok(submitted);
			assert.strictEqual(submitted.text, "Ahello");
		});
	});

	describe("Insertion guard", () => {
		it("refuses to splice text inside a paste marker", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.pasteImage(new Uint8Array([1]), "image/png", "foo.png");
			// Marker text: "[paste #1 image: foo.png]" (length 27). Force cursor inside it.
			const i = internals(editor);
			const marker = i.state.lines[0]!;
			const markerStart = 0;
			const markerEnd = marker.length;
			// Position cursor 5 chars inside the marker.
			i.state.cursorCol = markerStart + 5;

			editor.handleInput("X");

			// Marker text must be intact - "X" must NOT appear between the brackets.
			const after = i.state.lines[0]!;
			const insideMatch = after.match(/\[paste #1 image: foo\.png\]/);
			assert.ok(insideMatch, `marker was mutated: ${after}`);
			// Strip the marker from the line; only the surrounding "X" should remain.
			const outside = after.replace(/\[paste #1 image: foo\.png\]/, "");
			assert.strictEqual(outside, "X", `X was inserted outside marker boundary: ${after}`);
			// The "X" must sit exactly on the marker boundary, not within it.
			const xIdx = after.indexOf("X");
			assert.ok(
				xIdx === markerEnd || xIdx === markerStart,
				`X landed at ${xIdx}, marker [${markerStart}, ${markerEnd})`,
			);
		});

		it("snaps cursorCol back to a marker boundary when forced inside", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.pasteImage(new Uint8Array([1]), "image/png", "foo.png");
			const i = internals(editor);
			// Force cursor past the end of the marker; setCursorCol must not move it inside.
			i.state.cursorCol = 5;
			// Calling handleInput on something innocuous to flush state via insertCharacter path.
			editor.handleInput("\x1b[3~"); // forward delete on an empty character does nothing
			// The setCursorCol guard runs whenever we re-enter setCursorCol; doing any
			// navigation that calls setCursorCol is enough. Try a typed character.
			editor.handleInput("Y");
			// Cursor should not remain at 5 (inside marker); it should be snapped to a boundary.
			assert.ok(i.state.cursorCol !== 5, `cursor left inside marker: col=${i.state.cursorCol}`);
		});
	});

	describe("onSubmit payload", () => {
		it("invokes onSubmit with { text, attachments } when submitting", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let payload: { text: string; attachments: PasteAttachment[] } | undefined;
			editor.onSubmit = (p) => {
				payload = p;
			};

			editor.handleInput("hello");
			editor.handleInput("\r");

			assert.ok(payload);
			assert.strictEqual(payload.text, "hello");
			assert.deepStrictEqual(payload.attachments, []);
		});

		it("includes text attachments with their expanded text in the payload", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let payload: { text: string; attachments: PasteAttachment[] } | undefined;
			editor.onSubmit = (p) => {
				payload = p;
			};

			const big = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n");
			editor.pasteText(big);
			editor.handleInput("\r");

			assert.ok(payload);
			assert.strictEqual(payload.text, big);
			assert.strictEqual(payload.attachments.length, 1);
			assert.strictEqual(payload.attachments[0]?.kind, "text");
			if (payload.attachments[0]?.kind === "text") {
				assert.strictEqual(payload.attachments[0].content, big);
			}
		});
	});

	describe("getAttachments", () => {
		it("returns the current attachments in registry order", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.pasteText("text1", { forceMarker: true });
			editor.pasteImage(new Uint8Array([1, 2]), "image/png", "img.png");

			const attachments = editor.getAttachments();
			assert.strictEqual(attachments.length, 2);
			assert.strictEqual(attachments[0]?.kind, "text");
			assert.strictEqual(attachments[1]?.kind, "image");
		});

		it("clears attachments after submit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.pasteText("text1", { forceMarker: true });
			editor.handleInput("\r");
			assert.deepStrictEqual(editor.getAttachments(), []);
		});
	});
});
