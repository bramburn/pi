/**
 * Subagent Tool + Experimental Mode
 *
 * Two capabilities in one extension:
 *   1. Subagent: spawn isolated `pi` subprocesses for parallel/chain/single tasks.
 *   2. Experimental mode: hypothesis-driven worktree-based parallel exploration
 *      with E.D.I.T. loop tooling, registry persistence, status pill, and
 *      Research Mode auto-trigger on 3x-same-error.
 *
 * The subagent tool supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent, task, cwd? }, ...] }
 *   - Chain: { chain: [{ agent, task, cwd? }, ...] }
 *
 * The experimental mode adds 8 sibling tools: experiment_start, experiment_run,
 * experiment_test, experiment_diff, experiment_merge, experiment_discard,
 * experiment_list, experiment_compare. Each is a top-level pi.registerTool call;
 * the subagent extension is the single entry point.
 *
 * JSON mode is used to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	type ThemeColor,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { getRegistry as getBackgroundRegistry } from "./background.ts";
import {
	addExperiment as addExperimentRow,
	type ExperimentRow,
	logPath as experimentLogPath,
	getExperiment as getExperimentRow,
	listExperiments,
	makeExperimentId,
	updateExperiment,
} from "./registry.ts";
import { ResearchModeTracker } from "./research-mode.ts";
import {
	appendLogEvent as appendExperimentLogEvent,
	ensureLogFile as ensureExperimentLog,
	runCommand as runShellCommand,
} from "./runner.ts";
import { buildStatusInjection } from "./status-injector.ts";
import {
	CompareParams,
	DiffParams,
	DiscardParams,
	ListParams,
	MergeParams,
	RunParams,
	StartParams,
	TestParams,
} from "./tools.ts";
import { clearDashboard, refreshBackgroundPill, refreshStatusPill, showDashboard } from "./ui.ts";
import {
	cherryPickFromBranch,
	createWorktree,
	currentHead,
	diffVsParent,
	isGitRepo,
	pruneWorktrees,
	removeWorktree,
	squashSinceParent,
} from "./worktree.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

// ============================================================================
// Background-mode machinery
// ============================================================================
//
// Fire-and-forget variant of runSingleAgent. The LLM tool call returns
// immediately with a task ID; the child pi process runs detached; when it
// finishes, a custom message is sent to the parent session so the result
// appears in the next turn.
//
// On Windows the child is in the parent's Job Object and dies with the
// parent. This is acceptable for the planned "background while the user
// works" use case; see lab/sessions/2026-08-30-bun-subprocess-mgmt/.

const SUBAGENT_BACKGROUND_RESULT_CUSTOM_TYPE = "subagent-background-result";

type BackgroundRegistry = ReturnType<typeof getBackgroundRegistry>;

interface BackgroundSpec {
	agentName: string;
	mode: "single" | "parallel" | "chain" | "script";
	scriptOrTask: string;
	cwd: string;
	dispatchDefaults: DispatchDefaults;
	pi: ExtensionAPI;
	registry: BackgroundRegistry;
	agentScope: AgentScope;
}

// `registry.update` and `registry.appendLog` are synchronous in the current
// implementation but they take a file lock that can reject after 5 s. A bare
// `void` discards a synchronous throw into an uncaughtException. Wrap each
// call so the failure is captured in the per-task log instead.
function safeUpdate(
	reg: BackgroundRegistry,
	taskId: string,
	patch: Partial<Parameters<BackgroundRegistry["update"]>[1]>,
): void {
	try {
		reg.update(taskId, patch);
	} catch (err) {
		try {
			reg.appendLog(taskId, { type: "UPDATE_FAILED", error: String((err as Error).message ?? err) });
		} catch {
			/* log is best-effort */
		}
	}
}

function fireBackground(spec: BackgroundSpec): { taskId: string } {
	const taskId = spec.registry.makeTaskId();
	const initialTask = {
		id: taskId,
		kind: "pi-subprocess" as const,
		mode: spec.mode,
		agent: spec.agentName,
		agentScope: spec.agentScope,
		label: `${spec.agentName} (${spec.mode})`,
		scriptOrTask: spec.scriptOrTask,
		model: spec.dispatchDefaults.model,
		status: "running" as const,
		startedAt: new Date().toISOString(),
		lastEventAt: new Date().toISOString(),
		lastOutput: "",
		cwd: spec.cwd,
	};
	void spec.registry.add(initialTask);
	spec.registry.appendLog(taskId, { type: "SPAWN", agent: spec.agentName, mode: spec.mode });
	queueMicrotask(() => {
		void runBackgroundSubagent(spec, taskId);
	});
	return { taskId };
}

async function runBackgroundSubagent(spec: BackgroundSpec, taskId: string): Promise<void> {
	const registry = spec.registry;
	// runBackgroundSubagent is fire-and-forget from the parent's perspective
	// (`void` in fireBackground). Any uncaught rejection here becomes an
	// unhandledRejection and can crash the parent. Wrap the body in a top-level
	// try/catch that marks the task as crashed and records the error.
	try {
		await runBackgroundSubagentInner(spec, taskId);
	} catch (err) {
		safeUpdate(registry, taskId, {
			status: "crashed",
			errorMessage: `runner crashed: ${(err as Error).message ?? err}`,
			finishedAt: new Date().toISOString(),
		});
		registry.appendLog(taskId, {
			type: "RUNNER_CRASHED",
			error: (err as Error).message ?? String(err),
		});
	}
}

