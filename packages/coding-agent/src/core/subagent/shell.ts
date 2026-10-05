/**
 * Shell helpers for the native subagent capability. Bun only.
 *
 * Two backends, split by what the caller actually needs. Every claim below was
 * verified by running Bun 1.4.x locally, because the intuitive answers were
 * wrong in both directions.
 *
 * `Bun.$` — used when no timeout or abort is requested:
 * - Streams stay separate: `.quiet().nothrow()` returns
 * `{ stdout, stderr, exitCode }`.
 * - `.quiet()` and `.nothrow()` are both required and compose in either order.
 * `.quiet()` alone still rejects with `ShellError` on a non-zero exit;
 * `.nothrow()` alone still leaks the child's stdout to the parent terminal.
 * - `$\`${[cmd, ...args]}\`` spreads and escapes correctly. Verified: an argument
 * of `"a b"` and one of `"c;echo injected"` both arrive as single argv
 * elements with no injection.
 * - `$.cwd(dir)` works.
 * - `command.env(vars)` REPLACES the child's environment instead of merging
 * (verified: an inherited variable disappears from the child as soon as
 * `.env()` is used). This module therefore always passes the full merged
 * environment, so `ShellOptions.env` behaves the same on both backends.
 * - The command object has no `stdin()` (verified against its method list), so
 * the `$` path inherits the parent's stdin. Only short, non-interactive
 * commands without a timeout or abort signal take this path; `Bun.spawn`,
 * which can ignore stdin, handles everything else.
 *
 * `Bun.spawn` — used whenever a timeout or an abort signal is supplied:
 * - `$.timeout` is `undefined`, so `$` has no timeout at all.
 * - `$` exposes no pid, so nothing can be signalled: no tree kill, no cancel.
 * - `$` hangs on a pipe held open by a surviving grandchild *and* yields no
 * partial output. `Bun.spawn` plus early stream pumps returns partial output
 * in bounded time instead.
 * - The child is spawned `detached: true` so it leads its own process group on
 * POSIX and `killProcessTree`'s `kill(-pid)` reaches the whole tree instead of
 * failing with ESRCH and orphaning grandchildren. Verified under Bun on
 * Windows: the option is accepted and argv, pipes and kill behave as without
 * it. Windows residual limitation: `taskkill /F /T` walks the tree only
 * through a live direct child, so grandchildren that outlive the direct child
 * are orphaned; there is no spawn-side fix for that.
 *
 * Environment: `ShellOptions.env` is MERGED over the inherited environment on
 * both backends. `undefined` values leave the inherited setting alone;
 * unsetting a variable is not supported.
 *
 * `runShellLine` always takes the spawn path. A dynamic command line cannot be
 * expressed in `Bun.$` at all: `$\`${"echo dynamic-line-works"}\`` fails with
 * `command not found`, because an interpolated value is escaped into a single
 * quoted word. A line with pipes, redirects or quoting is shell source, and
 * `$` has no unescaped-entry point for one. For the same reason
 * `runShell(command, args, { shell: true })` rejects a non-empty `args`
 * instead of appending it: appending would need per-platform quoting
 * (`cmd.exe` vs `/bin/sh`) — exactly the injection surface this module avoids.
 * Compose the full line yourself and pass it to `runShellLine`.
 *
 * `node:path` and `node:os` are imported elsewhere in this module because Bun
 * implements them and there is no replacement; that is not a Node fallback.
 */

import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import {
	type BunApi,
	type BunShell,
	type BunShellCommand,
	type BunSpawnOptions,
	type BunSubprocess,
	getBun,
} from "./runtime.ts";
import { createStreamPump } from "./stream.ts";

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
	/**
	 * Extra environment for the child, merged over the inherited environment on
	 * both backends. `undefined` values leave the inherited value in place.
	 */
	env?: Record<string, string | undefined>;
	/** Run through the platform shell instead of exec'ing directly. */
	shell?: boolean;
	/** Observe output chunks as they arrive (spawn path). Used for live logging. */
	onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
	/** Bun API override, for tests. Defaults to the real runtime. */
	bun?: BunApi;
}

