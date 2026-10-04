/**
 * Subprocess runner for the native subagent capability. Bun only.
 *
 * Decision (plan Q0/Q1, step 1.2): the child is a separate `pi` process in JSON
 * mode, and the parent talks to it over JSONL on stdout. IPC is deliberately
 * NOT used. `Bun.spawn({ ipc })` needs the child to opt into the channel, and
 * the child entry point is not guaranteed to be the same build as the parent,
 * so a typed channel would fail at runtime rather than at compile time.
 * JSONL-on-stdout is what the reference extension already proved.
 *
 * `Bun.spawn` starts faster than `node:child_process` (which matters at 4
 * concurrent children) and exposes stdout as a web `ReadableStream`, which is
 * read through `collectStream` so a grandchild holding the pipe cannot hang the
 * parent. There is no `node:child_process` fallback: pi is Bun-only, and the
 * tool factory gates registration on `isBunRuntime()` so this runner is never
 * reached elsewhere.
 *
 * `node:path` and `node:os` are still imported. Bun implements both and has no
 * replacement — they are the POSIX path primitives, not Node-only code.
 */

import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { endSubagentTask, newTaskSpanId, startSubagentTask } from "../analytics-store.ts";
import { type BunApi, getBun } from "./runtime.ts";
import { createStreamPump } from "./stream.ts";
import {
	createEmptyUsage,
	type SubagentEventListener,
	type SubagentResult,
	type SubagentRunner,
	type SubagentRunRequest,
} from "./types.ts";

const MAX_LOG_LINE_BYTES = 1_000_000;
const SIGKILL_GRACE_MS = 5_000;
const PROMPT_DIR_PREFIX = "pi-subagent-";

export interface BunProcessRunnerOptions {
	/**
	 * Record a `pi_subagent_tasks` span per run. The tool factory passes the
	 * session's analytics-enabled state; the runner does not detect it itself.
	 */
	analyticsEnabled?: boolean;
	/** Override how the child `pi` is invoked. Defaults to self-re-exec, then `pi` on PATH. */
	resolveInvocation?: (args: string[]) => { command: string; args: string[] };
}

// ============================================================================
// Child invocation
// ============================================================================

/**
 * Resolve how to launch the child `pi`.
 *
 * A compiled Bun binary re-spawns itself via `process.execPath`; running from
 * source re-runs the current script; otherwise fall back to `pi` on PATH.
 */
export async function getPiInvocation(args: string[]): Promise<{ command: string; args: string[] }> {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && (await getBun().file(currentScript).exists())) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function buildChildArgs(request: SubagentRunRequest): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];
	// A spec that pins a model does not inherit the parent's thinking level: the
	// two belong together and mixing them is surprising.
	const model = request.spec.model ?? request.parentModel;
	if (model) args.push("--model", model);
	if (!request.spec.model && request.parentThinkingLevel) {
		args.push("--thinking", request.parentThinkingLevel);
	}
	if (request.spec.tools && request.spec.tools.length > 0) {
		args.push("--tools", request.spec.tools.join(","));
	}
	args.push(request.task);
	return args;
}

// ============================================================================
// Prompt file (the child's system prompt)
// ============================================================================

/**
 * Write the child's system prompt to a private temp file and pass it via
 * `--append-system-prompt`.
 *
 * `Bun.write` creates the parent directories itself, so no mkdir step is
 * needed. The prompt is written into a fresh `mkdtemp`-style directory so a
 * crashed run cannot leak a file that a later run would pick up.
 */
async function writeInstructionsToTempFile(role: string, instructions: string): Promise<{ dir: string; file: string }> {
	const bun = getBun();
	const dir = join(tmpdir(), `${PROMPT_DIR_PREFIX}${Date.now().toString(36)}-${process.pid}`);
	const safeRole = role.replace(/[^\w.-]+/g, "_");
	const file = join(dir, `prompt-${safeRole}.md`);
	await bun.write(file, instructions);
	return { dir, file };
}

async function removePromptFile(dir: string | null, file: string | null): Promise<void> {
	const bun = getBun();
	if (file)
		await bun
			.file(file)
			.delete()
			.catch(() => {});
	if (dir) await bun.$`rm -rf ${dir}`.quiet().catch(() => {});
}

// ============================================================================
// Event log
// ============================================================================

/**
 * Append-only JSONL event log, buffered in memory and flushed once per run.
 *
 * Buffering replaces the per-event `appendFileSync` of the reference
 * extension: a subagent run emits a handful of events, so one write at exit is
 * both cheaper and immune to a partially-flushed tail if the parent dies. A
 * run killed mid-flight loses its log tail, which is acceptable for a
 * best-effort diagnostic.
 */
