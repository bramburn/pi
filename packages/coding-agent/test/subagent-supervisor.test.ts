/**
 * Stage 3 tests: the supervisor channel (issue #1048) — a child's question, the
 * parent's answer, and the `contact_supervisor` tool that connects them.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONTACT_SUPERVISOR_TOOL_NAME,
	createContactSupervisorToolDefinition,
	shouldRegisterContactSupervisorTool,
} from "../src/core/subagent/contact-supervisor-tool.ts";
import {
	countOpenSupervisorRequests,
	formatOpenSupervisorRequests,
	hasSupervisorDir,
	listOpenSupervisorRequests,
	listSupervisorRequestStates,
	parseSupervisorReply,
	parseSupervisorRequest,
	postSupervisorRequest,
	pruneSupervisorDir,
	SUPERVISOR_DEFAULT_TIMEOUT_MS,
	SUPERVISOR_DIR_ENV,
	SUPERVISOR_MAX_LISTED,
	SUPERVISOR_MAX_MESSAGE_BYTES,
	SUPERVISOR_MAX_TIMEOUT_MS,
	serializeSupervisorRequest,
	supervisorDirFor,
	supervisorDirFromEnv,
	supervisorReplyPath,
	supervisorRequestPath,
	waitForSupervisorReply,
	writeSupervisorReply,
} from "../src/core/subagent/supervisor-channel.ts";

let tmpDir: string;
let dir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "subagent-supervisor-"));
	dir = supervisorDirFor(tmpDir);
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	vi.useRealTimers();
});

function filesIn(path: string): string[] {
	return existsSync(path) ? readdirSync(path) : [];
}

describe("supervisor dir layout", () => {
	it("is a sibling of the control inbox, never inside it", () => {
		expect(supervisorDirFor(join(tmpDir, "task"))).toBe(join(tmpDir, "task", "supervisor"));
		expect(supervisorDirFor(tmpDir)).not.toContain(join("control", "supervisor"));
	});

	it("names the dir from the environment and tolerates blank/whitespace", () => {
		expect(supervisorDirFromEnv({ [SUPERVISOR_DIR_ENV]: dir })).toBe(dir);
		expect(supervisorDirFromEnv({ [SUPERVISOR_DIR_ENV]: `  ${dir}  ` })).toBe(dir);
		expect(supervisorDirFromEnv({ [SUPERVISOR_DIR_ENV]: "" })).toBeUndefined();
		expect(supervisorDirFromEnv({ [SUPERVISOR_DIR_ENV]: "   " })).toBeUndefined();
		expect(supervisorDirFromEnv({})).toBeUndefined();
		expect(hasSupervisorDir({ [SUPERVISOR_DIR_ENV]: dir })).toBe(true);
		expect(hasSupervisorDir({})).toBe(false);
	});
});

describe("postSupervisorRequest", () => {
	it("writes a readable request and creates the dirs", () => {
		const { request, truncated } = postSupervisorRequest(dir, { question: "Which auth scheme should I use?" });
		expect(truncated).toBe(false);
		expect(request.question).toBe("Which auth scheme should I use?");
		expect(request.version).toBe(1);
		expect(request.pid).toBe(process.pid);
		expect(existsSync(supervisorRequestPath(dir, request.id))).toBe(true);
		// The dir must exist for the parent to answer into.
		expect(filesIn(join(dir, "replies"))).toEqual([]);
	});

	it("round-trips through the parser", () => {
		const { request } = postSupervisorRequest(dir, { question: "Q", context: "I tried A and B." });
		const raw = readFileSync(supervisorRequestPath(dir, request.id), "utf8");
		expect(parseSupervisorRequest(raw)).toEqual(request);
	});

	it("leaves no temp files behind", () => {
		postSupervisorRequest(dir, { question: "Q1" });
		postSupervisorRequest(dir, { question: "Q2" });
		expect(filesIn(join(dir, "requests")).filter((name) => name.includes(".tmp."))).toEqual([]);
	});

	it("records the target id when the caller knows it", () => {
		const { request } = postSupervisorRequest(dir, { question: "Q", targetId: "task_42" });
		expect(request.targetId).toBe("task_42");
	});

	it("caps an oversized question to the byte bound and flags it", () => {
		const huge = "x".repeat(SUPERVISOR_MAX_MESSAGE_BYTES * 2);
		const { request, truncated } = postSupervisorRequest(dir, { question: huge });
		expect(truncated).toBe(true);
		expect(request.truncated).toBe(true);
		expect(Buffer.byteLength(request.question, "utf8")).toBeLessThanOrEqual(SUPERVISOR_MAX_MESSAGE_BYTES);
	});

	it("caps oversized context independently of the question", () => {
		const { request, truncated } = postSupervisorRequest(dir, {
			question: "Short question",
			context: "y".repeat(100 * 1024),
		});
		expect(truncated).toBe(true);
		expect(request.question).toBe("Short question");
		expect(Buffer.byteLength(request.context ?? "", "utf8")).toBeLessThanOrEqual(8 * 1024);
	});

	it("keeps a multi-byte question intact under the cap", () => {
		const crabby = "🦀".repeat(100);
		const { request, truncated } = postSupervisorRequest(dir, { question: crabby });
		expect(truncated).toBe(false);
		expect(request.question).toBe(crabby);
	});

	it("honours an explicit id so the parent can answer a known question", () => {
		const { request } = postSupervisorRequest(dir, { question: "Q", id: "sup_explicit" });
		expect(request.id).toBe("sup_explicit");
		expect(existsSync(supervisorRequestPath(dir, "sup_explicit"))).toBe(true);
	});
});

describe("request parsing (defensive)", () => {
	it("rejects a foreign version", () => {
		expect(
			parseSupervisorRequest(`{"version":99,"id":"a","question":"Q","createdAt":"2026-01-01T00:00:00.000Z"}`),
		).toBeUndefined();
	});

	it("rejects a question with no text", () => {
		expect(
			parseSupervisorRequest(`{"version":1,"id":"a","question":"","createdAt":"2026-01-01T00:00:00.000Z"}`),
		).toBeUndefined();
	});

	it("rejects a half-written file", () => {
		expect(parseSupervisorRequest('{"version":1,"id":"a",')).toBeUndefined();
		expect(parseSupervisorRequest("[]")).toBeUndefined();
	});

	it("rejects a reply missing its request id", () => {
		expect(
			parseSupervisorReply(`{"version":1,"answer":"use cookies","createdAt":"2026-01-01T00:00:00.000Z"}`),
		).toBeUndefined();
	});

	it("skips corrupt files when listing instead of throwing", () => {
		postSupervisorRequest(dir, { question: "good" });
		mkdirSync(join(dir, "requests"), { recursive: true });
		writeFileSync(join(dir, "requests", "broken.json"), "{not json");
		expect(listOpenSupervisorRequests(dir)).toHaveLength(1);
	});
});

describe("answers and openness", () => {
	it("lists a question with no reply as open", () => {
		const { request } = postSupervisorRequest(dir, { question: "Open?" });
		const states = listSupervisorRequestStates(dir);
		expect(states).toHaveLength(1);
		expect(states[0].open).toBe(true);
		expect(states[0].request.id).toBe(request.id);
		expect(countOpenSupervisorRequests(dir)).toBe(1);
	});

	it("writes a reply for a question that exists", () => {
		const { request } = postSupervisorRequest(dir, { question: "Which scheme?" });
		const reply = writeSupervisorReply(dir, request.id, "Use the existing session cookie path.");
		expect(reply).toBeDefined();
		expect(reply?.requestId).toBe(request.id);
		expect(readFileSync(supervisorReplyPath(dir, request.id), "utf8")).toContain("session cookie");
	});

	it("refuses to answer an unknown request id", () => {
		expect(writeSupervisorReply(dir, "sup_never_asked", "answer")).toBeUndefined();
		expect(existsSync(supervisorReplyPath(dir, "sup_never_asked"))).toBe(false);
	});

	it("closing a question removes it from the open list", () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		writeSupervisorReply(dir, request.id, "A");
		expect(countOpenSupervisorRequests(dir)).toBe(0);
		const state = listSupervisorRequestStates(dir)[0];
		expect(state.open).toBe(false);
		expect(state.reply?.answer).toBe("A");
	});

	it("caps an oversized answer", () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		const reply = writeSupervisorReply(dir, request.id, "z".repeat(SUPERVISOR_MAX_MESSAGE_BYTES + 10));
		expect(reply?.truncated).toBe(true);
		expect(Buffer.byteLength(reply?.answer ?? "", "utf8")).toBeLessThanOrEqual(SUPERVISOR_MAX_MESSAGE_BYTES);
	});

	it("orders requests oldest first, ids breaking ties", () => {
		mkdirSync(join(dir, "requests"), { recursive: true });
		for (const [id, day] of [
			["sup_b", "2026-01-02"],
			["sup_a", "2026-01-03"],
			["sup_c", "2026-01-02"],
		] as const) {
			const request = {
				version: 1,
				id,
				question: `q ${id}`,
				createdAt: `${day}T00:00:00.000Z`,
			};
			writeFileSync(supervisorRequestPath(dir, id), serializeSupervisorRequest(request));
		}
		expect(listOpenSupervisorRequests(dir).map((r) => r.id)).toEqual(["sup_b", "sup_c", "sup_a"]);
	});
});

describe("waitForSupervisorReply", () => {
	it("returns an answer that is already there without waiting", () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		writeSupervisorReply(dir, request.id, "already answered");
		const sleep = vi.fn(async () => {});
		return waitForSupervisorReply(dir, request.id, { sleep, timeoutMs: 10_000 }).then((reply) => {
			expect(reply?.answer).toBe("already answered");
			expect(sleep).not.toHaveBeenCalled();
		});
	});

	it("resolves as soon as the answer lands mid-poll", async () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		let calls = 0;
		const sleep = vi.fn(async () => {
			calls += 1;
			if (calls === 2) writeSupervisorReply(dir, request.id, "cookies");
		});
		const reply = await waitForSupervisorReply(dir, request.id, { sleep, timeoutMs: 10_000, intervalMs: 100 });
		expect(reply?.answer).toBe("cookies");
		expect(calls).toBe(2);
	});

	it("gives up at the deadline and leaves the question open", async () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		const sleep = vi.fn(async () => {});
		const reply = await waitForSupervisorReply(dir, request.id, { sleep, timeoutMs: 300, intervalMs: 100 });
		expect(reply).toBeUndefined();
		expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(countOpenSupervisorRequests(dir)).toBe(1);
	});

	it("stops waiting when the signal aborts", async () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		const controller = new AbortController();
		let calls = 0;
		const sleep = vi.fn(async () => {
			calls += 1;
			if (calls === 1) controller.abort();
		});
		const reply = await waitForSupervisorReply(dir, request.id, {
			sleep,
			timeoutMs: 60_000,
			intervalMs: 100,
			signal: controller.signal,
		});
		expect(reply).toBeUndefined();
		expect(calls).toBe(1);
		// Still a live question: aborting the wait does not cancel the ask.
		expect(countOpenSupervisorRequests(dir)).toBe(1);
	});

	it("treats an already-aborted signal as no wait at all", async () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		const controller = new AbortController();
		controller.abort();
		const sleep = vi.fn(async () => {});
		expect(await waitForSupervisorReply(dir, request.id, { sleep, signal: controller.signal })).toBeUndefined();
		expect(sleep).not.toHaveBeenCalled();
	});

	it("caps a caller-supplied timeout at the maximum", async () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		const steps: number[] = [];
		const sleep = vi.fn(async (ms: number) => {
			steps.push(ms);
		});
		await waitForSupervisorReply(dir, request.id, {
			sleep,
			timeoutMs: 10_000_000,
			intervalMs: 1_000,
		});
		// A capped wait means at most MAX_TIMEOUT_MS / intervalMs polls.
		expect(steps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SUPERVISOR_MAX_TIMEOUT_MS);
		expect(steps.length).toBe(Math.ceil(SUPERVISOR_MAX_TIMEOUT_MS / 1_000));
	});

	it("waits the default bound when the caller gives no timeout", async () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		const steps: number[] = [];
		await waitForSupervisorReply(dir, request.id, {
			sleep: async (ms) => {
				steps.push(ms);
			},
			intervalMs: 1_000,
		});
		expect(steps.reduce((a, b) => a + b, 0)).toBe(SUPERVISOR_DEFAULT_TIMEOUT_MS);
	});

	it("never throws for an unknown dir or id", async () => {
		expect(
			await waitForSupervisorReply(join(tmpDir, "nope"), "sup_x", { sleep: async () => {}, timeoutMs: 10 }),
		).toBeUndefined();
	});
});

describe("raising open questions to the parent", () => {
	it("is empty when nothing is open", () => {
		expect(formatOpenSupervisorRequests(dir)).toBe("");
	});

	it("names the id and the question so the parent can answer it", () => {
		const { request } = postSupervisorRequest(dir, { question: "Delete the v1 endpoints or keep them?" });
		const text = formatOpenSupervisorRequests(dir);
		expect(text).toContain(`id=${request.id}`);
		expect(text).toContain("Delete the v1 endpoints");
		expect(text).toContain("unanswered question from child");
	});

	it("collapses past the listed bound instead of flooding", () => {
		mkdirSync(join(dir, "requests"), { recursive: true });
		for (let i = 0; i < SUPERVISOR_MAX_LISTED + 4; i += 1) {
			const id = `sup_${String(i).padStart(3, "0")}`;
			writeFileSync(
				supervisorRequestPath(dir, id),
				serializeSupervisorRequest({
					version: 1,
					id,
					question: `question ${i}`,
					createdAt: "2026-01-01T00:00:00.000Z",
				}),
			);
		}
		const lines = formatOpenSupervisorRequests(dir).split("\n");
		expect(lines).toHaveLength(SUPERVISOR_MAX_LISTED + 1);
		expect(lines[lines.length - 1]).toContain("+4 more unanswered question(s)");
	});

	it("skips questions the parent already answered", () => {
		const a = postSupervisorRequest(dir, { question: "answered", id: "sup_a" }).request;
		postSupervisorRequest(dir, { question: "still open", id: "sup_b" });
		writeSupervisorReply(dir, a.id, "yes");
		const text = formatOpenSupervisorRequests(dir);
		expect(text).toContain("still open");
		expect(text).not.toContain("sup_a");
		expect(text).not.toContain("older question");
	});

	it("says nothing when the dir does not exist", () => {
		expect(formatOpenSupervisorRequests(join(tmpDir, "missing"))).toBe("");
		expect(countOpenSupervisorRequests(join(tmpDir, "missing"))).toBe(0);
	});
});

describe("pruneSupervisorDir", () => {
	it("keeps open questions forever — they are what the parent owes", () => {
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		mkdirSync(join(dir, "requests"), { recursive: true });
		writeFileSync(
			supervisorRequestPath(dir, "sup_old"),
			serializeSupervisorRequest({ version: 1, id: "sup_old", question: "ancient", createdAt: old }),
		);
		const result = pruneSupervisorDir(dir, { maxAgeMs: 24 * 60 * 60 * 1000 });
		expect(result.requestsRemoved).toBe(0);
		expect(existsSync(supervisorRequestPath(dir, "sup_old"))).toBe(true);
	});

	it("collects answered pairs once both halves are old", () => {
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		writeSupervisorReply(dir, request.id, "A");
		// Age both files by rewriting them with an old timestamp.
		writeFileSync(supervisorRequestPath(dir, request.id), serializeSupervisorRequest({ ...request, createdAt: old }));
		const reply = parseSupervisorReply(readFileSync(supervisorReplyPath(dir, request.id), "utf8"));
		writeFileSync(supervisorReplyPath(dir, request.id), JSON.stringify({ ...reply, createdAt: old }));

		const result = pruneSupervisorDir(dir, { maxAgeMs: 24 * 60 * 60 * 1000 });
		expect(result.requestsRemoved).toBe(1);
		expect(result.repliesRemoved).toBe(1);
		expect(existsSync(supervisorRequestPath(dir, request.id))).toBe(false);
		expect(existsSync(supervisorReplyPath(dir, request.id))).toBe(false);
	});

	it("leaves a recent answered pair alone", () => {
		const { request } = postSupervisorRequest(dir, { question: "Q" });
		writeSupervisorReply(dir, request.id, "A");
		expect(pruneSupervisorDir(dir).requestsRemoved).toBe(0);
		expect(existsSync(supervisorReplyPath(dir, request.id))).toBe(true);
	});

	it("drops an orphan reply whose question is gone", () => {
		mkdirSync(join(dir, "replies"), { recursive: true });
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
		writeFileSync(
			join(dir, "replies", "sup_orphan.json"),
			JSON.stringify({ version: 1, requestId: "sup_orphan", answer: "A", createdAt: old }),
		);
		expect(pruneSupervisorDir(dir).repliesRemoved).toBe(1);
		expect(filesIn(join(dir, "replies"))).toEqual([]);
	});

	it("is a no-op when the dir is absent", () => {
		expect(pruneSupervisorDir(join(tmpDir, "nope"))).toEqual({ requestsRemoved: 0, repliesRemoved: 0 });
	});
});

describe("contact_supervisor tool", () => {
	it("is only offered when a supervisor dir is configured", () => {
		expect(shouldRegisterContactSupervisorTool({ [SUPERVISOR_DIR_ENV]: dir })).toBe(true);
		expect(shouldRegisterContactSupervisorTool({})).toBe(false);
		expect(createContactSupervisorToolDefinition({ env: {} })).toBeUndefined();
	});

	it("has the shape the runtime expects", () => {
		const definition = createContactSupervisorToolDefinition({ env: { [SUPERVISOR_DIR_ENV]: dir } });
		expect(definition?.name).toBe(CONTACT_SUPERVISOR_TOOL_NAME);
		expect(definition?.label).toBe("Contact Supervisor");
		expect(definition?.parameters).toBeDefined();
	});

	it("posts the question and reports the answer it received", async () => {
		const definition = createContactSupervisorToolDefinition({
			env: { [SUPERVISOR_DIR_ENV]: dir },
			sleep: async () => {},
			pollIntervalMs: 10,
		});
		const pending = definition!.execute(
			"tc1",
			{ question: "Which endpoint should I keep?" },
			undefined,
			undefined,
			{} as never,
		);
		// Answer it from the parent side while the tool is still waiting.
		const open = listOpenSupervisorRequests(dir);
		expect(open).toHaveLength(1);
		writeSupervisorReply(dir, open[0].id, "Keep v1, it is still in production.");
		const result = await pending;
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("Keep v1");
		expect(result.details).toMatchObject({ answered: true });
	});

	it("reports an open question rather than hanging when nobody answers", async () => {
		const definition = createContactSupervisorToolDefinition({
			env: { [SUPERVISOR_DIR_ENV]: dir },
			sleep: async () => {},
			pollIntervalMs: 10,
		});
		const result = await definition!.execute(
			"tc2",
			{ question: "Block or not?", timeout_ms: 200 },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.details).toMatchObject({ answered: false, timedOut: true });
		expect((result.content[0] as { text: string }).text).toContain("stays open");
		// The question survives for the settlement path to raise.
		expect(countOpenSupervisorRequests(dir)).toBe(1);
	});

	it("rejects an empty question without writing a request", async () => {
		const definition = createContactSupervisorToolDefinition({
			env: { [SUPERVISOR_DIR_ENV]: dir },
			sleep: async () => {},
		});
		const result = await definition!.execute("tc3", { question: "   " }, undefined, undefined, {} as never);
		expect((result.content[0] as { text: string }).text).toContain("must not be empty");
		expect(countOpenSupervisorRequests(dir)).toBe(0);
	});

	it("answers only its own request when two are open", async () => {
		const first = postSupervisorRequest(dir, { question: "older question", id: "sup_first" }).request;
		const definition = createContactSupervisorToolDefinition({
			env: { [SUPERVISOR_DIR_ENV]: dir },
			sleep: async () => {},
			pollIntervalMs: 10,
		});
		const pending = definition!.execute(
			"tc4",
			{ question: "newer question", timeout_ms: 200 },
			undefined,
			undefined,
			{} as never,
		);
		writeSupervisorReply(dir, first.id, "not for you");
		const result = await pending;
		expect(result.details).toMatchObject({ answered: false, timedOut: true });
		expect(listSupervisorRequestStates(dir).filter((s) => s.open)).toHaveLength(1);
	});
});

describe("isolation from the control inbox", () => {
	it("supervisor files never show up in a control listing and vice versa", () => {
		// Same task dir, two sibling dirs: control is push, supervisor is pull.
		const controlDir = join(tmpDir, "control", "requests");
		mkdirSync(controlDir, { recursive: true });
		writeFileSync(
			join(controlDir, "req_1.json"),
			JSON.stringify({ version: 1, id: "req_1", action: "steer", createdAt: "x" }),
		);
		postSupervisorRequest(dir, { question: "Q" });
		expect(filesIn(join(dir, "requests")).some((name) => name === "req_1.json")).toBe(false);
		expect(filesIn(controlDir).some((name) => name.startsWith("sup_"))).toBe(false);
	});
});
