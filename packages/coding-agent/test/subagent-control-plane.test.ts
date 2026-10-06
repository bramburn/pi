/**
 * Stage 4 wiring for issues #1047 (file control inbox + steer receipts) and
 * #1048 (supervisor channel).
 *
 * These tests drive the *tool* — `createSubagentToolDefinition(...).execute(...)`
 * with a stub registry and runner — because the point of this stage is not the
 * control primitives (covered by `subagent-control.test.ts` and
 * `subagent-control-watcher.test.ts`) but that the existing management actions
 * now write to the file plane alongside the in-process path, that `status`
 * reports the receipt state, and that the new `supervisor` action can read and
 * answer a child's open questions.
 *
 * The agent dir is redirected to a temp directory so the inline control-plane
 * paths (`<agentDir>/subagent-control/<runId>/`) and the background rows'
 * (`<agentDir>/subagent-bg/<taskId>/`) land in the sandbox.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	type BackgroundRegistry,
	type BackgroundTask,
	backgroundTaskDir,
	type CancelResult,
} from "../src/core/subagent/background.ts";
import {
	CONTROL_APPLIED_DIR_NAME,
	CONTROL_RECEIPTS_FILE,
	CONTROL_REQUESTS_DIR_NAME,
	controlReceiptStates,
	listClaimedControlRequests,
	listControlRequests,
} from "../src/core/subagent/control.ts";
import {
	createSubagentToolDefinition,
	inlineTaskDir,
	runControlDir,
	runSupervisorDir,
	runTaskDir,
} from "../src/core/subagent/subagent-tool.ts";
import {
	ensureSupervisorDir,
	postSupervisorRequest,
	readSupervisorReply,
	readSupervisorRequest,
	supervisorRepliesDir,
} from "../src/core/subagent/supervisor-channel.ts";
import type { InFlightRun, SubagentResult, SubagentRunner } from "../src/core/subagent/types.ts";

let agentDir = "";
const previousAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-control-plane-"));
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

function taskRow(id: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	const now = new Date().toISOString();
	return {
		id,
		kind: "pi-subprocess",
		mode: "single",
		role: "worker",
		label: id,
		task: "read the module and report",
		status: "running",
		startedAt: now,
		lastEventAt: now,
		lastOutput: "",
		cwd: process.cwd(),
		pid: 4242,
		ownerPid: process.pid,
		...overrides,
	};
}

interface StubRegistryOptions {
	tasks?: BackgroundTask[];
	cancel?: (taskId: string) => CancelResult;
}

/**
 * The management plane only reads rows and cancels them here, so the stub keeps
 * the `BackgroundRegistry` surface mutable where the tests need it and inert
 * everywhere else.
 */
function stubRegistry(options: StubRegistryOptions = {}): BackgroundRegistry {
	const tasks = options.tasks ?? [];
	return {
		makeTaskId: () => `bg_test_${Math.random().toString(36).slice(2)}`,
		add() {},
		update() {},
		appendLog() {},
		listRunning: () => tasks.filter((task) => task.status === "running" || task.status === "pending"),
		snapshot: () => ({ tasks: [...tasks] }),
		markAllRunningAsCrashed: async () => 0,
		prune: async () => 0,
		cancel: async (taskId) => (options.cancel === undefined ? { kind: "cancelled-queued" } : options.cancel(taskId)),
	};
}

function inlineRun(runId: string, overrides: Partial<InFlightRun> = {}): InFlightRun {
	return {
		runId,
		role: "worker",
		task: "read the module and report",
		cwd: process.cwd(),
		startedAt: new Date().toISOString(),
		pid: 9100,
		...overrides,
	};
}

interface StubRunnerOptions {
	running?: InFlightRun[];
	/** Returned by `interrupt`. `undefined` means the runner has no control plane. */
	interruptResult?: boolean;
}

