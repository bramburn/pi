/**
 * Child-side control watcher (issue #1047, Stage 2).
 *
 * The watcher is the half of the control inbox that runs inside the child, so
 * these tests drive it with a recording session stub and a real control dir on
 * a temp path — no process spawning. The invariants that matter are the
 * delivery ones: a request is claimed before it is applied, applied exactly
 * once across competing watchers, recorded with a terminal state either way, and
 * never allowed to throw into a timer callback.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONTROL_APPLIED_DIR_NAME,
	CONTROL_DIR_ENV,
	controlAppliedPath,
	controlDirFor,
	listClaimedControlRequests,
	listControlRequests,
	readControlReceipts,
	writeControlRequest,
} from "../src/core/subagent/control.ts";
import {
	type ControlWatcherSession,
	createControlWatcher,
	createControlWatcherFromEnv,
} from "../src/core/subagent/control-watcher.ts";

interface Recorded {
	steer: string[];
	interrupt: number;
	stop: number;
}

function makeSession(overrides: Partial<ControlWatcherSession> = {}): {
	session: ControlWatcherSession;
	calls: Recorded;
} {
	const calls: Recorded = { steer: [], interrupt: 0, stop: 0 };
	const session: ControlWatcherSession = {
		steer: async (text) => {
			calls.steer.push(text);
		},
		interrupt: async () => {
			calls.interrupt += 1;
		},
		stop: async () => {
			calls.stop += 1;
		},
		...overrides,
	};
	return { session, calls };
}

let root = "";
let dir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "subagent-control-watcher-"));
	dir = controlDirFor(join(root, "task-1"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Applying each action
// ---------------------------------------------------------------------------

describe("applying control actions", () => {
	it("steers the session and records queued then delivered", async () => {
		const { session, calls } = makeSession();
		writeControlRequest(dir, { action: "steer", text: "switch to the async driver" });
		const watcher = createControlWatcher({ controlDir: dir, session });

		expect(await watcher.tick()).toBe(1);
		expect(calls.steer).toEqual(["switch to the async driver"]);
		expect(readControlReceipts(dir).map((row) => row.state)).toEqual(["requested", "queued", "delivered"]);
		expect(listControlRequests(dir)).toEqual([]);
	});

	it("interrupts without touching session text", async () => {
		const { session, calls } = makeSession();
		writeControlRequest(dir, { action: "interrupt" });
		const watcher = createControlWatcher({ controlDir: dir, session });

		expect(await watcher.tick()).toBe(1);
		expect(calls.interrupt).toBe(1);
		expect(calls.steer).toEqual([]);
		expect(readControlReceipts(dir).at(-1)?.state).toBe("delivered");
	});

	it("stops the session and marks the request delivered", async () => {
		const { session, calls } = makeSession();
		const { request } = writeControlRequest(dir, { action: "stop" });
		const watcher = createControlWatcher({ controlDir: dir, session });

		await watcher.tick();
		expect(calls.stop).toBe(1);
		const ledger = readControlReceipts(dir);
		expect(ledger.at(-1)?.state).toBe("delivered");
		expect(ledger.at(-1)?.by).toBe("child");
		expect(listClaimedControlRequests(dir).map((row) => row.id)).toEqual([request.id]);
	});

	it("passes the stored steer text through unchanged", async () => {
		const { session, calls } = makeSession();
		const text = "line one\nline two\twith\ttabs";
		writeControlRequest(dir, { action: "steer", text });
		await createControlWatcher({ controlDir: dir, session }).tick();
		expect(calls.steer[0]).toBe(text);
	});
});

// ---------------------------------------------------------------------------
// Claim ordering and single delivery
// ---------------------------------------------------------------------------

describe("claim semantics", () => {
	it("claims the request file before applying it", async () => {
		const seen: string[] = [];
		const { session } = makeSession({
			steer: async () => {
				// By the time the session is touched, the request must already be
				// out of the pending directory — that is what makes a second
				// watcher's claim fail.
				seen.push(readdirSync(join(dir, CONTROL_APPLIED_DIR_NAME)).length > 0 ? "claimed" : "pending");
			},
		});
		writeControlRequest(dir, { action: "steer", text: "x" });
		await createControlWatcher({ controlDir: dir, session }).tick();
		expect(seen).toEqual(["claimed"]);
	});

	it("delivers a request only once across two watchers on the same inbox", async () => {
		const a = makeSession();
		const b = makeSession();
		writeControlRequest(dir, { action: "steer", text: "only one of us" });
		const wa = createControlWatcher({ controlDir: dir, session: a.session });
		const wb = createControlWatcher({ controlDir: dir, session: b.session });

		const both = await Promise.all([wa.tick(), wb.tick()]);
		const total = a.calls.steer.length + b.calls.steer.length;
		expect(total).toBe(1);
		// Exactly one `queued` and one `delivered` in the ledger.
		const states = readControlReceipts(dir).map((row) => row.state);
		expect(states.filter((state) => state === "queued")).toHaveLength(1);
		expect(states.filter((state) => state === "delivered")).toHaveLength(1);
		expect(both.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(1);
	});

	it("leaves an applied request out of the pending listing", async () => {
		const { session } = makeSession();
		const first = writeControlRequest(dir, { action: "steer", text: "a" });
		writeControlRequest(dir, { action: "steer", text: "b" });
		await createControlWatcher({ controlDir: dir, session, maxPerTick: 1 }).tick();
		expect(listControlRequests(dir).map((row) => row.text)).toEqual(["b"]);
		expect(listClaimedControlRequests(dir).map((row) => row.id)).toEqual([first.request.id]);
	});
});

// ---------------------------------------------------------------------------
// Failure posture
// ---------------------------------------------------------------------------

describe("failure posture", () => {
	it("records a failed apply and does not re-pend the request", async () => {
		const { session } = makeSession({
			steer: async () => {
				throw new Error("session disposed");
			},
		});
		const { request } = writeControlRequest(dir, { action: "steer", text: "doomed" });
		const watcher = createControlWatcher({ controlDir: dir, session });

		expect(await watcher.tick()).toBe(0);
		const ledger = readControlReceipts(dir);
		expect(ledger.at(-1)?.state).toBe("failed");
		expect(ledger.at(-1)?.note).toBe("session disposed");
		// Stays claimed: no infinite retry from the timer.
		expect(listControlRequests(dir)).toEqual([]);
		expect(await watcher.tick()).toBe(0);
		expect(listClaimedControlRequests(dir).map((row) => row.id)).toEqual([request.id]);
	});

	it("survives a throw from a synchronous session adapter", async () => {
		const { session } = makeSession({
			interrupt: () => {
				throw new Error("boom");
			},
		});
		writeControlRequest(dir, { action: "interrupt" });
		await expect(createControlWatcher({ controlDir: dir, session }).tick()).resolves.toBe(0);
		expect(readControlReceipts(dir).at(-1)?.note).toBe("boom");
	});

	it("fails an empty steer without calling the session", async () => {
		const { session, calls } = makeSession();
		const { request } = writeControlRequest(dir, { action: "steer", text: "" });
		await createControlWatcher({ controlDir: dir, session }).tick();
		expect(calls.steer).toEqual([]);
		const failure = readControlReceipts(dir).at(-1);
		expect(failure?.state).toBe("failed");
		expect(failure?.id).toBe(request.id);
		expect(failure?.note).toBe("empty steer message");
	});

	it("reports a tick on a missing control dir as zero work, not an error", async () => {
		const { session } = makeSession();
		const watcher = createControlWatcher({ controlDir: join(root, "absent", "control"), session });
		expect(await watcher.tick()).toBe(0);
	});

	it("never rejects the timer callback", async () => {
		vi.useFakeTimers();
		try {
			const { session } = makeSession({
				steer: async () => {
					throw new Error("nope");
				},
			});
			writeControlRequest(dir, { action: "steer", text: "x" });
			const spy = vi.spyOn(console, "error").mockImplementation(() => {
				throw new Error("unhandled error escaped the watcher");
			});
			const watcher = createControlWatcher({ controlDir: dir, session, intervalMs: 100 });
			watcher.start();
			await vi.advanceTimersByTimeAsync(250);
			watcher.stop();
			expect(spy).not.toHaveBeenCalled();
			expect(readdirSync(join(dir, CONTROL_APPLIED_DIR_NAME)).length).toBe(1);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});
});

// ---------------------------------------------------------------------------
// Ordering, bounds, and lifecycle
// ---------------------------------------------------------------------------

describe("pass bounds and lifecycle", () => {
	it("honours maxPerTick", async () => {
		const { session, calls } = makeSession();
		// Explicit ids keep the oldest-first order deterministic when several
		// requests land inside the same millisecond.
		for (const [index, text] of ["a", "b", "c"].entries()) {
			writeControlRequest(dir, { action: "steer", text, id: `req-${index}` });
		}
		const watcher = createControlWatcher({ controlDir: dir, session, maxPerTick: 2 });
		expect(await watcher.tick()).toBe(2);
		expect(calls.steer).toEqual(["a", "b"]);
		expect(await watcher.tick()).toBe(1);
		expect(calls.steer).toEqual(["a", "b", "c"]);
	});

	it("ends the pass after a stop request", async () => {
		const { session, calls } = makeSession();
		writeControlRequest(dir, { action: "stop", id: "a-stop" });
		// A steer filed after the stop must not be applied to a stopping session.
		writeControlRequest(dir, { action: "steer", text: "too late", id: "b-steer" });
		await createControlWatcher({ controlDir: dir, session }).tick();
		expect(calls.stop).toBe(1);
		expect(calls.steer).toEqual([]);
		expect(listControlRequests(dir).map((row) => row.action)).toEqual(["steer"]);
	});

	it("does not overlap passes while an apply is in flight", async () => {
		const release: string[] = [];
		let gate: { resolve: () => void } | undefined;
		const { session } = makeSession({
			steer: async () => {
				release.push("in");
				await new Promise<void>((resolve) => {
					gate = { resolve };
				});
				release.push("out");
			},
		});
		writeControlRequest(dir, { action: "steer", text: "slow" });
		const watcher = createControlWatcher({ controlDir: dir, session });
		const first = watcher.tick();
		const second = await watcher.tick();
		expect(second).toBe(0);
		gate?.resolve();
		expect(await first).toBe(1);
		expect(release).toEqual(["in", "out"]);
	});

	it("start and stop are idempotent and stop ends polling", () => {
		const { session } = makeSession();
		const watcher = createControlWatcher({ controlDir: dir, session, intervalMs: 1000 });
		expect(watcher.isRunning()).toBe(false);
		watcher.start();
		expect(watcher.isRunning()).toBe(true);
		watcher.start();
		expect(watcher.isRunning()).toBe(true);
		watcher.stop();
		expect(watcher.isRunning()).toBe(false);
		watcher.stop();
		// A stopped watcher stays stopped.
		watcher.start();
		expect(watcher.isRunning()).toBe(false);
	});

	it("collects stale applied requests on a prune sweep", async () => {
		const { session } = makeSession();
		const { request } = writeControlRequest(dir, { action: "steer", text: "aged" });
		await createControlWatcher({ controlDir: dir, session, pruneEveryTicks: 1 }).tick();
		// Backdate the claim so the sweep considers it expired.
		const claimed = listClaimedControlRequests(dir)[0];
		writeFileSync(
			controlAppliedPath(dir, request.id),
			JSON.stringify({ ...claimed, createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }),
		);
		await createControlWatcher({ controlDir: dir, session, pruneEveryTicks: 1 }).tick();
		expect(listClaimedControlRequests(dir)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Environment gating
// ---------------------------------------------------------------------------

describe("createControlWatcherFromEnv", () => {
	it("returns undefined when the environment names no control dir", () => {
		const { session } = makeSession();
		expect(createControlWatcherFromEnv(session, {})).toBeUndefined();
		expect(createControlWatcherFromEnv(session, { [CONTROL_DIR_ENV]: "  " })).toBeUndefined();
	});

	it("wires a watcher to the control dir named by the environment", async () => {
		const { session, calls } = makeSession();
		writeControlRequest(dir, { action: "steer", text: "via env" });
		const watcher = createControlWatcherFromEnv(session, { [CONTROL_DIR_ENV]: dir });
		expect(watcher).toBeDefined();
		await watcher?.tick();
		expect(calls.steer).toEqual(["via env"]);
	});
});
