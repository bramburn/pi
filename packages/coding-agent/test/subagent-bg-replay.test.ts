/**
 * Durable settle notifications (#1050) and consecutive-failure escalation
 * (#1051) against a real background registry on a temp agent dir.
 *
 * The invariants under test come from
 * `specs/subagent/features/durability/spec.md` REQ-O03: the settle path writes
 * a completion record *before* it notifies, the record is deleted only once
 * delivery succeeded, a live claim makes a second delivery of the same settle
 * a no-op, and the next startup replays whatever is left. Escalation rides on
 * the same channel: the third consecutive identical failure attaches an
 * `escalation` field to the result (and to the record the replay reads back).
 *
 * Every test points the agent dir at a temp directory — never the real
 * ~/.pi/agent.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	_resetBackgroundRegistryForTests,
	BG_DIR_NAME,
	claimReplayDeliveries,
	completeReplayDelivery,
	getBackgroundRegistry,
	startBackgroundSubagent,
} from "../src/core/subagent/background.ts";
import {
	buildCompletionRecord,
	COMPLETION_CLAIM_STALE_MS,
	claimRecord,
	countersFile,
	FAILURE_ESCALATION_THRESHOLD,
	type FailureCountersFile,
	REPLAY_MAX_AGE_MS,
	REPLAY_MAX_RECORDS,
	readFailureCounters,
	readRecordFile,
	recordFile,
	recordFileExists,
	replayDir,
} from "../src/core/subagent/result-record.ts";
import { createEmptyUsage, type SubagentResult, type SubagentRunner } from "../src/core/subagent/types.ts";

const bunRef = vi.hoisted(() => ({ current: undefined as unknown }));

// background.ts reads crash evidence via getBun().file().text(). The vitest
// runner is Node (no `Bun` global), so swap in a node:fs-backed reader — the
// same injection seam the registry tests use.
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

function sleep(ms = 300): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The shape every fake runner resolves with; overrides model one outcome. */
function okResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		role: "scout",
		task: "noop",
		exitCode: 0,
		aborted: false,
		finalOutput: "done",
		stderr: "",
		usage: createEmptyUsage(),
		messages: [],
		...overrides,
	};
}

function failedResult(message = "boom"): SubagentResult {
	return okResult({ exitCode: 1, stopReason: "error", errorMessage: message, finalOutput: "" });
}

