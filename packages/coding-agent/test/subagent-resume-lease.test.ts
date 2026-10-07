/**
 * resume + session-lease coverage for the native subagent tool.
 *
 * Three layers, in the order a resume actually travels through them:
 *
 *   1. `resolveResumeTarget` — every rejection is a hard error, because
 *      resuming is a claim about one specific child session file. A silent
 *      fallback dispatch would report a result nobody asked for, and resuming
 *      a session another process still writes puts two writers on one JSONL.
 *   2. `session-lease` — the cross-process guard that makes the claim safe.
 *      Acquire/release round-trips, the token gate on release, and the
 *      deliberate asymmetry in stale-breaking (`spawning` is never breakable;
 *      a recorded writer must also be proven gone).
 *   3. The tool itself — `action="resume"` end to end through
 *      `createSubagentToolDefinition` with a stub runner, asserting both the
 *      dispatched spec and the lease's lifetime across the hand-off.
 *
 * Everything points at a temp agent dir: never the real ~/.pi/agent.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	_resetBackgroundRegistryForTests,
	type BackgroundRegistry,
	type BackgroundTask,
	getBackgroundRegistry,
	type TaskStatus,
} from "../src/core/subagent/background.ts";
import {
	acquireSessionLease,
	canonicalSessionFilePath,
	inspectSessionLease,
	releaseSessionLease,
	SESSION_LEASE_FILE,
	SessionLeaseConflictError,
	type SessionLeaseOwner,
	sessionLeaseDir,
	sessionLeaseRootDir,
} from "../src/core/subagent/session-lease.ts";
import {
	buildResumeInstructions,
	createSubagentToolDefinition,
	resolveResumeTarget,
} from "../src/core/subagent/subagent-tool.ts";
import {
	createEmptyUsage,
	type InFlightRun,
	type SubagentResult,
	type SubagentRunner,
	type SubagentRunRequest,
} from "../src/core/subagent/types.ts";

/** A pid that cannot exist: `kill(pid, 0)` reports ESRCH on win32 and Unix alike. */
const DEAD_PID = 999999999;

let agentDir: string;
const previousAgentDir = process.env[ENV_AGENT_DIR];
const previousAnalyticsHome = process.env.PI_TEST_ANALYTICS_HOME;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-resume-"));
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
	rmSync(agentDir, { recursive: true, force: true });
});

/** A real child session file inside the temp agent dir. */
function childSession(name: string): string {
	const path = join(agentDir, name);
	writeFileSync(path, `${JSON.stringify({ type: "session_start", name })}\n`, "utf8");
	return path;
}

function makeRow(id: string, status: TaskStatus, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	const now = new Date().toISOString();
	return {
		id,
		kind: "pi-subprocess",
		mode: "single",
		role: "researcher",
		label: `researcher (${id})`,
		task: "summarise the changelog",
		status,
		startedAt: now,
		lastEventAt: now,
		lastOutput: "",
		cwd: process.cwd(),
		...overrides,
	};
}

function addRow(id: string, status: TaskStatus, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	const row = makeRow(id, status, overrides);
	getBackgroundRegistry().add(row);
	return row;
}

// ============================================================================
// A. resolveResumeTarget
// ============================================================================

