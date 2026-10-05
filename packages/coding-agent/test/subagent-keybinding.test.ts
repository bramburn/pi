import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../src/core/keybindings.ts";

/**
 * Regression tests for the ctrl+e default-key collision: app keybindings are
 * matched before base editor actions in CustomEditor.handleInput, so the
 * experiments dashboard default must stay disjoint from every editor default
 * (notably tui.editor.cursorLineEnd's ctrl+e) and from every other app default.
 */

interface KeyDefinition {
	defaultKeys: string | readonly string[];
}

function defaultKeys(definition: KeyDefinition): string[] {
	return typeof definition.defaultKeys === "string" ? [definition.defaultKeys] : [...definition.defaultKeys];
}

/** Modifier order is not significant: "shift+ctrl+o" and "ctrl+shift+o" collide. */
function normalizeKey(key: string): string {
	return key.split("+").sort().join("+");
}

describe("app.subagent.experimentsDashboard default key", () => {
	const dashboard = KEYBINDINGS["app.subagent.experimentsDashboard"];

	it("defaults to ctrl+shift+e", () => {
		expect(defaultKeys(dashboard)).toEqual(["ctrl+shift+e"]);
	});

	it("does not collide with any TUI editor default key", () => {
		const dashboardKeys = new Set(defaultKeys(dashboard).map(normalizeKey));
		for (const [id, definition] of Object.entries(TUI_KEYBINDINGS)) {
			for (const key of defaultKeys(definition)) {
				expect(dashboardKeys.has(normalizeKey(key)), `${id} claims ${key}`).toBe(false);
			}
		}
	});

	it("does not collide with any other default key in the combined table", () => {
		const dashboardKeys = new Set(defaultKeys(dashboard).map(normalizeKey));
		for (const [id, definition] of Object.entries(KEYBINDINGS)) {
			if (id === "app.subagent.experimentsDashboard") continue;
			for (const key of defaultKeys(definition)) {
				expect(dashboardKeys.has(normalizeKey(key)), `${id} claims ${key}`).toBe(false);
			}
		}
	});

	it("leaves cursorLineEnd's ctrl+e default untouched", () => {
		expect(defaultKeys(TUI_KEYBINDINGS["tui.editor.cursorLineEnd"])).toContain("ctrl+e");
	});
});