async function runBackgroundSubagentInner(spec: BackgroundSpec, taskId: string): Promise<void> {
	const registry = spec.registry;
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const model = spec.dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (spec.dispatchDefaults.thinkingLevel) {
		args.push("--thinking", spec.dispatchDefaults.thinkingLevel);
	}
	args.push(`Task: ${spec.scriptOrTask}`);
	const invocation = getPiInvocation(args);
	let proc: ReturnType<typeof spawn> | null = null;
	try {
		proc = spawn(invocation.command, invocation.args, {
			cwd: spec.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (err) {
		safeUpdate(registry, taskId, {
			status: "failed",
			errorMessage: `spawn failed: ${(err as Error).message}`,
			finishedAt: new Date().toISOString(),
		});
		registry.appendLog(taskId, { type: "SPAWN_ERROR", error: (err as Error).message });
		try {
			spec.pi.sendMessage(
				{
					customType: SUBAGENT_BACKGROUND_RESULT_CUSTOM_TYPE,
					content: `Background task ${taskId} (${spec.agentName}) failed to start: ${(err as Error).message}`,
					display: true,
					details: { taskId, status: "failed", errorMessage: (err as Error).message },
				},
				{ triggerTurn: true, deliverAs: "nextTurn" },
			);
		} catch (sendErr) {
			registry.appendLog(taskId, { type: "POST_RESULT_FAILED", error: (sendErr as Error).message });
		}
		return;
	}
	safeUpdate(registry, taskId, { pid: proc.pid, lastOutput: "spawned" });
	registry.appendLog(taskId, { type: "PID", pid: proc.pid });
	let buffer = "";
	let lastAssistantText = "";
	const totalUsage = { input: 0, output: 0, cost: 0, turns: 0 };
	proc.stdout?.on("data", (data: Buffer) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			registry.appendLog(taskId, { type: "EVENT", event: { t: event.type } });
			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				if (msg.role === "assistant") {
					const usage = msg.usage;
					if (usage) {
						totalUsage.input += usage.input || 0;
						totalUsage.output += usage.output || 0;
						totalUsage.cost += usage.cost?.total || 0;
						totalUsage.turns += 1;
					}
					for (const part of msg.content ?? []) {
						if (part.type === "text") lastAssistantText = part.text;
					}
					safeUpdate(registry, taskId, {
						lastOutput: lastAssistantText.slice(-200),
						usage: totalUsage,
					});
				}
			}
			if (event.type === "tool_result_end" && event.message) {
				const msg = event.message as Message;
				const toolName = (msg as { toolName?: string }).toolName ?? "tool";
				const output = (msg as { output?: string }).output ?? "";
				safeUpdate(registry, taskId, {
					lastOutput: `[${toolName}] ${String(output).slice(-160)}`,
				});
			}
		}
	});
	proc.stderr?.on("data", (data: Buffer) => {
		const text = data.toString();
		registry.appendLog(taskId, { type: "STDERR", chunk: text.slice(-500) });
		safeUpdate(registry, taskId, { lastOutput: `[stderr] ${text.slice(-160)}` });
	});
	proc.on("close", (code, signal) => {
		if (buffer.trim()) {
			try {
				const event = JSON.parse(buffer);
				registry.appendLog(taskId, { type: "EVENT_TRAILING", event: { t: event.type } });
			} catch {
				/* drop */
			}
		}
		// Node reports `code: null` when the child is killed by a signal (Windows
		// Job Object termination, OOM, explicit proc.kill). Treat that as crashed,
		// not as exit-code 0. Leave exitCode undefined so the on-disk record
		// distinguishes "exited normally with 0" from "was killed".
		const killed = code === null;
		const status: "completed" | "failed" | "crashed" = killed ? "crashed" : code === 0 ? "completed" : "failed";
		const exitCode = killed ? undefined : (code ?? 1);
		const errorMessage = killed ? `Killed by signal ${signal ?? "unknown"}` : undefined;
		const finalText = lastAssistantText || "(no output)";
		safeUpdate(registry, taskId, {
			status,
			exitCode,
			finishedAt: new Date().toISOString(),
			lastOutput: finalText.slice(-200),
			...(errorMessage ? { errorMessage } : {}),
		});
		registry.appendLog(taskId, { type: "EXIT", exitCode: exitCode ?? null, status, signal: signal ?? null });
		const isError = status !== "completed";
		const content = isError
			? `Background task ${taskId} (${spec.agentName}) ${status}${errorMessage ? `: ${errorMessage}` : exitCode !== undefined ? ` with exit code ${exitCode}` : ""}.\n\n${finalText}`
			: `Background task ${taskId} (${spec.agentName}) completed.\n\n${finalText}`;
		try {
			spec.pi.sendMessage(
				{
					customType: SUBAGENT_BACKGROUND_RESULT_CUSTOM_TYPE,
					content,
					display: true,
					details: { taskId, status, agent: spec.agentName, exitCode, finalOutput: finalText, usage: totalUsage },
				},
				{ triggerTurn: true, deliverAs: "nextTurn" },
			);
		} catch (err) {
			registry.appendLog(taskId, { type: "POST_RESULT_FAILED", error: (err as Error).message });
		}
	});
	proc.on("error", (err) => {
		safeUpdate(registry, taskId, {
			status: "failed",
			errorMessage: `child error: ${err.message}`,
			finishedAt: new Date().toISOString(),
		});
		registry.appendLog(taskId, { type: "CHILD_ERROR", error: err.message });
	});
}

