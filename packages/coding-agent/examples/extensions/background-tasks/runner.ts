/**
 * Background Task Runner
 *
 * Spawns detached pi subprocesses for background tasks.
 * Each task gets its own log file and registry entry.
 *
 * Uses detached spawn so tasks survive parent process exit.
 * On Windows, uses shell:true and sets windowsHide:true.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendTaskLog, type BackgroundTask, taskDir, updateTask } from "./registry.ts";

const SIGKILL_GRACE_MS = 5_000;

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

export interface SpawnTaskOptions {
	name: string;
	role: string;
	objective: string;
	model?: string;
	thinkingLevel?: string;
	allowedTools?: string[];
	contextQuery?: string;
	cwd: string;
	baseDir: string;
	timeoutMs?: number;
	systemPrompt?: string;
}

export interface SpawnedTask {
	task: BackgroundTask;
	proc: ReturnType<typeof spawn>;
}

export function spawnBackgroundTask(opts: SpawnTaskOptions): SpawnedTask {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
	if (opts.allowedTools && opts.allowedTools.length > 0) args.push("--tools", opts.allowedTools.join(","));

	// Build task prompt with role and objective
	const taskPrompt = buildTaskPrompt(opts);

	let tmpPromptPath: string | null = null;
	if (opts.systemPrompt || taskPrompt) {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-task-"));
		tmpPromptPath = path.join(tmpDir, "task-prompt.md");
		fs.writeFileSync(tmpPromptPath, taskPrompt, { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", tmpPromptPath);
	}

	args.push(`Task: ${opts.objective}`);

	const invocation = getPiInvocation(args);
	const isWindows = process.platform === "win32";

	const proc = spawn(invocation.command, invocation.args, {
		cwd: opts.cwd,
		shell: isWindows,
		detached: !isWindows, // Windows doesn't support detached well
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: isWindows,
		env: {
			...process.env,
			PI_BACKGROUND_TASK: "1",
			PI_BACKGROUND_TASK_ROLE: opts.role,
		},
	});

	const task: BackgroundTask = {
		id: opts.name,
		name: opts.name,
		role: opts.role,
		objective: opts.objective,
		status: "running",
		pid: proc.pid ?? undefined,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		command: invocation.command,
		args: invocation.args,
		cwd: opts.cwd,
		model: opts.model,
		allowedTools: opts.allowedTools,
		contextQuery: opts.contextQuery,
		outputPath: taskDir(opts.baseDir, opts.name),
	};

	// Stream output to log
	let stdoutBuffer = "";
	let stderrBuffer = "";

	proc.stdout?.on("data", (data: Buffer) => {
		const chunk = data.toString();
		stdoutBuffer += chunk;
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() ?? "";
		for (const line of lines) {
			appendTaskLog(opts.baseDir, opts.name, { type: "STDOUT", line });
			// Try to extract last assistant output for status
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const text = event.message.content?.find((c: any) => c.type === "text")?.text;
					if (text) {
						updateTask(opts.baseDir, opts.name, { lastOutput: text.slice(0, 500) });
					}
				}
			} catch {
				/* not json, ignore */
			}
		}
	});

	proc.stderr?.on("data", (data: Buffer) => {
		const chunk = data.toString();
		stderrBuffer += chunk;
		appendTaskLog(opts.baseDir, opts.name, { type: "STDERR", line: chunk });
	});

	proc.on("close", (code, signal) => {
		// Flush remaining buffer
		if (stdoutBuffer) appendTaskLog(opts.baseDir, opts.name, { type: "STDOUT", line: stdoutBuffer });
		if (stderrBuffer) appendTaskLog(opts.baseDir, opts.name, { type: "STDERR", line: stderrBuffer });

		const finalStatus =
			signal === "SIGTERM" || signal === "SIGKILL" ? "cancelled" : code === 0 ? "completed" : "failed";
		updateTask(opts.baseDir, opts.name, {
			status: finalStatus,
			exitCode: code,
			completedAt: new Date().toISOString(),
		});

		// Cleanup temp file
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
			try {
				fs.rmdirSync(path.dirname(tmpPromptPath));
			} catch {
				/* ignore */
			}
		}
	});

	proc.on("error", (err) => {
		updateTask(opts.baseDir, opts.name, {
			status: "failed",
			errorMessage: err.message,
			completedAt: new Date().toISOString(),
		});
	});

	return { task, proc };
}

function buildTaskPrompt(opts: SpawnTaskOptions): string {
	const parts: string[] = [];

	parts.push(`# Role: ${opts.role}`);
	parts.push("");
	parts.push(`## Objective`);
	parts.push(opts.objective);
	parts.push("");

	if (opts.contextQuery) {
		parts.push(`## Context`);
		parts.push(opts.contextQuery);
		parts.push("");
	}

	if (opts.allowedTools && opts.allowedTools.length > 0) {
		parts.push(`## Available Tools`);
		parts.push(`You may ONLY use these tools: ${opts.allowedTools.join(", ")}.`);
		parts.push("");
	}

	parts.push(`## Rules`);
	parts.push("- You are a background task. Work independently and report findings concisely.");
	parts.push("- Do not ask the user questions. Make decisions autonomously within your scope.");
	parts.push("- When complete, summarize your results clearly.");

	if (opts.systemPrompt) {
		parts.push("");
		parts.push(`## Additional Instructions`);
		parts.push(opts.systemPrompt);
	}

	return parts.join("\n");
}

export function cancelTask(proc: ReturnType<typeof spawn>, baseDir: string, taskId: string): void {
	if (!proc.killed) {
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (!proc.killed) {
				proc.kill("SIGKILL");
			}
		}, SIGKILL_GRACE_MS);
	}
	updateTask(baseDir, taskId, { status: "cancelled", completedAt: new Date().toISOString() });
}