class EventLog {
	private lines: string[] = [];
	private readonly path: string | undefined;

	constructor(path: string | undefined) {
		this.path = path;
	}

	append(event: Record<string, unknown>): void {
		if (!this.path) return;
		const line = JSON.stringify({ ...event, at: new Date().toISOString() });
		this.lines.push(line.length > MAX_LOG_LINE_BYTES ? `${line.slice(0, MAX_LOG_LINE_BYTES)}... [truncated]` : line);
	}

	async flush(): Promise<void> {
		if (!this.path || this.lines.length === 0) return;
		const payload = `${this.lines.join("\n")}\n`;
		this.lines = [];
		try {
			const existing = await getBun().file(this.path).exists();
			const previous = existing ? await getBun().file(this.path).text() : "";
			await getBun().write(this.path, `${previous}${payload}`);
		} catch {
			/* logging is best-effort and must never fail a run */
		}
	}
}

// ============================================================================
// Output parsing
// ============================================================================

/** Splits a byte stream into newline-delimited JSON objects, tolerating partial lines. */
class JsonLineParser {
	private buffer = "";

	push(chunk: string, onEvent: (event: Record<string, unknown>) => void): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.consume(line, onEvent);
	}

	flush(onEvent: (event: Record<string, unknown>) => void): void {
		if (this.buffer.trim()) this.consume(this.buffer, onEvent);
		this.buffer = "";
	}

	private consume(line: string, onEvent: (event: Record<string, unknown>) => void): void {
		if (!line.trim()) return;
		try {
			onEvent(JSON.parse(line) as Record<string, unknown>);
		} catch {
			/* non-JSON noise on stdout is ignored */
		}
	}
}

// ============================================================================
// Runner
// ============================================================================

export function createBunProcessRunner(options?: BunProcessRunnerOptions): SubagentRunner {
	const analyticsEnabled = options?.analyticsEnabled ?? false;

	return {
		async run(request, signal, onEvent): Promise<SubagentResult> {
			const emit: SubagentEventListener = onEvent ?? (() => {});
			const result: SubagentResult = {
				role: request.spec.role,
				task: request.task,
				exitCode: 0,
				aborted: false,
				finalOutput: "",
				stderr: "",
				usage: createEmptyUsage(),
				step: request.step,
				messages: [],
			};

			const instructions = request.spec.instructions.trim();
			let promptDir: string | null = null;
			let promptFile: string | null = null;
			try {
				if (instructions) {
					const written = await writeInstructionsToTempFile(request.spec.role, instructions);
					promptDir = written.dir;
					promptFile = written.file;
				}

				const args = buildChildArgs(request);
				if (promptFile) args.splice(args.length - 1, 0, "--append-system-prompt", promptFile);

				const invocation = options?.resolveInvocation
					? options.resolveInvocation(args)
					: await getPiInvocation(args);

				const spanId = analyticsEnabled ? newTaskSpanId() : undefined;
				if (spanId) {
					startSubagentTask({ spanId, agentName: request.spec.role, taskLabel: request.task.slice(0, 200) });
				}

				const childRequest: ChildRequest = {
					command: invocation.command,
					args: invocation.args,
					cwd: request.cwd,
					env: { ...process.env },
					role: request.spec.role,
					timeoutMs: request.timeoutMs,
					logPath: request.logPath,
				};

				const bun = getBun();
				await runChild(childRequest, signal, result, emit, bun);

				if (spanId) {
					const success = !result.aborted && result.exitCode === 0 && result.stopReason !== "error";
					endSubagentTask(spanId, success, success ? undefined : result.errorMessage);
				}
				return result;
			} finally {
				await removePromptFile(promptDir, promptFile);
			}
		},
	};
}

interface ChildRequest {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	role: string;
	timeoutMs?: number;
	logPath?: string;
}

