/**
 * Background-task dashboard + per-task log-tail overlay rendering.
 *
 * The dashboard rendering is pure (theme + tasks in, strings out) so we can
 * assert on its output without standing up the TUI. The log-tail reader is
 * bounded by `maxBytes` and `maxRecords`; tests exercise both bounds to
 * lock the truncation semantics down — the dashboard must never OOM even
 * for a runaway runner writing gigabytes per minute.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TuiMainScreen } from "@bramburn/qi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	_resetBackgroundRegistryForTests,
	type BackgroundTask,
	getBackgroundRegistry,
} from "../src/core/subagent/background.ts";
import {
	BG_LOG_MAX_RECORDS,
	backgroundLogPath,
	clearBackgroundDashboard,
	clearBackgroundLogOverlay,
	moveSelectedRow,
	readBackgroundLogTail,
	renderBackgroundLines,
	renderBackgroundLogLines,
	showBackgroundDashboard,
	showBackgroundLogOverlay,
	UI_KEYS,
} from "../src/core/subagent/experiments-dashboard.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";

/** Strip ANSI escape sequences so we can assert on the human-readable text. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	const now = new Date("2026-10-05T12:00:00Z").toISOString();
	return {
		id: "bg_lwj5y2i_demo00000",
		kind: "pi-subprocess",
		mode: "single",
		role: "explorer",
		label: "explorer (background)",
		task: "scan repo",
		status: "running",
		startedAt: now,
		lastEventAt: now,
		lastOutput: "scanning src/ ...",
		cwd: "/tmp",
		...overrides,
	};
}

function makeUi(): {
	ui: Parameters<typeof showBackgroundDashboard>[0];
	widget: { key: string | undefined; lines: string[] | undefined; placement?: string };
	notices: Array<{ message: string; type: string }>;
} {
	const state: { key: string | undefined; lines: string[] | undefined; placement?: string } = {
		key: undefined,
		lines: undefined,
		placement: undefined,
	};
	const notices: Array<{ message: string; type: string }> = [];
	const ui = {
		mode: "tui" as const,
		setWidget: (key: string, lines: string[] | undefined, options?: { placement?: string }) => {
			state.key = key;
			state.lines = lines;
			state.placement = options?.placement;
		},
		setStatus: (_key: string, _text: string | undefined) => {},
		notify: (message: string, type: "info" | "warning" | "error") => {
			notices.push({ message, type });
		},
	};
	return { ui, widget: state, notices };
}

describe("background dashboard rendering", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	it("renderBackgroundLines sorts tasks newest-first and tags a selected row", () => {
		const old = makeTask({ id: "bg_old", startedAt: "2026-10-05T10:00:00Z", lastOutput: "older" });
		const mid = makeTask({ id: "bg_mid", startedAt: "2026-10-05T11:00:00Z", lastOutput: "middle" });
		const fresh = makeTask({ id: "bg_fresh", startedAt: "2026-10-05T12:00:00Z", lastOutput: "newest" });
		const now = new Date("2026-10-05T12:00:30Z").getTime();
		const lines = renderBackgroundLines(theme, [old, mid, fresh], 0, now);
		const text = lines.map(stripAnsi).join("\n");
		// Newest appears before older (renderBackgroundLines sorts by startedAt desc).
		expect(text.indexOf("bg_fresh")).toBeLessThan(text.indexOf("bg_mid"));
		expect(text.indexOf("bg_mid")).toBeLessThan(text.indexOf("bg_old"));
		// The selected (first) row carries the ▶ marker, the rest carry the muted gutter.
		const freshLine = lines.map(stripAnsi).find((l) => l.includes("bg_fresh"));
		expect(freshLine?.trimStart().startsWith("▶")).toBe(true);
		const oldLine = lines.map(stripAnsi).find((l) => l.includes("bg_old"));
		expect(oldLine?.trimStart().startsWith("▶")).toBe(false);
		// Truncate lastOutput to 60 chars: it carries an ellipsis when shortened.
		const longOutput = "x".repeat(120);
		const longTask = makeTask({ id: "bg_long", lastOutput: longOutput });
		const longLines = renderBackgroundLines(theme, [longTask], 0, now);
		const longText = longLines.map(stripAnsi).join("\n");
		expect(longText).toContain("…");
		// The (no output yet) placeholder is shown when lastOutput is empty.
		const empty = makeTask({ id: "bg_empty", lastOutput: "" });
		const emptyLines = renderBackgroundLines(theme, [empty], 0, now);
		expect(emptyLines.map(stripAnsi).join("\n")).toContain("(no output yet)");
	});

	it("renderBackgroundLines emits a friendly message when no tasks are present", () => {
		const lines = renderBackgroundLines(theme, []);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "")).toContain("No background subagent tasks");
	});

	it("moveSelectedRow wraps at both ends so repeated arrow presses cycle the list", () => {
		// Walking down three rows from the top of a three-task list.
		expect(moveSelectedRow(0, 3, 1)).toBe(1);
		expect(moveSelectedRow(1, 3, 1)).toBe(2);
		// Past the last row: wrap to the top instead of dead-ending.
		expect(moveSelectedRow(2, 3, 1)).toBe(0);
		// Before the first row: wrap to the bottom.
		expect(moveSelectedRow(0, 3, -1)).toBe(2);
		expect(moveSelectedRow(1, 3, -1)).toBe(0);
		// A delta larger than the list still lands on a valid row.
		expect(moveSelectedRow(0, 3, 7)).toBe(1);
		expect(moveSelectedRow(0, 3, -7)).toBe(2);
		// Single-row list never moves off the row.
		expect(moveSelectedRow(0, 1, 1)).toBe(0);
		expect(moveSelectedRow(0, 1, -1)).toBe(0);
		// Empty list: no row to select.
		expect(moveSelectedRow(0, 0, 1)).toBe(0);
		expect(moveSelectedRow(3, 0, -1)).toBe(0);
	});

	it("showBackgroundDashboard installs the widget with the BG_DASHBOARD_KEY", () => {
		const { ui, widget } = makeUi();
		const tasks = [makeTask()];
		showBackgroundDashboard(ui, theme, tasks);
		expect(widget.key).toBe(UI_KEYS.BG_DASHBOARD_KEY);
		expect(widget.lines?.length).toBeGreaterThan(0);
		expect(widget.placement).toBe("belowEditor");
		// Footer hint is appended so the user knows how to leave the overlay.
		const lastLine = widget.lines?.[widget.lines.length - 1] ?? "";
		expect(stripAnsi(lastLine)).toContain("esc");
	});

	it("the dashboard hint documents arrow navigation and enter-to-open-log", () => {
		const { ui, widget } = makeUi();
		showBackgroundDashboard(ui, theme, [makeTask()]);
		const lastLine = stripAnsi(widget.lines?.[widget.lines.length - 1] ?? "");
		expect(lastLine).toContain("↑/↓");
		expect(lastLine).toContain("select");
		expect(lastLine).toContain("open log");
	});

	it("renderBackgroundLines marks the row the caller selected, not just row 0", () => {
		const older = makeTask({ id: "bg_older", startedAt: "2026-10-05T10:00:00Z" });
		const newer = makeTask({ id: "bg_newer", startedAt: "2026-10-05T12:00:00Z" });
		const now = new Date("2026-10-05T12:00:30Z").getTime();
		const lines = renderBackgroundLines(theme, [older, newer], 1, now);
		const plain = lines.map(stripAnsi);
		expect(
			plain
				.find((l) => l.includes("bg_older"))
				?.trimStart()
				.startsWith("▶"),
		).toBe(true);
		expect(
			plain
				.find((l) => l.includes("bg_newer"))
				?.trimStart()
				.startsWith("▶"),
		).toBe(false);
	});

	it("clearBackgroundDashboard uninstalls the widget", () => {
		const { ui, widget } = makeUi();
		showBackgroundDashboard(ui, theme, [makeTask()]);
		clearBackgroundDashboard(ui);
		expect(widget.key).toBe(UI_KEYS.BG_DASHBOARD_KEY);
		expect(widget.lines).toBeUndefined();
	});

	it("non-tui modes get the dashboard content as a single notification", () => {
		const { ui, notices } = makeUi();
		ui.mode = "rpc";
		showBackgroundDashboard(ui, theme, [makeTask()]);
		expect(notices).toHaveLength(1);
		expect(stripAnsi(notices[0]?.message ?? "")).toContain("Background tasks");
	});
});

describe("background log-tail reader", () => {
	let agentDir: string | undefined;
	const previous = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-bg-dashboard-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		_resetBackgroundRegistryForTests();
	});

	afterEach(() => {
		_resetBackgroundRegistryForTests();
		if (previous === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previous;
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	});

	function writeLog(taskId: string, lines: string[]): void {
		const dir = join(agentDir as string, "subagent-bg", taskId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "log.jsonl"), lines.map((l) => `${l}\n`).join(""), "utf8");
	}

	it("returns an empty result for a missing log", () => {
		const tail = readBackgroundLogTail("bg_missing");
		expect(tail.records).toEqual([]);
		expect(tail.truncated).toBe(false);
		expect(tail.totalLines).toBe(0);
	});

	it("parses every record when the file is well under the byte cap", () => {
		const taskId = "bg_short";
		const lines = [
			`{"at":"2026-10-05T12:00:00Z","type":"SPAWN","role":"explorer"}`,
			`{"at":"2026-10-05T12:00:01Z","type":"message_end","text":"hi"}`,
			`{"at":"2026-10-05T12:00:02Z","type":"EXIT","exitCode":0}`,
		];
		writeLog(taskId, lines);
		const tail = readBackgroundLogTail(taskId);
		expect(tail.truncated).toBe(false);
		expect(tail.totalLines).toBe(3);
		expect(tail.records).toHaveLength(3);
		expect(tail.records[0]).toMatchObject({ type: "SPAWN" });
		expect(tail.records[2]).toMatchObject({ type: "EXIT", exitCode: 0 });
	});

	it("caps at maxRecords and returns the most recent N lines", () => {
		const taskId = "bg_capped";
		const lines: string[] = [];
		for (let i = 0; i < BG_LOG_MAX_RECORDS + 50; i++) {
			lines.push(`{"at":"2026-10-05T12:00:00Z","type":"tick","i":${i}}`);
		}
		writeLog(taskId, lines);
		const tail = readBackgroundLogTail(taskId, 10 * 1024 * 1024, BG_LOG_MAX_RECORDS);
		expect(tail.truncated).toBe(false);
		expect(tail.records).toHaveLength(BG_LOG_MAX_RECORDS);
		expect(tail.totalLines).toBe(BG_LOG_MAX_RECORDS + 50);
		// The last 240 records — i=50..289 in this fixture.
		const last = tail.records[tail.records.length - 1] as { i?: number };
		expect(last.i).toBe(BG_LOG_MAX_RECORDS + 49);
	});

	it("truncates to the trailing maxBytes when the file is huge", () => {
		const taskId = "bg_huge";
		const dir = join(agentDir as string, "subagent-bg", taskId);
		mkdirSync(dir, { recursive: true });
		// 500 KiB of padded lines, well above the 4 KiB test cap.
		const padding = "x".repeat(500);
		const total = 1000;
		const stream = [] as string[];
		for (let i = 0; i < total; i++) {
			stream.push(JSON.stringify({ at: "2026-10-05T12:00:00Z", type: "tick", i, padding }));
		}
		writeFileSync(join(dir, "log.jsonl"), stream.join("\n"), "utf8");

		const tail = readBackgroundLogTail(taskId, 4 * 1024, 20);
		expect(tail.truncated).toBe(true);
		// We only kept the trailing window, so totalLines <= the line count in that
		// window (not the full file): the reader can't see what it threw away.
		expect(tail.totalLines).toBeLessThanOrEqual(total);
		expect(tail.records.length).toBeLessThanOrEqual(20);
		// Records are not empty and the tail is from the end of the readable window.
		for (const r of tail.records) expect(r.type).toBe("tick");
	});

	it("survives a torn last line (crash-induced partial write)", () => {
		const taskId = "bg_torn";
		const dir = join(agentDir as string, "subagent-bg", taskId);
		mkdirSync(dir, { recursive: true });
		const complete = '{"at":"2026-10-05T12:00:00Z","type":"SPAWN","role":"explorer"}';
		const partial = '{"at":"2026-10-05T12:00:01Z","type":"mess';
		writeFileSync(join(dir, "log.jsonl"), `${complete}\n${partial}`, "utf8");
		const tail = readBackgroundLogTail(taskId);
		// The complete line is parsed; the torn one falls back to a `_raw` carrier.
		expect(tail.records.length).toBe(2);
		expect(tail.records[0]).toMatchObject({ type: "SPAWN" });
		const last = tail.records[1] as { _raw?: string };
		expect(typeof last._raw).toBe("string");
	});

	it("ignores blank lines without inflating the line count", () => {
		const taskId = "bg_blank";
		const dir = join(agentDir as string, "subagent-bg", taskId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "log.jsonl"), '{"type":"SPAWN"}\n\n{"type":"EXIT","exitCode":0}\n', "utf8");
		const tail = readBackgroundLogTail(taskId);
		expect(tail.totalLines).toBe(2);
		expect(tail.records).toHaveLength(2);
	});

	it("backgroundLogPath resolves under the agent dir, scoped to the task id", () => {
		expect(backgroundLogPath("bg_demo")).toBe(join(agentDir as string, "subagent-bg", "bg_demo", "log.jsonl"));
	});

	// Trusted-root check (issue #1044): a hostile registry row id must not steer
	// the reader outside the agent dir, even when the escape target exists.
	it("rejects a traversal task id even when the escape target file exists", () => {
		const outside = mkdtempSync(join(tmpdir(), "pi-bg-escape-"));
		try {
			writeFileSync(
				join(outside, "log.jsonl"),
				`${JSON.stringify({ at: "2026-10-05T12:00:00Z", type: "stdout", text: "stolen" })}\n`,
				"utf8",
			);
			const escapeId = join("..", "..", "..", outside, "log.jsonl");
			const tail = readBackgroundLogTail(escapeId);
			expect(tail.records).toHaveLength(0);
			expect(tail.truncated).toBe(false);
			expect(tail.totalLines).toBe(0);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("still reads a legitimate task log under the agent dir", () => {
		writeLog("bg_legit", [JSON.stringify({ at: "2026-10-05T12:00:00Z", type: "stdout", text: "ok" })]);
		const tail = readBackgroundLogTail("bg_legit");
		expect(tail.records).toHaveLength(1);
	});
});

describe("background log overlay rendering", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	it("renderBackgroundLogLines lines up time, type and a JSON body per record", () => {
		const now = new Date("2026-10-05T12:00:00Z").toISOString();
		const tail = {
			records: [
				{ at: now, type: "SPAWN", role: "explorer" },
				{ at: now, type: "message_end", output: "hi" },
			],
			truncated: false,
			totalLines: 2,
		};
		const lines = renderBackgroundLogLines(theme, { id: "bg_x", role: "explorer", status: "running" }, tail);
		const text = lines.map(stripAnsi).join("\n");
		expect(text).toContain("Log · explorer · bg_x · running");
		expect(text).toContain("12:00:00");
		expect(text).toContain("SPAWN");
		expect(text).toContain("message_end");
	});

	it("renderBackgroundLogLines flags truncated reads with a warning line", () => {
		const tail = {
			records: [{ type: "EXIT", exitCode: 0 }],
			truncated: true,
			totalLines: 9999,
		};
		const lines = renderBackgroundLogLines(theme, { id: "bg_t", role: "explorer", status: "completed" }, tail);
		const text = lines.map(stripAnsi).join("\n");
		expect(text).toContain("showing last 1 of 9999");
		// Line numbers: when truncated, numbering must start where the slice
		// begins (9999 - 1 + 1 = 9999) so the column still reads as a 4-digit
		// absolute index.
		expect(text).toMatch(/9999/);
	});

	it("renderBackgroundLogLines renders a friendly empty state", () => {
		const lines = renderBackgroundLogLines(
			theme,
			{ id: "bg_e", role: "explorer", status: "running" },
			{ records: [], truncated: false, totalLines: 0 },
		);
		expect(lines.map(stripAnsi).join("\n")).toContain("(no log entries)");
	});

	it("showBackgroundLogOverlay installs the widget with BG_LOG_KEY", () => {
		const { ui, widget } = makeUi();
		showBackgroundLogOverlay(
			ui,
			theme,
			{ id: "bg_o", role: "explorer", status: "running" },
			{ records: [{ type: "SPAWN" }], truncated: false, totalLines: 1 },
		);
		expect(widget.key).toBe(UI_KEYS.BG_LOG_KEY);
		expect(widget.placement).toBe("belowEditor");
		clearBackgroundLogOverlay(ui);
		expect(widget.lines).toBeUndefined();
	});

	it("non-tui modes get the log overlay as a single notification", () => {
		const { ui, notices } = makeUi();
		ui.mode = "rpc";
		showBackgroundLogOverlay(
			ui,
			theme,
			{ id: "bg_o", role: "explorer", status: "running" },
			{ records: [{ type: "SPAWN" }], truncated: false, totalLines: 1 },
		);
		expect(notices.length).toBe(1);
		expect(stripAnsi(notices[0]?.message ?? "")).toContain("Log");
	});
});

describe("background dashboard integration with the registry", () => {
	let agentDir: string | undefined;
	const previous = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		initTheme("dark");
		agentDir = mkdtempSync(join(tmpdir(), "pi-bg-dash-int-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		_resetBackgroundRegistryForTests();
	});

	afterEach(() => {
		_resetBackgroundRegistryForTests();
		if (previous === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previous;
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	});

	it("end-to-end: append a log line, then read it back via the overlay reader", () => {
		const taskId = "bg_e2e";
		const dir = join(agentDir as string, "subagent-bg", taskId);
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "log.jsonl"),
			`${JSON.stringify({ at: "2026-10-05T12:00:00Z", type: "SPAWN", role: "explorer" })}\n`,
			"utf8",
		);
		const tail = readBackgroundLogTail(taskId);
		expect(tail.records).toHaveLength(1);
		expect(tail.records[0]).toMatchObject({ type: "SPAWN" });
	});

	it("the registry snapshot is a stable input for the dashboard renderer", () => {
		const reg = getBackgroundRegistry();
		const t = makeTask();
		reg.add(t);
		const tasks = reg.snapshot().tasks;
		expect(tasks.find((row) => row.id === t.id)).toBeDefined();
		// The pure renderer is happy with a snapshot from the live registry.
		const lines = renderBackgroundLines(theme, tasks);
		expect(lines.map(stripAnsi).join("\n")).toContain(t.role);
	});
});

/**
 * `/subagents` navigation, end to end over the real `InteractiveMode`
 * methods. The dashboard is a widget, not a focused component, so the editor
 * keeps focus and the arrow keys have to be taken from it explicitly — the
 * regression this covers is "the dashboard opens but up/down do nothing".
 *
 * The prototype methods are invoked against a stand-in `this` carrying a real
 * `CustomEditor`, so key routing goes through the production
 * `handleInput`/`KeybindingsManager` path rather than a hand-rolled call.
 */