/**
 * Reported exit code when a child survives even a force-kill and its real exit
 * status is unknowable: the POSIX convention `128 + SIGKILL`. The
 * `timedOut` / `cancelled` flags say why the code is synthetic.
 */
export const HARD_KILL_EXIT_CODE = 128 + 9;

/** Grace for draining pipes AFTER the child has exited. */
const POST_EXIT_DRAIN_GRACE_MS = 500;

/** How long the graceful first kill gets before the tree is force-killed. */
const KILL_GRACE_MS = 5_000;

const decoder = new TextDecoder();

/** A command that can outlive a `Bun.$` call must not go through `$`. */
function requiresSpawn(options: ShellOptions): boolean {
	return options.timeoutMs !== undefined || options.signal !== undefined;
}

/** Merge overrides over the inherited environment. `undefined` values are skipped. */
function mergeEnv(overrides: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/**
 * Kill escalation and bounded exit waiting for one spawned child.
 *
 * `killOnce` is the idempotent GRACEFUL first kill: SIGTERM to the child and,
 * where the detached child leads a process group (POSIX), SIGTERM to that
 * group so grandchildren get the same grace. `killHard` is the hard
 * escalation (SIGKILL / `taskkill /F` through the tree where addressable) and
 * deliberately bypasses that idempotence so the escalation scheduled by the
 * first kill actually fires. `waitForExit` stops being unbounded once a kill
 * was requested: a child that survives even `killHard` resolves to `null`
 * instead of hanging the caller forever.
 */
export interface KillController {
	/** Idempotent graceful first kill (SIGTERM). Schedules the `killHard` escalation. */
	killOnce(): void;
	/** Hard escalation (SIGKILL / `taskkill /F`). Runs even after `killOnce`. */
	killHard(): void;
	/** Wait for the exit code; `null` means the child outlived a force-kill. */
	waitForExit(): Promise<number | null>;
	/** Clear the escalation timers. Call once when the run is over. */
	dispose(): void;
}

export function createKillController(proc: BunSubprocess, graceMs: number = KILL_GRACE_MS): KillController {
	let killed = false;
	let escalationTimer: NodeJS.Timeout | undefined;
	let giveUpTimer: NodeJS.Timeout | undefined;
	let resolveGiveUp: (value: null) => void = () => {};
	const gaveUp = new Promise<null>((resolve) => {
		resolveGiveUp = resolve;
	});

	const killTree = () => {
		// The child runs its own tools, so its real descendants are
		// grandchildren. Hard-kill the whole tree when we can address it.
		// Windows residual limitation: `taskkill /F /T` walks the tree only
		// through the live direct child; grandchildren that outlive it are
		// orphaned and unreachable.
		if (proc.pid !== undefined) killProcessTree(proc.pid);
	};

	const killHard = () => {
		// Escalation: bypasses `killOnce`'s idempotence on purpose. Clears the
		// escalation timer so a late call cannot double-fire.
		killed = true;
		if (escalationTimer) {
			clearTimeout(escalationTimer);
			escalationTimer = undefined;
		}
		killTree();
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already gone.
		}
		// If even SIGKILL does not settle the exit, stop waiting at the grace
		// deadline; the run reports HARD_KILL_EXIT_CODE and returns.
		giveUpTimer = setTimeout(() => resolveGiveUp(null), graceMs);
		giveUpTimer.unref?.();
	};

	const killGracefully = () => {
		// Graceful first, on every platform: SIGTERM to the child itself.
		try {
			proc.kill("SIGTERM");
		} catch {
			// Already gone.
		}
		// The child is spawned detached, so on POSIX it leads its own process
		// group and a graceful group signal extends the same grace to its
		// grandchildren. Windows has no signal groups (detached is ignored
		// there), so the direct child is all the grace the tree gets before
		// `killHard` force-kills it.
		if (proc.pid !== undefined && process.platform !== "win32") {
			try {
				process.kill(-proc.pid, "SIGTERM");
			} catch {
				// No group to signal, or it is already gone.
			}
		}
	};

	const killOnce = () => {
		if (killed) return;
		killed = true;
		killGracefully();
		escalationTimer = setTimeout(killHard, graceMs);
		escalationTimer.unref?.();
	};

	return {
		killOnce,
		killHard,
		waitForExit: () => Promise.race([proc.exited, gaveUp]),
		dispose: () => {
			if (escalationTimer) clearTimeout(escalationTimer);
			if (giveUpTimer) clearTimeout(giveUpTimer);
			escalationTimer = undefined;
			giveUpTimer = undefined;
		},
	};
}