describe("resolveResumeTarget", () => {
	it("rejects a missing id before touching the registry", () => {
		expect(() => resolveResumeTarget(getBackgroundRegistry(), undefined)).toThrow(/action="resume" requires `id`/);
		expect(() => resolveResumeTarget(getBackgroundRegistry(), "   ")).toThrow(/action="resume" requires `id`/);
	});

	it("rejects an unknown id and lists the ids that do exist", () => {
		addRow("bg_alpha", "completed");
		addRow("bg_beta", "completed");
		expect(() => resolveResumeTarget(getBackgroundRegistry(), "bg_missing")).toThrow(
			/Unknown subagent run "bg_missing" \(background: bg_alpha, bg_beta\)/,
		);
	});

	it("says 'none' when no background rows exist at all", () => {
		expect(() => resolveResumeTarget(getBackgroundRegistry(), "bg_ghost")).toThrow(
			/Unknown subagent run "bg_ghost" \(background: none\)/,
		);
	});

	it("refuses a row that is still running — there is nothing settled to resume", () => {
		addRow("bg_live", "running");
		expect(() => resolveResumeTarget(getBackgroundRegistry(), "bg_live")).toThrow(
			/Background task bg_live is still running, so it has not settled and there is nothing to resume\. Use action="steer"/,
		);
	});

	it("refuses a pending row for the same reason", () => {
		addRow("bg_pending", "pending");
		expect(() => resolveResumeTarget(getBackgroundRegistry(), "bg_pending")).toThrow(
			/Background task bg_pending is still pending/,
		);
	});

	it("refuses a cancelled row — cancellation never signalled the detached child", () => {
		addRow("bg_killed", "cancelled", { sessionFile: childSession("cancelled.jsonl") });
		expect(() => resolveResumeTarget(getBackgroundRegistry(), "bg_killed")).toThrow(
			/Background task bg_killed was cancelled, so it cannot be resumed/,
		);
	});

	it("refuses a settled row that never reported a session file", () => {
		addRow("bg_nosession", "completed");
		expect(() => resolveResumeTarget(getBackgroundRegistry(), "bg_nosession")).toThrow(
			/\(status=completed\) settled before the child reported a session file/,
		);
	});

	it("refuses a settled row whose session file was pruned or moved", () => {
		const gone = join(agentDir, "pruned.jsonl");
		addRow("bg_pruned", "completed", { sessionFile: gone });
		expect(() => resolveResumeTarget(getBackgroundRegistry(), "bg_pruned")).toThrow(
			/which no longer exists on disk \(pruned or moved\)/,
		);
	});

	it("returns a background target for a settled row with a live session file", () => {
		const sessionFile = childSession("resumable.jsonl");
		addRow("bg_ok", "completed", { sessionFile, model: "anthropic/claude-sonnet-4" });
		const target = resolveResumeTarget(getBackgroundRegistry(), "bg_ok");
		expect(target).toEqual({
			kind: "background",
			id: "bg_ok",
			role: "researcher",
			cwd: process.cwd(),
			sessionFile,
			model: "anthropic/claude-sonnet-4",
			warnings: [
				"Note: background rows do not record a tools allowlist, so the resumed run uses the full tool set.",
			],
		});
	});

	it("omits `model` when the row pinned none, and accepts a failed row", () => {
		const sessionFile = childSession("failed.jsonl");
		addRow("bg_failed", "failed", { sessionFile });
		const target = resolveResumeTarget(getBackgroundRegistry(), "bg_failed");
		expect(target.kind).toBe("background");
		expect("model" in target).toBe(false);
		expect(target.sessionFile).toBe(sessionFile);
	});

	it("builds the default continuation instruction when no message is given", () => {
		expect(buildResumeInstructions(undefined)).toBe("[RESUME] Continue from where your session left off.");
		expect(buildResumeInstructions("   ")).toBe("[RESUME] Continue from where your session left off.");
	});

	it("prefixes a caller message with the resume marker and appends the continuation note", () => {
		expect(buildResumeInstructions("Pick up at step 4")).toBe(
			"[RESUME] Pick up at step 4\n\n---\n\nContinue from where your session left off.",
		);
	});
});

// ============================================================================
// B. session-lease
// ============================================================================