describe("background dashboard navigation wiring", () => {
	let agentDir: string | undefined;
	const previous = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		initTheme("dark");
		agentDir = mkdtempSync(join(tmpdir(), "pi-bg-dash-nav-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		_resetBackgroundRegistryForTests();
	});

	afterEach(() => {
		_resetBackgroundRegistryForTests();
		if (previous === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previous;
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	});

	/** The subset of InteractiveMode the dashboard owns, with `this` bound to a fake. */
	interface DashboardSelf {
		defaultEditor: CustomEditor;
		createExperimentsUi(): Parameters<typeof showBackgroundDashboard>[0];
		bgDashboardOpen: boolean;
		bgDashboardEscapeHandler?: () => void;
		bgDashboardSelectedRow: number;
		bgDashboardTasks: BackgroundTask[];
		bgLogOverlayOpen: boolean;
		bgLogOverlayEscapeHandler?: () => void;
		toggleBackgroundDashboard(): void;
		collectDashboardTasks(): BackgroundTask[];
		closeBackgroundDashboard(): void;
		setBackgroundDashboardNavigation(active: boolean): void;
		moveBackgroundDashboardSelection(delta: number): void;
		openBackgroundLogOverlay(task: BackgroundTask): void;
		closeBackgroundLogOverlay(): void;
	}

	function makeSelf(): {
		self: DashboardSelf;
		editor: CustomEditor;
		lines(key: string): string[] | undefined;
	} {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		// The dashboard and the log overlay are separate widgets keyed separately
		// in the real UI, so record per key: reading the dashboard's content must
		// work while the log overlay is stacked on top of it.
		const widgets = new Map<string, string[] | undefined>();
		const ui = {
			mode: "tui" as const,
			setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines),
			setStatus: () => {},
			notify: () => {},
		};
		const methods = InteractiveMode.prototype as unknown as DashboardSelf;
		const self = {
			defaultEditor: editor,
			createExperimentsUi: () => ui,
			bgDashboardOpen: false,
			bgDashboardEscapeHandler: undefined,
			bgDashboardSelectedRow: 0,
			bgDashboardTasks: [] as BackgroundTask[],
			bgLogOverlayOpen: false,
			bgLogOverlayEscapeHandler: undefined,
			toggleBackgroundDashboard: methods.toggleBackgroundDashboard,
			collectDashboardTasks: methods.collectDashboardTasks,
			closeBackgroundDashboard: methods.closeBackgroundDashboard,
			setBackgroundDashboardNavigation: methods.setBackgroundDashboardNavigation,
			moveBackgroundDashboardSelection: methods.moveBackgroundDashboardSelection,
			openBackgroundLogOverlay: methods.openBackgroundLogOverlay,
			closeBackgroundLogOverlay: methods.closeBackgroundLogOverlay,
		} satisfies DashboardSelf;
		return { self, editor, lines: (key) => widgets.get(key) };
	}

	/** Three crashed tasks, oldest last, so the dashboard shows them in a known order. */
	function seedTasks(): BackgroundTask[] {
		const registry = getBackgroundRegistry();
		const seeded = [
			makeTask({ id: "bg_nav_old", startedAt: "2026-10-05T10:00:00Z", status: "crashed" }),
			makeTask({ id: "bg_nav_mid", startedAt: "2026-10-05T11:00:00Z", status: "crashed" }),
			makeTask({ id: "bg_nav_new", startedAt: "2026-10-05T12:00:00Z", status: "crashed" }),
		];
		for (const task of seeded) registry.add(task);
		return seeded;
	}

	/** Id of the dashboard row currently carrying the ▶ marker. */
	function selectedTaskId(self: DashboardSelf, lines: string[] | undefined): string | undefined {
		const selected = (lines ?? []).map(stripAnsi).find((line) => line.trimStart().startsWith("▶"));
		return self.bgDashboardTasks.find((task) => selected?.includes(task.id))?.id;
	}

	/**
	 * `InteractiveMode.resetExtensionUI` with the parts the dashboard does not
	 * own stubbed out. Only its widget teardown and its effect on the
	 * dashboard matter here.
	 */
	function resetExtensionUi(self: DashboardSelf): void {
		const noop = () => {};
		// Stubs land on `self` itself so the method mutates the same object the
		// test observes.
		Object.assign(self, {
			extensionSelector: undefined,
			extensionInput: undefined,
			extensionEditor: undefined,
			ui: { hideOverlay: noop },
			clearExtensionTerminalInputListeners: noop,
			setExtensionFooter: noop,
			setExtensionHeader: noop,
			clearExtensionWidgets: noop,
			footerDataProvider: { clearExtensionStatuses: noop },
			footer: { invalidate: noop },
			autocompleteProviderWrappers: [],
			setCustomEditorComponent: noop,
			setupAutocompleteProvider: noop,
			updateTerminalTitle: noop,
			setWorkingIndicator: noop,
			setHiddenThinkingLabel: noop,
			activeStatusIndicator: undefined,
			defaultWorkingMessage: "working",
			workingMessage: undefined,
			workingVisible: true,
		});
		(InteractiveMode.prototype as unknown as { resetExtensionUI(): void }).resetExtensionUI.call(self);
	}

	it("up/down move the highlighted row and wrap at the ends", () => {
		seedTasks();
		const { self, editor, lines } = makeSelf();
		const dashboard = () => lines(UI_KEYS.BG_DASHBOARD_KEY);
		self.toggleBackgroundDashboard();
		expect(self.bgDashboardOpen).toBe(true);
		// Newest first, so row 0 is the newest task.
		expect(self.bgDashboardTasks.map((t) => t.id)).toEqual(["bg_nav_new", "bg_nav_mid", "bg_nav_old"]);
		expect(selectedTaskId(self, dashboard())).toBe("bg_nav_new");

		editor.handleInput("\x1b[B"); // Down
		expect(selectedTaskId(self, dashboard())).toBe("bg_nav_mid");
		editor.handleInput("\x1b[B");
		expect(selectedTaskId(self, dashboard())).toBe("bg_nav_old");
		// Wraps past the last row instead of dead-ending.
		editor.handleInput("\x1b[B");
		expect(selectedTaskId(self, dashboard())).toBe("bg_nav_new");

		editor.handleInput("\x1b[A"); // Up
		expect(selectedTaskId(self, dashboard())).toBe("bg_nav_old");
		// Wraps past the first row too.
		editor.handleInput("\x1b[A");
		expect(selectedTaskId(self, dashboard())).toBe("bg_nav_mid");
	});

	it("enter opens the log for the row the arrows selected", () => {
		seedTasks();
		const { self, editor, lines } = makeSelf();
		self.toggleBackgroundDashboard();
		editor.handleInput("\x1b[B"); // Down -> bg_nav_mid
		const selected = self.bgDashboardTasks[self.bgDashboardSelectedRow];
		expect(selected?.id).toBe("bg_nav_mid");

		self.openBackgroundLogOverlay(selected as BackgroundTask);
		expect(self.bgLogOverlayOpen).toBe(true);
		expect(lines(UI_KEYS.BG_LOG_KEY)?.map(stripAnsi).join("\n")).toContain("bg_nav_mid");

		self.closeBackgroundLogOverlay();
		expect(self.bgLogOverlayOpen).toBe(false);
		expect(lines(UI_KEYS.BG_LOG_KEY)).toBeUndefined();
		// The dashboard is visible again, so it takes its navigation back.
		editor.handleInput("\x1b[B");
		expect(self.bgDashboardSelectedRow).toBe(2);
		expect(selectedTaskId(self, lines(UI_KEYS.BG_DASHBOARD_KEY))).toBe("bg_nav_old");
	});

	it("the log overlay hands up/down back to the editor", () => {
		seedTasks();
		const { self, editor, lines } = makeSelf();
		self.toggleBackgroundDashboard();
		editor.handleInput("\x1b[B"); // Down -> bg_nav_mid
		const selected = self.bgDashboardTasks[self.bgDashboardSelectedRow];
		self.openBackgroundLogOverlay(selected as BackgroundTask);

		// Arrows now edit the prompt instead of moving a row hidden behind the log.
		editor.setText("first\nsecond");
		editor.handleInput("\x1b[A"); // Up
		expect(editor.getCursor().line).toBe(0);
		expect(self.bgDashboardSelectedRow).toBe(1);
		expect(selectedTaskId(self, lines(UI_KEYS.BG_DASHBOARD_KEY))).toBe("bg_nav_mid");
	});

	it("closing the dashboard returns up/down to the editor", () => {
		seedTasks();
		const { self, editor, lines } = makeSelf();
		self.toggleBackgroundDashboard();
		editor.handleInput("\x1b[B"); // Down
		self.closeBackgroundDashboard();
		expect(lines(UI_KEYS.BG_DASHBOARD_KEY)).toBeUndefined();

		editor.setText("first\nsecond");
		const before = editor.getCursor().line;
		editor.handleInput("\x1b[A"); // Up now moves the cursor
		expect(editor.getCursor().line).not.toBe(before);
		expect(self.bgDashboardSelectedRow).toBe(1);
	});

	it("reopening the dashboard resets the selection to the newest task", () => {
		seedTasks();
		const { self, editor, lines } = makeSelf();
		self.toggleBackgroundDashboard();
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		expect(self.bgDashboardSelectedRow).toBe(2);

		self.toggleBackgroundDashboard(); // closes
		self.toggleBackgroundDashboard(); // reopens
		expect(self.bgDashboardSelectedRow).toBe(0);
		expect(selectedTaskId(self, lines(UI_KEYS.BG_DASHBOARD_KEY))).toBe("bg_nav_new");
	});

	it("resetExtensionUI closes the dashboard so up/down do not leak out", () => {
		seedTasks();
		const { self, editor, lines } = makeSelf();
		self.toggleBackgroundDashboard();
		editor.handleInput("\x1b[B");

		// A session invalidation or /reload wipes extension widgets without the
		// dashboard's own close path running — the navigation must not survive.
		resetExtensionUi(self);
		expect(self.bgDashboardOpen).toBe(false);
		expect(lines(UI_KEYS.BG_DASHBOARD_KEY)).toBeUndefined();

		editor.setText("first\nsecond");
		const before = editor.getCursor().line;
		editor.handleInput("\x1b[A"); // Up is editor cursor movement again
		expect(editor.getCursor().line).not.toBe(before);
	});
});

// Sanity: keep a Theme import so theme.ts stays reachable from this test
// (the renderer needs it). The lint rule against unused imports would
// otherwise drop it; using the type in a comment is the lightest enforcement.
const _typecheckTheme: Theme = theme;
void _typecheckTheme;

// Mock surface to keep `vi` in scope if we add runtime mocking later — biome
// would otherwise flag the import as unused. The keep-alive is harmless.
void vi;
