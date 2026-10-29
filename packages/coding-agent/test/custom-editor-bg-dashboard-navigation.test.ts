/**
 * The `/subagents` background-task dashboard is a non-modal widget below the
 * editor, so the editor keeps focus and the up/down keys have to be taken from
 * it explicitly. These tests pin the two halves of that contract:
 *
 * - while the dashboard is open, `app.subagent.bgDashboardUp/Down` win over the
 *   editor's own up/down (cursor movement, prompt history), and
 * - after `offAction`, the keys fall back to the editor again, so an unbound
 *   dashboard can never leave up/down dead.
 */
import { setKeybindings, TuiMainScreen } from "@bramburn/qi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

function makeEditor(keybindings = new KeybindingsManager()) {
	setKeybindings(keybindings);
	return new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
}

describe("CustomEditor background-dashboard navigation", () => {
	it("routes up/down to the dashboard instead of the editor while registered", () => {
		const editor = makeEditor();
		const moves: number[] = [];
		editor.onAction("app.subagent.bgDashboardDown", () => moves.push(1));
		editor.onAction("app.subagent.bgDashboardUp", () => moves.push(-1));
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput(DOWN);
		editor.handleInput(UP);
		expect(moves).toEqual([1, -1]);
		// The editor never saw the keys: no history navigation, no cursor move.
		expect(editor.getText()).toBe("draft");
	});

	it("returns up/down to the editor after offAction", () => {
		const editor = makeEditor();
		let moved = 0;
		editor.onAction("app.subagent.bgDashboardUp", () => moved++);
		// setText parks the cursor at the end of the last line.
		editor.setText("first\nsecond");
		expect(editor.getCursor().line).toBe(1);

		editor.handleInput(UP);
		expect(moved).toBe(1);
		// Consumed by the dashboard: the cursor stayed put.
		expect(editor.getCursor().line).toBe(1);

		editor.offAction("app.subagent.bgDashboardUp");
		editor.handleInput(UP);
		expect(moved).toBe(1);
		// With no app handler left, up is editor cursor movement again.
		expect(editor.getCursor().line).toBe(0);
	});

	it("honours a user override of the dashboard navigation keys", () => {
		const keybindings = new KeybindingsManager({
			"app.subagent.bgDashboardDown": "ctrl+n",
			"tui.editor.historyNext": "ctrl+j",
		});
		const editor = makeEditor(keybindings);
		let moved = 0;
		editor.onAction("app.subagent.bgDashboardDown", () => moved++);
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput("\x0e"); // Ctrl+N
		expect(moved).toBe(1);
		expect(editor.getText()).toBe("draft");

		// The overridden binding frees plain down for the editor again.
		editor.handleInput(DOWN);
		expect(moved).toBe(1);
	});
});
