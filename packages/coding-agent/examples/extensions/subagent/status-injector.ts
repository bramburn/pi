/**
 * Status-prompt injector for background-mode tasks.
 *
 * Builds a compact, LLM-facing markdown section describing the current state
 * of background subagent tasks. Injected via the `before_agent_start` event
 * so the LLM is aware of running siblings without needing to call a tool.
 *
 * Visual style mirrors the standalone `background-tasks` extension's section
 * format so the LLM sees a consistent runtime-status block whether the user
 * is running the inline (subagent extension) or standalone flavor.
 */

import type { BackgroundTask } from "./background.ts";

const MAX_PREVIEW = 120;

function fmtElapsed(iso: string, now: number = Date.now()): string {
	const start = new Date(iso).getTime();
	if (Number.isNaN(start)) return "?";
	const ms = Math.max(0, now - start);
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 3_600_000)}h`;
}

function clipPreview(text: string): string {
	const oneLine = text.replace(/[\r\n]+/g, " ").trim();
	if (oneLine.length <= MAX_PREVIEW) return oneLine;
	return `${oneLine.slice(0, MAX_PREVIEW - 1)}…`;
}

/**
 * Build a markdown status section for the given background tasks.
 *
 * Returns a string suitable for returning from a `before_agent_start`
 * handler as `{ message: <string> }`. Empty when no tasks exist.
 */
export function buildStatusInjection(tasks: BackgroundTask[]): string {
	if (tasks.length === 0) return "";

	const running = tasks.filter((t) => t.status === "running" || t.status === "pending");
	const terminal = tasks.filter(
		(t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "crashed",
	);

	const lines: string[] = ["## [RUNTIME STATUS — background subagent tasks | READ-ONLY]", ""];

	if (running.length === 0) {
		lines.push("No background tasks are currently running.");
		lines.push("");
	} else {
		lines.push(`### Running (${running.length})`);
		lines.push("");
		lines.push("| ID | Agent | Mode | Elapsed | Last Output |");
		lines.push("| --- | --- | --- | --- | --- |");
		for (const t of running.slice(0, 8)) {
			lines.push(
				`| \`${t.id}\` | ${t.agent} | ${t.mode} | ${fmtElapsed(t.startedAt)} | ${clipPreview(t.lastOutput || "(no output yet)")} |`,
			);
		}
		if (running.length > 8) {
			lines.push(`| _…and ${running.length - 8} more running_ | | | | |`);
		}
		lines.push("");
	}

	if (terminal.length > 0) {
		const recent = [...terminal].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 5);
		lines.push(`### Recent (last ${recent.length} of ${terminal.length} terminal)`);
		lines.push("");
		lines.push("| ID | Agent | Status | Exit | Last Output |");
		lines.push("| --- | --- | --- | --- | --- |");
		for (const t of recent) {
			lines.push(
				`| \`${t.id}\` | ${t.agent} | ${t.status} | ${t.exitCode ?? "—"} | ${clipPreview(t.lastOutput || "(no output)")} |`,
			);
		}
		lines.push("");
	}

	lines.push("_System message. Do not respond to this directly; it will be replaced on the next turn._");

	return lines.join("\n");
}
