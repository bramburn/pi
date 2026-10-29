/**
 * Descendant snapshot for the win32 kill path.
 *
 * Windows has no process groups and no `kill(-pid)`: `taskkill /F /T` walks the
 * tree from a LIVE direct child downwards, so grandchildren that outlive the
 * direct child are re-parented and escape the sweep entirely. That is the
 * "residual limitation" the shell modules used to document.
 *
 * The fallback here closes most of that hole by asking the OS for the process
 * table BEFORE the sweep, so the descendants we are about to orphan are known
 * by pid and can each be force-killed individually. Order matters: snapshot
 * first, then sweep.
 *
 * Honest remaining limitation: a descendant spawned AFTER the snapshot is taken
 * is invisible to it and can still escape. `CreationDate` is carried through so
 * a recycled pid (a process that reuses the number but started EARLIER than the
 * root) is never killed as if it were a descendant.
 *
 * This module is deliberately win32-only and never imported by POSIX-only
 * paths: on POSIX the process group already reaches the whole tree.
 *
 * No `bun:*` imports. The Bun API is obtained through `runtime.ts` (which reads
 * the `Bun` global), because a static `bun:ffi` / `bun:jsc` import crashes the
 * Node-run vitest suite.
 */

import { getBun, isBunRuntime } from "./runtime.ts";
import { collectStream } from "./stream.ts";

/** One row of the OS process table. `createdMs` is NaN when unavailable. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	/** Process start time, epoch milliseconds. NaN when PowerShell gave none. */
	createdMs: number;
}

/** The snapshot is a best-effort optimization: never let it delay a teardown. */
const SNAPSHOT_TIMEOUT_MS = 5_000;

const PROCESS_TABLE_COMMAND =
	"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress";

/** Parse one `CreationDate` value. PowerShell 5.1 emits `\/Date(ms)\/`; 7+ emits ISO. */
function parseCreatedMs(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return Number.NaN;
	const ms = /^\/Date\((-?\d+)\)\/$/.exec(value);
	if (ms) return Number(ms[1]);
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Pure parser for the `ConvertTo-Json` process table.
 *
 * `ConvertTo-Json` collapses a one-element result to a bare object instead of an
 * array, so both shapes are accepted. Malformed rows are dropped rather than
 * rejecting the whole snapshot.
 */
export function parseProcessTable(json: string): ProcessRow[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	const entries = Array.isArray(parsed) ? parsed : [parsed];
	const rows: ProcessRow[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const raw = entry as Record<string, unknown>;
		const pid = Number(raw.ProcessId);
		const ppid = Number(raw.ParentProcessId);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		rows.push({
			pid,
			ppid: Number.isInteger(ppid) ? ppid : 0,
			createdMs: parseCreatedMs(raw.CreationDate),
		});
	}
	return rows;
}

/**
 * Transitive descendants of `rootPid`, deepest-first, for a pre-sweep kill.
 *
 * Deepest-first is what makes the per-pid `taskkill /F /PID` loop useful: a leaf
 * killed before its parent cannot be re-parented mid-sweep.
 *
 * Returns `[]` on ANY failure (missing PowerShell, timeout, parse error,
 * non-win32, non-Bun runtime, unknown root pid). An empty snapshot means the
 * caller falls back to exactly the old `taskkill /F /T` behaviour — this
 * function is an improvement, never a new failure mode.
 */
export async function snapshotDescendants(rootPid: number): Promise<number[]> {
	if (process.platform !== "win32") return [];
	if (!Number.isInteger(rootPid) || rootPid <= 0 || rootPid === process.pid) return [];
	if (!isBunRuntime()) return [];

	let json: string;
	try {
		const bun = getBun();
		const proc = bun.spawn(["powershell.exe", "-NoProfile", "-Command", PROCESS_TABLE_COMMAND], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const collected = await collectStream(proc.stdout, SNAPSHOT_TIMEOUT_MS);
		// The grace may have expired with PowerShell still narrowing the table;
		// the partial read is not parseable, so drop the handle too.
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already gone.
		}
		if (!collected.complete) return [];
		json = collected.text;
	} catch {
		return [];
	}

	const rows = parseProcessTable(json);
	if (rows.length === 0) return [];

	const root = rows.find((row) => row.pid === rootPid);
	// Without the root row there is no parent chain to walk and no start time to
	// guard pid reuse against. Let the tree sweep handle it.
	if (!root) return [];

	// parent -> children, so the walk below is a plain traversal.
	const childrenOf = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		const bucket = childrenOf.get(row.ppid);
		if (bucket) bucket.push(row);
		else childrenOf.set(row.ppid, [row]);
	}

	// Breadth-first from the root, carrying depth so the result can be emitted
	// deepest-first. `seen` also makes a (malformed) parent cycle terminate.
	const seen = new Set<number>([rootPid]);
	const descendants: Array<{ pid: number; depth: number }> = [];
	let frontier: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
	while (frontier.length > 0) {
		const next: Array<{ pid: number; depth: number }> = [];
		for (const node of frontier) {
			for (const child of childrenOf.get(node.pid) ?? []) {
				if (seen.has(child.pid)) continue;
				seen.add(child.pid);
				// A child that started BEFORE the root is a recycled pid, not ours:
				// skip it and its subtree (its children are equally unrelated).
				const recycled =
					Number.isFinite(root.createdMs) && Number.isFinite(child.createdMs) && child.createdMs < root.createdMs;
				if (recycled) continue;
				descendants.push({ pid: child.pid, depth: node.depth + 1 });
				next.push({ pid: child.pid, depth: node.depth + 1 });
			}
		}
		frontier = next;
	}

	descendants.sort((a, b) => b.depth - a.depth || b.pid - a.pid);
	return descendants.map((entry) => entry.pid);
}