function stubRunner(options: StubRunnerOptions = {}): SubagentRunner & { interrupted: string[] } {
	const interrupted: string[] = [];
	const running = options.running ?? [];
	const runner: SubagentRunner & { interrupted: string[] } = {
		interrupted,
		async run(request): Promise<SubagentResult> {
			// No test in this file dispatches a replacement run; a call here means the
			// assertion under test reached the wrong branch.
			throw new Error(`stub runner must not be asked to run: ${request.task}`);
		},
	};
	if (options.running !== undefined) {
		runner.listRunning = () => running;
	}
	if (options.interruptResult !== undefined) {
		runner.interrupt = async (runId) => {
			interrupted.push(runId);
			return options.interruptResult === true;
		};
	}
	return runner;
}

function makeTool(registry: BackgroundRegistry, runner: SubagentRunner) {
	return createSubagentToolDefinition(process.cwd(), { registry, runner });
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

/**
 * Everything the tool wrote for one run's inbox: pending requests, claimed
 * requests, and the receipt ledger's newest state per request id.
 */
function readInbox(dir: string) {
	const pending = listControlRequests(dir);
	const claimed = listClaimedControlRequests(dir);
	const states = controlReceiptStates(dir);
	return {
		pending,
		claimed,
		all: [...pending, ...claimed],
		stateOf: (id: string) => states.get(id)?.state,
		noteOf: (id: string) => states.get(id)?.note,
		// Claim status is the request file's location: `applied/` means someone has
		// taken it, which the receipts ledger does not record.
		isClaimed: (id: string) => claimed.some((request) => request.id === id),
		raw: existsSync(join(dir, CONTROL_RECEIPTS_FILE)) ? readFileSync(join(dir, CONTROL_RECEIPTS_FILE), "utf8") : "",
	};
}

describe("control-plane directory addressing", () => {
	it("uses the inline directory for an id the registry does not know", () => {
		const registry = stubRegistry();
		expect(runTaskDir("inline-1", registry)).toBe(join(agentDir, "subagent-control", "inline-1"));
		expect(runTaskDir("inline-1", registry)).toBe(inlineTaskDir("inline-1"));
		expect(runControlDir("inline-1", registry)).toBe(join(inlineTaskDir("inline-1"), "control"));
		expect(runSupervisorDir("inline-1", registry)).toBe(join(inlineTaskDir("inline-1"), "supervisor"));
	});

	it("uses the background row's own directory for a registry id", () => {
		const registry = stubRegistry({ tasks: [taskRow("bg_row")] });
		expect(runTaskDir("bg_row", registry)).toBe(backgroundTaskDir("bg_row"));
		expect(runControlDir("bg_row", registry)).toBe(join(backgroundTaskDir("bg_row"), "control"));
	});

	it("resolves without a registry at all (foreground-only callers)", () => {
		expect(runTaskDir("solo")).toBe(inlineTaskDir("solo"));
	});
});

describe('action="stop" / "interrupt" on an inline run', () => {
	it("files the request before the kill and marks it delivered and claimed", async () => {
		const runner = stubRunner({ running: [inlineRun("in-1")], interruptResult: true });
		const registry = stubRegistry();
		const tool = makeTool(registry, runner);

		const result = await tool.execute("t1", { action: "stop", id: "in-1" }, undefined, undefined, undefined as never);
		expect(textOf(result)).toContain("Interrupted inline run in-1");
		expect(runner.interrupted).toEqual(["in-1"]);

		const inbox = readInbox(runControlDir("in-1", registry));
		expect(inbox.all).toHaveLength(1);
		const request = inbox.all[0]!;
		expect(request.action).toBe("stop");
		expect(request.targetId).toBe("in-1");
		// Only steers carry body text on disk; a stop is a bare signal.
		expect(request.text).toBeUndefined();
		expect(inbox.stateOf(request.id)).toBe("delivered");
		expect(inbox.noteOf(request.id)).toBe("killed inline run in-1");
		// Claimed: the parent already served the kill, so the child's watcher must
		// not apply the same stop a second time.
		expect(inbox.isClaimed(request.id)).toBe(true);
		expect(inbox.pending).toHaveLength(0);
		expect(inbox.claimed).toHaveLength(1);
		expect(existsSync(join(runControlDir("in-1", registry), CONTROL_REQUESTS_DIR_NAME, `${request.id}.json`))).toBe(
			false,
		);
		expect(
			readdirSync(join(runControlDir("in-1", registry), CONTROL_APPLIED_DIR_NAME)).some((name) =>
				name.startsWith(request.id),
			),
		).toBe(true);
		// The full requested -> delivered chain is readable in the ledger.
		expect(inbox.raw).toContain('"requested"');
		expect(inbox.raw).toContain('"scheduled"');
		expect(inbox.raw).toContain('"delivered"');
	});

	it("files the request under the inline task dir the child's watcher will read", async () => {
		const runner = stubRunner({ running: [inlineRun("in-2")], interruptResult: true });
		const registry = stubRegistry();
		const tool = makeTool(registry, runner);
		await tool.execute("t1", { action: "interrupt", id: "in-2" }, undefined, undefined, undefined as never);

		const dir = join(agentDir, "subagent-control", "in-2", "control");
		expect(existsSync(dir)).toBe(true);
		const requests = listControlRequests(dir);
		expect(requests).toHaveLength(0);
		const claimed = listClaimedControlRequests(dir);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]!.action).toBe("interrupt");
	});

	it("records a failed receipt and leaves the request claimable when the kill did not land", async () => {
		const runner = stubRunner({ running: [inlineRun("in-3")], interruptResult: false });
		const registry = stubRegistry();
		const tool = makeTool(registry, runner);

		await expect(
			tool.execute("t1", { action: "stop", id: "in-3" }, undefined, undefined, undefined as never),
		).rejects.toThrow("could not be interrupted");

		const inbox = readInbox(runControlDir("in-3", registry));
		expect(inbox.pending).toHaveLength(1);
		expect(inbox.stateOf(inbox.pending[0]!.id)).toBe("failed");
		expect(inbox.noteOf(inbox.pending[0]!.id)).toBe("settled before the kill landed");
		expect(inbox.isClaimed(inbox.pending[0]!.id)).toBe(false);
	});

	it("throws before touching the file plane when the id is missing", async () => {
		const registry = stubRegistry();
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));
		await expect(
			tool.execute("t1", { action: "stop", id: "   " }, undefined, undefined, undefined as never),
		).rejects.toThrow("requires `id`");
		expect(existsSync(runControlDir("   ", registry))).toBe(false);
	});

	it("keeps the kill in band for a runner with no control plane, filing nothing", async () => {
		// A runner that cannot list in-flight work cannot address an inline id, so
		// the call falls through to the background namespace and reports the miss —
		// "no inline candidates" must never be read as "this id is inline".
		const registry = stubRegistry();
		const tool = makeTool(registry, stubRunner());
		await expect(
			tool.execute("t1", { action: "stop", id: "ghost" }, undefined, undefined, undefined as never),
		).rejects.toThrow();
		expect(existsSync(runControlDir("ghost", registry))).toBe(false);
	});
});

