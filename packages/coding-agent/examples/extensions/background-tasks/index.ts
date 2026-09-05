/**
 * Background Tasks Extension
 *
 * Enables fire-and-forget background task execution with:
 * - Detached pi subprocess spawning
 * - File-based task registry with crash recovery
 * - Runtime status injection into the system prompt
 * - Task management tools (status, wait, cancel, list)
 *
 * No existing commands are overridden. All commands prefixed with `bg-`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	addTask,
	type BackgroundTask,
	getTask,
	listTasks,
	makeTaskId,
	readTaskLogTail,
	removeTask,
	updateTask,
} from "./registry.ts";
import { cancelTask, spawnBackgroundTask } from "./runner.ts";
import { buildStatusSection } from "./status-injector.ts";

// ============================================================================
// Constants
// ============================================================================

const MAX_CONCURRENT_TASKS = 8;
const MAX_TASK_NAME_LENGTH = 64;
const OUTPUT_PREVIEW_LINES = 30;

// In-memory process handles (not persisted; used for cancel/wait)
const activeProcesses = new Map<string, ReturnType<typeof spawnBackgroundTask>["proc"]>();

// ============================================================================
// Helpers
// ============================================================================

function getBaseDir(): string {
	return path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
}

function errorToolResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: { error: message } };
}

function successToolResult(message: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details };
}

function sanitizeTaskName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_TASK_NAME_LENGTH);
}

function formatTaskStatus(task: BackgroundTask): string {
	const lines: string[] = [
		`ID:       ${task.id}`,
		`Name:     ${task.name}`,
		`Role:     ${task.role}`,
		`Status:   ${task.status}`,
		`Started:  ${task.startedAt}`,
	];
	if (task.completedAt) lines.push(`Completed: ${task.completedAt}`);
	if (task.exitCode !== undefined && task.exitCode !== null) lines.push(`Exit:     ${task.exitCode}`);
	if (task.model) lines.push(`Model:    ${task.model}`);
	if (task.errorMessage) lines.push(`Error:    ${task.errorMessage}`);
	if (task.lastOutput) lines.push(`Last Output: ${task.lastOutput.slice(0, 200)}`);
	return lines.join("\n");
}

// ============================================================================
// Tool Parameters
// ============================================================================

const BackgroundTaskParams = Type.Object({
	name: Type.String({ description: "Unique name for this background task (e.g., 'security-audit')" }),
	role: Type.String({ description: "Role assigned to the subagent (e.g., 'researcher', 'coder', 'reviewer')" }),
	objective: Type.String({ description: "Clear, concise task description" }),
	model: Type.Optional(Type.String({ description: "Model to use (defaults to current model)" })),
	thinking_level: Type.Optional(Type.String({ description: "Thinking level: none, low, medium, high" })),
	allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "Subset of tools the subagent may use" })),
	context_query: Type.Optional(Type.String({ description: "Context slice description for the subagent" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current session cwd)" })),
});

const BackgroundStatusParams = Type.Object({
	task_id: Type.String({ description: "ID of the background task to check" }),
	show_output: Type.Optional(Type.Boolean({ default: false, description: "Include recent log output" })),
});

const BackgroundWaitParams = Type.Object({
	task_id: Type.String({ description: "ID of the background task to wait for" }),
	timeout_ms: Type.Optional(Type.Number({ default: 60_000, description: "Max time to wait in milliseconds" })),
});

const BackgroundCancelParams = Type.Object({
	task_id: Type.String({ description: "ID of the background task to cancel" }),
	reason: Type.Optional(Type.String({ default: "Cancelled by user request", description: "Reason for cancellation" })),
});

// ============================================================================
// Extension Factory
// ============================================================================

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
	const baseDir = getBaseDir();

	// Ensure registry dir exists
	const regPath = path.join(baseDir, "background-tasks");
	if (!fs.existsSync(regPath)) {
		fs.mkdirSync(regPath, { recursive: true });
	}

	// -------------------------------------------------------------------------
	// Lifecycle: session_start (crash recovery)
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const all = listTasks(baseDir, "all");
		let changed = false;
		for (const task of all) {
			if (task.status === "running" && task.pid) {
				let alive = true;
				try {
					process.kill(task.pid, 0);
				} catch {
					alive = false;
				}
				if (!alive) {
					updateTask(baseDir, task.id, {
						status: "failed",
						completedAt: new Date().toISOString(),
						errorMessage: "Process not found after restart",
					});
					changed = true;
				}
			}
		}
		if (changed) {
			ctx.ui.notify("Background tasks: stale running tasks marked failed (no process after restart).", "warning");
		}
	});

	// -------------------------------------------------------------------------
	// before_agent_start: inject runtime status into system prompt
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async (event, _ctx) => {
		const tasks = listTasks(baseDir, "all").filter(
			(t) => t.status === "running" || (t.status === "completed" && !t.resultSummary),
		);
		if (tasks.length === 0) return undefined;

		const section = buildStatusSection(tasks);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${section.text}`,
		};
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------
	pi.registerCommand("bg-tasks", {
		description: "List all background tasks (running, completed, failed).",
		handler: async (_args, ctx) => {
			const tasks = listTasks(baseDir, "all");
			if (tasks.length === 0) {
				ctx.ui.notify("No background tasks found.", "info");
				return;
			}
			const running = tasks.filter((t) => t.status === "running").length;
			const lines: string[] = [`Background Tasks: ${tasks.length} total (${running} running)`, ""];
			for (const task of tasks.slice(-10)) {
				const icon = task.status === "running" ? "●" : task.status === "completed" ? "✓" : "✗";
				lines.push(`${icon} ${task.id} | ${task.role} | ${task.status}`);
			}
			ctx.ui.notify(lines.join("\n"), running > 0 ? "info" : undefined);
		},
	});

	pi.registerCommand("bg-clear", {
		description: "Remove completed/failed background tasks from the registry.",
		handler: async (_args, ctx) => {
			const tasks = listTasks(baseDir, "all");
			let removed = 0;
			for (const task of tasks) {
				if (task.status !== "running" && task.status !== "pending") {
					if (removeTask(baseDir, task.id)) removed++;
				}
			}
			ctx.ui.notify(`Cleared ${removed} background tasks.`, "info");
		},
	});

	// -------------------------------------------------------------------------
	// Tool: background_task (spawn)
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "background_task",
		label: "Background Task",
		description:
			"Spawn a detached background subagent to work independently. Returns immediately with a task ID. " +
			"The subagent runs in its own pi process and does not block the main session. " +
			"Use background_status to check progress, background_wait to synchronize, and background_cancel to stop.",
		parameters: BackgroundTaskParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runningCount = listTasks(baseDir, "running").length;
			if (runningCount >= MAX_CONCURRENT_TASKS) {
				return errorToolResult(
					`Too many concurrent background tasks (${runningCount}/${MAX_CONCURRENT_TASKS}). ` +
						"Wait for some to complete or cancel existing ones.",
				);
			}

			const id = makeTaskId(sanitizeTaskName(params.name));
			const cwd = params.cwd ?? ctx.cwd;

			const task = spawnBackgroundTask({
				name: id,
				role: params.role,
				objective: params.objective,
				model: params.model,
				thinkingLevel: params.thinking_level,
				allowedTools: params.allowed_tools,
				contextQuery: params.context_query,
				cwd,
				baseDir,
			});

			addTask(baseDir, task.task);
			activeProcesses.set(id, task.proc);

			return successToolResult(
				`Background task spawned: ${id}\nRole: ${params.role}\nStatus: running\nPID: ${task.proc.pid ?? "unknown"}`,
				{ task_id: id, pid: task.proc.pid, status: "running" },
			);
		},
	});

	// -------------------------------------------------------------------------
	// Tool: background_status
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "background_status",
		label: "Background Status",
		description:
			"Check the current status and recent output of a background task. Non-blocking. " +
			"Use this to poll for completion or inspect results without waiting.",
		parameters: BackgroundStatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = getTask(baseDir, params.task_id);
			if (!task) {
				return errorToolResult(`Unknown background task: ${params.task_id}`);
			}

			let output = "";
			if (params.show_output) {
				const lines = readTaskLogTail(baseDir, params.task_id, OUTPUT_PREVIEW_LINES);
				output = lines.length > 0 ? `\n\n--- Recent Output ---\n${lines.join("\n")}` : "";
			}

			return successToolResult(formatTaskStatus(task) + output, {
				task_id: task.id,
				status: task.status,
				exitCode: task.exitCode,
			});
		},
	});

	// -------------------------------------------------------------------------
	// Tool: background_wait
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "background_wait",
		label: "Background Wait",
		description:
			"Block until a background task completes (or times out). Use this when you need " +
			"the task's result before proceeding. If the task is already completed, returns immediately.",
		parameters: BackgroundWaitParams,
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const task = getTask(baseDir, params.task_id);
			if (!task) {
				return errorToolResult(`Unknown background task: ${params.task_id}`);
			}

			if (task.status !== "running" && task.status !== "pending") {
				const lines = readTaskLogTail(baseDir, params.task_id, OUTPUT_PREVIEW_LINES);
				return successToolResult(
					`Task ${params.task_id} is already ${task.status}.\n\n${formatTaskStatus(task)}\n\n--- Output ---\n${lines.join("\n")}`,
					{ task_id: task.id, status: task.status, waited: false },
				);
			}

			const timeoutMs = params.timeout_ms ?? 60_000;
			const start = Date.now();

			return new Promise<AgentToolResult<unknown>>((resolve) => {
				const checkInterval = setInterval(() => {
					const current = getTask(baseDir, params.task_id);
					if (!current) {
						clearInterval(checkInterval);
						resolve(errorToolResult(`Task ${params.task_id} disappeared from registry.`));
						return;
					}

					if (current.status !== "running" && current.status !== "pending") {
						clearInterval(checkInterval);
						const lines = readTaskLogTail(baseDir, params.task_id, OUTPUT_PREVIEW_LINES);
						resolve(
							successToolResult(
								`Task ${params.task_id} completed after ${Date.now() - start}ms.\n\n${formatTaskStatus(current)}\n\n--- Output ---\n${lines.join("\n")}`,
								{ task_id: current.id, status: current.status, waited: true, durationMs: Date.now() - start },
							),
						);
						return;
					}

					if (Date.now() - start >= timeoutMs) {
						clearInterval(checkInterval);
						resolve(
							successToolResult(
								`Timed out after ${timeoutMs}ms waiting for ${params.task_id}. Task is still running.`,
								{ task_id: params.task_id, status: "running", waited: false, timedOut: true },
							),
						);
						return;
					}
				}, 500);

				if (signal) {
					signal.addEventListener(
						"abort",
						() => {
							clearInterval(checkInterval);
							resolve(errorToolResult(`Wait cancelled for task ${params.task_id}.`));
						},
						{ once: true },
					);
				}
			});
		},
	});

	// -------------------------------------------------------------------------
	// Tool: background_cancel
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "background_cancel",
		label: "Background Cancel",
		description:
			"Gracefully terminate a running background task. Always provide a clear reason. " +
			"This sends SIGTERM first, then SIGKILL after 5 seconds if the process does not exit.",
		parameters: BackgroundCancelParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = getTask(baseDir, params.task_id);
			if (!task) {
				return errorToolResult(`Unknown background task: ${params.task_id}`);
			}

			if (task.status !== "running" && task.status !== "pending") {
				return errorToolResult(`Task ${params.task_id} is already ${task.status}. Nothing to cancel.`);
			}

			const proc = activeProcesses.get(params.task_id);
			if (proc) {
				cancelTask(proc, baseDir, params.task_id);
				activeProcesses.delete(params.task_id);
			} else {
				// Process handle not in memory; mark as cancelled anyway
				updateTask(baseDir, params.task_id, {
					status: "cancelled",
					completedAt: new Date().toISOString(),
					errorMessage: params.reason,
				});
			}

			return successToolResult(`Cancelled background task ${params.task_id}. Reason: ${params.reason}`, {
				task_id: params.task_id,
				status: "cancelled",
			});
		},
	});
}
