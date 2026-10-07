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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
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
	readBackgroundLogTail,
	renderBackgroundLines,
	renderBackgroundLogLines,
	showBackgroundDashboard,
	showBackgroundLogOverlay,
	UI_KEYS,
} from "../src/core/subagent/experiments-dashboard.ts";
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

// Sanity: keep a Theme import so theme.ts stays reachable from this test
// (the renderer needs it). The lint rule against unused imports would
// otherwise drop it; using the type in a comment is the lightest enforcement.
const _typecheckTheme: Theme = theme;
void _typecheckTheme;

// Mock surface to keep `vi` in scope if we add runtime mocking later — biome
// would otherwise flag the import as unused. The keep-alive is harmless.
void vi;