describe("background settle durability + replay", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousAnalyticsHome = process.env.PI_TEST_ANALYTICS_HOME;
	let agentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-bg-replay-"));
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

	function counters(): FailureCountersFile {
		return readFailureCounters(countersFile(bgDir()));
	}

	/** Seed a claimable-but-unclaimed record that a replay pass must pick up. */
	function seedRecord(taskId: string, ageMs = 0): void {
		const record = buildCompletionRecord({
			taskId,
			role: "scout",
			status: "failed",
			exitCode: 1,
			errorMessage: "boom",
			output: "boom",
			task: "seeded",
			logPath: join(bgDir(), taskId, "log.jsonl"),
		});
		record.createdAt = new Date(Date.now() - ageMs).toISOString();
		// A claim from a dead pid is abandoned immediately — no need to wait out
		// COMPLETION_CLAIM_STALE_MS — and one delivery attempt is spent.
		claimRecord(record, "seed-token", Date.now() - ageMs, DEAD_PID);
		mkdirSync(replayDir(bgDir()), { recursive: true });
		writeFileSync(recordFile(bgDir(), taskId), `${JSON.stringify(record)}\n`, "utf8");
	}

	describe("write-at-settle", () => {
		it("writes the record before notifying and deletes it after delivery", async () => {
			const registry = getBackgroundRegistry();
			let atDelivery: { exists: boolean; status?: string; attempts?: number } | undefined;
			const settled: string[] = [];
			const runner: SubagentRunner = { run: async (): Promise<SubagentResult> => okResult() };
			const dispatch = startBackgroundSubagent({
				registry,
				runner,
				spec: { role: "scout", instructions: "noop" },
				task: "noop",
				cwd: home(),
				onSettled: (taskId) => {
					settled.push(taskId);
					// REQ-O03: the record must exist at the moment the consumer is
					// handed the notification, not after it returns.
					const record = readRecordFile(recordFile(bgDir(), taskId));
					atDelivery = {
						exists: record !== undefined,
						status: record?.status,
						attempts: record?.attempts,
					};
				},
			});

			await sleep();
			expect(settled).toEqual([dispatch.taskId]);
			expect(atDelivery).toEqual({ exists: true, status: "completed", attempts: 1 });
			// Delivery succeeded, so the record is cleared — nothing to replay.
			expect(recordFileExists(bgDir(), dispatch.taskId)).toBe(false);
			expect(existsSync(countersFile(bgDir()))).toBe(true);
		});

		it("keeps the record when the consumer throws, and replays it later", async () => {
			const registry = getBackgroundRegistry();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const runner: SubagentRunner = { run: async (): Promise<SubagentResult> => okResult() };
			const dispatch = startBackgroundSubagent({
				registry,
				runner,
				spec: { role: "scout", instructions: "noop" },
				task: "noop",
				cwd: home(),
				onSettled: () => {
					throw new Error("consumer down");
				},
			});

			await sleep();
			const record = readRecordFile(recordFile(bgDir(), dispatch.taskId));
			expect(record?.status).toBe("completed");
			expect(record?.output).toBe("done");
			expect(record?.task).toBe("noop");
			expect(record?.logPath).toContain(dispatch.taskId);
			expect(record?.attempts).toBe(1);
			expect(record?.claimToken).toBeTruthy();
			expect(record?.claimPid).toBe(process.pid);
			expect(warn).toHaveBeenCalled();
			warn.mockRestore();
		});

		it("holds a live claim against a replay pass (at-most-once per claim)", async () => {
			const registry = getBackgroundRegistry();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const runner: SubagentRunner = { run: async (): Promise<SubagentResult> => okResult() };
			const dispatch = startBackgroundSubagent({
				registry,
				runner,
				spec: { role: "scout", instructions: "noop" },
				task: "noop",
				cwd: home(),
				onSettled: () => {
					throw new Error("consumer down");
				},
			});

			await sleep();
			// Same process, claim written milliseconds ago: nothing to hand over.
			const receipt = claimReplayDeliveries();
			expect(receipt.delivered).toEqual([]);
			expect(receipt.claimsHeld).toBe(1);
			expect(receipt.collected).toBe(0);
			expect(recordFileExists(bgDir(), dispatch.taskId)).toBe(true);
			warn.mockRestore();
		});
	});

	describe("replay pass", () => {
		it("reclaims a stale claim, delivers once, and clears the record", async () => {
			const registry = getBackgroundRegistry();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const runner: SubagentRunner = { run: async (): Promise<SubagentResult> => failedResult("kaboom") };
			const dispatch = startBackgroundSubagent({
				registry,
				runner,
				spec: { role: "scout", instructions: "noop" },
				task: "boom",
				cwd: home(),
				onSettled: () => {
					throw new Error("consumer down");
				},
			});

			await sleep();
			// Simulate a restart: the writing process is gone, so its claim is
			// abandoned once the staleness window has passed.
			const restarted = Date.now() + COMPLETION_CLAIM_STALE_MS + 1_000;
			const first = claimReplayDeliveries(restarted);
			expect(first.claimsHeld).toBe(0);
			expect(first.delivered.length).toBe(1);
			const delivery = first.delivered[0];
			expect(delivery?.record.taskId).toBe(dispatch.taskId);
			expect(delivery?.record.status).toBe("failed");
			expect(delivery?.record.errorMessage).toBe("kaboom");
			expect(delivery?.record.attempts).toBe(2); // the live settle, then this claim
			expect(delivery?.token).toBeTruthy();
			// Claimed, not delivered: still on disk until the hand-off completes.
			expect(recordFileExists(bgDir(), dispatch.taskId)).toBe(true);

			// A second pass inside the same window must not double-deliver.
			const second = claimReplayDeliveries(restarted);
			expect(second.delivered).toEqual([]);
			expect(second.claimsHeld).toBe(1);

			completeReplayDelivery(delivery as NonNullable<typeof delivery>);
			expect(recordFileExists(bgDir(), dispatch.taskId)).toBe(false);
			warn.mockRestore();
		});

		it("collects expired and corrupt records without delivering them", () => {
			seedRecord("bg_expired", REPLAY_MAX_AGE_MS + 60_000);
			mkdirSync(replayDir(bgDir()), { recursive: true });
			writeFileSync(recordFile(bgDir(), "bg_corrupt"), "{ not json", "utf8");

			const receipt = claimReplayDeliveries();
			expect(receipt.delivered).toEqual([]);
			expect(receipt.collected).toBe(2);
			expect(receipt.deferred).toBe(0);
			expect(recordFileExists(bgDir(), "bg_expired")).toBe(false);
			expect(recordFileExists(bgDir(), "bg_corrupt")).toBe(false);
		});

		it("drops a record that spent its delivery attempts", () => {
			seedRecord("bg_capped");
			const path = recordFile(bgDir(), "bg_capped");
			const record = readRecordFile(path);
			expect(record).toBeDefined();
			const capped = { ...(record as NonNullable<typeof record>), attempts: 3 };
			writeFileSync(path, `${JSON.stringify(capped)}\n`, "utf8");

			const receipt = claimReplayDeliveries();
			expect(receipt.delivered).toEqual([]);
			expect(receipt.collected).toBe(1);
			expect(recordFileExists(bgDir(), "bg_capped")).toBe(false);
		});

		it("hands over at most REPLAY_MAX_RECORDS per pass and defers the rest", () => {
			const total = REPLAY_MAX_RECORDS + 5;
			for (let i = 0; i < total; i++) {
				seedRecord(`bg_row_${String(i).padStart(3, "0")}`);
			}

			const receipt = claimReplayDeliveries();
			expect(receipt.delivered.length).toBe(REPLAY_MAX_RECORDS);
			expect(receipt.deferred).toBe(5);
			expect(receipt.collected).toBe(0);
			// Oldest first, and each hand-off is claimed for this process.
			expect(receipt.delivered.every((d) => d.record.claimPid === process.pid)).toBe(true);
			expect(new Set(receipt.delivered.map((d) => d.record.taskId)).size).toBe(REPLAY_MAX_RECORDS);

			// The deferred remainder is still claimable once the pass's bound is
			// lifted by clearing the claimed hand-offs.
			for (const delivery of receipt.delivered) completeReplayDelivery(delivery);
			expect(claimReplayDeliveries().delivered.length).toBe(5);
		});
	});

	describe("failure escalation (#1051)", () => {
		it("attaches the escalation to the third consecutive identical failure", async () => {
			const registry = getBackgroundRegistry();
			const runner: SubagentRunner = { run: async (): Promise<SubagentResult> => failedResult() };
			const settled: Array<{ taskId: string; result: SubagentResult }> = [];
			const taskIds: string[] = [];
			for (let i = 0; i < FAILURE_ESCALATION_THRESHOLD; i++) {
				const dispatch = startBackgroundSubagent({
					registry,
					runner,
					spec: { role: "scout", instructions: "noop" },
					task: "boom",
					cwd: home(),
					onSettled: (taskId, result) => {
						settled.push({ taskId, result });
					},
				});
				taskIds.push(dispatch.taskId);
				await sleep();
			}

			expect(settled.length).toBe(FAILURE_ESCALATION_THRESHOLD);
			expect(settled[0]?.result.escalation).toBeUndefined();
			expect(settled[1]?.result.escalation).toBeUndefined();
			expect(settled[2]?.result.escalation).toEqual({
				consecutiveFailures: FAILURE_ESCALATION_THRESHOLD,
				threshold: FAILURE_ESCALATION_THRESHOLD,
				signature: "err:boom",
			});
			// Each settle delivered, so no records are left behind — only the
			// streak table remembers the run.
			expect(recordFileExists(bgDir(), taskIds[2] as string)).toBe(false);
			const entries = counters().entries;
			expect(entries.length).toBe(1);
			expect(entries[0]?.role).toBe("scout");
			expect(entries[0]?.count).toBe(FAILURE_ESCALATION_THRESHOLD);
			expect(entries[0]?.lastTaskId).toBe(taskIds[2]);
		});

		it("clears the streak once the role succeeds", async () => {
			const registry = getBackgroundRegistry();
			const failing: SubagentRunner = { run: async (): Promise<SubagentResult> => failedResult() };
			const passing: SubagentRunner = { run: async (): Promise<SubagentResult> => okResult() };
			for (let i = 0; i < FAILURE_ESCALATION_THRESHOLD; i++) {
				startBackgroundSubagent({
					registry,
					runner: failing,
					spec: { role: "scout", instructions: "noop" },
					task: "boom",
					cwd: home(),
					onSettled: () => {},
				});
				await sleep();
			}
			expect(counters().entries.length).toBe(1);

			startBackgroundSubagent({
				registry,
				runner: passing,
				spec: { role: "scout", instructions: "noop" },
				task: "noop",
				cwd: home(),
				onSettled: () => {},
			});
			await sleep();
			expect(counters().entries).toEqual([]);
		});

		it("carries the escalation into the record a replay reads back", async () => {
			const registry = getBackgroundRegistry();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const runner: SubagentRunner = { run: async (): Promise<SubagentResult> => failedResult() };
			let escalated: SubagentResult | undefined;
			for (let i = 0; i < FAILURE_ESCALATION_THRESHOLD; i++) {
				const last = i === FAILURE_ESCALATION_THRESHOLD - 1;
				startBackgroundSubagent({
					registry,
					runner,
					spec: { role: "scout", instructions: "noop" },
					task: "boom",
					cwd: home(),
					onSettled: (taskId, result) => {
						if (!last) return;
						escalated = result;
						// Delivery fails on the escalating settle: the record (with
						// its escalation) has to survive for the next startup.
						void taskId;
						throw new Error("consumer down");
					},
				});
				await sleep();
			}

			expect(escalated?.escalation?.consecutiveFailures).toBe(FAILURE_ESCALATION_THRESHOLD);
			const restarted = Date.now() + COMPLETION_CLAIM_STALE_MS + 1_000;
			const receipt = claimReplayDeliveries(restarted);
			expect(receipt.delivered.length).toBe(1);
			expect(receipt.delivered[0]?.record.status).toBe("failed");
			expect(receipt.delivered[0]?.record.escalation).toEqual({
				consecutiveFailures: FAILURE_ESCALATION_THRESHOLD,
				threshold: FAILURE_ESCALATION_THRESHOLD,
				signature: "err:boom",
			});
			warn.mockRestore();
		});
	});

	describe("crash path", () => {
		it("an already-cancelled row outranks the synthesized crash", async () => {
			const registry = getBackgroundRegistry();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			let rejectRun: ((err: Error) => void) | undefined;
			const hangingRunner: SubagentRunner = {
				run: () =>
					new Promise<SubagentResult>((_resolve, reject) => {
						rejectRun = reject;
					}),
			};
			let settled = 0;
			const dispatch = startBackgroundSubagent({
				registry,
				runner: hangingRunner,
				spec: { role: "scout", instructions: "noop" },
				task: "hangs",
				cwd: home(),
				onSettled: () => {
					settled += 1;
					throw new Error("consumer down");
				},
			});
			// `stop` writes `cancelled` while the child is still running; the
			// killed child then rejects. The row must not be stamped `crashed`.
			registry.update(dispatch.taskId, { status: "cancelled", finishedAt: new Date().toISOString() });
			rejectRun?.(new Error("killed"));
			await sleep();

			expect(registry.snapshot().tasks[0]?.status).toBe("cancelled");
			expect(settled).toBe(1);
			const record = readRecordFile(recordFile(bgDir(), dispatch.taskId));
			// The settle still has to be announced, but as the cancellation the
			// model was already told about.
			expect(record?.status).toBe("cancelled");
			expect(record?.errorMessage).toBe("runner crashed: killed");
			warn.mockRestore();
		});
	});
});
