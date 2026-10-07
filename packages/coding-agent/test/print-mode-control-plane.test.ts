/**
 * Unit tests for the json-mode control-plane handoff helpers (#1047, #1048).
 *
 * `summarizeControlPlaneRuns` and `formatControlPlaneHandoff` are pure
 * filesystem readers: they take the registry rows that were still live when
 * print mode settled and report each run's control inbox, supervisor outbox,
 * filed requests with their newest receipt, and unanswered questions. A
 * headless consumer is the only reader of that entry, so the shape of both
 * the structured summary and its rendered text is the contract under test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type BackgroundTask, backgroundTaskDir } from "../src/core/subagent/background.ts";
import {
	type ControlAction,
	claimControlRequest,
	controlDirFor,
	recordControlState,
	writeControlRequest,
} from "../src/core/subagent/control.ts";
import {
	postSupervisorRequest,
	supervisorDirFor,
	writeSupervisorReply,
} from "../src/core/subagent/supervisor-channel.ts";
import { formatControlPlaneHandoff, summarizeControlPlaneRuns } from "../src/modes/print-mode.ts";

let agentDir = "";
const previousAgentDir = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-print-control-"));
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
		...overrides,
	};
}

function controlDirOf(id: string): string {
	return controlDirFor(backgroundTaskDir(id));
}

function supervisorDirOf(id: string): string {
	return supervisorDirFor(backgroundTaskDir(id));
}

function fileRequest(id: string, action: ControlAction, text?: string): string {
	return writeControlRequest(controlDirOf(id), { action, ...(text === undefined ? {} : { text }) }).request.id;
}

describe("summarizeControlPlaneRuns", () => {
	it("returns nothing when no run was live", () => {
		expect(summarizeControlPlaneRuns([])).toEqual([]);
	});

	it("names each run's task, control, and supervisor directories", () => {
		const [run] = summarizeControlPlaneRuns([taskRow("bg-quiet")]);

		expect(run.taskId).toBe("bg-quiet");
		expect(run.status).toBe("running");
		expect(run.taskDir).toBe(backgroundTaskDir("bg-quiet"));
		expect(run.controlDir).toBe(join(run.taskDir, "control"));
		expect(run.supervisorDir).toBe(join(run.taskDir, "supervisor"));
		expect(run.requests).toEqual([]);
		expect(run.openQuestions).toEqual([]);
	});

	it("lists a filed request as pending with the state the parent recorded", () => {
		const requestId = fileRequest("bg-steer", "steer", "use the adapter instead");
		recordControlState(controlDirOf("bg-steer"), {
			id: requestId,
			action: "steer",
			state: "scheduled",
			by: "parent",
			note: "killed inline run bg-steer",
		});

		const [run] = summarizeControlPlaneRuns([taskRow("bg-steer")]);

		expect(run.requests).toHaveLength(1);
		expect(run.requests[0].id).toBe(requestId);
		expect(run.requests[0].action).toBe("steer");
		expect(run.requests[0].state).toBe("scheduled");
		expect(run.requests[0].pending).toBe(true);
		expect(run.requests[0].note).toBe("killed inline run bg-steer");
	});

	it("reports a claimed request with the child's newest state and no note", () => {
		const requestId = fileRequest("bg-claim", "stop");
		recordControlState(controlDirOf("bg-claim"), { id: requestId, action: "stop", state: "queued", by: "parent" });
		claimControlRequest(controlDirOf("bg-claim"), requestId);
		recordControlState(controlDirOf("bg-claim"), {
			id: requestId,
			action: "stop",
			state: "delivered",
			by: "child",
			note: "applied by the child",
		});

		const [run] = summarizeControlPlaneRuns([taskRow("bg-claim")]);

		expect(run.requests[0].state).toBe("delivered");
		expect(run.requests[0].pending).toBe(false);
		expect(run.requests[0].note).toBe("applied by the child");
	});

	it("falls back to 'requested' for a request that has no receipt line", () => {
		const requestId = fileRequest("bg-noreceipt", "interrupt");
		// A crash between the request write and the first receipt append still has
		// to read as an intent, not vanish from the handoff.
		rmSync(join(controlDirOf("bg-noreceipt"), "receipts.jsonl"), { force: true });

		const [run] = summarizeControlPlaneRuns([taskRow("bg-noreceipt")]);

		expect(run.requests.map((row) => row.id)).toEqual([requestId]);
		expect(run.requests[0].state).toBe("requested");
	});

	it("lists only questions that have no answer", () => {
		const dir = supervisorDirOf("bg-ask");
		const open = postSupervisorRequest(dir, { question: "which entry point?" });
		const answered = postSupervisorRequest(dir, { question: "is the fixture ok?" });
		writeSupervisorReply(dir, answered.request.id, "yes");

		const [run] = summarizeControlPlaneRuns([taskRow("bg-ask")]);

		expect(run.openQuestions).toEqual([open.request.id]);
	});

	it("keeps the row order it was given", () => {
		fileRequest("bg-second", "steer", "later");
		fileRequest("bg-first", "stop");

		const runs = summarizeControlPlaneRuns([taskRow("bg-first"), taskRow("bg-second", { status: "pending" })]);

		expect(runs.map((run) => run.taskId)).toEqual(["bg-first", "bg-second"]);
		expect(runs[1].status).toBe("pending");
	});
});

describe("formatControlPlaneHandoff", () => {
	it("renders the header and one block per run", () => {
		const text = formatControlPlaneHandoff(summarizeControlPlaneRuns([taskRow("bg-a"), taskRow("bg-b")]));

		expect(text.startsWith("Background subagent runs are still in flight:")).toBe(true);
		expect(text).toContain(`run bg-a is still running`);
		expect(text).toContain(`run bg-b is still running`);
		expect(text).toContain(`control inbox: ${controlDirOf("bg-a")}`);
		expect(text).toContain(`supervisor outbox: ${supervisorDirOf("bg-b")}`);
	});

	it("says so when a run has no filed request and no open question", () => {
		const text = formatControlPlaneHandoff(summarizeControlPlaneRuns([taskRow("bg-quiet")]));

		expect(text).toContain("control requests: none filed");
		expect(text).not.toContain("unanswered questions");
	});

	it("marks whether the child has taken a request yet", () => {
		const pending = fileRequest("bg-pending", "steer", "hold the format");
		recordControlState(controlDirOf("bg-pending"), {
			id: pending,
			action: "steer",
			state: "scheduled",
			by: "parent",
		});
		const claimed = fileRequest("bg-claimed", "interrupt");
		recordControlState(controlDirOf("bg-claimed"), {
			id: claimed,
			action: "interrupt",
			state: "queued",
			by: "parent",
		});
		claimControlRequest(controlDirOf("bg-claimed"), claimed);

		const text = formatControlPlaneHandoff(summarizeControlPlaneRuns([taskRow("bg-pending"), taskRow("bg-claimed")]));

		expect(text).toContain(`control id=${pending} action=steer state=scheduled awaiting child`);
		expect(text).toContain(`control id=${claimed} action=interrupt state=queued claimed by child`);
		expect(text).not.toContain("control requests: none filed");
	});

	it("includes the note when the settle path left one", () => {
		const requestId = fileRequest("bg-note", "stop");
		recordControlState(controlDirOf("bg-note"), {
			id: requestId,
			action: "stop",
			state: "failed",
			by: "parent",
			note: "already terminal",
		});

		const text = formatControlPlaneHandoff(summarizeControlPlaneRuns([taskRow("bg-note")]));

		expect(text).toContain("state=failed");
		expect(text).toContain("note=already terminal");
	});

	it("lists the ids of questions that are still waiting", () => {
		const dir = supervisorDirOf("bg-ask");
		const first = postSupervisorRequest(dir, { question: "which schema?" });
		const second = postSupervisorRequest(dir, { question: "which branch?" });

		const text = formatControlPlaneHandoff(summarizeControlPlaneRuns([taskRow("bg-ask")]));

		expect(text).toContain(`unanswered questions: ${first.request.id}, ${second.request.id}`);
	});
});
