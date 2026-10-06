/**
 * Experiments dashboard and footer status pills.
 *
 * The rendering is pure (theme + registry in, strings out) so it can be
 * asserted without a TUI. The two effectful entry points (`showDashboard`,
 * `clearDashboard`) talk to a minimal `ExperimentsUi` seam instead of the
 * extension host's context, so the interactive harness can wire them to the
 * `app.subagent.experimentsDashboard` keybinding without this module knowing
 * about the TUI.
 *
 * Pill text for background subagent tasks lives here too (it shared the
 * footer with the experiments pill in the reference extension), along with
 * the background dashboard and per-task log-tail overlay.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { type BackgroundTask, BG_DIR_NAME, BG_LOG_FILE } from "./background.ts";
import { type ExperimentStatus, listExperiments } from "./experiment-registry.ts";

export const UI_KEYS = {
	STATUS_KEY: "experiments",
	DASHBOARD_KEY: "experiments-dashboard",
	BG_STATUS_KEY: "subagent-bg",
	BG_DASHBOARD_KEY: "subagent-bg-dashboard",
	BG_LOG_KEY: "subagent-bg-log",
} as const;

/** Hard cap on the per-task log overlay — bounds memory even for runaway runs. */
export const BG_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** Maximum JSONL records to keep when the file is large. */
export const BG_LOG_MAX_RECORDS = 240;

/** The UI surface the dashboard needs. The interactive harness provides it. */
export interface ExperimentsUi {
	mode: string;
	setWidget(key: string, lines: string[] | undefined, options?: { placement?: string }): void;
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
}

function formatStatus(s: ExperimentStatus): string {
	switch (s) {
		case "running":
			return "running";
		case "scaffolded":
			return "scaffolded";
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "merged":
			return "merged";
		case "discarded":
			return "discarded";
		case "cancelled":
			return "cancelled";
	}
}

