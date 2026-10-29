/**
 * Real POSIX process-group kill semantics for the subagent kill path.
 *
 * The escalation test in `subagent-shell.test.ts` pins the signal SEQUENCE, but
 * it drives a fake with pid 99_999_999: every tree-kill syscall fails with ESRCH
 * and is absorbed, no grandchild exists, and a regression to a positive-pid
 * (child-only) kill would still pass.
 *
 * This file closes that gap with real processes:
 *
 * 1. A real child is spawned `detached: true`, so it leads its own POSIX
 *    process group, and it backgrounds a real grandchild that IGNORES SIGTERM
 *    and records both its pid and the SIGTERM it received.
 * 2. `createKillController(...).killOnce()` must deliver the graceful group
 *    signal (`process.kill(-proc.pid, "SIGTERM")`, shell.ts) to that grandchild:
 *    the grandchild's trap runs, so the marker file appears.
 * 3. The scheduled hard escalation (`killProcessTree` -> `process.kill(-pid,
 *    "SIGKILL")`, utils/shell.ts) must then actually kill the grandchild: it
 *    disappears from the pid table.
 * 4. Negative control: signalling the direct child with a POSITIVE pid only
 *    (`process.kill(childPid, "SIGTERM")`) leaves the ignoring grandchild
 *    alive, so a regression to child-only kill FAILS this suite instead of
 *    silently passing.
 *
 * POSIX only. On win32 there are no signal groups, so the suite skips there.
 * Deliberately NOT gated on `isBunRuntime()`: CI runs vitest under node, and
 * that gate is exactly why the existing kill tests never exercise real
 * processes. The production kill functions are imported from src; only the
 * fixture processes are spawned with `node:child_process`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BunSubprocess } from "../src/core/subagent/runtime.ts";
import { createKillController } from "../src/core/subagent/shell.ts";
import { killProcessTree } from "../src/utils/shell.ts";

/**
 * Fixture: the outer `sh` becomes `sleep 600` (the "direct child" the kill
 * path signals) and backgrounds a grandchild `sh` that:
 * - writes its own pid to `$PG_PIDFILE` (so the test can poll for it),
 * - traps SIGTERM, writes a marker to `$PG_MARKER`, and keeps running (a trap
 *   that ignores the signal, not one that exits),
 * - otherwise idles in a short sleep loop so the trap runs promptly.
 */
const FIXTURE_SCRIPT = [
	`sh -c 'printf "%s" "$$" > "$PG_PIDFILE"; trap "printf term > \\"$PG_MARKER\\"" TERM; while :; do sleep 0.5; done' &`,
	"exec sleep 600",
].join("\n");

interface Fixture {
	child: ChildProcess;
	childPid: number;
	grandchildPid: number;
	markerPath: string;
	dir: string;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True while the pid still exists (a zombie counts as existing). */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Poll until the pid is gone, up to `timeoutMs`. */
async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await delay(25);
	}
	return !isAlive(pid);
}

/**
 * Poll a file until it is non-empty (or, when `expected` is given, until its
 * trimmed text equals it). Returns the last non-empty text seen, so a failure
 * reports what actually landed on disk.
 */
async function waitForText(path: string, timeoutMs: number, expected?: string): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;
	let last: string | null = null;
	while (Date.now() < deadline) {
		try {
			const text = readFileSync(path, "utf8");
			if (text.length > 0) {
				last = text;
				if (expected === undefined || text.trim() === expected) return text;
			}
		} catch {
			// Not written yet.
		}
		await delay(20);
	}
	return last;
}

/** Adapt a node child to the `BunSubprocess` surface `createKillController` needs. */
function toKillTarget(child: ChildProcess): BunSubprocess {
	const exited = new Promise<number>((resolve) => {
		child.once("close", (code) => resolve(code ?? -1));
		child.once("error", () => resolve(-1));
	});
	return {
		pid: child.pid,
		stdout: null,
		stderr: null,
		signalCode: Promise.resolve(null),
		exited,
		kill: (signal?: number | NodeJS.Signals) => {
			try {
				child.kill(signal);
			} catch {
				// Already gone.
			}
		},
	};
}

