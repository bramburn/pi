import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";
import { snapshotDescendants } from "../core/subagent/win32-tree.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", [executable], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** Resolve PowerShell on Windows, preferring PowerShell 7 when available. */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		if (process.platform === "win32") {
			// Exit-path floor: every caller of this function is a signal handler
			// that terminates the process immediately afterwards (e.g. SIGHUP →
			// process.exit(129)). killProcessTree's enhanced win32 teardown is
			// asynchronous (PowerShell snapshot first) and would never reach its
			// taskkill spawn before exit, so launch the classic synchronous
			// /F /T sweep here. It only walks the live child's tree — the
			// pre-existing limitation — but that is strictly better than
			// launching nothing. The enhanced snapshot teardown covers all
			// in-session kills, where the process stays alive.
			try {
				spawnSync(taskkillPath(), ["/F", "/T", "/PID", String(pid)], {
					stdio: "ignore",
					windowsHide: true,
					timeout: 5_000,
				});
			} catch {
				// Ignore cleanup failures.
			}
		} else {
			killProcessTree(pid);
		}
	}
	trackedDetachedChildPids.clear();
}

/** The trusted System32 taskkill, so cleanup does not depend on PATH. */
function taskkillPath(): string {
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
}

/**
 * Fire taskkill and absorb both failure modes: a synchronous spawn throw and
 * the asynchronous `error` event a failed spawn emits (which would otherwise
 * crash Node).
 */
function spawnTaskkill(args: string[]): void {
	try {
		const child = spawn(taskkillPath(), args, {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		child.once("error", () => {});
	} catch {
		// Ignore errors if taskkill fails.
	}
}

/**
 * win32 teardown: every descendant of `pid` visible in the process table is
 * force-killed by its own pid (leaf-first), then the unchanged `taskkill /F /T`
 * sweep runs as the final, tree-walking pass.
 *
 * Why the snapshot exists: Windows has no process groups, and `/T` walks the
 * tree only through a LIVE direct child. A descendant that outlives the direct
 * child is re-parented and the sweep misses it, leaving an orphan holding ports
 * and files. Snapshotting first means those descendants are already known by
 * pid, so each can be killed directly.
 *
 * Honest remaining limitation: the snapshot is a point-in-time read, so a
 * descendant spawned AFTER it is taken can still escape `/T` — and a pid that
 * was recycled (started before the root) is filtered rather than killed. An
 * empty snapshot (no Bun runtime, no PowerShell, timeout, no root row) degrades
 * to exactly the previous behaviour.
 *
 * Deliberately asynchronous and not awaited by `killProcessTree`: the snapshot
 * is a PowerShell round-trip and no caller awaits teardown. The synchronous
 * spawn inside `snapshotDescendants` still launches immediately, and the
 * descendant kills plus the `/T` sweep follow on the microtask queue.
 */
async function killProcessTreeWin32(pid: number): Promise<void> {
	const descendants = await snapshotDescendants(pid);
	// Leaf-first, each failure ignored: a descendant that exited on its own is
	// not an error, and the final sweep below is the safety net.
	for (const descendantPid of descendants) {
		spawnTaskkill(["/F", "/PID", String(descendantPid)]);
	}
	spawnTaskkill(["/F", "/T", "/PID", String(pid)]);
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		void killProcessTreeWin32(pid).catch(() => {});
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
