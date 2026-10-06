/**
 * Background dispatch concurrency cap + FIFO queue (issue #1055).
 *
 * `background: true` used to bypass every concurrency limit: `subagent.maxConcurrent`
 * only ever guarded inline parallel batches, so one tool call that fired twenty
 * detached tasks spawned twenty concurrent children. `requestBackgroundDispatch`
 * now admits each dispatch into one slot of that budget and parks the overflow in
 * a per-registry FIFO queue, promoted by `releaseBackgroundDispatch` from the
 * settle callback.
 *
 * These tests drive the queue layer directly with a gated runner: the runner
 * records each task it starts and then waits until the test releases it, so
 * "how many children are alive right now" and "in what order did they start" are
 * both observable without sleeping on real processes.
 *
 * Every test points the registry at a temp agent dir — never the real ~/.pi/agent.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	_resetBackgroundQueueForTests,
	_resetBackgroundRegistryForTests,
	type BackgroundRegistry,
	type BackgroundRunOptions,
	BG_DIR_NAME,
	getBackgroundRegistry,
	normalizeDispatchCap,
	queuedTaskIds,
	queuePositionOf,
	releaseBackgroundDispatch,
	requestBackgroundDispatch,
} from "../src/core/subagent/background.ts";
import { createEmptyUsage, type SubagentResult, type SubagentRunner } from "../src/core/subagent/types.ts";

const bunRef = vi.hoisted(() => ({ current: undefined as unknown }));

// background.ts reads crash evidence via getBun().file().text(). The vitest
// runner is Node (no `Bun` global), so swap in a node:fs-backed reader — the
// same injection seam subagent-background-registry.test.ts uses.
vi.mock("../src/core/subagent/runtime.ts", () => ({
	getBun: () => bunRef.current,
	isBunRuntime: () => true,
}));

/**
 * A runner that holds every task open until the test releases it.
 *
 * `started` is the launch order (what the cap is supposed to bound) and
 * `released` is the settle order (what promotions must follow).
 */
class Gate {
	readonly started: string[] = [];
	readonly released: string[] = [];
	readonly waiters = new Map<string, () => void>();

	runner(): SubagentRunner {
		return {
			run: async (request): Promise<SubagentResult> => {
				const label = request.task;
				this.started.push(label);
				await new Promise<void>((resolve) => {
					this.waiters.set(label, resolve);
				});
				this.released.push(label);
				return {
					role: "scout",
					task: label,
					exitCode: 0,
					aborted: false,
					finalOutput: `${label} done`,
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				};
			},
		};
	}

	/** Let one task's child finish, and flush the settle → release → promote chain. */
	async settle(label: string): Promise<void> {
		const waiter = this.waiters.get(label);
		this.waiters.delete(label);
		waiter?.();
		await flush();
	}

	live(): number {
		return this.started.length - this.released.length;
	}
}

/** Let every queued microtask/macrotask land: run resolution, row update, release, promotion. */
async function flush(times = 10): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function resultRow(registry: BackgroundRegistry, id: string) {
	return registry.snapshot().tasks.find((task) => task.id === id);
}