/** Run a command with arguments. Never rejects for a non-zero exit. */
export function runShell(command: string, args: string[], options: ShellOptions): Promise<ShellResult> {
	if (options.shell === true || requiresSpawn(options)) {
		return execute(command, args, options);
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
 *
 * `Bun.$` inherits the parent's stdin (it has no `stdin()` control, verified),
 * and has no timeout — anything that needs either takes the spawn path.
 */
async function executeDollar(build: (shell: BunShell) => BunShellCommand, options: ShellOptions): Promise<ShellResult> {
	const started = Date.now();
	const bun = options.bun ?? getBun();
	const shell = options.cwd ? bun.$.cwd(options.cwd) : bun.$;
	let command = build(shell);
	if (options.env) {
		// `command.env()` replaces the child's environment (verified), so the
		// full merged map is passed to get merge semantics.
		command = command.env(mergeEnv(options.env));
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
	if (args.length > 0) {
		// Appending args to shell source would need per-platform quoting and is
		// exactly the injection surface this module avoids. Compose the full
		// line and pass it to runShellLine instead.
		throw new Error(
			"runShell(..., { shell: true }) does not accept args; pass the full command line via runShellLine",
		);
	}
	return process.platform === "win32" ? ["cmd.exe", "/c", command] : ["/bin/sh", "-c", command];
}

async function execute(command: string, args: string[], options: ShellOptions): Promise<ShellResult> {
	const started = Date.now();
	const argv = resolveArgv(command, args, options.shell === true);
	const bun = options.bun ?? getBun();
	const spawnOptions: BunSpawnOptions = {
		cwd: options.cwd,
		env: mergeEnv(options.env ?? {}),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// Own process group on POSIX so the tree kill can reach grandchildren.
		detached: true,
	};
	const proc = bun.spawn(argv, spawnOptions);
	if (proc.pid) trackDetachedChildPid(proc.pid);

	let timedOut = false;
	let cancelled = false;
	const kills = createKillController(proc);
	const onAbort = () => {
		cancelled = true;
		kills.killOnce();
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
					kills.killOnce();
				}, options.timeoutMs);

	// Pump both pipes concurrently with the child, so a chatty child can never
	// fill its pipe buffer and deadlock against `exited`. The pumps are only
	// released AFTER the child has exited: the grace must bound the post-exit
	// drain (a surviving grandchild can hold the pipe open), never the child's
	// whole lifetime.
	const onOutput = options.onOutput;
	const outPump = createStreamPump(proc.stdout, onOutput ? (chunk) => onOutput("stdout", chunk) : undefined);
	const errPump = createStreamPump(proc.stderr, onOutput ? (chunk) => onOutput("stderr", chunk) : undefined);
	const exitCode = await kills.waitForExit();

	if (timer) clearTimeout(timer);
	options.signal?.removeEventListener("abort", onAbort);
	// The child is gone (or outlived a force-kill): stop waiting for EOF at the
	// grace deadline and keep whatever was read.
	await Promise.all([outPump.release(POST_EXIT_DRAIN_GRACE_MS), errPump.release(POST_EXIT_DRAIN_GRACE_MS)]);
	kills.dispose();
	if (proc.pid) untrackDetachedChildPid(proc.pid);
	return {
		// `null` from waitForExit means the child survived a force-kill: its
		// real status is unknowable and timedOut/cancelled carry the story.
		exitCode: exitCode ?? HARD_KILL_EXIT_CODE,
		stdout: outPump.text,
		stderr: errPump.text,
		durationMs: Date.now() - started,
		timedOut,
		cancelled,
		complete: outPump.complete && errPump.complete,
	};
}
