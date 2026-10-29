import { setKeybindings, TuiMainScreen } from "@bramburn/qi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

function makeEditor(keybindings: KeybindingsManager): CustomEditor {
	setKeybindings(keybindings);
	return new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
}

describe("CustomEditor clipboard paste keybindings", () => {
	const sharedKey = "ctrl+v";
	const bindings = new KeybindingsManager({
		"app.clipboard.pasteImage": sharedKey,
		"app.clipboard.pasteText": sharedKey,
	});

	it("falls through to onPasteText when only onPasteText is wired", () => {
		const editor = makeEditor(bindings);
		let textPastes = 0;
		editor.onPasteText = () => {
			textPastes++;
		};

		editor.handleInput("\x16"); // Ctrl+V matches pasteImage first, but no image handler is wired
		expect(textPastes).toBe(1);
	});

	it("prefers onPasteImage over onPasteText when both are wired", () => {
		const editor = makeEditor(bindings);
		let imagePastes = 0;
		let textPastes = 0;
		editor.onPasteImage = () => {
			imagePastes++;
		};
		editor.onPasteText = () => {
			textPastes++;
		};

		editor.handleInput("\x16"); // Ctrl+V
		expect(imagePastes).toBe(1);
		expect(textPastes).toBe(0);
	});

	it("calls onPasteImage when only onPasteImage is wired", () => {
		const editor = makeEditor(bindings);
		let imagePastes = 0;
		editor.onPasteImage = () => {
			imagePastes++;
		};

		editor.handleInput("\x16"); // Ctrl+V
		expect(imagePastes).toBe(1);
	});

	it("does not fire either handler for an unrelated key", () => {
		const editor = makeEditor(bindings);
		let calls = 0;
		editor.onPasteImage = () => {
			calls++;
		};
		editor.onPasteText = () => {
			calls++;
		};

		editor.handleInput("a");
		expect(calls).toBe(0);
	});
});
