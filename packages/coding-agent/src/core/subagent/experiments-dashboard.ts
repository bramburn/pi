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
 * footer with the experiments pill in the reference extension).
 */

import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { type ExperimentStatus, listExperiments } from "./experiment-registry.ts";

export const UI_KEYS = {
	STATUS_KEY: "experiments",
	DASHBOARD_KEY: "experiments-dashboard",
	BG_STATUS_KEY: "subagent-bg",
} as const;

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
