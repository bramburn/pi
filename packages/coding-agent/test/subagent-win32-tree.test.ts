/**
 * win32 descendant snapshot: parsing (pure) + real-process discovery/teardown
 * (win32 only).
 *
 * The defect these pin: on win32 there are no process groups, so teardown falls
 * back to `taskkill /F /T /PID <pid>`, which walks only the LIVE direct child's
 * tree. A descendant that outlives the direct child is orphaned and leaks — it
 * keeps holding ports and files. `snapshotDescendants` asks the OS for the
 * process table BEFORE the sweep so every descendant is known by pid.
 *
 * Deliberately NOT gated on `isBunRuntime()`: CI runs vitest under node, and a
 * runtime gate is exactly why the existing kill tests never exercise real
 * processes. This file therefore mocks `runtime.ts` (the single place that
 * declares the Bun surface) with a fake whose `spawn` runs the SAME command
 * through `node:child_process.spawnSync` and returns a one-shot reader. The
 * production code under test — `parseProcessTable`, `snapshotDescendants`,
 * `killProcessTree` — runs unmodified, and the process table it reads is real.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** Fake Bun surface: identical command, executed with node:child_process. */
const fakeBun = {
	spawn(command: string[]) {
		const result = spawnSync(command[0], command.slice(1), {
			encoding: "buffer",
			windowsHide: true,
			timeout: 10_000,
		});
		const bytes = result.stdout ?? Buffer.alloc(0);
		let read = false;
		return {
			pid: undefined as number | undefined,
			stdout: {
				getReader() {
					return {
						read: async () => {
							if (read) return { done: true, value: undefined };
							read = true;
							return { done: false, value: new Uint8Array(bytes) };
						},
						cancel: async () => {},
						releaseLock: () => {},
					};
				},
			},
			stderr: null,
			signalCode: Promise.resolve(null),
			exited: Promise.resolve(0),
			kill: () => {},
		};
	},
};

vi.mock("../src/core/subagent/runtime.ts", () => ({
	getBun: () => fakeBun,
	isBunRuntime: () => true,
}));

const { parseProcessTable, snapshotDescendants } = await import("../src/core/subagent/win32-tree.ts");
const { killProcessTree } = await import("../src/utils/shell.ts");

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `tasklist /FI "PID eq N"` is the OS's own answer for "does this pid exist". */
function pidExists(pid: number): boolean {
	if (pid <= 0) return false;
	const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/NH"], {
		encoding: "utf8",
		windowsHide: true,
	});
	return (result.stdout ?? "").includes(String(pid));
}

async function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidExists(pid)) return true;
		await delay(100);
	}
	return !pidExists(pid);
}

interface Tree {
	/** The direct child every kill path addresses. */
	rootPid: number;
	/** The root's own child, one level down. */
	midPid: number;
	/** The sleeping leaf the mid spawned, two levels down. */
	leafPid: number;
	dir: string;
}

/**
 * Real three-level tree: node root -> node mid -> sleeping PowerShell leaf,
 * each level recording the next one's pid. The root stays ALIVE, which is the
 * precondition the teardown path runs under (it is the pid being cancelled).
 * Script files are used instead of `-e` so no shell quoting can mangle the
 * fixture, and the depth is real so the deepest-first ordering is observable.
 */
async function spawnTree(): Promise<Tree | undefined> {
	const dir = mkdtempSync(join(tmpdir(), "subagent-win32-tree-"));
	const midPidFile = join(dir, "mid.pid");
	const leafPidFile = join(dir, "leaf.pid");
	const midScript = join(dir, "mid.cjs");
	const rootScript = join(dir, "root.cjs");
	writeFileSync(
		midScript,
		[
			'const { spawn } = require("node:child_process");',
			'const fs = require("node:fs");',
			"fs.writeFileSync(process.argv[2], String(process.pid));",
			'const leaf = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 120"], { stdio: "ignore" });',
			"fs.writeFileSync(process.argv[3], String(leaf.pid));",
			"setTimeout(() => {}, 120_000);",
		].join("\n"),
	);
	writeFileSync(
		rootScript,
		[
			'const { spawn } = require("node:child_process");',
			'spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[4]], { stdio: "ignore" });',
			"setTimeout(() => {}, 120_000);",
		].join("\n"),
	);
	const root = spawn(process.execPath, [rootScript, midScript, midPidFile, leafPidFile], {
		stdio: "ignore",
		windowsHide: true,
	});
	if (root.pid === undefined) return undefined;
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const midPid = Number.parseInt(readFileSync(midPidFile, "utf8").trim(), 10);
			const leafPid = Number.parseInt(readFileSync(leafPidFile, "utf8").trim(), 10);
			if (Number.isInteger(midPid) && midPid > 0 && Number.isInteger(leafPid) && leafPid > 0) {
				return { rootPid: root.pid, midPid, leafPid, dir };
			}
		} catch {
			// Not written yet.
		}
		await delay(100);
	}
	return undefined;
}