function backgroundStartSummary(taskId: string, agent: string, mode: string): string {
	return `Background task ${taskId} started (${agent}, ${mode}). Use \`/tasks\` or \`Ctrl+T\` to see live status; the result will be injected as a custom message on the next turn.`;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Fire-and-forget mode. The tool returns immediately with a task ID; the child subagent runs in the background. Results are injected as a custom message on the next turn. Default: false (synchronous, blocks the LLM until done).",
			default: false,
		}),
	),
	script: Type.Optional(
		Type.String({
			description:
				"Arbitrary shell script body to pass to the subagent as the task. The subagent LLM reads it and executes via its bash tool. Use this for builds, multi-step commands, or any work you would normally paste into a terminal. Mutually exclusive with task; if both are provided, script wins.",
		}),
	),
});

// ============================================================================
// Experimental Mode (worktree-based E.D.I.T. loop)
// ============================================================================
//
// Adds 8 tools (experiment_start / run / test / diff / merge / discard / list /
// compare) plus a registry, status pill, /experimental + /experiments commands,
// Ctrl+E shortcut, Research Mode auto-trigger, and a before_agent_start fragment
// injector. See README.md §"Experimental mode" for the full design.

const EDIT_LOOP_FRAGMENT = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "prompts", "edit-loop.md"),
	"utf-8",
);
const RESEARCH_MODE_FRAGMENT = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "prompts", "research-mode.md"),
	"utf-8",
);

interface ExperimentalSessionState {
	enabled: boolean;
	researchModeEnabled: boolean;
}

function getSessionId(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() || "default";
}

function readFragments(): { editLoop: string; research: string } {
	return { editLoop: EDIT_LOOP_FRAGMENT, research: RESEARCH_MODE_FRAGMENT };
}

function errorToolResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
	};
}

function successToolResult(message: string, details: unknown = {}): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

function detectTestRunner(cwd: string): { name: string; command: string; filterFlag: string } | null {
	if (fs.existsSync(join(cwd, "bun.lockb")) || fs.existsSync(join(cwd, "bun.lock"))) {
		return { name: "bun", command: "bun test", filterFlag: "-t" };
	}
	if (fs.existsSync(join(cwd, "vitest.config.ts")) || fs.existsSync(join(cwd, "vitest.config.js"))) {
		return { name: "vitest", command: "npx vitest run", filterFlag: "-t" };
	}
	if (fs.existsSync(join(cwd, "jest.config.ts")) || fs.existsSync(join(cwd, "jest.config.js"))) {
		return { name: "jest", command: "npx jest", filterFlag: "-t" };
	}
	if (fs.existsSync(join(cwd, "package.json"))) {
		return { name: "npm", command: "npm test --", filterFlag: "--" };
	}
	return null;
}

function parseTestSummary(output: string, runner: string): { passed: number; failed: number; skipped: number } {
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	const passedMatch = output.match(/(\d+)\s+pass(?:ed|ing)?/i);
	const failedMatch = output.match(/(\d+)\s+fail(?:ed|ing)?/i);
	const skippedMatch = output.match(/(\d+)\s+skip(?:ped|ping)?/i);
	if (passedMatch) passed = Number.parseInt(passedMatch[1], 10);
	if (failedMatch) failed = Number.parseInt(failedMatch[1], 10);
	if (skippedMatch) skipped = Number.parseInt(skippedMatch[1], 10);
	if (runner === "vitest" && passed === 0 && failed === 0) {
		const m = output.match(/Tests?\s+(\d+)\s+passed\s*\((\d+)\)/i);
		if (m) passed = Number.parseInt(m[1], 10);
		const f = output.match(/Tests?\s+(\d+)\s+failed\s*\((\d+)\)/i);
		if (f) failed = Number.parseInt(f[1], 10);
	}
	return { passed, failed, skipped };
}