export function elapsedSince(iso: string, now: number = Date.now()): string {
	const start = new Date(iso).getTime();
	if (Number.isNaN(start)) return "?";
	const ms = now - start;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * Experiments footer pill text for the current registry state. Undefined means
 * clear the pill (no experiments and inactive).
 */
export function renderExperimentsStatusPill(theme: Theme, repoRoot: string, active: boolean): string | undefined {
	if (!active) return undefined;
	const all = listExperiments(repoRoot, "all");
	const running = all.filter((r) => r.status === "running" || r.status === "scaffolded").length;
	const total = all.length;
	return running > 0
		? theme.fg("accent", `● ${running} running`) + theme.fg("dim", ` · ${total} total · experiments dashboard`)
		: theme.fg("muted", "● 0 running") + theme.fg("dim", ` · ${total} total · experiments dashboard`);
}

function formatRow(theme: Theme, row: ReturnType<typeof listExperiments>[number]): string {
	const status = formatStatus(row.status);
	const elapsed = elapsedSince(row.createdAt);
	const result =
		row.result.testPassed !== undefined ? `tests:${row.result.testPassed}P/${row.result.testFailed ?? 0}F` : "";
	return (
		theme.fg("muted", `[${status}] `) +
		theme.fg("accent", row.approach) +
		theme.fg("dim", ` (${row.id}, ${elapsed})`) +
		(result ? ` ${theme.fg("muted", result)}` : "")
	);
}

/** Dashboard overlay content as a list of lines. */
export function renderDashboardLines(theme: Theme, repoRoot: string): string[] {
	const all = listExperiments(repoRoot, "all");
	if (all.length === 0) {
		return [theme.fg("muted", "No experiments yet. Use experiment_start to begin.")];
	}
	const sorted = [...all].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	const lines: string[] = [theme.fg("accent", `Experiments (${all.length})`), ""];
	for (const row of sorted) {
		lines.push(formatRow(theme, row));
	}
	return lines;
}

/**
 * Show the dashboard overlay. Non-TUI modes get the content as a
 * notification instead. The overlay is non-modal; the user closes it with Esc.
 */
export function showDashboard(ui: ExperimentsUi, theme: Theme, repoRoot: string): void {
	const lines = renderDashboardLines(theme, repoRoot);
	if (ui.mode !== "tui") {
		ui.notify(lines.join("\n"), "info");
		return;
	}
	const widget = theme.fg("muted", "[esc to close]");
	ui.setWidget(UI_KEYS.DASHBOARD_KEY, [...lines, "", widget], { placement: "belowEditor" });
}

export function clearDashboard(ui: ExperimentsUi): void {
	ui.setWidget(UI_KEYS.DASHBOARD_KEY, undefined);
}

/**
 * Background-task footer pill text. Distinct key from the experiments pill so
 * the two never overwrite each other in the footer. Undefined clears the pill.
 */
export function renderBackgroundPill(theme: Theme, runningCount: number, totalCount: number): string | undefined {
	if (totalCount === 0) return undefined;
	return runningCount > 0
		? theme.fg("accent", `▶ ${runningCount} bg`) + theme.fg("dim", ` · ${totalCount} total · bg dashboard`)
		: theme.fg("muted", "▶ 0 bg") + theme.fg("dim", ` · ${totalCount} total · bg dashboard`);
}

// ============================================================================
// Background-task dashboard (the Fleet TUI surface for /subagents)
// ============================================================================

function formatBgStatus(s: BackgroundTask["status"]): string {
	switch (s) {
		case "pending":
			return "pending";
		case "running":
			return "running";
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "crashed":
			return "crashed";
	}
}

/** Truncate a string to at most `max` characters, appending an ellipsis when shortened. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Strip newlines and surrounding whitespace so a single-line cell never wraps. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function formatBgRow(theme: Theme, task: BackgroundTask, selected: boolean, now: number): string {
	const marker = selected ? theme.fg("accent", "▶ ") : theme.fg("muted", "  ");
	const status = formatBgStatus(task.status);
	const elapsed = elapsedSince(task.startedAt, now);
	const last = truncate(oneLine(task.lastOutput || "(no output yet)"), 60);
	return (
		marker +
		theme.fg("muted", `[${status}] `) +
		theme.fg("accent", task.role) +
		theme.fg("dim", ` (${elapsed}) `) +
		theme.fg("muted", last) +
		theme.fg("dim", ` · ${task.id}`)
	);
}

/** Background-dashboard overlay content. Pure: takes the tasks it should render. */
export function renderBackgroundLines(
	theme: Theme,
	tasks: BackgroundTask[],
	selectedRow = 0,
	now = Date.now(),
): string[] {
	if (tasks.length === 0) {
		return [theme.fg("muted", "No background subagent tasks. Use subagent_bg to dispatch one.")];
	}
	const sorted = [...tasks].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
	const lines: string[] = [theme.fg("accent", `Background tasks (${tasks.length})`), ""];
	for (let i = 0; i < sorted.length; i++) {
		const task = sorted[i];
		if (!task) continue;
		lines.push(formatBgRow(theme, task, i === selectedRow, now));
	}
	return lines;
}

/** Show the background-task dashboard overlay. Non-TUI modes get a notification. */
export function showBackgroundDashboard(
	ui: ExperimentsUi,
	theme: Theme,
	tasks: BackgroundTask[],
	selectedRow = 0,
	now = Date.now(),
): void {
	const lines = renderBackgroundLines(theme, tasks, selectedRow, now);
	if (ui.mode !== "tui") {
		ui.notify(lines.join("\n"), "info");
		return;
	}
	const widget = theme.fg("muted", "[enter: open log · esc: close]");
	ui.setWidget(UI_KEYS.BG_DASHBOARD_KEY, [...lines, "", widget], { placement: "belowEditor" });
}

export function clearBackgroundDashboard(ui: ExperimentsUi): void {
	ui.setWidget(UI_KEYS.BG_DASHBOARD_KEY, undefined);
}

// ============================================================================
// Per-task log-tail overlay
// ============================================================================

/** The decoded shape of a single JSONL record (after timestamp injection). */
export interface BackgroundLogRecord {
	at?: string;
	type?: string;
	[key: string]: unknown;
}

/** Result of `readBackgroundLogTail`: the records plus truncation metadata. */
export interface BackgroundLogTail {
	records: BackgroundLogRecord[];
	/** True when the file exceeded `maxBytes` and only a tail slice was returned. */
	truncated: boolean;
	/** Total lines scanned (>= records.length when truncated). */
	totalLines: number;
}

/** Resolve the absolute path of a task's append-only log file. */
export function backgroundLogPath(taskId: string): string {
	return join(getAgentDir(), BG_DIR_NAME, taskId, BG_LOG_FILE);
}

/**
 * Read the tail of a background task's `log.jsonl`. The read is bounded so
 * pathological log growth (a runaway runner appending for hours) cannot OOM
 * the dashboard. The default bounds are 2 MB and 240 records; tests pass
 * smaller values to keep fixtures tiny.
 *
 * Truncation is by byte offset, not line: stat the file, read the last
 * `maxBytes` bytes, then keep the last `maxRecords` complete lines. The byte
 * cap exists so a multi-GB log still fits in a single `readFileSync` — and
 * the record cap exists so a log of millions of small lines still renders in
 * a sane number of overlay rows.
 *
 * The on-disk writer stamps each line with `{ at: <iso>, ...event }`; the
 * record shape intentionally mirrors that, so a malformed line (e.g. a
 * crash-induced partial write) surfaces as a best-effort decoded object
 * rather than throwing and hiding the rest of the log.
 */
export function readBackgroundLogTail(
	taskId: string,
	maxBytes = BG_LOG_MAX_BYTES,
	maxRecords = BG_LOG_MAX_RECORDS,
): BackgroundLogTail {
	const path = backgroundLogPath(taskId);
	if (!existsSync(path)) return { records: [], truncated: false, totalLines: 0 };
	const stat = statSync(path);
	const truncated = stat.size > maxBytes;
	const start = truncated ? stat.size - maxBytes : 0;
	let text: string;
	try {
		const buf = readFileSync(path);
		text = buf.subarray(start).toString("utf8");
	} catch {
		return { records: [], truncated, totalLines: 0 };
	}
	// After a byte-truncated read the first line is almost certainly partial.
	// Drop it so the JSONL stays valid for the consumer.
	if (truncated) {
		const firstNewline = text.indexOf("\n");
		if (firstNewline >= 0) text = text.slice(firstNewline + 1);
	}
	const allLines = text.split("\n");
	const totalLines = allLines.filter((l) => l.length > 0).length;
	// Keep the trailing maxRecords complete non-empty lines.
	const nonEmpty: string[] = [];
	for (let i = allLines.length - 1; i >= 0 && nonEmpty.length < maxRecords; i--) {
		const line = allLines[i];
		if (line && line.length > 0) nonEmpty.unshift(line);
	}
	const records: BackgroundLogRecord[] = [];
	for (const line of nonEmpty) {
		try {
			records.push(JSON.parse(line) as BackgroundLogRecord);
		} catch {
			// A partial/torn tail line is expected after a crash; record the raw
			// payload so the overlay still surfaces evidence of the truncated
			// line instead of dropping the record entirely.
			records.push({ _raw: line });
		}
	}
	return { records, truncated, totalLines };
}

/** Format a timestamp as HH:MM:SS in UTC; undefined yields an 8-char blank cell. */
function formatClock(iso: string | undefined): string {
	const blank = " ".repeat(8);
	if (!iso) return blank;
	const t = new Date(iso);
	if (Number.isNaN(t.getTime())) return blank;
	const hh = String(t.getUTCHours()).padStart(2, "0");
	const mm = String(t.getUTCMinutes()).padStart(2, "0");
	const ss = String(t.getUTCSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

/** Render a single log line: `[time] [type] {json}`. */
function formatLogLine(theme: Theme, record: BackgroundLogRecord): string {
	const time = formatClock(record.at);
	const type = typeof record.type === "string" ? record.type : "event";
	const timeCell = theme.fg("dim", `[${time}]`);
	const typeCell = theme.fg("accent", `[${type.padEnd(8)}]`);
	const { at: _at, type: _type, ...rest } = record;
	void _at;
	void _type;
	const body = Object.keys(rest).length === 0 ? theme.fg("muted", "{}") : theme.fg("muted", JSON.stringify(rest));
	return `${timeCell} ${typeCell} ${body}`;
}

/** Per-task log overlay content. Pure: takes the already-read records. */
export function renderBackgroundLogLines(
	theme: Theme,
	task: Pick<BackgroundTask, "id" | "role" | "status">,
	tail: BackgroundLogTail,
): string[] {
	const header = theme.fg("accent", `Log · ${task.role} · ${task.id} · ${task.status}`);
	const lines: string[] = [header, ""];
	if (tail.records.length === 0) {
		lines.push(theme.fg("muted", "(no log entries)"));
	} else {
		if (tail.truncated) {
			lines.push(theme.fg("warning", `(showing last ${tail.records.length} of ${tail.totalLines} records)`));
		}
		// Line numbers: pad to the total count so the column stays aligned.
		const pad = String(tail.totalLines).length;
		for (let i = 0; i < tail.records.length; i++) {
			const num = String((tail.truncated ? tail.totalLines - tail.records.length : 0) + i + 1).padStart(pad, " ");
			lines.push(theme.fg("dim", `${num} │ `) + formatLogLine(theme, tail.records[i] as BackgroundLogRecord));
		}
	}
	return lines;
}

/** Show the per-task log-tail overlay. Non-TUI modes get the content as a notification. */
export function showBackgroundLogOverlay(
	ui: ExperimentsUi,
	theme: Theme,
	task: Pick<BackgroundTask, "id" | "role" | "status">,
	tail: BackgroundLogTail,
): void {
	const lines = renderBackgroundLogLines(theme, task, tail);
	if (ui.mode !== "tui") {
		ui.notify(lines.join("\n"), "info");
		return;
	}
	const widget = theme.fg("muted", "[esc to close]");
	ui.setWidget(UI_KEYS.BG_LOG_KEY, [...lines, "", widget], { placement: "belowEditor" });
}

export function clearBackgroundLogOverlay(ui: ExperimentsUi): void {
	ui.setWidget(UI_KEYS.BG_LOG_KEY, undefined);
}