function cleanupTree(tree: Tree | undefined): void {
	if (!tree) return;
	spawnSync("taskkill.exe", ["/F", "/T", "/PID", String(tree.rootPid)], { windowsHide: true });
	for (const pid of [tree.midPid, tree.leafPid]) {
		if (pid > 0) spawnSync("taskkill.exe", ["/F", "/PID", String(pid)], { windowsHide: true });
	}
	rmSync(tree.dir, { recursive: true, force: true });
}

describe("parseProcessTable (pure)", () => {
	it("parses an array payload and both date encodings", () => {
		const json = `[{"ProcessId":10,"ParentProcessId":4,"CreationDate":"\\/Date(1700000001000)\\/"},{"ProcessId":11,"ParentProcessId":10,"CreationDate":"2024-01-02T03:04:05.000Z"}]`;
		const rows = parseProcessTable(json);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ pid: 10, ppid: 4, createdMs: 1_700_000_001_000 });
		expect(rows[1].pid).toBe(11);
		expect(rows[1].ppid).toBe(10);
		expect(rows[1].createdMs).toBe(Date.parse("2024-01-02T03:04:05.000Z"));
	});

	it("accepts the single-object shape PowerShell emits for one process", () => {
		const rows = parseProcessTable(`{"ProcessId":42,"ParentProcessId":4,"CreationDate":"\\/Date(1700000001000)\\/"}`);
		expect(rows).toEqual([{ pid: 42, ppid: 4, createdMs: 1_700_000_001_000 }]);
	});

	it("returns [] on malformed JSON, an empty payload, or a missing id", () => {
		expect(parseProcessTable("not json")).toEqual([]);
		expect(parseProcessTable("")).toEqual([]);
		expect(parseProcessTable("[]")).toEqual([]);
		expect(parseProcessTable(`[{"ParentProcessId":4},{"ProcessId":0,"ParentProcessId":0}]`)).toEqual([]);
	});

	it("keeps a row with an unparseable CreationDate, as NaN", () => {
		const rows = parseProcessTable(`[{"ProcessId":7,"ParentProcessId":1,"CreationDate":"garbage"}]`);
		expect(rows).toHaveLength(1);
		expect(rows[0].pid).toBe(7);
		expect(Number.isNaN(rows[0].createdMs)).toBe(true);
	});
});

describe.skipIf(process.platform !== "win32")("win32 descendant snapshot (real processes)", () => {
	it("finds the real grandchild of a live direct child", async () => {
		const tree = await spawnTree();
		expect(tree, "fixture tree never reported a leaf pid").toBeDefined();
		if (!tree) return;
		try {
			const found = await snapshotDescendants(tree.rootPid);
			expect(found).toContain(tree.midPid);
			expect(found).toContain(tree.leafPid);
			// The root itself is the starting point, never a target.
			expect(found).not.toContain(tree.rootPid);
			// Deepest-first: the leaf (plus whatever console host Windows gives it)
			// is emitted before its parent, so a leaf is killed before it can be
			// re-parented mid-sweep.
			expect(found.indexOf(tree.leafPid)).toBeLessThan(found.indexOf(tree.midPid));
		} finally {
			cleanupTree(tree);
		}
	}, 30_000);

	it("returns [] for a dead pid, invalid pids, and our own pid", async () => {
		expect(await snapshotDescendants(999_999_999)).toEqual([]);
		expect(await snapshotDescendants(0)).toEqual([]);
		expect(await snapshotDescendants(-1)).toEqual([]);
		expect(await snapshotDescendants(process.pid)).toEqual([]);
	});

	it("teardown reaches the grandchild and leaves no orphan behind", async () => {
		const tree = await spawnTree();
		expect(tree, "fixture tree never reported a leaf pid").toBeDefined();
		if (!tree) return;
		try {
			// The production win32 teardown: snapshot, per-pid leaf kill, then the
			// unchanged `taskkill /F /T` sweep. It is async by design (the snapshot
			// is a PowerShell round-trip), so poll rather than assume.
			killProcessTree(tree.rootPid);

			expect(await waitForPidGone(tree.leafPid, 15_000)).toBe(true);
			expect(await waitForPidGone(tree.midPid, 15_000)).toBe(true);
			expect(await waitForPidGone(tree.rootPid, 15_000)).toBe(true);
		} finally {
			cleanupTree(tree);
		}
	}, 40_000);
});