async function spawnFixture(): Promise<Fixture> {
	const dir = mkdtempSync(join(tmpdir(), "subagent-process-group-"));
	const markerPath = join(dir, "grandchild-term.marker");
	const pidFilePath = join(dir, "grandchild.pid");
	const child = spawn("/bin/sh", ["-c", FIXTURE_SCRIPT], {
		// Own process group: this is the precondition the production spawn sets
		// and the whole point of the negative-pid kill.
		detached: true,
		stdio: "ignore",
		env: { ...process.env, PG_MARKER: markerPath, PG_PIDFILE: pidFilePath },
	});
	if (child.pid === undefined) {
		throw new Error("fixture child did not report a pid");
	}
	const pidText = await waitForText(pidFilePath, 5_000);
	const grandchildPid = Number.parseInt(pidText ?? "", 10);
	if (!Number.isInteger(grandchildPid) || grandchildPid <= 0) {
		process.kill(-child.pid, "SIGKILL");
		throw new Error(`fixture grandchild never wrote its pid (got ${JSON.stringify(pidText)})`);
	}
	return { child, childPid: child.pid, grandchildPid, markerPath, dir };
}

/** Best-effort teardown: group kill, then the child, then the temp dir. */
function cleanupFixture(fixture: Fixture): void {
	try {
		process.kill(-fixture.childPid, "SIGKILL");
	} catch {
		// Group already gone.
	}
	try {
		fixture.child.kill("SIGKILL");
	} catch {
		// Already gone.
	}
	rmSync(fixture.dir, { recursive: true, force: true });
}

describe.skipIf(process.platform === "win32")("subagent POSIX process-group kill", () => {
	it("group SIGTERM reaches a real grandchild and the escalation kills it", async () => {
		const fixture = await spawnFixture();
		const kills = createKillController(toKillTarget(fixture.child), 1_500);
		try {
			expect(isAlive(fixture.grandchildPid)).toBe(true);

			kills.killOnce();

			// The graceful first kill signals the child AND, because the child
			// leads its own group, the group with a NEGATIVE pid. The grandchild
			// traps SIGTERM, so only a delivered group signal can produce this
			// marker. A regression to `process.kill(pid, "SIGTERM")` (child only)
			// leaves the marker absent and fails here.
			const marker = await waitForText(fixture.markerPath, 1_000, "term");
			expect(marker).toBe("term");

			// The escalation scheduled by killOnce runs the production hard kill
			// (`killProcessTree` -> `process.kill(-pid, "SIGKILL")`) and must
			// reach the grandchild through the same negative-pid group signal.
			const died = await waitForDeath(fixture.grandchildPid, 5_000);
			expect(died).toBe(true);
		} finally {
			kills.dispose();
			cleanupFixture(fixture);
		}
	}, 20_000);

	it("negative control: a positive-pid SIGTERM does NOT reach the grandchild", async () => {
		const fixture = await spawnFixture();
		try {
			// Child-only signal, exactly what a regression from
			// `process.kill(-pid, sig)` back to `process.kill(pid, sig)` would do.
			process.kill(fixture.childPid, "SIGTERM");

			await delay(1_000);

			// The direct child DID die, so the grandchild surviving below is a real
			// discrimination and not a no-op signal.
			expect(await waitForDeath(fixture.childPid, 2_000)).toBe(true);

			// The grandchild ignores SIGTERM either way, so the discriminator is
			// that it is STILL there — and that its trap never ran.
			expect(isAlive(fixture.grandchildPid)).toBe(true);
			expect(await waitForText(fixture.markerPath, 100, "term")).toBeNull();

			// Production hard kill cleans up the whole group.
			killProcessTree(fixture.childPid);
			expect(await waitForDeath(fixture.grandchildPid, 5_000)).toBe(true);
		} finally {
			cleanupFixture(fixture);
		}
	}, 20_000);
});
