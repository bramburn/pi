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
 * read through early stream pumps so a grandchild holding the pipe cannot hang
 * the parent. There is no `node:child_process` fallback: pi is Bun-only, and the
 * tool factory gates registration on `isBunRuntime()` so this runner is never
 * reached elsewhere.
 *
 * `node:path` and `node:os` are still imported. Bun implements both and has no
 * replacement — they are the POSIX path primitives, not Node-only code.
 */

import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { type BunApi, type BunSpawnOptions, getBun } from "./runtime.ts";
import { createKillController, HARD_KILL_EXIT_CODE } from "./shell.ts";
import { createStreamPump } from "./stream.ts";
import {
	createEmptyUsage,
	type SubagentEventListener,
	type SubagentResult,
	type SubagentRunner,
	type SubagentRunRequest,
} from "./types.ts";

const MAX_LOG_LINE_BYTES = 1_000_000;
/** Cap on retained child stderr: head + tail of a possibly huge stream. */
const MAX_STDERR_CHARS = 1_000_000;
const PROMPT_DIR_PREFIX = "pi-subagent-";
/** Exclusive-create attempts before giving up on a private prompt file name. */
const MAX_PROMPT_FILE_ATTEMPTS = 10;

export interface BunProcessRunnerOptions {
	/** Override how the child `pi` is invoked. Defaults to self-re-exec, then `pi` on PATH. */
	resolveInvocation?: (args: string[]) => { command: string; args: string[] };
	/** Bun API override, for tests. Defaults to the real runtime. */
	bun?: BunApi;
	/** Kill escalation grace: graceful SIGTERM → SIGKILL → give up, each after this long. Default 5000ms. */
	killGraceMs?: number;
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
export async function getPiInvocation(args: string[], bun?: BunApi): Promise<{ command: string; args: string[] }> {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && (await (bun ?? getBun()).file(currentScript).exists())) {
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

let promptFileCounter = 0;

/**
 * Write the child's system prompt to a private temp file and pass it via
 * `--append-system-prompt`.
 *
 * The file is created exclusively (`openSync` with `wx` / O_EXCL) at mode
 * 0600: the name is predictable in a shared tmpdir, so without O_EXCL another
 * local user could pre-create a symlink there and read the prompt — or worse,
 * swap its target. O_EXCL fails on any pre-existing name, symlinks included,
 * so the worst an attacker gains is denial-of-service; a collision retries
 * with a fresh name. The content is then written with `Bun.write`, which
 * truncates the file we just created and keeps its 0600 mode (between create
 * and write nobody else can replace the file: the sticky bit on POSIX tmpdirs
 * forbids removing another user's file).
 *
 * A flat temp file, not a per-run temp directory: `Bun.write` creates missing
 * parent directories, and a single file is removed with `Bun.file().delete()`.
 * That avoids a recursive delete, which would need either `node:fs` or a POSIX
 * `rm` that does not exist on Windows.
 */
async function writeInstructionsToTempFile(role: string, instructions: string, bun: BunApi): Promise<string> {
	const safeRole = role.replace(/[^\w.-]+/g, "_");
	for (let attempt = 0; attempt < MAX_PROMPT_FILE_ATTEMPTS; attempt += 1) {
		promptFileCounter += 1;
		const name = `${PROMPT_DIR_PREFIX}${Date.now().toString(36)}-${process.pid}-${promptFileCounter}-${safeRole}.md`;
		const file = join(tmpdir(), name);
		let fd: number;
		try {
			fd = openSync(file, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		closeSync(fd);
		await bun.write(file, instructions);
		return file;
	}
	throw new Error("Could not create an exclusive prompt temp file");
}

async function removePromptFile(file: string | null, bun: BunApi): Promise<void> {
	if (!file) return;
	await bun
		.file(file)
		.delete()
		.catch(() => {});
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
	private readonly bun: BunApi;

	constructor(path: string | undefined, bun: BunApi) {
		this.path = path;
		this.bun = bun;
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
			const existing = await this.bun.file(this.path).exists();
			const previous = existing ? await this.bun.file(this.path).text() : "";
			await this.bun.write(this.path, `${previous}${payload}`);
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
			const bun = options?.bun ?? getBun();
			let promptFile: string | null = null;
			try {
				if (instructions) {
					promptFile = await writeInstructionsToTempFile(request.spec.role, instructions, bun);
				}

				const args = buildChildArgs(request);
				if (promptFile) args.splice(args.length - 1, 0, "--append-system-prompt", promptFile);

				const invocation = options?.resolveInvocation
					? options.resolveInvocation(args)
					: await getPiInvocation(args, bun);

				const childRequest: ChildRequest = {
					command: invocation.command,
					args: invocation.args,
					cwd: request.cwd,
					env: { ...process.env },
					role: request.spec.role,
					timeoutMs: request.timeoutMs,
					killGraceMs: options?.killGraceMs,
					logPath: request.logPath,
				};

				await runChild(childRequest, signal, result, emit, bun);

				return result;
			} finally {
				await removePromptFile(promptFile, bun);
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
	killGraceMs?: number;
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
	// Kill escalation (SIGKILL after a grace) lives inside the KillController;
	// a plain callback here cannot deadhead it the way the old paired
	// `setTimeout(kill, grace)` did against `kill`'s idempotence guard.
	signal.addEventListener("abort", kill, { once: true });
	return () => signal.removeEventListener("abort", kill);
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

/**
 * Bounded text accumulation: keeps the head and tail of a possibly huge
 * stream and marks the cut, so one noisy child cannot grow parent memory
 * without limit.
 */
class BoundedText {
	private head = "";
	private tail = "";
	private overflow = false;
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	append(chunk: string): void {
		const tailRoom = Math.floor(this.limit / 2);
		if (!this.overflow) {
			const room = tailRoom - this.head.length;
			if (chunk.length <= room) {
				this.head += chunk;
				return;
			}
			this.head += chunk.slice(0, Math.max(0, room));
			this.overflow = true;
			this.tail = chunk.slice(Math.max(0, room)).slice(-tailRoom);
			return;
		}
		this.tail = (this.tail + chunk).slice(-tailRoom);
	}

	get text(): string {
		return this.overflow ? `${this.head}\n... [truncated] ...\n${this.tail}` : this.head;
	}
}

async function runChild(
	child: ChildRequest,
	signal: AbortSignal | undefined,
	result: SubagentResult,
	emit: SubagentEventListener,
	bun: BunApi,
): Promise<void> {
	const streams = createChildStreams();
	const parser = new JsonLineParser();
	const log = new EventLog(child.logPath, bun);
	const spawnOptions: BunSpawnOptions = {
		cwd: child.cwd,
		env: child.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// Own process group on POSIX so the tree kill reaches grandchildren
		// (`kill(-pid)` would otherwise ESRCH and orphan them). The Windows
		// residual limitation is documented on createKillController.
		detached: true,
	};
	const proc = bun.spawn([child.command, ...child.args], spawnOptions);
	if (proc.pid) trackDetachedChildPid(proc.pid);
	emit({ type: "spawned", pid: proc.pid });
	log.append({ type: "SPAWN", role: child.role, pid: proc.pid });

	let killed = false;
	let timedOut = false;
	const kills = createKillController(proc, child.killGraceMs);
	const killOnce = () => {
		killed = true;
		kills.killOnce();
	};
	const detachAbort = attachAbort(signal, killOnce);
	const timer = startTimeout(child.timeoutMs, () => {
		timedOut = true;
		killOnce();
	});

	// Parse JSONL as it arrives: a long-running subagent must keep emitting
	// progress, not stay silent until it exits. The pumps run with the child and
	// release only after it is gone, so the drain grace bounds the post-exit
	// wait and never the child's lifetime.
	const stdoutPump = createStreamPump(proc.stdout, (chunk) => {
		parser.push(chunk, (event) => applyJsonEvent(event, streams, emit));
	});
	const stderrBuffer = new BoundedText(MAX_STDERR_CHARS);
	const stderrPump = createStreamPump(proc.stderr, (chunk) => {
		stderrBuffer.append(chunk);
		emit({ type: "stderr", text: chunk });
		log.append({ type: "STDERR", text: chunk });
	});

	// Bounded after a kill: a child that survives even SIGKILL must not hang the
	// run. waitForExit then resolves null and the synthetic exit code plus
	// aborted/timedOut flags carry the outcome.
	const exitCode = await kills.waitForExit();
	clearTimeout(timer);
	detachAbort();
	// Only now do we stop waiting for EOF: a surviving grandchild may still hold
	// the pipe open, and it must not stall the parent after the child is gone.
	await Promise.all([stdoutPump.release(POST_EXIT_DRAIN_GRACE_MS), stderrPump.release(POST_EXIT_DRAIN_GRACE_MS)]);
	// Flush AFTER the drain, not before: a final JSONL line without a trailing
	// newline that completes during the drain window sits in the parser buffer
	// past a pre-release flush, and the run's last event would be dropped.
	parser.flush((event) => applyJsonEvent(event, streams, emit));
	kills.dispose();
	if (proc.pid) untrackDetachedChildPid(proc.pid);

	result.stderr = stderrBuffer.text;
	result.exitCode = exitCode ?? HARD_KILL_EXIT_CODE;
	finishResult(result, streams, killed, timedOut, child.timeoutMs);
	const signalName = killed ? "SIGTERM" : null;
	emit({ type: "exit", exitCode, signal: signalName });
	log.append({ type: "EXIT", exitCode, killed });
	await log.flush();
}
