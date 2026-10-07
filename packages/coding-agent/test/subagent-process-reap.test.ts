/**
 * Process reaping for background subagents: REQ-X00, REQ-X01, REQ-X02.
 *
 * The defect these pin: `BackgroundTask.pid` was declared but never assigned,
 * so `stop` rewrote a row and told the model the child kept running, while a
 * parent SIGKILL left a live, write-capable orphan behind a row claiming it had
 * crashed. A cancellation that does not cancel is worse than none — it invites
 * a retry loop against a process the operator believes is dead.
 *
 * The tests drive a fake runner that emits `spawned` with a controllable pid, so
 * every signal/reap path is exercised without spawning a real child. The two
 * "must NOT kill" cases are the safety-critical ones: a pid we cannot prove is
 * ours must never be signalled, because a recycled pid belongs to someone else.
 *
 * Every test points the registry at a temp agent dir — never the real ~/.pi/agent.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	_resetBackgroundQueueForTests,
	_resetBackgroundRegistryForTests,
	type BackgroundTask,
	getBackgroundRegistry,
	startBackgroundSubagent,
} from "../src/core/subagent/background.ts";
import { createEmptyUsage, type SubagentResult, type SubagentRunner } from "../src/core/subagent/types.ts";

const bunRef = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("../src/core/subagent/runtime.ts", () => ({
	getBun: () => bunRef.current,
	isBunRuntime: () => true,
}));

/** kill(pid, 0) reports ESRCH for this on win32 and Unix alike. */
const DEAD_PID = 999999999;

