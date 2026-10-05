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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	_resetBackgroundRegistryForTests,
	type BackgroundTask,
	BG_DIR_NAME,
	BG_LOCK_FILE,
	BG_REGISTRY_FILE,
	getBackgroundRegistry,
	RegistryLockError,
	startBackgroundSubagent,
	withLock,
} from "../src/core/subagent/background.ts";
import { createEmptyUsage, type SubagentResult, type SubagentRunner } from "../src/core/subagent/types.ts";

/** A pid that cannot exist: kill(pid, 0) reports ESRCH on win32 and Unix alike. */
const DEAD_PID = 999999999;

describe("background registry", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousAnalyticsHome = process.env.PI_TEST_ANALYTICS_HOME;
	let agentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-bg-registry-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		// Keep analytics writes inside the temp dir too (hermetic tests).
		process.env.PI_TEST_ANALYTICS_HOME = agentDir;
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
	});
});