describe("session-lease", () => {
	const request = (sessionFile: string, runId: string) => ({
		sessionFile,
		runId,
		sourceRunId: "bg_source",
	});

	it("acquires under the agent dir and reports the holder through inspect", () => {
		const sessionFile = childSession("lease-a.jsonl");
		const handle = acquireSessionLease(request(sessionFile, "resume-bg_a"), { pid: process.pid });
		expect(handle.leaseDir.startsWith(sessionLeaseRootDir())).toBe(true);
		expect(handle.leaseDir).toBe(sessionLeaseDir(sessionFile));
		const inspection = inspectSessionLease(sessionFile);
		expect(inspection.state).toBe("owned");
		if (inspection.state !== "owned") throw new Error("expected owned");
		expect(inspection.owner.runId).toBe("resume-bg_a");
		expect(inspection.owner.sourceRunId).toBe("bg_source");
		expect(inspection.owner.writerState).toBe("none");
		expect(releaseSessionLease(handle)).toBe(true);
		expect(inspectSessionLease(sessionFile).state).toBe("free");
	});

	it("conflicts when the holder is alive, naming both runs", () => {
		const sessionFile = childSession("lease-conflict.jsonl");
		const first = acquireSessionLease(request(sessionFile, "resume-first"), { pid: process.pid });
		try {
			expect(() => acquireSessionLease(request(sessionFile, "resume-second"), { pid: process.pid })).toThrow(
				SessionLeaseConflictError,
			);
		} finally {
			releaseSessionLease(first);
		}
		expect(inspectSessionLease(sessionFile).state).toBe("free");
	});

	it("refuses to release with a foreign token, leaving the successor's lease intact", () => {
		const sessionFile = childSession("lease-token.jsonl");
		const handle = acquireSessionLease(request(sessionFile, "resume-token"), { pid: process.pid });
		const forged = { ...handle, owner: { ...handle.owner, token: "not-the-issued-token" } };
		expect(releaseSessionLease(forged)).toBe(false);
		expect(inspectSessionLease(sessionFile).state).toBe("owned");
		expect(releaseSessionLease(handle)).toBe(true);
		// Idempotent: the directory is already gone, so the second release is a no-op.
		expect(releaseSessionLease(handle)).toBe(false);
	});

	it("reports an unreadable record as unverifiable instead of free", () => {
		const sessionFile = childSession("lease-corrupt.jsonl");
		const leaseDir = sessionLeaseDir(sessionFile);
		mkdirSync(leaseDir, { recursive: true });
		writeFileSync(join(leaseDir, SESSION_LEASE_FILE), "{ not json", "utf8");
		expect(inspectSessionLease(sessionFile).state).toBe("unreadable");
		expect(() => acquireSessionLease(request(sessionFile, "resume-corrupt"), { pid: process.pid })).toThrow(
			SessionLeaseConflictError,
		);
	});

	it("breaks a stale lease whose dead holder recorded no writer, keeping a tombstone", () => {
		const sessionFile = childSession("lease-stale.jsonl");
		const canonical = canonicalSessionFilePath(sessionFile);
		writeStaleLease(canonical, { pid: DEAD_PID, writerState: "none", token: "stale-token" });
		const handle = acquireSessionLease(request(sessionFile, "resume-reclaimed"), {
			pid: process.pid,
			isProcessAlive: (pid) => pid !== DEAD_PID,
		});
		const inspection = inspectSessionLease(sessionFile);
		expect(inspection.state).toBe("owned");
		if (inspection.state !== "owned") throw new Error("expected owned");
		expect(inspection.owner.runId).toBe("resume-reclaimed");
		expect(readdirSync(sessionLeaseRootDir()).some((name) => name.endsWith(".stale-stale-token"))).toBe(true);
		releaseSessionLease(handle);
	});

	it("never breaks a lease held by a live process", () => {
		const sessionFile = childSession("lease-live.jsonl");
		writeStaleLease(canonicalSessionFilePath(sessionFile), {
			pid: DEAD_PID,
			writerState: "none",
			token: "stale-token",
		});
		expect(() =>
			acquireSessionLease(request(sessionFile, "resume-rival"), {
				pid: process.pid,
				// The recorded holder pid is alive after all: the probe says so.
				isProcessAlive: () => true,
			}),
		).toThrow(SessionLeaseConflictError);
	});

	it("never breaks an ownerless 'spawning' lease — the child may still be coming up", () => {
		const sessionFile = childSession("lease-spawning.jsonl");
		writeStaleLease(canonicalSessionFilePath(sessionFile), {
			pid: DEAD_PID,
			writerState: "spawning",
			token: "stale-token",
		});
		expect(() =>
			acquireSessionLease(request(sessionFile, "resume-impatient"), {
				pid: process.pid,
				isProcessAlive: (pid) => pid !== DEAD_PID,
			}),
		).toThrow(SessionLeaseConflictError);
	});

	it("breaks a lease only once the recorded writer is also proven gone", () => {
		const sessionFile = childSession("lease-writer.jsonl");
		const canonical = canonicalSessionFilePath(sessionFile);
		writeStaleLease(canonical, {
			pid: DEAD_PID,
			writerState: "running",
			writerPid: DEAD_PID + 1,
			token: "stale-writer-token",
		});
		// The writer outlived its parent: still writing that JSONL, so the lease holds.
		expect(() =>
			acquireSessionLease(request(sessionFile, "resume-cautious"), {
				pid: process.pid,
				isProcessAlive: (pid) => pid !== DEAD_PID,
			}),
		).toThrow(SessionLeaseConflictError);
		// Both processes gone: reclaiming is safe.
		const handle = acquireSessionLease(request(sessionFile, "resume-safe"), {
			pid: process.pid,
			isProcessAlive: () => false,
			getProcessStartIdentity: () => undefined,
		});
		expect(inspectSessionLease(sessionFile).state).toBe("owned");
		releaseSessionLease(handle);
	});

	/** Write a lease record by hand, as a crashed predecessor would leave it. */
	function writeStaleLease(
		canonicalSessionFile: string,
		overrides: {
			pid: number;
			writerState: SessionLeaseOwner["writerState"];
			writerPid?: number;
			token: string;
		},
	): void {
		const leaseDir = sessionLeaseDir(canonicalSessionFile);
		mkdirSync(leaseDir, { recursive: true });
		const owner: SessionLeaseOwner = {
			version: 1,
			token: overrides.token,
			canonicalSessionFile,
			runId: "resume-crashed",
			sourceRunId: "bg_source",
			pid: overrides.pid,
			hostname: hostname(),
			writerState: overrides.writerState,
			...(overrides.writerPid === undefined ? {} : { writerPid: overrides.writerPid }),
			acquiredAt: new Date(0).toISOString(),
			acquiredAtMs: 0,
			updatedAtMs: 0,
		};
		writeFileSync(join(leaseDir, SESSION_LEASE_FILE), JSON.stringify(owner, null, 2), "utf8");
	}
});

