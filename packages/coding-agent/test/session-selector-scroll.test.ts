import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function makeSession(overrides: Partial<SessionInfo> & { id: string; message: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.message,
		allMessagesText: overrides.message,
	};
}

const TWENTY_SESSIONS = (): SessionInfo[] =>
	Array.from({ length: 20 }, (_, i) => makeSession({ id: `s${i}`, message: `Session number ${i}` }));

// Raw arrow-down (CSI B) and Page Down (CSI 6~) sequences.
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";

describe("session selector scrolling", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Keybindings are a global singleton; reset for test isolation.
		setKeybindings(new KeybindingsManager());
	});

	function makeSelector(terminalHeight: number, sessions: SessionInfo[]): SessionSelectorComponent {
		return new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
			undefined,
			terminalHeight,
		);
	}

	it("uses the chrome-aware window size on a normal short terminal", async () => {
		// terminalHeight = 17 → chrome = 12 → maxVisible = max(1, 5) = 5.
		const selector = makeSelector(17, TWENTY_SESSIONS());
		await flushPromises();

		const rendered = stripAnsi(selector.render(120).join("\n"));
		const labelCount = (rendered.match(/Session number \d+/g) ?? []).length;
		expect(labelCount).toBeLessThanOrEqual(5);
		expect(rendered).toMatch(/\(1\/20\)/);
	});

	it("shrinks the window below 5 rows on extremely small terminals so chrome stays visible", async () => {
		// terminalHeight = 12 → chrome = 12 → maxVisible = max(1, 0) = 1.
		// Only 1 session row fits; the scroll indicator `(N/M)` reframes the rest.
		const selector = makeSelector(12, TWENTY_SESSIONS());
		await flushPromises();

		const rendered = stripAnsi(selector.render(120).join("\n"));
		const labelCount = (rendered.match(/Session number \d+/g) ?? []).length;
		expect(labelCount).toBe(1);
		// The chrome (header, border, scroll indicator) must remain visible — the scroll
		// indicator only renders when there's overflow, and `(N/M)` is present here.
		expect(rendered).toMatch(/\(1\/20\)/);
	});

	it("arrow-down shifts the visible window and updates the indicator", async () => {
		const selector = makeSelector(17, TWENTY_SESSIONS()); // maxVisible = 5
		await flushPromises();

		const list = selector.getSessionList();
		for (let i = 0; i < 6; i++) {
			list.handleInput(DOWN);
		}
		await flushPromises();

		const rendered = stripAnsi(selector.render(120).join("\n"));
		// After 6 down presses, selectedIndex is 6, indicator reads "(7/20)".
		expect(rendered).toMatch(/\(7\/20\)/);
	});

	it("PageDown jumps by maxVisible rows", async () => {
		const selector = makeSelector(17, TWENTY_SESSIONS()); // maxVisible = 5
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput(PAGE_DOWN);
		await flushPromises();

		const rendered = stripAnsi(selector.render(120).join("\n"));
		// PageDown from index 0 with maxVisible = 5 lands on index 5 → "(6/20)".
		expect(rendered).toMatch(/\(6\/20\)/);
	});

	it("does not show the scroll indicator when the list fits in the window", async () => {
		// Tall terminal, only 3 sessions → maxVisible = max(1, 28) = 28; everything fits.
		const sessions = Array.from({ length: 3 }, (_, i) =>
			makeSession({ id: `s${i}`, message: `Session number ${i}` }),
		);
		const selector = makeSelector(40, sessions);
		await flushPromises();

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("Session number 0");
		expect(rendered).toContain("Session number 2");
		expect(rendered).not.toMatch(/\(\d+\/3\)/);
	});

	it("falls back to a 12-row window when terminalHeight is not provided", async () => {
		// No terminalHeight → defaults to 24 → maxVisible = max(1, 12) = 12.
		const selector = new SessionSelectorComponent(
			async () => TWENTY_SESSIONS(),
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
		await flushPromises();

		const rendered = stripAnsi(selector.render(120).join("\n"));
		const labelCount = (rendered.match(/Session number \d+/g) ?? []).length;
		expect(labelCount).toBeLessThanOrEqual(12);
		expect(rendered).toMatch(/\(1\/20\)/);
	});
});