describe("background dispatch concurrency cap", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousAnalyticsHome = process.env.PI_TEST_ANALYTICS_HOME;
	let agentDir: string | undefined;
	let gate: Gate;
	let registry: BackgroundRegistry;
	let liveCap = 1;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-bg-cap-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.PI_TEST_ANALYTICS_HOME = agentDir;
		bunRef.current = {
			file(path: string) {
				return {
					async exists() {
						return existsSync(path);
					},
					async text() {
						return "";
					},
					async delete() {
						rmSync(path, { force: true });
					},
				};
			},
		};
		_resetBackgroundRegistryForTests();
		_resetBackgroundQueueForTests();
		gate = new Gate();
		registry = getBackgroundRegistry();
	});

	afterEach(async () => {
		// Drain anything still held open so no detached promise outlives the test.
		for (const label of [...gate.waiters.keys()]) {
			gate.waiters.get(label)?.();
		}
		await flush();
		_resetBackgroundQueueForTests();
		_resetBackgroundRegistryForTests();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		if (previousAnalyticsHome === undefined) delete process.env.PI_TEST_ANALYTICS_HOME;
		else process.env.PI_TEST_ANALYTICS_HOME = previousAnalyticsHome;
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	});

	/**
	 * Dispatch one gated task and record its settle-time slot release, like dispatchDetached does.
	 *
	 * The release reads the cap as it stands when the task settles rather than the
	 * one this dispatch was admitted under, because that is what the real helper
	 * does: it closes over a live `settings()` thunk, not a captured number.
	 */
	function dispatch(label: string, cap: number, taskId?: string) {
		liveCap = cap;
		const options: BackgroundRunOptions = {
			registry,
			runner: gate.runner(),
			spec: { role: "scout", instructions: label },
			task: label,
			cwd: agentDir as string,
			...(taskId === undefined ? {} : { taskId }),
			onSettled: (settledId) => {
				releaseBackgroundDispatch(registry, settledId, liveCap);
			},
		};
		return requestBackgroundDispatch(registry, options, cap);
	}

	describe("admission", () => {
		it("runs up to the cap and parks the overflow", () => {
			const first = dispatch("A", 2);
			const second = dispatch("B", 2);
			const third = dispatch("C", 2);
			const fourth = dispatch("D", 2);

			expect([first.admission, second.admission]).toEqual(["running", "running"]);
			expect([third.admission, fourth.admission]).toEqual(["queued", "queued"]);
			expect([third.queuePosition, fourth.queuePosition]).toEqual([1, 2]);
			expect(first.queuePosition).toBe(0);
			expect(gate.started).toEqual(["A", "B"]);
			expect(queuedTaskIds(registry)).toEqual([third.taskId, fourth.taskId]);
		});

		it("records a parked row as pending with a queued label, and starts no child for it", () => {
			const running = dispatch("A", 1);
			const parked = dispatch("B", 1);

			const row = resultRow(registry, parked.taskId);
			expect(row?.status).toBe("pending");
			expect(row?.label).toBe("scout (queued)");
			expect(row?.task).toBe("B");
			expect(row?.id).toBe(parked.taskId);
			// The running row keeps the ordinary background label.
			expect(resultRow(registry, running.taskId)?.label).toBe("scout (background)");
			// No child, so no per-task log dir was written for the parked one either.
			expect(existsSync(join(agentDir as string, BG_DIR_NAME, parked.taskId))).toBe(false);
			expect(gate.started).toEqual(["A"]);
		});

		it("honours a caller-supplied task id for a parked task", () => {
			dispatch("holder", 1);
			const parked = dispatch("A", 1, "bg_mytask01");
			expect(parked.admission).toBe("queued");
			expect(parked.taskId).toBe("bg_mytask01");
			expect(resultRow(registry, "bg_mytask01")?.status).toBe("pending");
		});

		it("reports no queue at all for a registry that has never overflowed", () => {
			dispatch("A", 4);
			expect(queuedTaskIds(registry)).toEqual([]);
			expect(queuePositionOf(registry, "bg_nope01")).toBe(0);
		});
	});

	describe("promotion", () => {
		it("promotes parked tasks FIFO as slots free, one per release", async () => {
			const a = dispatch("A", 2);
			const b = dispatch("B", 2);
			const c = dispatch("C", 2);
			const d = dispatch("D", 2);
			expect(gate.started).toEqual(["A", "B"]);

			await gate.settle("A");
			expect(gate.started).toEqual(["A", "B", "C"]);
			expect(resultRow(registry, c.taskId)?.status).toBe("running");
			expect(resultRow(registry, c.taskId)?.label).toBe("scout (background)");
			expect(queuedTaskIds(registry)).toEqual([d.taskId]);
			expect(queuePositionOf(registry, d.taskId)).toBe(1);
			// The promoted row keeps the id the model was handed at dispatch time.
			expect(gate.live()).toBe(2);

			await gate.settle("B");
			expect(gate.started).toEqual(["A", "B", "C", "D"]);
			expect(resultRow(registry, d.taskId)?.status).toBe("running");
			expect(queuedTaskIds(registry)).toEqual([]);

			await gate.settle("C");
			await gate.settle("D");
			expect(gate.started).toEqual(["A", "B", "C", "D"]);
			expect(gate.live()).toBe(0);
			expect(a.admission).toBe("running");
			expect(b.admission).toBe("running");
		});

		it("never exceeds the cap in live children, however many are dispatched", async () => {
			const ids: string[] = [];
			for (const label of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
				ids.push(dispatch(label, 3).taskId);
			}
			expect(gate.started).toEqual(["A", "B", "C"]);

			await gate.settle("A");
			expect(gate.live()).toBe(3);
			await gate.settle("B");
			expect(gate.live()).toBe(3);

			for (const label of ["C", "D", "E", "F", "G"]) {
				await gate.settle(label);
				expect(gate.live()).toBeLessThanOrEqual(3);
			}
			await gate.settle("H");
			expect(gate.started).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
			expect(ids).toHaveLength(8);
		});

		it("delivers a terminal result to the parked task's own settle callback", async () => {
			const settled: string[] = [];
			const options: BackgroundRunOptions = {
				registry,
				runner: gate.runner(),
				spec: { role: "scout", instructions: "parked" },
				task: "parked",
				cwd: agentDir as string,
				onSettled: (taskId) => {
					settled.push(taskId);
					releaseBackgroundDispatch(registry, taskId, 1);
				},
			};
			dispatch("holder", 1);
			const parked = requestBackgroundDispatch(registry, options, 1);

			await gate.settle("holder");
			expect(settled).toEqual([]); // not yet — it has only just started
			await gate.settle("parked");
			expect(settled).toEqual([parked.taskId]);
			expect(resultRow(registry, parked.taskId)?.status).toBe("completed");
		});
	});

	describe("cancellation", () => {
		it("drops a cancelled queued task without spending a slot on it", async () => {
			dispatch("A", 1);
			const parked = dispatch("B", 1);
			const after = dispatch("C", 1);

			await registry.cancel(parked.taskId, "user cancelled");
			releaseBackgroundDispatch(registry, parked.taskId, 1);

			expect(resultRow(registry, parked.taskId)?.status).toBe("cancelled");
			expect(queuedTaskIds(registry)).toEqual([after.taskId]);
			expect(queuePositionOf(registry, parked.taskId)).toBe(0);
			expect(gate.started).toEqual(["A"]); // B never got a child

			await gate.settle("A");
			expect(gate.started).toEqual(["A", "C"]); // C took the freed slot, B stayed dead
			expect(resultRow(registry, parked.taskId)?.status).toBe("cancelled");
		});

		it("frees a cancelled running task's slot for the next queued one", async () => {
			const running = dispatch("A", 1);
			const parked = dispatch("B", 1);

			await registry.cancel(running.taskId, "user cancelled");
			releaseBackgroundDispatch(registry, running.taskId, 1);

			expect(resultRow(registry, running.taskId)?.status).toBe("cancelled");
			// The row is cancelled and its slot released, so B is promoted into it.
			// The gate runner reports no pid, so `cancel` took the spawn-window
			// branch: nothing was signalled, and the fake child is still parked.
			await flush();
			expect(gate.started).toEqual(["A", "B"]);
			expect(resultRow(registry, parked.taskId)?.status).toBe("running");

			// When the abandoned child finally settles it releases a slot it no
			// longer holds — the queue must not double-advance. The row must NOT go
			// back to `completed`: a cancellation that a later self-overwrite undoes
			// is exactly the contradiction REQ-X01.4 forbids, and the fake child
			// here did exit 0, so it is the case that would regress.
			await gate.settle("A");
			expect(resultRow(registry, running.taskId)?.status).toBe("cancelled");
			expect(gate.started).toEqual(["A", "B"]);
			await gate.settle("B");
			expect(gate.live()).toBe(0);
		});
	});

	describe("robustness", () => {
		it("cannot double-promote from a double release", async () => {
			const a = dispatch("A", 2);
			dispatch("B", 2);
			dispatch("C", 2);
			const d = dispatch("D", 2);
			const e = dispatch("E", 2);

			await gate.settle("A"); // settle → release → C promoted
			expect(gate.started).toEqual(["A", "B", "C"]);

			// A second release for an id that already released — cancel racing a
			// settle, or a doubly-wired callback — must not hand out an extra slot.
			// Releasing an id this queue never admitted is harmless for the same
			// reason: the slot set is the only thing either of them can touch.
			releaseBackgroundDispatch(registry, a.taskId, 2);
			releaseBackgroundDispatch(registry, "bg_ghost00", 2);
			await flush();
			expect(gate.started).toEqual(["A", "B", "C"]);
			expect(queuedTaskIds(registry)).toEqual([d.taskId, e.taskId]);

			await gate.settle("B");
			expect(gate.started).toEqual(["A", "B", "C", "D"]);
			await gate.settle("C");
			expect(gate.started).toEqual(["A", "B", "C", "D", "E"]);
		});

		it("reclaims a slot lost when a row ended outside the settle callback", () => {
			// Simulate startup hygiene (or a foreign process) ending a row whose
			// release never fired: without the sweep the cap shrinks permanently.
			const a = dispatch("A", 2);
			dispatch("B", 2);
			registry.update(a.taskId, { status: "crashed", finishedAt: new Date().toISOString() });

			const c = dispatch("C", 2);
			expect(c.admission).toBe("running");
			expect(gate.started).toEqual(["A", "B", "C"]);
		});

		it("gives a slot freed by the sweep to the parked head, not to the newcomer", () => {
			const a = dispatch("A", 2);
			dispatch("B", 2);
			dispatch("C", 2);
			registry.update(a.taskId, { status: "crashed", finishedAt: new Date().toISOString() });

			const newcomer = dispatch("D", 2);
			// The reclaimed slot belongs to C, which was parked before D arrived, so
			// the sweep runs ahead of the cap check rather than handing D its find.
			expect(newcomer.admission).toBe("queued");
			expect(gate.started).toEqual(["A", "B", "C"]);
			expect(queuedTaskIds(registry)).toEqual([newcomer.taskId]);
		});

		it("applies a raised cap to parked work in FIFO order, without jumping the line", async () => {
			// The cap is read per dispatch, so a mid-session settings change affects
			// the next call — but widening it must not let a newcomer overtake work
			// that was already waiting, or the queue stops being fair.
			dispatch("A", 1);
			const b = dispatch("B", 1);
			const c = dispatch("C", 1);
			expect([b.admission, c.admission]).toEqual(["queued", "queued"]);
			expect(gate.started).toEqual(["A"]);

			const d = dispatch("D", 3);
			expect(d.admission).toBe("queued"); // B and C were already in line
			await flush();
			expect(gate.started).toEqual(["A", "B", "C"]); // the raised cap serves them
			expect(resultRow(registry, b.taskId)?.status).toBe("running");
			expect(queuedTaskIds(registry)).toEqual([d.taskId]);

			await gate.settle("A");
			expect(gate.started).toEqual(["A", "B", "C", "D"]);
		});

		it("clamps a nonsensical cap to one slot instead of stalling forever", () => {
			expect(normalizeDispatchCap(0)).toBe(1);
			expect(normalizeDispatchCap(-4)).toBe(1);
			expect(normalizeDispatchCap(Number.NaN)).toBe(1);
			expect(normalizeDispatchCap(Number.POSITIVE_INFINITY)).toBe(1);
			expect(normalizeDispatchCap(2.9)).toBe(2);

			// A zero cap must still run one task at a time rather than parking all
			// of them, which is what an unvalidated `maxConcurrent: 0` would do.
			const first = dispatch("A", 0);
			const second = dispatch("B", 0);
			expect(first.admission).toBe("running");
			expect(second.admission).toBe("queued");
			expect(gate.started).toEqual(["A"]);
		});
	});

	describe("isolation", () => {
		it("keeps queue state per registry instance", () => {
			dispatch("A", 1);
			const parked = dispatch("B", 1);
			expect(queuedTaskIds(registry)).toEqual([parked.taskId]);

			// A second registry (a different agent dir, or a test double) starts
			// with its own empty budget and is unaffected by this one being full.
			_resetBackgroundRegistryForTests();
			const other = getBackgroundRegistry();
			expect(other).not.toBe(registry);
			expect(queuedTaskIds(other)).toEqual([]);
			const fresh = requestBackgroundDispatch(
				other,
				{
					registry: other,
					runner: gate.runner(),
					spec: { role: "scout", instructions: "C" },
					task: "C",
					cwd: agentDir as string,
				},
				1,
			);
			expect(fresh.admission).toBe("running");
		});

		it("_resetBackgroundQueueForTests drops parked work with its registry", () => {
			dispatch("A", 1);
			const parked = dispatch("B", 1);
			expect(queuedTaskIds(registry)).toEqual([parked.taskId]);

			_resetBackgroundQueueForTests();
			expect(queuedTaskIds(registry)).toEqual([]);
			expect(queuePositionOf(registry, parked.taskId)).toBe(0);
		});
	});
});
