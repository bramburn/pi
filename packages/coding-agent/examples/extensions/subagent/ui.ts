/**
 * UI helpers for the experimental-mode extension.
 *
 * - status pill: shows running experiment count, updated on every registry mutation
 * - dashboard overlay: 2-column table of all experiments, opened via /experiments
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExperimentRow, type ExperimentStatus, listExperiments } from "./registry.ts";

const STATUS_KEY = "experiments";
const DASHBOARD_KEY = "experiments-dashboard";

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

function elapsedSince(iso: string, now: number = Date.now()): string {
	const start = new Date(iso).getTime();
	if (Number.isNaN(start)) return "?";
	const ms = now - start;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * Refresh the footer status pill to reflect the current registry state.
 * Clears the pill when zero experiments are running and experimental mode is off.
 */
export function refreshStatusPill(ctx: ExtensionContext, repoRoot: string, active: boolean): void {
	if (!active) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const all = listExperiments(repoRoot, "all");
	const running = all.filter((r) => r.status === "running" || r.status === "scaffolded").length;
	const total = all.length;
	const text =
		running > 0
			? ctx.ui.theme.fg("accent", `● ${running} running`) +
				ctx.ui.theme.fg("dim", ` · ${total} total · Ctrl+E for dashboard`)
			: ctx.ui.theme.fg("muted", `● 0 running`) + ctx.ui.theme.fg("dim", ` · ${total} total · Ctrl+E for dashboard`);
	ctx.ui.setStatus(STATUS_KEY, text);
}

/**
 * Render the dashboard overlay content as a list of lines.
 */
export function renderDashboardLines(ctx: ExtensionContext, repoRoot: string): string[] {
	const all = listExperiments(repoRoot, "all");
	if (all.length === 0) {
		return [ctx.ui.theme.fg("muted", "No experiments yet. Use experiment_start to begin.")];
	}
	const sorted = [...all].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	const lines: string[] = [ctx.ui.theme.fg("accent", `Experiments (${all.length})`), ""];
	for (const row of sorted) {
		lines.push(formatRow(ctx, row));
	}
	return lines;
}

function formatRow(ctx: ExtensionContext, row: ExperimentRow): string {
	const status = formatStatus(row.status);
	const id = row.id;
	const approach = row.approach;
	const elapsed = elapsedSince(row.createdAt);
	const result =
		row.result.testPassed !== undefined ? `tests:${row.result.testPassed}P/${row.result.testFailed ?? 0}F` : "";
	return (
		ctx.ui.theme.fg("muted", `[${status}] `) +
		ctx.ui.theme.fg("accent", approach) +
		ctx.ui.theme.fg("dim", ` (${id}, ${elapsed})`) +
		(result ? ` ${ctx.ui.theme.fg("muted", result)}` : "")
	);
}

/**
 * Show the dashboard overlay. The overlay is non-modal; the user closes it with Esc.
 */
export async function showDashboard(ctx: ExtensionContext, repoRoot: string): Promise<void> {
	if (ctx.mode !== "tui") {
		const lines = renderDashboardLines(ctx, repoRoot);
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}
	const lines = renderDashboardLines(ctx, repoRoot);
	const widget = ctx.ui.theme.fg("muted", "[esc to close]");
	ctx.ui.setWidget(DASHBOARD_KEY, [...lines, "", widget], { placement: "belowEditor" });
	// The widget persists until cleared; the user can dismiss by sending a message
	// (cleared by the next refreshStatusPill call) or by pressing Esc which we
	// do not hook here — extensions can't easily intercept Esc in widget mode.
}

export function clearDashboard(ctx: ExtensionContext): void {
	ctx.ui.setWidget(DASHBOARD_KEY, undefined);
}

/**
 * Background-task footer pill. Shown when at least one background subagent
 * task is in flight. Distinct from the experiment pill so the two never
 * overwrite each other in the footer.
 *
 * Signature is minimal ({ ui }) because the caller passes a stub with just
 * the ui reference — keeps the dispatch site free of full ExtensionContext
 * typing where it isn't needed.
 */
export function refreshBackgroundPill(
	ctx: { ui: { setStatus: (key: string, text: string | undefined) => void; theme: ExtensionContext["ui"]["theme"] } },
	runningCount: number,
	totalCount: number,
): void {
	const BG_STATUS_KEY = "subagent-bg";
	if (totalCount === 0) {
		ctx.ui.setStatus(BG_STATUS_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const text =
		runningCount > 0
			? theme.fg("accent", `▶ ${runningCount} bg`) + theme.fg("dim", ` · ${totalCount} total · Ctrl+T for dashboard`)
			: theme.fg("muted", `▶ 0 bg`) + theme.fg("dim", ` · ${totalCount} total · Ctrl+T for dashboard`);
	ctx.ui.setStatus(BG_STATUS_KEY, text);
}

export const UI_KEYS = { STATUS_KEY, DASHBOARD_KEY } as const;
