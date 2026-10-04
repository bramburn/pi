/**
 * Shell helpers for the native subagent capability. Bun only.
 *
 * Two backends, split by what the caller actually needs. Every claim below was
 * verified by running Bun 1.4 locally, because the intuitive answers were wrong
 * in both directions.
 *
 * `Bun.$` — used when no timeout or abort is requested:
 * - Streams stay separate: `.quiet().nothrow()` returns
 *   `{ stdout, stderr, exitCode }`.
 * - `.quiet()` and `.nothrow()` are both required and compose in either order.
 *   `.quiet()` alone still rejects with `ShellError` on a non-zero exit;
 *   `.nothrow()` alone still leaks the child's stdout to the parent terminal.
 * - `$\`${[cmd, ...args]}\`` spreads and escapes correctly. Verified: an argument
 *   of `"a b"` and one of `"c;echo injected"` both arrive as single argv
 *   elements with no injection.
 * - `$.cwd(dir)` works.
 *
 * `Bun.spawn` — used whenever a timeout or an abort signal is supplied:
 * - `$.timeout` is `undefined`, so `$` has no timeout at all.
 * - `$` exposes no pid, so nothing can be signalled: no tree kill, no cancel.
 * - `$` hangs on a pipe held open by a surviving grandchild *and* yields no
 *   partial output. `Bun.spawn` plus `collectStream` returns partial output in
 *   bounded time instead.
 *
 * `runShellLine` always takes the spawn path. A dynamic command line cannot be
 * expressed in `Bun.$` at all: `$\`${"echo dynamic-line-works"}\`` fails with
 * `command not found`, because an interpolated value is escaped into a single
 * quoted word. A line with pipes, redirects or quoting is shell source, and
 * `$` has no unescaped-entry point for one.
 *
 * `node:path` and `node:os` are imported elsewhere in this module because Bun
 * implements them and there is no replacement; that is not a Node fallback.
 */

import { killProcessTree } from "../../utils/shell.ts";
import { type BunShell, type BunShellCommand, getBun } from "./runtime.ts";
import { collectStream } from "./stream.ts";

export interface ShellResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	cancelled: boolean;
	/** False when a surviving grandchild held the pipe and the read was cut short. */
	complete: boolean;
}

export interface ShellOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: Record<string, string | undefined>;
	/** Run through the platform shell instead of exec'ing directly. */
	shell?: boolean;
	/** Observe output chunks as they arrive (spawn path). Used for live logging. */
	onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

const decoder = new TextDecoder();

/** A command that can outlive a `Bun.$` call must not go through `$`. */
function requiresSpawn(options: ShellOptions): boolean {
	return options.timeoutMs !== undefined || options.signal !== undefined;
}

/** Run a command with arguments. Never rejects for a non-zero exit. */
export function runShell(command: string, args: string[], options: ShellOptions): Promise<ShellResult> {
	if (options.shell === true || requiresSpawn(options)) {
		return execute(resolveArgv(command, args, options.shell === true), options);
	}
	// The whole argv is interpolated as one array so Bun escapes and spreads it:
	// an argument containing spaces or a semicolon stays a single argv element.
	return executeDollar((shell) => shell`${[command, ...args]}`, options);
}

/**
 * Run a command line through the platform shell (`shell: true` semantics).
 *
 * Always the spawn path — see the header for why `Bun.$` cannot express a
 * dynamic command line.
 */
export function runShellLine(commandLine: string, options: ShellOptions): Promise<ShellResult> {
	return runShell(commandLine, [], { ...options, shell: true });
}

/** Run `git` with the given arguments. Convenience over `runShell`. */
export function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<ShellResult> {
	const options: ShellOptions = { cwd };
	if (signal) options.signal = signal;
	return runShell("git", args, options);
}

/**
 * Execute through `Bun.$`.
 *
 * The command is built by a callback so the cwd-scoped shell is only created on
 * this path. `.quiet()` and `.nothrow()` are both applied: quiet stops the
 * child's stdout from reaching the parent terminal, nothrow stops a non-zero
 * exit from rejecting. Order does not matter, but both are required.
 */
async function executeDollar(build: (shell: BunShell) => BunShellCommand, options: ShellOptions): Promise<ShellResult> {
	const started = Date.now();
	const bun = getBun();
	const shell = options.cwd ? bun.$.cwd(options.cwd) : bun.$;
	let command = build(shell);
	if (options.env) {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(options.env)) {
			if (value !== undefined) env[key] = value;
		}
		command = command.env(env);
	}
	const result = await command.quiet().nothrow();
	return {
		exitCode: result.exitCode,
		stdout: decoder.decode(result.stdout),
		stderr: decoder.decode(result.stderr),
		durationMs: Date.now() - started,
		timedOut: false,
		cancelled: false,
		complete: true,
	};
}

function resolveArgv(command: string, args: string[], shell: boolean): string[] {
	if (!shell) return [command, ...args];
	return process.platform === "win32" ? ["cmd.exe", "/c", command] : ["/bin/sh", "-c", command];
}

async function execute(argv: string[], options: ShellOptions): Promise<ShellResult> {
	const started = Date.now();
	const proc = getBun().spawn(argv, {
		cwd: options.cwd,
		env: options.env ?? { ...process.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	let cancelled = false;
	let killed = false;
	// Kill the whole tree when we have a pid: a shell command's real work is
	// usually a grandchild, and signalling only the direct child orphans it.
	const kill = () => {
		if (killed) return;
		killed = true;
		if (proc.pid !== undefined) killProcessTree(proc.pid);
		else proc.kill("SIGTERM");
	};
	const onAbort = () => {
		cancelled = true;
		kill();
	};
	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					kill();
				}, options.timeoutMs);

	// Pump both pipes concurrently with the wait, so a chatty child can never
	// fill its pipe buffer and deadlock against `exited`.
	const onOutput = options.onOutput;
	const [out, err] = await Promise.all([
		collectStream(proc.stdout, undefined, onOutput ? (chunk) => onOutput("stdout", chunk) : undefined),
		collectStream(proc.stderr, undefined, onOutput ? (chunk) => onOutput("stderr", chunk) : undefined),
	]);
	const exitCode = await proc.exited;

	if (timer) clearTimeout(timer);
	options.signal?.removeEventListener("abort", onAbort);
	return {
		exitCode: exitCode ?? 0,
		stdout: out.text,
		stderr: err.text,
		durationMs: Date.now() - started,
		timedOut,
		cancelled,
		complete: out.complete && err.complete,
	};
}