describe('action="stop" / "interrupt" on a background row', () => {
	it("files the request and settles it delivered when the cancel reached the child", async () => {
		const registry = stubRegistry({
			tasks: [taskRow("bg-1")],
			cancel: () => ({ kind: "cancelled", pid: 4242, killed: true }),
		});
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));

		const result = await tool.execute("t1", { action: "stop", id: "bg-1" }, undefined, undefined, undefined as never);
		expect(textOf(result)).toContain("marked cancelled");

		const inbox = readInbox(runControlDir("bg-1", registry));
		expect(inbox.all).toHaveLength(1);
		expect(inbox.stateOf(inbox.all[0]!.id)).toBe("delivered");
		expect(inbox.isClaimed(inbox.all[0]!.id)).toBe(true);
		// The row's own directory holds the plane, not the inline namespace.
		expect(runControlDir("bg-1", registry).startsWith(backgroundTaskDir("bg-1"))).toBe(true);
	});

	it("reports a queued cancel without pretending a child was signalled", async () => {
		const registry = stubRegistry({ tasks: [taskRow("bg-queue", { status: "pending", pid: undefined })] });
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));

		const result = await tool.execute(
			"t1",
			{ action: "stop", id: "bg-queue" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(textOf(result)).toContain("was queued and had not started");

		const inbox = readInbox(runControlDir("bg-queue", registry));
		expect(inbox.stateOf(inbox.all[0]!.id)).toBe("delivered");
		expect(inbox.noteOf(inbox.all[0]!.id)).toBe("cancelled background task bg-queue");
	});

	it("records a claimed failed receipt when the row was already terminal", async () => {
		const registry = stubRegistry({
			tasks: [taskRow("bg-2")],
			cancel: () => ({ kind: "already-terminal", status: "completed" }),
		});
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));

		await tool.execute("t1", { action: "stop", id: "bg-2" }, undefined, undefined, undefined as never);

		const inbox = readInbox(runControlDir("bg-2", registry));
		expect(inbox.stateOf(inbox.all[0]!.id)).toBe("failed");
		expect(inbox.noteOf(inbox.all[0]!.id)).toBe("already terminal");
		// Claimed on purpose: a terminal row has no child to apply the stop, so the
		// request must not sit in its inbox claiming otherwise.
		expect(inbox.isClaimed(inbox.all[0]!.id)).toBe(true);
	});

	it("leaves the request pending as the backstop path when the child could not be signalled", async () => {
		const registry = stubRegistry({
			tasks: [taskRow("bg-3")],
			cancel: () => ({ kind: "not-cancelled", reason: "owner pid is not this session" }),
		});
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));

		await expect(
			tool.execute("t1", { action: "stop", id: "bg-3" }, undefined, undefined, undefined as never),
		).rejects.toThrow("Could not stop background task bg-3");

		const inbox = readInbox(runControlDir("bg-3", registry));
		expect(inbox.pending).toHaveLength(1);
		expect(inbox.stateOf(inbox.pending[0]!.id)).toBe("failed");
		expect(inbox.noteOf(inbox.pending[0]!.id)).toBe("owner pid is not this session");
		expect(inbox.isClaimed(inbox.pending[0]!.id)).toBe(false);
	});

	it("files an interrupt request for a background row too", async () => {
		const registry = stubRegistry({ tasks: [taskRow("bg-4")] });
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));

		await tool.execute("t1", { action: "interrupt", id: "bg-4" }, undefined, undefined, undefined as never);

		const inbox = readInbox(runControlDir("bg-4", registry));
		expect(inbox.all[0]!.action).toBe("interrupt");
		expect(inbox.stateOf(inbox.all[0]!.id)).toBe("delivered");
	});
});

