/**
 * Background registry on a fresh agent dir (2.7 live-smoke regression): the
 * first `add()` used to throw ENOENT because `withLock` opened the lock file
 * before the `subagent-bg/` directory existed. Unit tests missed it because
 * they stub the registry object; the live smoke hit the real singleton.
 *
 * Also covers the registry-hardening fixes: stale-lock breaking, corrupt-file
 * preservation, task-id collision regeneration, pid-aware
 * markAllRunningAsCrashed, prune retention, and the onSettled throw guard.
 * Every test points the registry at a temp agent dir — never the real
 * ~/.pi/agent.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	_resetBackgroundRegistryForTests,
	type BackgroundTask,
	BG_DIR_NAME,
	BG_LOCK_FILE,
	BG_LOG_FILE,
	BG_REGISTRY_FILE,
	BG_REGISTRY_VERSION,
	breakLockIfUnchanged,
	getBackgroundRegistry,
	inspectLock,
	preserveCorruptRegistry,
	RegistryLockError,
	startBackgroundSubagent,
	withLock,
} from "../src/core/subagent/background.ts";
import { createEmptyUsage, type SubagentResult, type SubagentRunner } from "../src/core/subagent/types.ts";

const bunRef = vi.hoisted(() => ({ current: undefined as unknown }));

// background.ts reads crash evidence via getBun().file().text(). The vitest
// runner is Node (no `Bun` global), so swap in a node:fs-backed reader — the
// same injection seam bun-process-runner's tests use. Hermetic: it reads only
// real files inside the temp agent dir.
vi.mock("../src/core/subagent/runtime.ts", () => ({
	getBun: () => bunRef.current,
	isBunRuntime: () => true,
}));

/** A pid that cannot exist: kill(pid, 0) reports ESRCH on win32 and Unix alike. */
const DEAD_PID = 999999999;

function makeFakeBun(): {
	file(path: string): { exists(): Promise<boolean>; text(): Promise<string>; delete(): Promise<void> };
} {
	return {
		file(path: string) {
			return {
				async exists(): Promise<boolean> {
					return existsSync(path);
				},
				async text(): Promise<string> {
					return readFileSync(path, "utf8");
				},
				async delete(): Promise<void> {
					rmSync(path, { force: true });
				},
			};
		},
	};
}

