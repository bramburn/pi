/**
 * Runner — spawn + stream for experiment_run and friends.
 *
 * Output streams to <repo>/.pi-experiments/<id>/log.jsonl (append-only,
 * one JSON message per line, capped at 1 MB per line). stdout/stderr
 * from the subprocess is also returned to the caller for direct display.
 *
 * TODO (Phase 2): upgrade to Bun.spawn({ ipc: true }) if structured
 * message passing is needed. For now we follow the existing subagent
 * extension's child_process + line-buffered pattern.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logPath } from "./registry.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SIGKILL_GRACE_MS = 5_000;
const MAX_LINE_BYTES = 1_000_000;

export interface RunCommandOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** When provided, output is also appended to this per-experiment log file. */
	experimentLogPath?: string;
}

export interface RunCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	truncated: boolean;
	timedOut: boolean;
	cancelled: boolean;
}

export function ensureLogFile(path: string): void {
	if (existsSync(path)) return;
	const dir = join(path, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, "", "utf-8");
}

function appendLogLine(path: string | undefined, line: string): void {
	if (!path) return;
	const capped = line.length > MAX_LINE_BYTES ? `${line.slice(0, MAX_LINE_BYTES)}\n... [truncated]` : line;
	try {
		appendFileSync(path, capped.endsWith("\n") ? capped : `${capped}\n`, "utf-8");
	} catch {
		/* log is best-effort; do not let logging fail the run */
	}
}

/**
 * Spawn a single shell command, capture stdout/stderr, respect timeout and signal.
 */
export function runCommand(command: string, opts: RunCommandOptions): Promise<RunCommandResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const start = Date.now();

	return new Promise((resolve) => {
		const proc = spawn(command, {
			cwd: opts.cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timedOut = false;
		let cancelled = false;

		const onAbort = (): void => {
			cancelled = true;
			killProc("SIGTERM");
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		const timer = setTimeout(() => {
			timedOut = true;
			killProc("SIGTERM");
		}, timeoutMs);

		function killProc(signal: NodeJS.Signals): void {
			if (killed) return;
			killed = true;
			try {
				proc.kill(signal);
			} catch {
				/* process may already be gone */
			}
			setTimeout(() => {
				if (!proc.killed) {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}
			}, SIGKILL_GRACE_MS);
		}

		proc.stdout?.on("data", (d: Buffer) => {
			const chunk = d.toString();
			stdout += chunk;
			appendLogLine(opts.experimentLogPath, JSON.stringify({ type: "OUTPUT", stream: "stdout", line: chunk }));
		});
		proc.stderr?.on("data", (d: Buffer) => {
			const chunk = d.toString();
			stderr += chunk;
			appendLogLine(opts.experimentLogPath, JSON.stringify({ type: "OUTPUT", stream: "stderr", line: chunk }));
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			stdout += `\n[spawn error: ${err.message}]`;
			resolve({
				exitCode: 1,
				stdout,
				stderr,
				durationMs: Date.now() - start,
				truncated: false,
				timedOut,
				cancelled,
			});
		});

		proc.on("close", (code, signal) => {
			clearTimeout(timer);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			// signal-based termination: report as null exit code + the kill reason
			const exitCode = killed ? null : code;
			if (signal && killed) {
				stderr += `\n[killed by ${signal}]`;
			}
			resolve({
				exitCode,
				stdout,
				stderr,
				durationMs: Date.now() - start,
				truncated: false,
				timedOut,
				cancelled,
			});
		});
	});
}

/**
 * Run a sequence of commands serially. Stops at the first non-zero exit unless
 * `continueOnError` is set.
 */
export async function runCommandSequence(
	commands: string[],
	opts: RunCommandOptions & { continueOnError?: boolean },
): Promise<RunCommandResult[]> {
	const results: RunCommandResult[] = [];
	for (const command of commands) {
		const res = await runCommand(command, opts);
		results.push(res);
		if (res.exitCode !== 0 && !opts.continueOnError) break;
	}
	return results;
}

export function appendLogEvent(experimentLogPath: string, event: Record<string, unknown>): void {
	const line = JSON.stringify({ ...event, at: new Date().toISOString() });
	appendLogLine(experimentLogPath, line);
}

export { logPath };
