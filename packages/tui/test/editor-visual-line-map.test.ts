/**
 * Visual line map cache: the map must be reused across cursor moves
 * (same content version + width) and rebuilt after every content or
 * paste-registry mutation.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Create a TUI with a virtual terminal for testing */
function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

type VisualLine = { logicalLine: number; startCol: number; length: number };
type CacheInternals = { buildVisualLineMap(width: number): VisualLine[] };

function mapFor(editor: Editor, width = 40): VisualLine[] {
	return (editor as unknown as CacheInternals).buildVisualLineMap(width);
}

describe("Editor visual line map cache", () => {
	it("returns the same map for repeated calls at the same width", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("hello world");
		assert.strictEqual(mapFor(editor), mapFor(editor));
	});

	it("rebuilds after text input", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("hello");
		const before = mapFor(editor);
		editor.handleInput("!");
		const after = mapFor(editor);
		assert.notStrictEqual(after, before);
		assert.strictEqual(after[0]?.length, "hello!".length);
	});

	it("rebuilds when the width changes", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("hello world this is a long line");
		const narrow = mapFor(editor, 10);
		const wide = mapFor(editor, 40);
		assert.notStrictEqual(narrow, wide);
		assert.ok(narrow.length > wide.length, "narrower width must wrap into more visual lines");
	});

	it("rebuilds after undo", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("first");
		const before = mapFor(editor);
		editor.handleInput("x");
		assert.notStrictEqual(mapFor(editor), before);
		editor.handleInput("\x1b[45;5u"); // undo
		const after = mapFor(editor);
		assert.notStrictEqual(after, before);
		assert.deepStrictEqual(after, before);
	});

	it("rebuilds after a paste registry change", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("start ");
		const before = mapFor(editor);
		editor.pasteText("pasted content", { forceMarker: true });
		const after = mapFor(editor);
		assert.notStrictEqual(after, before);
	});
});