function tailOf(s: string, lines: number): string {
	const arr = s.split("\n");
	return arr.length > lines ? `... ${arr.length - lines} earlier lines\n${arr.slice(-lines).join("\n")}` : s;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

function registerExperimentalMode(pi: ExtensionAPI): void {
	const sessionState = new Map<string, ExperimentalSessionState>();
	const researchTracker = new ResearchModeTracker({ notify: () => {} });

	function stateFor(ctx: { sessionManager: { getSessionId(): string } }): ExperimentalSessionState {
		const id = getSessionId(ctx);
		let s = sessionState.get(id);
		if (!s) {
			s = { enabled: false, researchModeEnabled: true };
			sessionState.set(id, s);
		}
		return s;
	}

	function activeExperimentLog(ctx: { cwd: string }): string | undefined {
		const all = listExperiments(ctx.cwd, "all");
		const running = all.filter((r) => r.status === "running").slice(-1);
		return running[0] ? experimentLogPath(ctx.cwd, running[0].id) : undefined;
	}

	// -------------------------------------------------------------------------
	// Lifecycle: session_start (crash recovery for running experiments)
	// -------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		if (!(await isGitRepo(ctx.cwd))) return;
		const all = listExperiments(ctx.cwd, "all");
		let changed = false;
		for (const row of all) {
			if (row.status === "running" && row.pid) {
				let alive = true;
				try {
					process.kill(row.pid, 0);
				} catch (_err) {
					alive = false;
				}
				if (!alive) {
					updateExperiment(ctx.cwd, row.id, {
						status: "failed",
						completedAt: new Date().toISOString(),
						result: { ...row.result, notes: "no process after restart" },
					});
					changed = true;
				}
			}
		}
		if (changed) {
			ctx.ui.notify(
				"Experimental mode: stale running experiments marked failed (no process after restart).",
				"warning",
			);
		}
		refreshStatusPill(ctx, ctx.cwd, stateFor(ctx).enabled);
	});

	// -------------------------------------------------------------------------
	// before_agent_start: inject the E.D.I.T. + Research Mode fragments when enabled
	// -------------------------------------------------------------------------
	pi.on("before_agent_start", async (event, ctx) => {
		if (!stateFor(ctx).enabled) return;
		const { editLoop, research } = readFragments();
		return { systemPrompt: `${event.systemPrompt}\n\n${editLoop}\n\n${research}` };
	});

	// -------------------------------------------------------------------------
	// tool_result: Research Mode 3x-same-error watcher
	// -------------------------------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		const s = stateFor(ctx);
		if (!s.enabled || !s.researchModeEnabled) return;
		if (!event.isError) return;
		const text = event.content
			.filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
			.map((b) => b.text)
			.join("\n");
		if (!text) return;
		const toolName = (event as { toolName?: string }).toolName ?? "unknown";
		const activeLog = activeExperimentLog(ctx);
		researchTracker.recordToolResult(getSessionId(ctx), toolName, true, text, activeLog);
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------
	pi.registerCommand("experimental", {
		description: "Toggle experimental mode (E.D.I.T. loop + worktree substrate).",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			const s = stateFor(ctx);
			if (arg === "on") s.enabled = true;
			else if (arg === "off") s.enabled = false;
			else s.enabled = !s.enabled;
			ctx.ui.notify(
				s.enabled
					? "Experimental mode ON — E.D.I.T. loop fragment appended to the system prompt."
					: "Experimental mode OFF — system prompt unchanged.",
				"info",
			);
			refreshStatusPill(ctx, ctx.cwd, s.enabled);
		},
	});

	pi.registerCommand("experiments", {
		description: "Show the experiment dashboard overlay.",
		handler: async (_args, ctx) => {
			await showDashboard(ctx, ctx.cwd);
		},
	});

	pi.registerShortcut(Key.ctrl("e"), {
		description: "Open the experiment dashboard.",
		handler: async (ctx) => {
			await showDashboard(ctx, ctx.cwd);
		},
	});

	// -------------------------------------------------------------------------
	// Tool: experiment_start
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "experiment_start",
		label: "Experiment Start",
		description: "Fork a worktree for one experimental approach. Use once per approach when comparing 2+ candidates.",
		parameters: StartParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = stateFor(ctx);
			if (!s.enabled) return errorToolResult("Experimental mode is off. Use /experimental on to enable it.");
			if (!(await isGitRepo(ctx.cwd))) {
				return errorToolResult(`Not a git repository: ${ctx.cwd}. Experimental mode requires git.`);
			}
			let parentCommit: string;
			try {
				parentCommit = params.parent_commit ?? (await currentHead(ctx.cwd));
			} catch (err) {
				return errorToolResult(`Could not resolve parent commit: ${(err as Error).message}`);
			}
			const id = makeExperimentId(params.approach_name);
			const work = await createWorktree(ctx.cwd, params.approach_name, parentCommit);
			if (work.exitCode !== 0) {
				return errorToolResult(
					`git worktree add failed (exit ${work.exitCode}): ${work.stderr.trim() || work.stdout.trim()}`,
				);
			}
			const logFile = experimentLogPath(ctx.cwd, id);
			ensureExperimentLog(logFile);
			appendExperimentLogEvent(logFile, {
				type: "STARTED",
				hypothesis: params.hypothesis,
				approach: params.approach_name,
				parentCommit,
			});
			const now = new Date().toISOString();
			const row: ExperimentRow = {
				id,
				hypothesis: params.hypothesis,
				approach: params.approach_name,
				worktreePath: work.worktreePath,
				branch: work.branch,
				parentCommit,
				startedInCwd: ctx.cwd,
				status: "scaffolded",
				outputPath: logFile,
				result: {},
				merged: false,
				createdAt: now,
				updatedAt: now,
			};
			addExperimentRow(ctx.cwd, row);
			refreshStatusPill(ctx, ctx.cwd, true);
			clearDashboard(ctx);
			return successToolResult(
				`Created experiment ${id}\n  branch: ${work.branch}\n  worktree: ${work.worktreePath}\n  parent: ${parentCommit.slice(0, 12)}\n  status: scaffolded`,
				{ id, branch: work.branch, worktree_path: work.worktreePath, status: "scaffolded" },
			);
		},
	});

	// -------------------------------------------------------------------------
	// Tool: experiment_run
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "experiment_run",
		label: "Experiment Run",
		description:
			"Run a shell command inside the experiment's worktree. Output is captured to log.jsonl and returned.",
		parameters: RunParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const row = getExperimentRow(ctx.cwd, params.experiment_id);
			if (!row) return errorToolResult(`Unknown experiment: ${params.experiment_id}`);
			const logFile = experimentLogPath(ctx.cwd, row.id);
			ensureExperimentLog(logFile);
			appendExperimentLogEvent(logFile, {
				type: "RUN_STARTED",
				command: params.command,
				timeoutMs: params.timeout_ms,
			});
			const result = await runShellCommand(params.command, {
				cwd: row.worktreePath,
				timeoutMs: params.timeout_ms,
				signal,
				experimentLogPath: logFile,
			});
			appendExperimentLogEvent(logFile, {
				type: "RUN_COMPLETED",
				command: params.command,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				timedOut: result.timedOut,
				cancelled: result.cancelled,
			});
			const newStatus = result.exitCode === 0 ? "completed" : result.cancelled ? "cancelled" : "failed";
			updateExperiment(ctx.cwd, row.id, { status: newStatus });
			const summary =
				`exit ${result.exitCode} · ${result.durationMs}ms` +
				(result.timedOut ? " · TIMED OUT" : "") +
				(result.cancelled ? " · CANCELLED" : "");
			return successToolResult(
				`${summary}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`.trim(),
				{
					experiment_id: row.id,
					exitCode: result.exitCode,
					durationMs: result.durationMs,
				},
			);
		},
	});

	// -------------------------------------------------------------------------
	// Tool: experiment_test
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "experiment_test",
		label: "Experiment Test",
		description:
			"Auto-detect the test runner and run it inside the worktree. Records passed/failed counts in the registry.",
		parameters: TestParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const row = getExperimentRow(ctx.cwd, params.experiment_id);
			if (!row) return errorToolResult(`Unknown experiment: ${params.experiment_id}`);
			const detector = detectTestRunner(row.worktreePath);
			if (!detector) {
				return errorToolResult(
					"Could not detect a test runner. Pass an explicit command via experiment_run instead.",
				);
			}
			const command = params.filter
				? `${detector.command} ${detector.filterFlag} ${`'${params.filter.replace(/'/g, "'\\''")}'`}`
				: detector.command;
			const logFile = experimentLogPath(ctx.cwd, row.id);
			ensureExperimentLog(logFile);
			appendExperimentLogEvent(logFile, { type: "TEST_STARTED", runner: detector.name, command });
			const result = await runShellCommand(command, {
				cwd: row.worktreePath,
				signal,
				experimentLogPath: logFile,
			});
			const { passed, failed, skipped } = parseTestSummary(`${result.stdout}\n${result.stderr}`, detector.name);
			appendExperimentLogEvent(logFile, {
				type: "TEST_COMPLETED",
				runner: detector.name,
				exitCode: result.exitCode,
				passed,
				failed,
				skipped,
			});
			updateExperiment(ctx.cwd, row.id, {
				status: failed > 0 || result.exitCode !== 0 ? "failed" : "completed",
				result: { ...row.result, testPassed: passed, testFailed: failed, testSkipped: skipped },
			});
			return successToolResult(
				`runner: ${detector.name}\nexit: ${result.exitCode}\n` +
					`passed: ${passed} · failed: ${failed} · skipped: ${skipped}\n\n` +
					tailOf(result.stdout, 50),
				{ experiment_id: row.id, runner: detector.name, passed, failed, skipped },
			);
		},
	});

	// -------------------------------------------------------------------------
	// Tool: experiment_diff
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "experiment_diff",
		label: "Experiment Diff",
		description: "Show what changed in the experiment's worktree vs the parent commit.",
		parameters: DiffParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const row = getExperimentRow(ctx.cwd, params.experiment_id);
			if (!row) return errorToolResult(`Unknown experiment: ${params.experiment_id}`);
			const diff = await diffVsParent(row.worktreePath, row.parentCommit);
			if (diff.raw.exitCode !== 0) {
				return errorToolResult(
					`git diff failed (exit ${diff.raw.exitCode}): ${diff.raw.stderr.trim() || diff.raw.stdout.trim()}`,
				);
			}
			const commitList =
				diff.commits.map((c) => `${c.sha.slice(0, 7)}  ${c.subject}`).join("\n") || "(no commits yet)";
			return successToolResult(
				`files changed: ${diff.filesChanged}\ninsertions:    ${diff.insertions}\ndeletions:     ${diff.deletions}\ncommits:\n${commitList}\n\n--- diff (truncated) ---\n${tailOf(diff.diff, 80)}`,
				{
					experiment_id: row.id,
					files_changed: diff.filesChanged,
					insertions: diff.insertions,
					deletions: diff.deletions,
					commits: diff.commits,
				},
			);
		},
	});

	// -------------------------------------------------------------------------
	// Tool: experiment_merge
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "experiment_merge",
		label: "Experiment Merge",
		description: "Transfer the winning experiment back to the main worktree via cherry-pick, squash, or merge.",
		parameters: MergeParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const row = getExperimentRow(ctx.cwd, params.experiment_id);
			if (!row) return errorToolResult(`Unknown experiment: ${params.experiment_id}`);
			if (row.merged) return errorToolResult(`Experiment ${row.id} is already merged.`);

			// Refuse to merge if the main worktree has uncommitted changes (ignoring the
			// .pi-experiments/ registry dir which is expected to be untracked).
			const status = await runShellCommand("git status --porcelain -- . :!./.pi-experiments :!./.pi-experiments/", {
				cwd: ctx.cwd,
			});
			if (status.stdout.trim().length > 0) {
				return errorToolResult(
					`Main worktree has uncommitted changes. Commit or stash them before merging an experiment.\n${status.stdout}`,
				);
			}

			if (params.strategy === "cherry-pick") {
				const head = await runShellCommand(`git rev-parse ${row.branch}`, { cwd: ctx.cwd });
				if (head.exitCode !== 0) {
					return errorToolResult(`Could not resolve ${row.branch}: ${head.stderr.trim() || head.stdout.trim()}`);
				}
				const pick = await cherryPickFromBranch(ctx.cwd, row.branch, head.stdout.trim());
				if (pick.exitCode !== 0) {
					return errorToolResult(
						`Cherry-pick failed (exit ${pick.exitCode}): ${pick.stderr.trim() || pick.stdout.trim()}`,
					);
				}
				await finalizeExperimentMerge(ctx, row, "cherry-pick", pick.newCommit);
				return successToolResult(
					`Cherry-picked ${row.branch} into main as ${pick.newCommit?.slice(0, 7) ?? "(no commit)"}`,
				);
			}

			if (params.strategy === "squash") {
				if (!params.squash_message) {
					return errorToolResult("strategy='squash' requires squash_message.");
				}
				const sq = await squashSinceParent(ctx.cwd, row.branch, row.parentCommit, params.squash_message);
				if (sq.exitCode !== 0) {
					return errorToolResult(`Squash failed (exit ${sq.exitCode}): ${sq.stderr.trim() || sq.stdout.trim()}`);
				}
				if (sq.wasNoOp) {
					return errorToolResult(
						"No commits to squash. The experiment worktree has no commits beyond the parent.",
					);
				}
				await finalizeExperimentMerge(ctx, row, "squash", sq.newCommit);
				return successToolResult(
					`Squashed ${row.branch} into main as ${sq.newCommit?.slice(0, 7) ?? "(no commit)"}`,
				);
			}

			const merge = await runShellCommand(
				`git merge --no-ff ${row.branch} -m "Merge experiment ${row.id} (${row.approach})"`,
				{ cwd: ctx.cwd },
			);
			if (merge.exitCode !== 0) {
				return errorToolResult(
					`Merge failed (exit ${merge.exitCode}): ${merge.stderr.trim() || merge.stdout.trim()}`,
				);
			}
			const head = await runShellCommand("git rev-parse HEAD", { cwd: ctx.cwd });
			await finalizeExperimentMerge(ctx, row, "merge", head.exitCode === 0 ? head.stdout.trim() : undefined);
			return successToolResult(`Merged ${row.branch} into main as ${head.stdout.trim().slice(0, 7)}`);
		},
	});

	// -------------------------------------------------------------------------
	// Tool: experiment_discard
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "experiment_discard",
		label: "Experiment Discard",
		description:
			"Remove the worktree and mark the experiment as discarded. The branch is kept by default with WHY_IT_FAILED.md for archaeology.",
		parameters: DiscardParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const row = getExperimentRow(ctx.cwd, params.experiment_id);
			if (!row) return errorToolResult(`Unknown experiment: ${params.experiment_id}`);
			const keepBranch = params.keep_branch ?? true;
			if (keepBranch) {
				const whyPath = join(row.worktreePath, "WHY_IT_FAILED.md");
				try {
					fs.writeFileSync(
						whyPath,
						`# Why this experiment failed\n\n` +
							`**Approach:** ${row.approach}\n` +
							`**Hypothesis:** ${row.hypothesis}\n` +
							`**Discarded at:** ${new Date().toISOString()}\n\n` +
							`## Reason\n\n${params.reason}\n\n` +
							`## Original result\n\n\`\`\`json\n${JSON.stringify(row.result, null, 2)}\n\`\`\`\n`,
						"utf-8",
					);
					await runShellCommand('git add WHY_IT_FAILED.md && git commit -m "experiment: record discard reason"', {
						cwd: row.worktreePath,
					});
				} catch {
					/* worktree may already be unwriteable; continue with removal */
				}
			}
			const removed = await removeWorktree(ctx.cwd, row.worktreePath, true);
			if (removed.exitCode !== 0) {
				return errorToolResult(
					`git worktree remove failed (exit ${removed.exitCode}): ${removed.stderr.trim()}\n\n` +
						`On Windows this often means MAX_PATH or a handle lock. Move the build dir aside and retry:\n` +
						`  Move-Item "${row.worktreePath}\\node_modules" "${row.worktreePath}\\__nm_backup" -Force\n` +
						`  git worktree remove --force "${row.worktreePath}"`,
				);
			}
			await pruneWorktrees(ctx.cwd);
			if (!keepBranch) {
				await runShellCommand(`git branch -D ${row.branch}`, { cwd: ctx.cwd });
			}
			updateExperiment(ctx.cwd, row.id, { status: "discarded" });
			refreshStatusPill(ctx, ctx.cwd, stateFor(ctx).enabled);
			return successToolResult(
				`Discarded ${row.id} (${row.approach}). Branch ${keepBranch ? "kept" : "deleted"}: ${row.branch}`,
			);
		},
	});

	// -------------------------------------------------------------------------
	// Tool: experiment_list
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "experiment_list",
		label: "Experiment List",
		description: "List experiments, optionally filtered by status.",
		parameters: ListParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const status = (params.status as ExperimentRow["status"] | "all" | undefined) ?? "all";
			const rows = listExperiments(ctx.cwd, status);
			if (rows.length === 0) {
				return successToolResult(`No experiments${status === "all" ? "" : ` with status ${status}`}.`);
			}
			const text = rows
				.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
				.map(
					(r) =>
						`[${r.status}] ${r.approach}  ${r.id}  (${r.createdAt.slice(0, 16)})  ${truncate(r.hypothesis, 60)}`,
				)
				.join("\n");
			return successToolResult(`${rows.length} experiment(s):\n\n${text}`);
		},
	});

	// -------------------------------------------------------------------------
	// Tool: experiment_compare
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "experiment_compare",
		label: "Experiment Compare",
		description: "Side-by-side diff of two experiments' benchmarks, tests, and diff stats.",
		parameters: CompareParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const a = getExperimentRow(ctx.cwd, params.exp_id_1);
			const b = getExperimentRow(ctx.cwd, params.exp_id_2);
			if (!a) return errorToolResult(`Unknown experiment: ${params.exp_id_1}`);
			if (!b) return errorToolResult(`Unknown experiment: ${params.exp_id_2}`);
			const axes = params.axes ?? Object.keys({ ...a.result.benchmarks, ...b.result.benchmarks });
			const lines: string[] = [];
			for (const axis of axes) {
				const av = a.result.benchmarks?.[axis];
				const bv = b.result.benchmarks?.[axis];
				if (typeof av !== "number" || typeof bv !== "number") continue;
				const winner = av < bv ? a.approach : b.approach;
				lines.push(`${axis}:  ${a.approach}=${av}  vs  ${b.approach}=${bv}  ->  winner=${winner}`);
			}
			const text =
				`Comparing ${a.approach} (${a.id}) vs ${b.approach} (${b.id})\n\n` +
				`hypotheses:\n  A: ${a.hypothesis}\n  B: ${b.hypothesis}\n\n` +
				`tests: A=${a.result.testPassed ?? "?"}P/${a.result.testFailed ?? "?"}F  ` +
				`B=${b.result.testPassed ?? "?"}P/${b.result.testFailed ?? "?"}F\n\n` +
				(lines.length > 0 ? `benchmarks:\n${lines.join("\n")}\n` : "(no comparable benchmarks)\n");
			return successToolResult(text);
		},
	});
}