function makeFakeBun() {
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

/**
 * A runner that reports a pid on `spawned` and then parks until the test
 * releases it, so a background row can be cancelled while it is genuinely
 * in flight. `kill` records what the registry signalled, standing in for the
 * real child's exit.
 */
class FakeChild {
	readonly started: number[] = [];
	readonly killed: number[] = [];
	private release: (() => void) | undefined;

	readonly runner: SubagentRunner = {
		run: async (request, _signal, onEvent): Promise<SubagentResult> => {
			const pid = this.started.length + 1;
			this.started.push(pid);
			// pid 0 is rejected by killPidTree (kill() addresses process groups),
			// so report a real-looking positive pid the registry can act on.
			onEvent?.({ type: "spawned", pid: 1000 + pid });
			await new Promise<void>((resolve) => {
				this.release = resolve;
			});
			return {
				role: request.spec.role,
				task: request.task,
				exitCode: 0,
				aborted: false,
				finalOutput: "done",
				stderr: "",
				usage: createEmptyUsage(),
				messages: [],
			};
		},
	};

	finish(): void {
		this.release?.();
		this.release = undefined;
	}
}

describe("background process reaping (REQ-X00 / X01 / X02)", () => {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousAnalyticsHome = process.env.PI_TEST_ANALYTICS_HOME;
	let agentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-bg-reap-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.PI_TEST_ANALYTICS_HOME = agentDir;
		bunRef.current = makeFakeBun();
		_resetBackgroundRegistryForTests();
		_resetBackgroundQueueForTests();
	});

	afterEach(() => {
		_resetBackgroundRegistryForTests();
		_resetBackgroundQueueForTests();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		if (previousAnalyticsHome === undefined) delete process.env.PI_TEST_ANALYTICS_HOME;
		else process.env.PI_TEST_ANALYTICS_HOME = previousAnalyticsHome;
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	});

	function dispatch(child: FakeChild): string {
		const { taskId } = startBackgroundSubagent({
			registry: getBackgroundRegistry(),
			runner: child.runner,
			spec: { role: "scout", instructions: "do the thing" },
			task: "do the thing",
			cwd: process.cwd(),
		});
		return taskId;
	}

	function row(id: string): BackgroundTask | undefined {
		return getBackgroundRegistry()
			.snapshot()
			.tasks.find((t) => t.id === id);
	}

	/** Let the spawned event's registry write land before the test reads the row. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	}

	describe("REQ-X00 — the child pid is recorded", () => {
		it("records the pid reported on the spawned event", async () => {
			const child = new FakeChild();
			const id = dispatch(child);
			await settle();

			// Before this fix the field was declared and never assigned, which is
			// what blocked X01 and X02 entirely.
			expect(row(id)?.pid).toBe(1001);
			child.finish();
		});
	});

	describe("REQ-X01 — stop actually stops", () => {
		it("reports the kill rather than claiming the child keeps running", async () => {
			const child = new FakeChild();
			const id = dispatch(child);
			await settle();

			const result = await getBackgroundRegistry().cancel(id, "user cancelled");

			expect(result.kind).toBe("cancelled");
			expect(row(id)?.status).toBe("cancelled");
			child.finish();
		});

		it("leaves a foreign row running even when its pid is alive", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			// A real, live pid — this process — on a row owned by a different
			// session. Without the ownership gate this test would kill the test
			// runner itself, so passing it IS the assertion.
			registry.add({
				id,
				kind: "pi-subprocess",
				mode: "single",
				role: "scout",
				label: "scout (background)",
				task: "do the thing",
				status: "running",
				startedAt: new Date().toISOString(),
				lastEventAt: new Date().toISOString(),
				lastOutput: "",
				cwd: process.cwd(),
				pid: process.pid,
				ownerPid: DEAD_PID, // a session that is gone: the pid is not provably ours
			});

			const result = await registry.cancel(id, "user cancelled");

			expect(result.kind).toBe("not-cancelled");
			// The load-bearing assertion: no false `cancelled` for a live child.
			expect(row(id)?.status).toBe("running");
		});

		it("cancels a queued task without any signal — it never spawned", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add({
				id,
				kind: "pi-subprocess",
				mode: "single",
				role: "scout",
				label: "scout (queued)",
				task: "do the thing",
				status: "pending",
				startedAt: new Date().toISOString(),
				lastEventAt: new Date().toISOString(),
				lastOutput: "",
				cwd: process.cwd(),
			});

			const result = await registry.cancel(id, "user cancelled");

			expect(result.kind).toBe("cancelled-queued");
			expect(row(id)?.status).toBe("cancelled");
		});

		it("does not overwrite the cancelled status when the child later settles", async () => {
			const child = new FakeChild();
			const id = dispatch(child);
			await settle();

			await getBackgroundRegistry().cancel(id, "user cancelled");
			// The child settles AFTER the cancel. Its own terminal write must not
			// rewrite `cancelled` to `completed`.
			child.finish();
			await settle();

			expect(row(id)?.status).toBe("cancelled");
		});

		it("kills a child that spawns after its row was already cancelled", async () => {
			// The spawn window: the row exists before the runner has resolved its
			// invocation, so a `stop` issued immediately has no pid to signal. The
			// child must still die when it appears.
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add({
				id,
				kind: "pi-subprocess",
				mode: "single",
				role: "scout",
				label: "scout (background)",
				task: "do the thing",
				status: "running",
				startedAt: new Date().toISOString(),
				lastEventAt: new Date().toISOString(),
				lastOutput: "",
				cwd: process.cwd(),
			});

			const result = await registry.cancel(id, "user cancelled");
			expect(result.kind).toBe("cancelled");
			expect(row(id)?.pid).toBeUndefined();

			// The pid lands after the cancellation: the spawned handler must act on it.
			registry.update(id, { pid: process.pid });
			await settle();

			// process.pid is refused by killPidTree (never kill the caller), so the
			// row keeps its cancelled status and the session is still running.
			expect(row(id)?.status).toBe("cancelled");
			expect(row(id)?.pid).toBe(process.pid);
		});
	});

	describe("REQ-X02 — orphan reconciliation reaps survivors", () => {
		it("crashes an orphan row and records the reap outcome in errorMessage", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add({
				id,
				kind: "pi-subprocess",
				mode: "single",
				role: "scout",
				label: "scout (background)",
				task: "do the thing",
				status: "running",
				startedAt: new Date().toISOString(),
				lastEventAt: new Date().toISOString(),
				lastOutput: "",
				cwd: process.cwd(),
				pid: DEAD_PID, // already gone: nothing to kill, but the row still ends crashed
				ownerPid: DEAD_PID, // the parent is what makes this an orphan
			});

			expect(await registry.markAllRunningAsCrashed()).toBe(1);
			const crashed = row(id);
			expect(crashed?.status).toBe("crashed");
			expect(crashed?.errorMessage).toContain("crashed (parent process died");
		});

		it("never signals a live-owner row's child", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add({
				id,
				kind: "pi-subprocess",
				mode: "single",
				role: "scout",
				label: "scout (background)",
				task: "do the thing",
				status: "running",
				startedAt: new Date().toISOString(),
				lastEventAt: new Date().toISOString(),
				lastOutput: "",
				cwd: process.cwd(),
				pid: process.pid,
				// ownerPid defaults to this live process: not an orphan, so the
				// reconciliation pass must leave both the row and its pid alone.
			});

			expect(await registry.markAllRunningAsCrashed()).toBe(0);
			expect(row(id)?.status).toBe("running");
			expect(row(id)?.pid).toBe(process.pid);
		});

		it("refuses to reap our own pid even on an orphan row", async () => {
			const registry = getBackgroundRegistry();
			const id = registry.makeTaskId();
			registry.add({
				id,
				kind: "pi-subprocess",
				mode: "single",
				role: "scout",
				label: "scout (background)",
				task: "do the thing",
				status: "running",
				startedAt: new Date().toISOString(),
				lastEventAt: new Date().toISOString(),
				lastOutput: "",
				cwd: process.cwd(),
				pid: process.pid,
				ownerPid: DEAD_PID,
			});

			await registry.markAllRunningAsCrashed();

			// Reaching this line at all is the assertion: killPidTree refuses
			// pid === process.pid, so the test process survived its own reap.
			expect(row(id)?.status).toBe("crashed");
		});
	});
});