describe("background registry", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousAnalyticsHome = process.env.PI_TEST_ANALYTICS_HOME;
	let agentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-bg-registry-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// Keep analytics writes inside the temp dir too (hermetic tests).
		process.env.PI_TEST_ANALYTICS_HOME = agentDir;
		bunRef.current = makeFakeBun();
		_resetBackgroundRegistryForTests();
	});

	afterEach(() => {
		_resetBackgroundRegistryForTests();
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (previousAnalyticsHome === undefined) {
			delete process.env.PI_TEST_ANALYTICS_HOME;
		} else {
			process.env.PI_TEST_ANALYTICS_HOME = previousAnalyticsHome;
		}
		if (agentDir && existsSync(agentDir)) {
			rmSync(agentDir, { recursive: true, force: true });
		}
		agentDir = undefined;
	});

	function home(): string {
		return agentDir as string;
	}

	function bgDir(): string {
		return join(home(), BG_DIR_NAME);
	}

	function lockFile(): string {
		return join(bgDir(), BG_LOCK_FILE);
	}

	function registryFile(): string {
		return join(bgDir(), BG_REGISTRY_FILE);
	}

	function seedLock(contents: string): void {
		mkdirSync(bgDir(), { recursive: true });
		writeFileSync(lockFile(), contents, "utf8");
	}

	function seedRegistry(contents: string): void {
		mkdirSync(bgDir(), { recursive: true });
		writeFileSync(registryFile(), contents, "utf8");
	}

	function lockSnapshot(path: string): { text: string; size: number; mtimeMs: number } {
		return { text: readFileSync(path, "utf8"), size: statSync(path).size, mtimeMs: statSync(path).mtimeMs };
	}

	function makeTask(id: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
		const now = new Date().toISOString();
		return {
			id,
			kind: "pi-subprocess",
			mode: "single",
			role: "scout",
			label: "scout (background)",
			task: `task ${id}`,
			status: "running",
			startedAt: now,
			lastEventAt: now,
			lastOutput: "",
			cwd: home(),
			...overrides,
		};
	}

	describe("fresh agent dir", () => {
		it("creates the subagent-bg directory on first write instead of failing", () => {
			const registry = getBackgroundRegistry();
			expect(() => registry.add(makeTask("bg_test_1"))).not.toThrow();
			expect(existsSync(registryFile())).toBe(true);
			expect(registry.snapshot().tasks.map((t) => t.id)).toEqual(["bg_test_1"]);
		});
	});

	describe("stale lock recovery", () => {
		it("breaks a lock left behind by a dead pid", () => {
			seedLock(JSON.stringify({ pid: DEAD_PID, createdAt: Date.now(), token: "theirs" }));
			const registry = getBackgroundRegistry();
			expect(() => registry.add(makeTask("bg_dead_owner"))).not.toThrow();
			expect(registry.snapshot().tasks.map((t) => t.id)).toEqual(["bg_dead_owner"]);
			expect(existsSync(lockFile())).toBe(false);
		});

		it("breaks a lock older than the stale threshold even when its pid is alive", () => {
			seedLock(JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000, token: "theirs" }));
			const registry = getBackgroundRegistry();
			expect(() => registry.add(makeTask("bg_old_lock"))).not.toThrow();
			expect(registry.snapshot().tasks.map((t) => t.id)).toEqual(["bg_old_lock"]);
		});

		it("breaks a foreign-format lock file (e.g. the legacy empty lock)", () => {
			seedLock("not json at all");
			const registry = getBackgroundRegistry();
			expect(() => registry.add(makeTask("bg_foreign_lock"))).not.toThrow();
			expect(registry.snapshot().tasks.map((t) => t.id)).toEqual(["bg_foreign_lock"]);
		});

		it("serializes two sequential withLock users", () => {
			const order: string[] = [];
			withLock(lockFile(), () => {
				expect(existsSync(lockFile())).toBe(true); // we hold it
				order.push("first");
			});
			withLock(lockFile(), () => {
				expect(existsSync(lockFile())).toBe(true);
				order.push("second");
			});
			expect(order).toEqual(["first", "second"]);
			expect(existsSync(lockFile())).toBe(false);
		});

		it("respects a live fresh lock instead of breaking it", { timeout: 15_000 }, () => {
			seedLock(JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "theirs" }));
			let ran = false;
			expect(() =>
				withLock(lockFile(), () => {
					ran = true;
				}),
			).toThrow(RegistryLockError);
			expect(ran).toBe(false);
			// The live holder's lock must not have been broken.
			expect(existsSync(lockFile())).toBe(true);
			expect(JSON.parse(readFileSync(lockFile(), "utf8"))).toMatchObject({ pid: process.pid, token: "theirs" });
		});
	});

	describe("lock break and release verification", () => {
		it("a fresh valid lock with a live pid is never judged breakable", () => {
			seedLock(JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "theirs" }));
			expect(inspectLock(lockFile()).state).toBe("fresh");
		});

		it("breakLockIfUnchanged removes the exact stale lock the decision was made on", () => {
			seedLock(JSON.stringify({ pid: DEAD_PID, createdAt: Date.now(), token: "theirs" }));
			const decided = lockSnapshot(lockFile());
			breakLockIfUnchanged(lockFile(), decided);
			expect(existsSync(lockFile())).toBe(false);
		});

		it("breakLockIfUnchanged never removes a fresh lock that replaced the stale one", () => {
			// The finding-2 interleaving: A judges T1 stale, C acquires a fresh
			// lock T2 before A's unlink runs — T2 must survive.
			const stale = JSON.stringify({ pid: DEAD_PID, createdAt: Date.now(), token: "theirs" });
			seedLock(stale);
			const decided = lockSnapshot(lockFile());
			const fresh = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "fresh" });
			writeFileSync(lockFile(), fresh, "utf8");
			breakLockIfUnchanged(lockFile(), decided);
			expect(existsSync(lockFile())).toBe(true);
			expect(readFileSync(lockFile(), "utf8")).toBe(fresh);
		});

		it("breakLockIfUnchanged requires content, size and mtime to all match", () => {
			const text = JSON.stringify({ pid: DEAD_PID, createdAt: Date.now(), token: "theirs" });
			seedLock(text);
			const stamp = statSync(lockFile());
			// Different content, matching stat — the content limb rejects.
			breakLockIfUnchanged(lockFile(), {
				text: "an earlier lock with different content",
				size: stamp.size,
				mtimeMs: stamp.mtimeMs,
			});
			expect(existsSync(lockFile())).toBe(true);
			// Matching content, mismatched size — the stat limb rejects.
			breakLockIfUnchanged(lockFile(), { text, size: stamp.size + 1, mtimeMs: stamp.mtimeMs });
			expect(existsSync(lockFile())).toBe(true);
			// Matching content and size, mismatched mtime — also rejects.
			breakLockIfUnchanged(lockFile(), { text, size: stamp.size, mtimeMs: stamp.mtimeMs + 1 });
			expect(existsSync(lockFile())).toBe(true);
			// All three match — removed.
			breakLockIfUnchanged(lockFile(), { text, size: stamp.size, mtimeMs: stamp.mtimeMs });
			expect(existsSync(lockFile())).toBe(false);
		});

		it("release with a foreign token does not unlink the current lock", () => {
			withLock(lockFile(), () => {
				// Our lock changes hands mid-hold (stale break + new owner): release
				// must leave the new owner's lock alone.
				writeFileSync(
					lockFile(),
					JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "theirs" }),
					"utf8",
				);
			});
			expect(existsSync(lockFile())).toBe(true);
			expect(JSON.parse(readFileSync(lockFile(), "utf8"))).toMatchObject({ token: "theirs" });
		});
	});

	describe("corrupt registry preservation", () => {
		it("preserves an unparseable registry file and warns exactly once", () => {
			const garbage = "not json{{{";
			seedRegistry(garbage);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const registry = getBackgroundRegistry();

			expect(registry.snapshot().tasks).toEqual([]);
			expect(warn).toHaveBeenCalledTimes(1);
			// A second read must not warn again — the file is already preserved.
			expect(registry.snapshot().tasks).toEqual([]);
			expect(warn).toHaveBeenCalledTimes(1);

			const preserved = readdirSync(bgDir()).filter((f) => f.startsWith(`${BG_REGISTRY_FILE}.corrupt-`));
			expect(preserved.length).toBe(1);
			expect(readFileSync(join(bgDir(), preserved[0] ?? ""), "utf8")).toBe(garbage);

			// Rows restart empty and writes never touch the preserved file.
			registry.add(makeTask("bg_fresh"));
			expect(registry.snapshot().tasks.map((t) => t.id)).toEqual(["bg_fresh"]);
			expect(readFileSync(join(bgDir(), preserved[0] ?? ""), "utf8")).toBe(garbage);
			warn.mockRestore();
		});

		it("preserves a version-mismatched registry file", () => {
			const foreign = JSON.stringify({ version: 99, tasks: [{ id: "bg_old" }] });
			seedRegistry(foreign);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const registry = getBackgroundRegistry();

			expect(registry.snapshot().tasks).toEqual([]);
			const preserved = readdirSync(bgDir()).filter((f) => f.startsWith(`${BG_REGISTRY_FILE}.corrupt-`));
			expect(preserved.length).toBe(1);
			expect(readFileSync(join(bgDir(), preserved[0] ?? ""), "utf8")).toBe(foreign);
			warn.mockRestore();
		});

		it("treats an empty registry file as empty without preserving it", () => {
			seedRegistry("");
			const registry = getBackgroundRegistry();
			expect(registry.snapshot().tasks).toEqual([]);
			const preserved = readdirSync(bgDir()).filter((f) => f.startsWith(`${BG_REGISTRY_FILE}.corrupt-`));
			expect(preserved.length).toBe(0);
		});

		it("does not rename a fresh registry that replaced the corrupt one mid-read", () => {
			// Interleaving pin: P1's unlocked read sees garbage at t0, a writer's
			// locked write lands valid rows at t1, P1's preserve step runs at t2.
			const garbage = "not json{{{";
			seedRegistry(garbage);
			const raw = readFileSync(registryFile(), "utf8"); // P1's corrupt read at t0
			const fresh = JSON.stringify({ version: BG_REGISTRY_VERSION, tasks: [makeTask("bg_writers_row")] }, null, 2);
			writeFileSync(registryFile(), fresh, "utf8"); // W's write at t1
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			preserveCorruptRegistry(registryFile(), raw); // P1's preserve step at t2
			// The fresh registry must NOT be renamed away and its rows survive.
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
			expect(existsSync(registryFile())).toBe(true);
			expect(readdirSync(bgDir()).filter((f) => f.startsWith(`${BG_REGISTRY_FILE}.corrupt-`))).toEqual([]);
			expect(
				getBackgroundRegistry()
					.snapshot()
					.tasks.map((t) => t.id),
			).toEqual(["bg_writers_row"]);
		});

		it("preserveCorruptRegistry still renames when the corrupt payload is unchanged", () => {
			const garbage = "not json{{{";
			seedRegistry(garbage);
			const raw = readFileSync(registryFile(), "utf8");
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			preserveCorruptRegistry(registryFile(), raw);
			expect(warn).toHaveBeenCalledTimes(1);
			warn.mockRestore();
			expect(existsSync(registryFile())).toBe(false);
			const preserved = readdirSync(bgDir()).filter((f) => f.startsWith(`${BG_REGISTRY_FILE}.corrupt-`));
			expect(preserved.length).toBe(1);
			expect(readFileSync(join(bgDir(), preserved[0] ?? ""), "utf8")).toBe(garbage);
		});
	});

	describe("task rows", () => {
		it("regenerates a colliding task id instead of dropping the row", () => {
			const registry = getBackgroundRegistry();
			const first = makeTask("bg_dup", { task: "first" });
			registry.add(first);
			const second = makeTask("bg_dup", { task: "second" });
			registry.add(second);

			// The fresh id lands on the caller's object; the other row is intact.
			expect(first.id).toBe("bg_dup");
			expect(second.id).not.toBe("bg_dup");
			const tasks = registry.snapshot().tasks;
			expect(tasks.map((t) => t.id)).toEqual(["bg_dup", second.id]);
			expect(tasks[0]?.task).toBe("first");
			expect(tasks[1]?.task).toBe("second");

			// A later update targets the right row.
			registry.update(second.id, { lastOutput: "updated" });
			expect(registry.snapshot().tasks[1]?.lastOutput).toBe("updated");
			expect(registry.snapshot().tasks[0]?.lastOutput).toBe("");
		});

		it("add() stamps ownerPid atomically — no persisted running row ever lacks it", () => {
			const registry = getBackgroundRegistry();
			registry.add(makeTask("t_owner_stamp"));
			const raw = JSON.parse(readFileSync(registryFile(), "utf8")) as { tasks: BackgroundTask[] };
			expect(raw.tasks[0]?.status).toBe("running");
			expect(raw.tasks[0]?.ownerPid).toBe(process.pid);
		});

		it("markAllRunningAsCrashed skips live owners and crashes dead ones", async () => {
			const registry = getBackgroundRegistry();
			// ownerPid defaults to this process — alive, so it must be skipped.
			registry.add(makeTask("t_live"));
			registry.add(makeTask("t_dead", { ownerPid: DEAD_PID }));
			registry.add(makeTask("t_legacy", { status: "pending" }));
			// Rows from before ownerPid existed carry no owner and count as orphans.
			registry.update("t_legacy", { ownerPid: undefined });

			const count = await registry.markAllRunningAsCrashed();
			expect(count).toBe(2);
			const byId = new Map(registry.snapshot().tasks.map((t) => [t.id, t]));
			expect(byId.get("t_live")?.status).toBe("running");
			expect(byId.get("t_dead")?.status).toBe("crashed");
			expect(byId.get("t_legacy")?.status).toBe("crashed");
		});

		it("prune drops terminal rows older than 7 days and keeps in-flight rows", async () => {
			const registry = getBackgroundRegistry();
			const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
			registry.add(makeTask("t_old_done", { status: "completed", finishedAt: eightDaysAgo }));
			registry.add(makeTask("t_new_done", { status: "completed", finishedAt: new Date().toISOString() }));
			registry.add(makeTask("t_old_running", { startedAt: eightDaysAgo, lastEventAt: eightDaysAgo }));

			expect(await registry.prune()).toBe(1);
			expect(
				registry
					.snapshot()
					.tasks.map((t) => t.id)
					.sort(),
			).toEqual(["t_new_done", "t_old_running"]);
		});

		it("prune caps terminal rows at the newest 200", async () => {
			const registry = getBackgroundRegistry();
			const base = Date.now();
			// Row i has finishedAt base - i seconds: i=0 is the newest.
			for (let i = 0; i < 250; i++) {
				registry.add(
					makeTask(`bg_row_${i}`, {
						status: "completed",
						finishedAt: new Date(base - i * 1000).toISOString(),
					}),
				);
			}
			expect(await registry.prune()).toBe(50);
			const kept = registry.snapshot().tasks.map((t) => t.id);
			const expected = Array.from({ length: 200 }, (_, i) => `bg_row_${i}`);
			expect(kept).toEqual(expected);
		});
	});

	describe("prune log dir GC", () => {
		it("prune deletes removed rows' log dirs and keeps retained/running ones", async () => {
			const registry = getBackgroundRegistry();
			const oldId = registry.makeTaskId();
			const keptId = registry.makeTaskId();
			const runningId = registry.makeTaskId();
			const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
			registry.add(makeTask(oldId, { status: "completed", finishedAt: eightDaysAgo }));
			registry.add(makeTask(keptId, { status: "completed" }));
			registry.add(makeTask(runningId, { status: "running" }));
			for (const id of [oldId, keptId, runningId]) {
				mkdirSync(join(bgDir(), id), { recursive: true });
				writeFileSync(join(bgDir(), id, BG_LOG_FILE), `${JSON.stringify({ type: "SPAWN" })}\n`, "utf8");
			}

			expect(await registry.prune()).toBe(1);
			// Row removal persisted first, then the dir is deleted.
			expect(existsSync(join(bgDir(), oldId))).toBe(false);
			// Retained and running rows' dirs survive untouched.
			expect(readFileSync(join(bgDir(), keptId, BG_LOG_FILE), "utf8")).toContain("SPAWN");
			expect(readFileSync(join(bgDir(), runningId, BG_LOG_FILE), "utf8")).toContain("SPAWN");
		});

		it("prune never deletes a dir whose name is not our task-id format", async () => {
			const registry = getBackgroundRegistry();
			const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
			registry.add(makeTask("legacy_id", { status: "completed", finishedAt: eightDaysAgo }));
			mkdirSync(join(bgDir(), "legacy_id"), { recursive: true });
			writeFileSync(join(bgDir(), "legacy_id", BG_LOG_FILE), "{}\n", "utf8");

			expect(await registry.prune()).toBe(1); // row removed
			expect(existsSync(join(bgDir(), "legacy_id"))).toBe(true); // dir leaks, never misdeleted
		});
	});

	describe("background dispatch", () => {
		it("a throwing onSettled does not rewrite the terminal status", async () => {
			const registry = getBackgroundRegistry();
			const fakeRunner: SubagentRunner = {
				run: async (): Promise<SubagentResult> => ({
					role: "scout",
					task: "noop",
					exitCode: 0,
					aborted: false,
					finalOutput: "done",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				}),
			};
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const dispatch = startBackgroundSubagent({
				registry,
				runner: fakeRunner,
				spec: { role: "scout", instructions: "noop" },
				task: "noop",
				cwd: home(),
				onSettled: () => {
					throw new Error("callback bug");
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 300));
			const row = registry.snapshot().tasks[0];
			expect(row?.id).toBe(dispatch.taskId);
			expect(row?.status).toBe("completed");
			expect(warn).toHaveBeenCalled(); // swallowed and warned, not rethrown
			warn.mockRestore();
		});

		it("a throwing runner still delivers the settle notification", async () => {
			const registry = getBackgroundRegistry();
			const throwingRunner: SubagentRunner = {
				run: async (): Promise<SubagentResult> => {
					throw new Error("runner exploded");
				},
			};
			const settled: Array<{ taskId: string; result: SubagentResult }> = [];
			const dispatch = startBackgroundSubagent({
				registry,
				runner: throwingRunner,
				spec: { role: "scout", instructions: "noop" },
				task: "boom",
				cwd: home(),
				onSettled: (taskId, result) => {
					settled.push({ taskId, result });
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(settled.length).toBe(1);
			expect(settled[0]?.taskId).toBe(dispatch.taskId);
			expect(settled[0]?.result.errorMessage).toBe("runner crashed: runner exploded");
			expect(registry.snapshot().tasks[0]?.status).toBe("crashed");
		});

		it("a throwing onSettled in the crash path is swallowed, not rethrown", async () => {
			const registry = getBackgroundRegistry();
			const throwingRunner: SubagentRunner = {
				run: async (): Promise<SubagentResult> => {
					throw new Error("runner exploded");
				},
			};
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			startBackgroundSubagent({
				registry,
				runner: throwingRunner,
				spec: { role: "scout", instructions: "noop" },
				task: "boom",
				cwd: home(),
				onSettled: () => {
					throw new Error("callback bug");
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 300));
			// Guarded: the row still lands crashed and the throw cannot escape as
			// an unhandled rejection from the top-level catch.
			expect(registry.snapshot().tasks[0]?.status).toBe("crashed");
			expect(warn).toHaveBeenCalled();
			warn.mockRestore();
		});
	});

	describe("crash evidence", () => {
		function seedLog(taskId: string, lines: Array<Record<string, unknown>>): void {
			mkdirSync(join(bgDir(), taskId), { recursive: true });
			writeFileSync(
				join(bgDir(), taskId, BG_LOG_FILE),
				`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
				"utf8",
			);
		}

		it("records last-known-state evidence (final exit code) from the task log", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add(makeTask(id, { ownerPid: DEAD_PID }));
			seedLog(id, [
				{ type: "SPAWN", role: "scout" },
				{ type: "EXIT", exitCode: 1 },
				{ type: "EXIT", exitCode: 3 },
			]);

			expect(await registry.markAllRunningAsCrashed()).toBe(1);
			const row = registry.snapshot().tasks[0];
			expect(row?.status).toBe("crashed");
			expect(row?.errorMessage).toContain("crashed (parent process died)");
			expect(row?.errorMessage).toContain("last known state");
			expect(row?.errorMessage).toContain("exit code 3");
			expect(row?.errorMessage).not.toContain("exit code 1");

			// Guard: the error field survives the JSON store round-trip (undefined
			// fields are stripped by JSON.stringify — this must not be one of them).
			const raw = JSON.parse(readFileSync(registryFile(), "utf8")) as { tasks: BackgroundTask[] };
			expect(raw.tasks[0]?.errorMessage).toContain("exit code 3");
		});

		it("extracts the last errorMessage alongside the exit code", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add(makeTask(id, { ownerPid: DEAD_PID }));
			seedLog(id, [
				{ type: "EXIT", exitCode: 2 },
				{ type: "ERROR", errorMessage: "kaboom" },
			]);

			await registry.markAllRunningAsCrashed();
			expect(registry.snapshot().tasks[0]?.errorMessage).toContain("exit code 2");
			expect(registry.snapshot().tasks[0]?.errorMessage).toContain("kaboom");
		});

		it("falls back to a bounded raw tail when the log has no exit code or error", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add(makeTask(id, { ownerPid: DEAD_PID }));
			seedLog(id, [{ type: "STDERR", text: "partial output before the crash" }]);

			await registry.markAllRunningAsCrashed();
			const row = registry.snapshot().tasks[0];
			expect(row?.errorMessage).toContain("last known state");
			expect(row?.errorMessage).toContain("partial output before the crash");
		});

		it("records the no-log fallback when the task log is missing", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add(makeTask(id, { ownerPid: DEAD_PID }));

			await registry.markAllRunningAsCrashed();
			expect(registry.snapshot().tasks[0]?.errorMessage).toBe("crashed (parent process died; no log available)");
		});

		it("never marks a live-owner row and sets no crash error on it", async () => {
			const registry = getBackgroundRegistry();
			registry.add(makeTask("t_live_owner")); // ownerPid defaults to this live pid
			expect(await registry.markAllRunningAsCrashed()).toBe(0);
			const row = registry.snapshot().tasks[0];
			expect(row?.status).toBe("running");
			expect(row?.errorMessage).toBeUndefined();
		});

		it("does not overwrite an existing result on a dead-owner row", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add(makeTask(id, { ownerPid: DEAD_PID, errorMessage: "already recorded" }));
			seedLog(id, [{ type: "EXIT", exitCode: 9 }]);

			await registry.markAllRunningAsCrashed();
			const row = registry.snapshot().tasks[0];
			expect(row?.status).toBe("crashed");
			expect(row?.errorMessage).toBe("already recorded");
		});

		it("update() persists an additive error field through the JSON store", () => {
			const registry = getBackgroundRegistry();
			registry.add(makeTask("t_additive"));
			registry.update("t_additive", { errorMessage: "via update" });
			const raw = JSON.parse(readFileSync(registryFile(), "utf8")) as { tasks: BackgroundTask[] };
			expect(raw.tasks[0]?.errorMessage).toBe("via update");
		});
	});
});