describe("detached steer: the inbox is the only channel", () => {
	it("queues the steer in the control inbox instead of killing the run", async () => {
		// No session file means the kill-and-redispatch path cannot redirect the run;
		// the live child's watcher is what will apply the instruction.
		const registry = stubRegistry({ tasks: [taskRow("bg-live", { sessionFile: undefined })] });
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));

		const result = await tool.execute(
			"t1",
			{ action: "steer", id: "bg-live", message: "stop reading and write the test" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(textOf(result)).toContain("queued in the control inbox of background task bg-live");
		expect(textOf(result)).toContain("It was not killed or restarted");

		const inbox = readInbox(runControlDir("bg-live", registry));
		expect(inbox.pending).toHaveLength(1);
		expect(inbox.pending[0]!.action).toBe("steer");
		expect(inbox.pending[0]!.text).toBe("stop reading and write the test");
		expect(inbox.stateOf(inbox.pending[0]!.id)).toBe("queued");
		// Unclaimed: the child's watcher is the one that must pick it up.
		expect(inbox.isClaimed(inbox.pending[0]!.id)).toBe(false);
	});

	it("names the queued request id in the tool text so status can be read back", async () => {
		const registry = stubRegistry({ tasks: [taskRow("bg-live2", { sessionFile: undefined })] });
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));

		const result = await tool.execute(
			"t1",
			{ action: "steer", id: "bg-live2", message: "focus on the parser" },
			undefined,
			undefined,
			undefined as never,
		);
		const inbox = readInbox(runControlDir("bg-live2", registry));
		expect(textOf(result)).toContain(inbox.pending[0]!.id);
	});

	it("rejects an empty steer before filing anything", async () => {
		// The row is redirectable so the call reaches the message guard instead of
		// failing on the detached-session check first.
		const registry = stubRegistry({
			tasks: [taskRow("bg-empty", { sessionFile: join(agentDir, "empty-session.jsonl") })],
		});
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));

		await expect(
			tool.execute(
				"t1",
				{ action: "steer", id: "bg-empty", message: "  " },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("requires `message`");
		expect(existsSync(runControlDir("bg-empty", registry))).toBe(false);
	});

	it("does not file a control request for a model swap", async () => {
		// swap-model is not one of the child-applicable control actions: the
		// replacement run carries the new model, so filing it would let a watcher
		// "apply" a model change the parent cannot observe.
		const registry = stubRegistry({ tasks: [taskRow("bg-swap", { sessionFile: undefined })] });
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));

		await expect(
			tool.execute(
				"t1",
				{ action: "swap-model", id: "bg-swap", model: "sonnet" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow();
		expect(existsSync(runControlDir("bg-swap", registry))).toBe(false);
	});

	it("steers a resumable background row in band and claims the request", async () => {
		// With a session file the steer takes the kill-and-redispatch path; the
		// request is still filed first, then claimed when the replacement run
		// carries the instruction.
		const registry = stubRegistry({
			tasks: [taskRow("bg-redir", { sessionFile: join(agentDir, "child-session.jsonl") })],
		});
		const runner = stubRunner({ running: [], interruptResult: true }) as SubagentRunner & { interrupted: string[] };
		const tool = makeTool(registry, runner);

		await expect(
			tool.execute(
				"t1",
				{ action: "steer", id: "bg-redir", message: "narrow the scope" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow();
		// The stub runner refuses to dispatch, which is the throw: the request must
		// be on disk with a failed receipt and must stay unclaimed so the child's
		// watcher can still apply the steer.
		const inbox = readInbox(runControlDir("bg-redir", registry));
		expect(inbox.pending).toHaveLength(1);
		expect(inbox.pending[0]!.action).toBe("steer");
		expect(inbox.stateOf(inbox.pending[0]!.id)).toBe("failed");
		expect(inbox.isClaimed(inbox.pending[0]!.id)).toBe(false);
	});
});

describe('action="supervisor"', () => {
	function seed(dir: string, questions: Array<{ id: string; question: string; context?: string }>): void {
		ensureSupervisorDir(dir);
		for (const item of questions) {
			postSupervisorRequest(dir, {
				question: item.question,
				...(item.context === undefined ? {} : { context: item.context }),
				id: item.id,
			});
		}
	}

	it("requires an id", async () => {
		const tool = makeTool(stubRegistry(), stubRunner());
		await expect(
			tool.execute("t1", { action: "supervisor" }, undefined, undefined, undefined as never),
		).rejects.toThrow('action="supervisor" requires `id`');
	});

	it("reports when a run has nothing open", async () => {
		const registry = stubRegistry();
		const tool = makeTool(registry, stubRunner());
		const result = await tool.execute(
			"t1",
			{ action: "supervisor", id: "in-quiet" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(textOf(result)).toBe("No open supervisor questions for in-quiet.");
	});

	it("lists the open questions for a foreground run", async () => {
		const registry = stubRegistry();
		const dir = runSupervisorDir("in-ask", registry);
		seed(dir, [{ id: "q-1", question: "Which auth model should the child assume?", context: "two candidates" }]);
		const tool = makeTool(registry, stubRunner());

		const result = await tool.execute(
			"t1",
			{ action: "supervisor", id: "in-ask" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(textOf(result)).toContain("q-1");
		expect(textOf(result)).toContain("Which auth model should the child assume?");
		// The listing clips to the question; the context stays on disk for whoever
		// opens the request file.
		expect(readSupervisorRequest(dir, "q-1")?.context).toBe("two candidates");
	});

	it("lists the open questions from the background row's own directory", async () => {
		const registry = stubRegistry({ tasks: [taskRow("bg-ask")] });
		const dir = join(backgroundTaskDir("bg-ask"), "supervisor");
		seed(dir, [{ id: "q-bg", question: "Is the fixture allowed to hit the network?" }]);
		const tool = makeTool(registry, stubRunner());

		const result = await tool.execute(
			"t1",
			{ action: "supervisor", id: "bg-ask" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(textOf(result)).toContain("q-bg");
	});

	it("refuses to answer with only a replyTo", async () => {
		const registry = stubRegistry();
		seed(runSupervisorDir("in-reply", registry), [{ id: "q-2", question: "Which name?" }]);
		const tool = makeTool(registry, stubRunner());

		await expect(
			tool.execute(
				"t1",
				{ action: "supervisor", id: "in-reply", replyTo: "q-2" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("requires `message`");
		expect(existsSync(join(runSupervisorDir("in-reply", registry), "replies", "q-2.json"))).toBe(false);
	});

	it("refuses a message with no replyTo rather than guessing the question", async () => {
		const registry = stubRegistry();
		seed(runSupervisorDir("in-guess", registry), [{ id: "q-3", question: "Which name?" }]);
		const tool = makeTool(registry, stubRunner());

		await expect(
			tool.execute(
				"t1",
				{ action: "supervisor", id: "in-guess", message: "the short one" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("takes `replyTo`");
	});

	it("refuses to answer a question that is not open", async () => {
		const registry = stubRegistry();
		seed(runSupervisorDir("in-stale", registry), [{ id: "q-real", question: "Which name?" }]);
		const tool = makeTool(registry, stubRunner());

		await expect(
			tool.execute(
				"t1",
				{ action: "supervisor", id: "in-stale", replyTo: "q-fake", message: "whatever" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("is not open for run in-stale");
		expect(existsSync(join(runSupervisorDir("in-stale", registry), "replies", "q-fake.json"))).toBe(false);
	});

	it("files the answer where the asking child is polling", async () => {
		const registry = stubRegistry();
		const dir = runSupervisorDir("in-answered", registry);
		seed(dir, [{ id: "q-4", question: "May I rewrite the public API?" }]);
		const tool = makeTool(registry, stubRunner());

		const result = await tool.execute(
			"t1",
			{ action: "supervisor", id: "in-answered", replyTo: "q-4", message: "No — keep the surface stable." },
			undefined,
			undefined,
			undefined as never,
		);
		expect(textOf(result)).toContain("Answered supervisor question q-4 for run in-answered");
		const reply = readSupervisorReply(dir, "q-4");
		expect(reply?.answer).toBe("No — keep the surface stable.");
		expect(readdirSync(supervisorRepliesDir(dir))).toEqual(["q-4.json"]);
	});

	it("makes the answered question disappear from the open list", async () => {
		const registry = stubRegistry();
		const dir = runSupervisorDir("in-after", registry);
		seed(dir, [
			{ id: "q-5", question: "First?" },
			{ id: "q-6", question: "Second?" },
		]);
		const tool = makeTool(registry, stubRunner());

		await tool.execute(
			"t1",
			{ action: "supervisor", id: "in-after", replyTo: "q-5", message: "yes" },
			undefined,
			undefined,
			undefined as never,
		);
		const listing = await tool.execute(
			"t2",
			{ action: "supervisor", id: "in-after" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(textOf(listing)).toContain("Second?");
		expect(textOf(listing)).not.toContain("First?");
	});

	it("answers a background row's question in the row's directory", async () => {
		const registry = stubRegistry({ tasks: [taskRow("bg-answer")] });
		const dir = runSupervisorDir("bg-answer", registry);
		seed(dir, [{ id: "q-bg-2", question: "Which branch should I diff against?" }]);
		const tool = makeTool(registry, stubRunner());

		await tool.execute(
			"t1",
			{ action: "supervisor", id: "bg-answer", replyTo: "q-bg-2", message: "main" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(readSupervisorReply(join(backgroundTaskDir("bg-answer"), "supervisor"), "q-bg-2")?.answer).toBe("main");
	});
});

describe('action="status" surfaces the control plane', () => {
	it("shows a filed request with its receipt state and the child's open questions", async () => {
		const registry = stubRegistry({ tasks: [taskRow("bg-status")] });
		// File through the real path so the receipt chain is the tool's own.
		const stopTool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));
		await stopTool.execute("t1", { action: "stop", id: "bg-status" }, undefined, undefined, undefined as never);
		ensureSupervisorDir(runSupervisorDir("bg-status", registry));
		postSupervisorRequest(runSupervisorDir("bg-status", registry), {
			id: "q-h",
			question: "Should I also update the docs?",
		});

		const result = await stopTool.execute("t2", { action: "status" }, undefined, undefined, undefined as never);
		const text = textOf(result);
		expect(text).toContain("Background tasks (registry, running or pending): 1");
		expect(text).toMatch(/control id=\S+ action=stop state=delivered/);
		expect(text).toContain("action=stop");
		expect(text).toContain("state=delivered");
		expect(text).toContain("claimed by child");
		expect(text).toContain("Supervisor questions (unanswered):");
		expect(text).toContain("Should I also update the docs?");
	});

	it("renders a detached steer's pending request as awaiting the child", async () => {
		// A detached row's steer stays in `requests/`, which status renders as
		// `awaiting child` with the `queued` receipt state.
		const detached = stubRegistry({ tasks: [taskRow("bg-pend", { sessionFile: undefined })] });
		const detachedTool = makeTool(detached, stubRunner({ running: [], interruptResult: true }));
		await detachedTool.execute(
			"t1",
			{ action: "steer", id: "bg-pend", message: "hold on the parser" },
			undefined,
			undefined,
			undefined as never,
		);

		const result = await detachedTool.execute("t2", { action: "status" }, undefined, undefined, undefined as never);
		const text = textOf(result);
		expect(text).toContain("action=steer");
		expect(text).toContain("state=queued");
		expect(text).toContain("awaiting child");
		expect(text).not.toContain("claimed by child");
	});

	it("renders a stop the parent served itself as claimed", async () => {
		const registry = stubRegistry({ tasks: [taskRow("bg-done", { sessionFile: join(agentDir, "done.jsonl") })] });
		const tool = makeTool(registry, stubRunner({ running: [], interruptResult: true }));
		await tool.execute("t1", { action: "stop", id: "bg-done" }, undefined, undefined, undefined as never);
		const text = textOf(await tool.execute("t2", { action: "status" }, undefined, undefined, undefined as never));
		expect(text).toContain("state=delivered");
		expect(text).toContain("claimed by child");
	});

	it("stays silent for a run that never used the control plane", async () => {
		const registry = stubRegistry({ tasks: [taskRow("bg-plain")] });
		const tool = makeTool(registry, stubRunner({ running: [inlineRun("in-plain")], interruptResult: true }));

		const result = await tool.execute("t1", { action: "status" }, undefined, undefined, undefined as never);
		const text = textOf(result);
		expect(text).toContain("id=in-plain");
		expect(text).toContain("id=bg-plain");
		expect(text).not.toContain("control id=");
		expect(text).not.toContain("Supervisor questions");
	});

	it("reports no run in flight without inventing a control plane", async () => {
		const tool = makeTool(stubRegistry(), stubRunner());
		const result = await tool.execute("t1", { action: "status" }, undefined, undefined, undefined as never);
		expect(textOf(result)).toContain("No subagent run is in flight.");
	});

	it("returns the supervisor action in details.action", async () => {
		const tool = makeTool(stubRegistry(), stubRunner());
		const result = await tool.execute(
			"t1",
			{ action: "supervisor", id: "in-x" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details?.action).toBe("supervisor");
		expect(result.details?.mode).toBe("single");
		expect(result.details?.results).toEqual([]);
	});
});