interface ChildStreams {
	messages: Message[];
	finalOutput: string;
	usage: ReturnType<typeof createEmptyUsage>;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

function createChildStreams(): ChildStreams {
	return { messages: [], finalOutput: "", usage: createEmptyUsage() };
}

function applyJsonEvent(event: Record<string, unknown>, streams: ChildStreams, emit: SubagentEventListener): void {
	const type = event.type;
	if (type !== "message_end" && type !== "tool_result_end") return;
	const message = event.message as Message | undefined;
	if (!message) return;

	streams.messages.push(message);
	if (type === "message_end") {
		applyAssistantMessage(message, streams);
		emit({ type: "message_end", message });
	} else {
		emit({ type: "tool_result_end", message });
	}
}

function applyAssistantMessage(message: Message, streams: ChildStreams): void {
	if (message.role !== "assistant") return;
	streams.usage.turns += 1;
	const usage = message.usage;
	if (usage) {
		streams.usage.input += usage.input ?? 0;
		streams.usage.output += usage.output ?? 0;
		streams.usage.cacheRead += usage.cacheRead ?? 0;
		streams.usage.cacheWrite += usage.cacheWrite ?? 0;
		streams.usage.cost += usage.cost?.total ?? 0;
		streams.usage.contextTokens = usage.totalTokens ?? 0;
	}
	if (!streams.model && message.model) streams.model = message.model;
	if (message.stopReason) streams.stopReason = message.stopReason;
	if (message.errorMessage) streams.errorMessage = message.errorMessage;
	for (const part of message.content) {
		if (part.type === "text") streams.finalOutput = part.text;
	}
}

function finishResult(
	result: SubagentResult,
	streams: ChildStreams,
	killed: boolean,
	timedOut: boolean,
	timeoutMs: number | undefined,
): void {
	result.messages = streams.messages;
	result.finalOutput = streams.finalOutput;
	result.usage = streams.usage;
	result.model = streams.model;
	result.stopReason = streams.stopReason;
	if (streams.errorMessage) result.errorMessage = streams.errorMessage;
	if (timedOut) {
		result.aborted = true;
		result.errorMessage = `Subagent timed out after ${timeoutMs}ms`;
	}
	if (killed && !timedOut) result.aborted = true;
}

/** Attach the caller's AbortSignal to a kill callback. Returns a detach function. */
function attachAbort(signal: AbortSignal | undefined, kill: () => void): () => void {
	if (!signal) return () => {};
	if (signal.aborted) {
		kill();
		return () => {};
	}
	const onAbort = () => {
		kill();
		setTimeout(kill, SIGKILL_GRACE_MS);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

function startTimeout(timeoutMs: number | undefined, kill: () => void): NodeJS.Timeout | undefined {
	if (timeoutMs === undefined) return undefined;
	const timer = setTimeout(kill, timeoutMs);
	// Do not hold the event loop open just for the kill timer.
	timer.unref?.();
	return timer;
}

/** Grace period for reading a pipe after the child has already exited. */
const POST_EXIT_DRAIN_GRACE_MS = 500;

async function runChild(
	child: ChildRequest,
	signal: AbortSignal | undefined,
	result: SubagentResult,
	emit: SubagentEventListener,
	bun: BunApi,
): Promise<void> {
	const streams = createChildStreams();
	const parser = new JsonLineParser();
	const log = new EventLog(child.logPath);
	const proc = bun.spawn([child.command, ...child.args], {
		cwd: child.cwd,
		env: child.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.pid) trackDetachedChildPid(proc.pid);
	emit({ type: "spawned", pid: proc.pid });
	log.append({ type: "SPAWN", role: child.role, pid: proc.pid });

	let killed = false;
	let timedOut = false;
	const kill = () => {
		if (killed) return;
		killed = true;
		// The child runs its own tools, so its real descendants are grandchildren.
		// Signal the whole tree when we can address it.
		if (proc.pid !== undefined) killProcessTree(proc.pid);
		else proc.kill("SIGTERM");
	};
	const detachAbort = attachAbort(signal, kill);
	const timer = startTimeout(child.timeoutMs, () => {
		timedOut = true;
		kill();
	});

	// Parse JSONL as it arrives: a long-running subagent must keep emitting
	// progress, not stay silent until it exits.
	const stdoutPump = createStreamPump(proc.stdout, (chunk) => {
		parser.push(chunk, (event) => applyJsonEvent(event, streams, emit));
	});
	let stderr = "";
	const stderrPump = createStreamPump(proc.stderr, (chunk) => {
		stderr += chunk;
		emit({ type: "stderr", text: chunk });
		log.append({ type: "STDERR", text: chunk });
	});

	const exitCode = await proc.exited;
	clearTimeout(timer);
	detachAbort();
	parser.flush((event) => applyJsonEvent(event, streams, emit));
	// Only now do we stop waiting for EOF: a surviving grandchild may still hold
	// the pipe open, and it must not stall the parent after the child is gone.
	await Promise.all([stdoutPump.release(POST_EXIT_DRAIN_GRACE_MS), stderrPump.release(POST_EXIT_DRAIN_GRACE_MS)]);
	if (proc.pid) untrackDetachedChildPid(proc.pid);

	result.stderr = stderr;
	result.exitCode = exitCode ?? 0;
	finishResult(result, streams, killed, timedOut, child.timeoutMs);
	const signalName = killed ? "SIGTERM" : null;
	emit({ type: "exit", exitCode, signal: signalName });
	log.append({ type: "EXIT", exitCode, killed });
	await log.flush();
}