async function finalizeExperimentMerge(
	ctx: ExtensionContext,
	row: ExperimentRow,
	strategy: "cherry-pick" | "squash" | "merge",
	newCommit: string | undefined,
): Promise<void> {
	const logFile = experimentLogPath(ctx.cwd, row.id);
	appendExperimentLogEvent(logFile, { type: "MERGED", strategy, commit: newCommit });
	try {
		await removeWorktree(ctx.cwd, row.worktreePath, true);
	} catch {
		/* removal may fail on Windows; leave it for the user to clean up */
	}
	updateExperiment(ctx.cwd, row.id, {
		status: "merged",
		merged: true,
		mergeStrategy: strategy,
		mergeCommit: newCommit,
	});
	ctx.ui.setStatus("experiments", undefined);
	refreshStatusPill(ctx, ctx.cwd, false);
}

export default function (pi: ExtensionAPI) {
	registerExperimentalMode(pi);

	const backgroundRegistry = getBackgroundRegistry();

	pi.on("session_start", async () => {
		const crashedCount = await backgroundRegistry.markAllRunningAsCrashed();
		const pruned = await backgroundRegistry.prune();
		if (crashedCount > 0) {
			backgroundRegistry.appendLog("__system__", {
				type: "RECOVERED",
				count: crashedCount,
				at: new Date().toISOString(),
			});
		}
		if (pruned > 0) {
			backgroundRegistry.appendLog("__system__", { type: "PRUNED", count: pruned });
		}
	});

	pi.on("session_shutdown", async () => {
		const runningTasks = backgroundRegistry.listRunning();
		for (const t of runningTasks) {
			await backgroundRegistry.cancel(t.id, "Parent session ended");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const tasks = backgroundRegistry.snapshot().tasks;
		const runningCount = tasks.filter((t) => t.status === "running" || t.status === "pending").length;
		const totalCount = tasks.length;
		refreshBackgroundPill(ctx, runningCount, totalCount);
		const injection = buildStatusInjection(tasks);
		if (!injection) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
	});

	pi.registerCommand("tasks", {
		description: "Show the background-task dashboard (subagent background mode).",
		handler: async (_args, ctx) => {
			const tasks = backgroundRegistry.snapshot().tasks;
			if (tasks.length === 0) {
				ctx.ui.notify("No background tasks. Use `subagent({ background: true, ... })` to start one.", "info");
				return;
			}
			const lines = renderTasksDashboardLines(ctx, tasks);
			if (ctx.mode === "tui") {
				ctx.ui.setWidget("subagent-bg-tasks", lines, { placement: "belowEditor" });
				ctx.ui.notify(`${tasks.length} task(s) shown. Press Esc to close.`, "info");
			} else {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});

	pi.registerShortcut(Key.ctrl("t"), {
		description: "Toggle the background-task dashboard.",
		handler: async (ctx) => {
			const tasks = backgroundRegistry.snapshot().tasks;
			if (tasks.length === 0) {
				ctx.ui.notify("No background tasks. Use `subagent({ background: true, ... })` to start one.", "info");
				return;
			}
			const lines = renderTasksDashboardLines(ctx, tasks);
			ctx.ui.setWidget("subagent-bg-tasks", lines, { placement: "belowEditor" });
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			// ----------------------------------------------------------------
			// Background-mode dispatch (fire-and-forget) — placed early so the
			// parent can return immediately with a task ID, regardless of
			// modeCount validity.
			// ----------------------------------------------------------------
			const isBackground = params.background === true;
			const scriptOrTask = params.script?.trim() || params.task?.trim() || "";
			if (isBackground) {
				if (!scriptOrTask) {
					return {
						content: [
							{
								type: "text",
								text: "Background mode requires a non-empty `task` or `script` parameter.",
							},
						],
						details: {
							mode: "single",
							agentScope,
							projectAgentsDir: discovery.projectAgentsDir,
							results: [],
							background: true,
							taskIds: [],
						},
					};
				}
				const hasBgChain = (params.chain?.length ?? 0) > 0;
				const hasBgTasks = (params.tasks?.length ?? 0) > 0;
				const hasBgSingle = Boolean(params.agent);
				const bgModeCount = Number(hasBgChain) + Number(hasBgTasks) + Number(hasBgSingle);
				if (bgModeCount !== 1) {
					return {
						content: [
							{
								type: "text",
								text: "Background mode: provide exactly one of `{ agent }`, `{ tasks }`, or `{ chain }`. Use `/tasks` to monitor after starting.",
							},
						],
						details: {
							mode: "single",
							agentScope,
							projectAgentsDir: discovery.projectAgentsDir,
							results: [],
							background: true,
							taskIds: [],
						},
					};
				}
			}
			if (isBackground && scriptOrTask) {
				const registry = getBackgroundRegistry();
				const taskIds: string[] = [];

				if (params.agent) {
					const { taskId } = fireBackground({
						agentName: params.agent,
						mode: "single",
						scriptOrTask,
						cwd: params.cwd ?? ctx.cwd,
						dispatchDefaults,
						pi,
						registry,
						agentScope,
					});
					taskIds.push(taskId);
				} else if (params.tasks) {
					for (const t of params.tasks) {
						const td = t.task?.trim() ? t.task : scriptOrTask;
						const { taskId } = fireBackground({
							agentName: t.agent,
							mode: "parallel",
							scriptOrTask: td,
							cwd: t.cwd ?? ctx.cwd,
							dispatchDefaults,
							pi,
							registry,
							agentScope,
						});
						taskIds.push(taskId);
					}
				} else if (params.chain) {
					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						const { taskId } = fireBackground({
							agentName: step.agent,
							mode: "chain",
							scriptOrTask: step.task,
							cwd: step.cwd ?? ctx.cwd,
							dispatchDefaults,
							pi,
							registry,
							agentScope,
						});
						taskIds.push(taskId);
					}
				}

				const summary =
					taskIds.length === 1
						? backgroundStartSummary(taskIds[0]!, params.agent ?? "agent", "single")
						: `Started ${taskIds.length} background tasks: ${taskIds.join(", ")}. Use \`/tasks\` or \`Ctrl+T\` to monitor. Results will be injected on the next turn.`;

				return {
					content: [{ type: "text", text: summary }],
					details: {
						mode: params.chain ? "chain" : params.tasks ? "parallel" : "single",
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results: [],
						background: true,
						taskIds,
					},
				};
			}

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
	function renderTasksDashboardLines(
		ctx: { ui: { theme: { fg: (color: ThemeColor, text: string) => string } } },
		tasks: Array<{ id: string; agent: string; status: string; startedAt: string; lastOutput: string }>,
	): string[] {
		const theme = ctx.ui.theme;
		const lines: string[] = [theme.fg("accent", `Background tasks (${tasks.length})`), ""];
		const sorted = [...tasks].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
		for (const t of sorted.slice(0, 30)) {
			const statusColor: ThemeColor =
				t.status === "running"
					? "warning"
					: t.status === "completed"
						? "success"
						: t.status === "failed" || t.status === "crashed"
							? "error"
							: "muted";
			const elapsed = formatElapsedSince(t.startedAt);
			lines.push(
				`${theme.fg(statusColor, `[${t.status}]`)} ${theme.fg("accent", t.agent)} ${theme.fg("muted", `${t.id} · ${elapsed}`)}`,
			);
			const last = (t.lastOutput || "").replace(/[\r\n]+/g, " ").trim();
			if (last) lines.push(`  ${theme.fg("dim", last.slice(0, 100))}`);
		}
		if (tasks.length > 30) {
			lines.push("");
			lines.push(theme.fg("muted", `… and ${tasks.length - 30} more older tasks.`));
		}
		lines.push("");
		lines.push(theme.fg("muted", "[Esc to close]"));
		return lines;
	}

	function formatElapsedSince(iso: string, now: number = Date.now()): string {
		const start = new Date(iso).getTime();
		if (Number.isNaN(start)) return "?";
		const ms = now - start;
		if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
		return `${Math.round(ms / 3_600_000)}h ago`;
	}
}