// ============================================================================
// C. action="resume" end to end
// ============================================================================

describe("action=resume dispatch", () => {
	/** Runner stub that records what it was asked to run and succeeds immediately. */
	function stubRunner(
		capture: SubagentRunRequest[],
		options: { result?: Partial<SubagentResult>; inFlight?: InFlightRun[] } = {},
	): SubagentRunner {
		return {
			async run(request): Promise<SubagentResult> {
				capture.push(request);
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 0,
					aborted: false,
					finalOutput: "resumed ok",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
					stopReason: "completed",
					...options.result,
				};
			},
			listRunning: () => options.inFlight ?? [],
			async interrupt() {
				return true;
			},
		};
	}

	function settlement(): {
		promise: Promise<SubagentResult>;
		resolve: (taskId: string, result: SubagentResult) => void;
	} {
		let resolve!: (taskId: string, result: SubagentResult) => void;
		const promise = new Promise<SubagentResult>((res) => {
			resolve = (_taskId: string, result: SubagentResult) => res(result);
		});
		return { promise, resolve };
	}

	/** Drop the trailing `undefined as never` context arg the tool signature requires. */
	async function executeResume(
		tool: ReturnType<typeof createSubagentToolDefinition>,
		params: Record<string, unknown>,
	): Promise<{ text: string; details: { taskIds?: string[]; background?: boolean } }> {
		const result = await tool.execute("tc-resume", params, undefined, undefined, undefined as never);
		const first = result.content[0] as { text: string };
		return {
			text: first.text,
			details: (result.details ?? {}) as { taskIds?: string[]; background?: boolean },
		};
	}

	it("re-dispatches against the same child session and reports the new task id", async () => {
		const sessionFile = childSession("resume-e2e.jsonl");
		addRow("bg_e2e", "completed", { sessionFile });
		const capture: SubagentRunRequest[] = [];
		const settled = settlement();
		const registry: BackgroundRegistry = getBackgroundRegistry();
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: stubRunner(capture, { result: { sessionFile } }),
			registry,
			onBackgroundSettled: (_taskId, result) => settled.resolve(_taskId, result),
		});

		const { text, details } = await executeResume(tool, {
			action: "resume",
			id: "bg_e2e",
			background: true,
		});

		const taskId = details.taskIds?.[0] as string;
		expect(taskId).toMatch(/^bg_/);
		expect(text).toContain(
			`Resumed background run bg_e2e (role=researcher), resuming child session ${sessionFile} as detached task ${taskId}.`,
		);
		expect(text).toContain("background rows do not record a tools allowlist");
		expect(details.background).toBe(true);
		expect(capture).toHaveLength(1);
		expect(capture[0]?.spec.role).toBe("researcher");
		expect(capture[0]?.spec.sessionFile).toBe(sessionFile);
		expect(capture[0]?.spec.cwd).toBe(process.cwd());
		expect(capture[0]?.spec.instructions).toBe("[RESUME] Continue from where your session left off.");
		expect(capture[0]?.task).toBe(capture[0]?.spec.instructions);

		await settled.promise;
		const row = registry.snapshot().tasks.find((task) => task.id === taskId);
		expect(row?.status).toBe("completed");
		expect(row?.role).toBe("researcher");
		expect(row?.lastOutput).toBe("resumed ok");
		// The replacement reopens the same child session, so the row is resumable again.
		expect(row?.sessionFile).toBe(sessionFile);
	});

	it("threads the caller's message into the continuation instruction", async () => {
		const sessionFile = childSession("resume-message.jsonl");
		addRow("bg_message", "completed", { sessionFile });
		const capture: SubagentRunRequest[] = [];
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: stubRunner(capture),
			registry: getBackgroundRegistry(),
		});

		await executeResume(tool, { action: "resume", id: "bg_message", message: "Pick up at step 4", background: true });

		expect(capture[0]?.spec.instructions).toBe(
			"[RESUME] Pick up at step 4\n\n---\n\nContinue from where your session left off.",
		);
	});

	it("holds the lease across the redispatch and hands it to the settle path", async () => {
		const sessionFile = childSession("resume-lease.jsonl");
		addRow("bg_lease", "completed", { sessionFile });
		const capture: SubagentRunRequest[] = [];
		const leaseStates: string[] = [];
		const runner: SubagentRunner = {
			async run(request) {
				// The lease must already exist here: the replacement is about to
				// open this very session file.
				const inspection = inspectSessionLease(sessionFile);
				leaseStates.push(inspection.state === "owned" ? `owned:${inspection.owner.runId}` : inspection.state);
				capture.push(request);
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 0,
					aborted: false,
					finalOutput: "resumed ok",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
					stopReason: "completed",
					sessionFile,
				};
			},
			listRunning: () => [],
		};
		const settled = settlement();
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner,
			registry: getBackgroundRegistry(),
			onBackgroundSettled: (taskId, result) => settled.resolve(taskId, result),
		});

		await executeResume(tool, { action: "resume", id: "bg_lease", background: true });
		// The detached child owns the lease while it runs...
		expect(leaseStates).toEqual(["owned:resume-bg_lease"]);
		// ...and the settle path is the last moment it can be writing, so the
		// lease is released there rather than in the redirect's own `finally`.
		await settled.promise;
		expect(inspectSessionLease(sessionFile).state).toBe("free");
	});

	it("refuses to resume a background row that has not settled, dispatching nothing", async () => {
		addRow("bg_still_running", "running");
		const capture: SubagentRunRequest[] = [];
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: stubRunner(capture),
			registry: getBackgroundRegistry(),
		});
		await expect(executeResume(tool, { action: "resume", id: "bg_still_running", background: true })).rejects.toThrow(
			/Background task bg_still_running is still running, so it has not settled and there is nothing to resume/,
		);
		expect(capture).toHaveLength(0);
	});

	it("refuses an inline in-flight id — an unfinished run is not resumable", async () => {
		const inFlight: InFlightRun = {
			runId: "inline-1",
			role: "researcher",
			task: "still working",
			cwd: process.cwd(),
			startedAt: new Date().toISOString(),
			sessionFile: childSession("inline.jsonl"),
		};
		const capture: SubagentRunRequest[] = [];
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: stubRunner(capture, { inFlight: [inFlight] }),
			registry: getBackgroundRegistry(),
		});
		await expect(executeResume(tool, { action: "resume", id: "inline-1", background: true })).rejects.toThrow(
			/Inline run inline-1 is still running, so there is nothing to resume\. Use action="steer"/,
		);
		expect(capture).toHaveLength(0);
	});

	it("refuses `model` on resume, pointing at swap-model", async () => {
		const capture: SubagentRunRequest[] = [];
		const tool = createSubagentToolDefinition(process.cwd(), {
			runner: stubRunner(capture),
			registry: getBackgroundRegistry(),
		});
		await expect(
			executeResume(tool, { action: "resume", id: "bg_anything", model: "anthropic/other", background: true }),
		).rejects.toThrow(/action="resume" does not take `model`/);
		expect(capture).toHaveLength(0);
	});

	it("surfaces a second resume while the first replacement is still leased", async () => {
		const sessionFile = childSession("resume-conflict.jsonl");
		addRow("bg_conflict", "completed", { sessionFile });
		// A live lease on the same session file, as a concurrent pi process would hold.
		const holder = acquireSessionLease(
			{ sessionFile, runId: "resume-other", sourceRunId: "bg_other" },
			{ pid: process.pid },
		);
		const capture: SubagentRunRequest[] = [];
		try {
			const tool = createSubagentToolDefinition(process.cwd(), {
				runner: stubRunner(capture),
				registry: getBackgroundRegistry(),
			});
			await expect(executeResume(tool, { action: "resume", id: "bg_conflict", background: true })).rejects.toThrow(
				/Cannot resume run bg_conflict: /,
			);
			expect(capture).toHaveLength(0);
		} finally {
			releaseSessionLease(holder);
		}
	});
});
