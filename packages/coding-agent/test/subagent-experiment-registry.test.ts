/**
 * Experiment registry hardening: stale-lock breaking (dead pid / old
 * timestamp / foreign format), corrupt registry preservation, exclusive
 * log creation (no TOCTOU truncation), and collision-free experiment ids.
 * Every test uses a temp repoRoot — never a real checkout.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireLock,
	addExperiment,
	appendExperimentLogEvent,
	EXPERIMENTS_DIR_NAME,
	ExperimentRegistryLockError,
	type ExperimentRow,
	ensureExperimentLog,
	getExperiment,
	LOCK_FILE_NAME,
	makeExperimentId,
	REGISTRY_FILE_NAME,
	readRegistry,
	updateExperiment,
} from "../src/core/subagent/experiment-registry.ts";

/** A pid that cannot exist: kill(pid, 0) reports ESRCH on win32 and Unix alike. */
const DEAD_PID = 999999999;

describe("experiment registry", () => {
	let repoRoot: string | undefined;

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "pi-exp-registry-"));
	});

	afterEach(() => {
		if (repoRoot && existsSync(repoRoot)) {
			rmSync(repoRoot, { recursive: true, force: true });
		}
		repoRoot = undefined;
	});

	function root(): string {
		return repoRoot as string;
	}

	function expDir(): string {
		return join(root(), EXPERIMENTS_DIR_NAME);
	}

	function lockFile(): string {
		return join(expDir(), LOCK_FILE_NAME);
	}

	function registryFile(): string {
		return join(expDir(), REGISTRY_FILE_NAME);
	}

	function seedLock(contents: string): void {
		mkdirSync(expDir(), { recursive: true });
		writeFileSync(lockFile(), contents, "utf8");
	}

	function seedRegistry(contents: string): void {
		mkdirSync(expDir(), { recursive: true });
		writeFileSync(registryFile(), contents, "utf8");
	}

	function makeRow(id: string, overrides: Partial<ExperimentRow> = {}): ExperimentRow {
		const now = new Date().toISOString();
		return {
			id,
			hypothesis: "faster with caching",
			approach: "try x",
			worktreePath: join(root(), "..", id),
			branch: `exp/${id}`,
			parentCommit: "abc123",
			startedInCwd: root(),
			status: "scaffolded",
			result: {},
			merged: false,
			createdAt: now,
			updatedAt: now,
			...overrides,
		};
	}

	describe("locking", () => {
		it("serializes two sequential lock users", () => {
			const order: string[] = [];
			const first = acquireLock(root());
			expect(existsSync(lockFile())).toBe(true); // we hold it
			order.push("first");
			first.release();
			expect(existsSync(lockFile())).toBe(false);

			const second = acquireLock(root());
			order.push("second");
			second.release();
			expect(order).toEqual(["first", "second"]);
			expect(existsSync(lockFile())).toBe(false);
		});

		it("breaks a lock left behind by a dead pid", () => {
			seedLock(JSON.stringify({ pid: DEAD_PID, createdAt: Date.now(), token: "theirs" }));
			const handle = acquireLock(root());
			expect(existsSync(lockFile())).toBe(true);
			handle.release();
			expect(existsSync(lockFile())).toBe(false);
		});

		it("breaks a lock older than the stale threshold even when its pid is alive", () => {
			seedLock(JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000, token: "theirs" }));
			const handle = acquireLock(root());
			handle.release();
			expect(existsSync(lockFile())).toBe(false);
		});

		it("breaks a foreign-format lock file", () => {
			seedLock("");
			const handle = acquireLock(root());
			handle.release();
			expect(existsSync(lockFile())).toBe(false);
		});

		it("respects a live fresh lock instead of breaking it", { timeout: 15_000 }, () => {
			seedLock(JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "theirs" }));
			expect(() => acquireLock(root())).toThrow(ExperimentRegistryLockError);
			// The live holder's lock must not have been broken.
			expect(JSON.parse(readFileSync(lockFile(), "utf8"))).toMatchObject({ pid: process.pid, token: "theirs" });
		});
	});

	describe("corrupt registry preservation", () => {
		it("preserves an unparseable registry and restarts empty", () => {
			const garbage = "not json{{{";
			seedRegistry(garbage);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			expect(readRegistry(root()).experiments).toEqual([]);
			expect(warn).toHaveBeenCalledTimes(1);

			const preserved = readdirSync(expDir()).filter((f) => f.startsWith(`${REGISTRY_FILE_NAME}.corrupt-`));
			expect(preserved.length).toBe(1);
			expect(readFileSync(join(expDir(), preserved[0] ?? ""), "utf8")).toBe(garbage);

			// Rows restart empty and writes never touch the preserved file.
			addExperiment(root(), makeRow("exp_a"));
			expect(readRegistry(root()).experiments.map((r) => r.id)).toEqual(["exp_a"]);
			expect(readFileSync(join(expDir(), preserved[0] ?? ""), "utf8")).toBe(garbage);
			warn.mockRestore();
		});

		it("preserves a version-mismatched registry", () => {
			const foreign = JSON.stringify({ version: 42, experiments: [makeRow("exp_old")] });
			seedRegistry(foreign);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			expect(readRegistry(root()).experiments).toEqual([]);
			const preserved = readdirSync(expDir()).filter((f) => f.startsWith(`${REGISTRY_FILE_NAME}.corrupt-`));
			expect(preserved.length).toBe(1);
			expect(readFileSync(join(expDir(), preserved[0] ?? ""), "utf8")).toBe(foreign);
			warn.mockRestore();
		});

		it("treats an empty registry file as empty without preserving it", () => {
			seedRegistry("");
			expect(readRegistry(root()).experiments).toEqual([]);
			const preserved = readdirSync(expDir()).filter((f) => f.startsWith(`${REGISTRY_FILE_NAME}.corrupt-`));
			expect(preserved.length).toBe(0);
		});
	});

	describe("rows and ids", () => {
		it("addExperiment and updateExperiment round-trip", () => {
			addExperiment(root(), makeRow("exp_rt"));
			const updated = updateExperiment(root(), "exp_rt", { status: "running" });
			expect(updated?.status).toBe("running");
			expect(getExperiment(root(), "exp_rt")?.status).toBe("running");
		});

		it("makeExperimentId is unique for same-second, same-approach ids", () => {
			const now = new Date("2026-01-01T12:00:00Z");
			const a = makeExperimentId("Try X", now);
			const b = makeExperimentId("Try X", now);
			expect(a).not.toBe(b);
			expect(a.startsWith("exp-20260101120000-try-x-")).toBe(true);
			expect(b.startsWith("exp-20260101120000-try-x-")).toBe(true);
		});
	});

	describe("experiment log", () => {
		it("ensureExperimentLog never truncates an existing log", () => {
			const dir = join(root(), "exp_log");
			const file = join(dir, "log.jsonl");
			ensureExperimentLog(file);
			expect(existsSync(file)).toBe(true);
			appendExperimentLogEvent(file, { type: "SPAWN" });
			appendExperimentLogEvent(file, { type: "EXIT" });
			// A second "create" must not wipe the appended events.
			ensureExperimentLog(file);
			expect(readFileSync(file, "utf8").trim().split("\n").length).toBe(2);
		});
	});
});
