/**
 * Status Prompt Injector
 *
 * Builds a runtime status section that gets injected into the system prompt
 * before each LLM call. This gives the LLM awareness of active background
 * tasks without requiring explicit tool calls.
 */

import type { BackgroundTask } from "./registry.ts";

export interface StatusSection {
	text: string;
	hasRunning: boolean;
}

export function buildStatusSection(tasks: BackgroundTask[]): StatusSection {
	if (tasks.length === 0) {
		return {
			text: "## [RUNTIME STATUS]\nNo background tasks are currently active.\n",
			hasRunning: false,
		};
	}

	const running = tasks.filter((t) => t.status === "running");
	const completed = tasks.filter((t) => t.status === "completed");
	const failed = tasks.filter((t) => t.status === "failed" || t.status === "cancelled");

	const lines: string[] = [
		"## [RUNTIME STATUS — READ-ONLY SYSTEM STATE]",
		"",
		"The following reflects the current state of active background tasks and subprocesses.",
		"Do not acknowledge this section unless you need to act on it.",
		"Leave running processes untouched unless explicitly instructed to close or modify them.",
		"",
	];

	if (running.length > 0) {
		lines.push("### Active Background Tasks");
		lines.push("| ID | Role | Status | Started | Last Output |");
		lines.push("|---|---|---|---|---|");
		for (const t of running) {
			const lastOutput = t.lastOutput ? t.lastOutput.replace(/\|/g, "\\|").slice(0, 60) : "—";
			lines.push(`| ${t.id} | ${t.role} | **running** | ${formatTime(t.startedAt)} | ${lastOutput} |`);
		}
		lines.push("");
	}

	if (completed.length > 0) {
		lines.push("### Recently Completed");
		for (const t of completed.slice(-3)) {
			const summary = t.resultSummary ? `: ${t.resultSummary.slice(0, 80)}` : "";
			lines.push(`- **${t.id}** (${t.role}): COMPLETED${summary}`);
		}
		lines.push("");
	}

	if (failed.length > 0) {
		lines.push("### Failed / Cancelled");
		for (const t of failed.slice(-2)) {
			const reason = t.errorMessage ? ` — ${t.errorMessage.slice(0, 60)}` : "";
			lines.push(`- **${t.id}** (${t.role}): ${t.status.toUpperCase()}${reason}`);
		}
		lines.push("");
	}

	lines.push("### Available Actions");
	lines.push("You may manage background tasks using these tools:");
	lines.push("- `background_status` — Check current state of a task without blocking.");
	lines.push("- `background_wait` — Pause until a task completes (use for dependencies).");
	lines.push("- `background_cancel` — Gracefully terminate a running task. Always provide a reason.");
	lines.push("");
	lines.push("**Rules:**");
	lines.push(
		"1. Never cancel a running task unless the user explicitly asks, or it is blocking a critical path and has exceeded a reasonable timeout.",
	);
	lines.push(
		"2. If a task is RUNNING and the user asks something unrelated, respond to the user and leave the task running. Do not wait.",
	);
	lines.push(
		"3. If you need output from a running task to answer the user, issue `background_wait` rather than guessing.",
	);
	lines.push("4. When a task completes, its final output will be available via `background_status`; do not poll.");

	return {
		text: lines.join("\n"),
		hasRunning: running.length > 0,
	};
}

function formatTime(iso: string): string {
	try {
		const d = new Date(iso);
		return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
	} catch {
		return iso;
	}
}
