/**
 * Shell helpers for the native subagent capability. Bun only.
 *
 * What the Bun docs and a local probe actually establish, since both were
 * contrary to the first draft of this file:
 *
 * - `Bun.$` does NOT merge stdout and stderr. `await $\`...\`.quiet()` returns
 *   `{ stdout, stderr, exitCode }` with the streams kept apart, and interpolated
 *   values are escaped (a value containing `"; echo pwned"` arrives as a single
 *   argv entry). It also does not need `.nothrow()` to avoid throwing — that is
 *   what `.quiet()` is for.
 * - The real `Bun.$` hazard is stdio inheritance: a `$` call with no output
 *   modifier writes the child's stdout straight to the parent's terminal. Every
 *   call here uses `.quiet()`.
 * - `Bun.spawn` has no `shell` option, so shell mode is spelled out as the shell
 *   binary in the argv array. `Bun.$` is the better tool when interpolating
 *   values, but nothing in this module interpolates: `runShellLine` takes a
 *   caller-authored command line, and `runShell` passes argv directly. So
 *   `Bun.spawn` is used for both and skips a shell hop.
 *
 * Stream reads go through `collectStream` because a command that leaves a
 * background grandchild holding the pipe would otherwise hang the caller
 * forever. See `stream.ts`.
 *
 * `node:path`-style helpers are imported elsewhere in this module because Bun
 * implements them and has no replacement; that is not a Node fallback.
 */

import { killProcessTree } from "../../utils/shell.ts";
import { getBun } from "./runtime.ts";
import { collectStream } from "./stream.ts";

export interface ShellResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	cancelled: boolean;
	/** False when a grandchild kept the pipe open and the read was cut short. */
	complete: boolean;
}

export interface ShellOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: Record<string, string | undefined>;
	/** Run the command through the platform shell instead of exec'ing directly. */
	shell?: boolean;
}

/** Run a command with arguments (no shell interpretation). Never rejects for a non-zero exit. */
export function runShell(command: string, args: string[], options: ShellOptions): Promise<ShellResult> {
	return execute(resolveArgv(command, args, options.shell === true), options);
}

/** Run a command line through the platform shell (`shell: true` semantics). */
export function runShellLine(commandLine: string, options: ShellOptions): Promise<ShellResult> {
	return runShell(commandLine, [], { ...options, shell: true });
}

/** Run `git` with the given arguments. Convenience over `runShell`. */
export function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<ShellResult> {
	return runShell("git", args, { cwd, signal });
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
	// often a grandchild, and signalling only the direct child orphans it.
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
	const [out, err] = await Promise.all([collectStream(proc.stdout), collectStream(proc.stderr)]);
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
