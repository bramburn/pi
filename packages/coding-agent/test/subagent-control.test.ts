/**
 * File control inbox (issue #1047, Stage 1).
 *
 * Covers the on-disk contract the parent and the child watcher both depend on:
 * a request lands atomically as one file, claiming it is an exclusive move so a
 * delivery happens exactly once, the ledger records each state transition in
 * order, oversized steer text is bounded before it can reach disk, and a
 * listing tolerates a directory the other side never created or a file a crash
 * left half-written.
 *
 * Every test points the control dir at a temp directory — never the real
 * ~/.pi/agent.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONTROL_APPLIED_DIR_NAME,
	CONTROL_DIR_ENV,
	CONTROL_MAX_MESSAGE_BYTES,
	CONTROL_REQUESTS_DIR_NAME,
	capControlText,
	claimControlRequest,
	controlAppliedPath,
	controlDirFor,
	controlDirFromEnv,
	controlReceiptsPath,
	controlRequestPath,
	discardControlRequest,
	formatControlRequestsForStatus,
	hasControlDir,
	listClaimedControlRequests,
	listControlRequests,
	parseControlReceipt,
	parseControlRequest,
	pruneControlDir,
	readControlReceipts,
	recordControlState,
	summarizeControlRequests,
	writeControlRequest,
} from "../src/core/subagent/control.ts";

let dir = "";
let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "subagent-control-"));
	dir = controlDirFor(join(root, "task-1"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Filing a request
// ---------------------------------------------------------------------------

describe("writeControlRequest", () => {
	it("writes one request file and records it as requested", () => {
		const { request } = writeControlRequest(dir, { action: "steer", text: "use the v2 schema" });

		expect(request.action).toBe("steer");
		expect(request.text).toBe("use the v2 schema");
		expect(request.truncated).toBeUndefined();

		const onDisk = parseControlRequest(readFileSync(controlRequestPath(dir, request.id), "utf8"));
		expect(onDisk?.id).toBe(request.id);
		expect(onDisk?.text).toBe("use the v2 schema");

		const receipts = readControlReceipts(dir);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].state).toBe("requested");
		expect(receipts[0].by).toBe("parent");
		expect(receipts[0].id).toBe(request.id);
	});

	it("leaves no temp file behind", () => {
		writeControlRequest(dir, { action: "stop" });
		const names = readdirSync(join(dir, CONTROL_REQUESTS_DIR_NAME));
		expect(names.filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("creates the requests and applied directories", () => {
		writeControlRequest(dir, { action: "interrupt" });
		expect(readdirSync(join(dir, CONTROL_REQUESTS_DIR_NAME))).toHaveLength(1);
		expect(readdirSync(join(dir, CONTROL_APPLIED_DIR_NAME))).toEqual([]);
	});

	it("carries no text for interrupt and stop", () => {
		const stop = writeControlRequest(dir, { action: "stop", text: "ignored" });
		expect(stop.request.text).toBeUndefined();
		const interrupt = writeControlRequest(dir, { action: "interrupt", text: "ignored" });
		expect(interrupt.request.text).toBeUndefined();
	});

	it("records the target id and writer pid for diagnostics", () => {
		const { request } = writeControlRequest(dir, { action: "stop", targetId: "bg_task_9" });
		expect(request.targetId).toBe("bg_task_9");
		expect(request.pid).toBe(process.pid);
	});

	it("keeps a caller-supplied id so a retry overwrites in place", () => {
		const first = writeControlRequest(dir, { action: "steer", text: "one", id: "fixed-1" });
		const second = writeControlRequest(dir, { action: "steer", text: "two", id: "fixed-1" });
		expect(second.request.id).toBe(first.request.id);
		expect(listControlRequests(dir)).toHaveLength(1);
		expect(listControlRequests(dir)[0].text).toBe("two");
	});
});

// ---------------------------------------------------------------------------
// The byte bound on steer text
// ---------------------------------------------------------------------------

describe("steer message bound", () => {
	it("truncates an oversized message and flags it on the request", () => {
		const huge = "x".repeat(CONTROL_MAX_MESSAGE_BYTES + 4096);
		const filed = writeControlRequest(dir, { action: "steer", text: huge });

		expect(filed.truncated).toBe(true);
		expect(filed.droppedBytes).toBeGreaterThan(0);
		expect(filed.request.truncated).toBe(true);
		expect(Buffer.byteLength(filed.request.text ?? "", "utf8")).toBeLessThanOrEqual(CONTROL_MAX_MESSAGE_BYTES);

		// The bound is about what lands on disk, not just what comes back.
		const raw = readFileSync(controlRequestPath(dir, filed.request.id), "utf8");
		const stored = parseControlRequest(raw);
		expect(Buffer.byteLength(stored?.text ?? "", "utf8")).toBeLessThanOrEqual(CONTROL_MAX_MESSAGE_BYTES);
		expect(stored?.truncated).toBe(true);
	});

	it("notes the truncation in the ledger so status can surface it", () => {
		const filed = writeControlRequest(dir, { action: "steer", text: "y".repeat(CONTROL_MAX_MESSAGE_BYTES * 2) });
		const receipts = readControlReceipts(dir);
		expect(receipts[0].note).toContain("truncated");
		expect(formatControlRequestsForStatus(dir)).toContain("truncated");
		expect(filed.request.id).toBeDefined();
	});

	it("leaves a message at the bound untouched", () => {
		const exact = "a".repeat(CONTROL_MAX_MESSAGE_BYTES);
		const filed = writeControlRequest(dir, { action: "steer", text: exact });
		expect(filed.truncated).toBe(false);
		expect(filed.request.text).toBe(exact);
	});

	it("does not split a multi-byte code point", () => {
		const text = "é".repeat(20000); // 3 bytes each in UTF-8
		const capped = capControlText(text, 1000);
		expect(capped.truncated).toBe(true);
		expect(Buffer.byteLength(capped.text, "utf8")).toBeLessThanOrEqual(1000);
		expect(capped.text).not.toContain("\uFFFD");
		expect(capped.text.startsWith("é")).toBe(true);
	});

	it("keeps an emoji intact at the cut boundary", () => {
		const text = "🦀".repeat(5000);
		const capped = capControlText(text, 64);
		expect(capped.text).not.toContain("\uFFFD");
		expect(Buffer.byteLength(capped.text, "utf8")).toBeLessThanOrEqual(64);
	});
});

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

describe("claimControlRequest", () => {
	it("moves the request out of the pending directory exactly once", () => {
		const { request } = writeControlRequest(dir, { action: "steer", text: "go left" });

		const claimed = claimControlRequest(dir, request.id);
		expect(claimed?.text).toBe("go left");
		expect(listControlRequests(dir)).toEqual([]);
		expect(listClaimedControlRequests(dir).map((row) => row.id)).toEqual([request.id]);

		// A second claimer finds nothing: no double delivery.
		expect(claimControlRequest(dir, request.id)).toBeUndefined();
	});

	it("keeps the claimed copy readable and parseable", () => {
		const { request } = writeControlRequest(dir, { action: "stop" });
		claimControlRequest(dir, request.id);
		const stored = parseControlRequest(readFileSync(controlAppliedPath(dir, request.id), "utf8"));
		expect(stored?.action).toBe("stop");
	});

	it("returns undefined for an id that was never filed", () => {
		expect(claimControlRequest(dir, "steer_nope")).toBeUndefined();
	});

	it("reports a request as pending until it is claimed", () => {
		const { request } = writeControlRequest(dir, { action: "interrupt" });
		expect(summarizeControlRequests(dir)[0].pending).toBe(true);
		claimControlRequest(dir, request.id);
		expect(summarizeControlRequests(dir)[0].pending).toBe(false);
	});
});

describe("discardControlRequest", () => {
	it("removes a request that will never be delivered", () => {
		const { request } = writeControlRequest(dir, { action: "steer", text: "scratch this" });
		expect(discardControlRequest(dir, request.id)).toBe(true);
		expect(listControlRequests(dir)).toEqual([]);
		// Discarding twice is not an error worth propagating.
		expect(discardControlRequest(dir, request.id)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

describe("receipt ledger", () => {
	it("records transitions in order and reports the newest state", () => {
		const { request } = writeControlRequest(dir, { action: "steer", text: "one" });
		recordControlState(dir, { id: request.id, action: "steer", state: "scheduled", by: "parent" });
		recordControlState(dir, { id: request.id, action: "steer", state: "queued", by: "child" });
		recordControlState(dir, { id: request.id, action: "steer", state: "delivered", by: "child" });

		const receipts = readControlReceipts(dir);
		expect(receipts.map((row) => row.state)).toEqual(["requested", "scheduled", "queued", "delivered"]);

		const latest = new Map(receipts.map((row) => [row.id, row.state]));
		expect(latest.get(request.id)).toBe("delivered");
	});

	it("carries a failure note to the terminal state", () => {
		const { request } = writeControlRequest(dir, { action: "steer", text: "bad" });
		recordControlState(dir, {
			id: request.id,
			action: "steer",
			state: "failed",
			by: "child",
			note: "session disposed",
		});
		const row = summarizeControlRequests(dir).find((entry) => entry.request.id === request.id);
		expect(row?.state).toBe("failed");
		expect(row?.note).toBe("session disposed");
	});

	it("drops corrupt and foreign-version ledger lines instead of throwing", () => {
		mkdirSync(dir, { recursive: true });
		const lines = [
			"{ not json",
			JSON.stringify({
				version: 99,
				id: "x",
				action: "steer",
				state: "delivered",
				at: "2026-01-01T00:00:00.000Z",
				by: "child",
			}),
			JSON.stringify({
				version: 1,
				id: "x",
				action: "explode",
				state: "delivered",
				at: "2026-01-01T00:00:00.000Z",
				by: "child",
			}),
			"",
			"   ",
			JSON.stringify({
				version: 1,
				id: "ok",
				action: "steer",
				state: "queued",
				at: "2026-01-01T00:00:00.000Z",
				by: "child",
			}),
		];
		writeFileSync(controlReceiptsPath(dir), `${lines.join("\n")}\n`);
		const receipts = readControlReceipts(dir);
		expect(receipts.map((row) => row.id)).toEqual(["ok"]);
	});

	it("reads an empty or missing ledger as no receipts", () => {
		expect(readControlReceipts(dir)).toEqual([]);
		mkdirSync(dir, { recursive: true });
		writeFileSync(controlReceiptsPath(dir), "");
		expect(readControlReceipts(dir)).toEqual([]);
	});

	it("appends to an existing ledger without rewriting it", () => {
		mkdirSync(dir, { recursive: true });
		appendFileSync(controlReceiptsPath(dir), "garbage line\n");
		const { request } = writeControlRequest(dir, { action: "stop" });
		expect(request.action).toBe("stop");
		expect(readControlReceipts(dir).map((row) => row.state)).toEqual(["requested"]);
	});
});

// ---------------------------------------------------------------------------
// Listing / formatting
// ---------------------------------------------------------------------------

describe("listings", () => {
	it("lists pending requests oldest first", () => {
		for (const text of ["first", "second", "third"]) {
			writeControlRequest(dir, { action: "steer", text });
		}
		const ids = listControlRequests(dir);
		expect(ids).toHaveLength(3);
		for (let i = 1; i < ids.length; i += 1) {
			expect(Date.parse(ids[i - 1].createdAt) <= Date.parse(ids[i].createdAt)).toBe(true);
		}
	});

	it("formats a status line per request", () => {
		const filed = writeControlRequest(dir, { action: "steer", text: "hello", targetId: "bg_1" });
		recordControlState(dir, { id: filed.request.id, action: "steer", state: "scheduled", by: "parent" });
		const text = formatControlRequestsForStatus(dir);
		expect(text).toContain(`id=${filed.request.id}`);
		expect(text).toContain("action=steer");
		expect(text).toContain("state=scheduled");
		expect(text).toContain("awaiting child");
	});

	it("returns an empty string when the inbox is empty or absent", () => {
		expect(formatControlRequestsForStatus(dir)).toBe("");
		expect(formatControlRequestsForStatus(join(root, "nope", "control"))).toBe("");
	});

	it("skips a half-written request file without failing the listing", () => {
		writeControlRequest(dir, { action: "steer", text: "good" });
		mkdirSync(join(dir, CONTROL_REQUESTS_DIR_NAME), { recursive: true });
		writeFileSync(join(dir, CONTROL_REQUESTS_DIR_NAME, "broken.json"), '{"version":1,"id":"b"');
		const listed = listControlRequests(dir);
		expect(listed).toHaveLength(1);
		expect(listed[0].text).toBe("good");
	});
});

// ---------------------------------------------------------------------------
// Parsing guards
// ---------------------------------------------------------------------------

describe("parsers", () => {
	it("rejects requests with an unknown action or version", () => {
		expect(
			parseControlRequest(JSON.stringify({ version: 1, id: "a", action: "pause", createdAt: "x" })),
		).toBeUndefined();
		expect(
			parseControlRequest(JSON.stringify({ version: 2, id: "a", action: "steer", createdAt: "x" })),
		).toBeUndefined();
		expect(parseControlRequest(JSON.stringify({ version: 1, action: "steer", createdAt: "x" }))).toBeUndefined();
		expect(parseControlRequest("[]")).toBeUndefined();
	});

	it("rejects receipts with an unknown state", () => {
		expect(
			parseControlReceipt(
				JSON.stringify({ version: 1, id: "a", action: "steer", state: "exploded", at: "x", by: "child" }),
			),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe("pruneControlDir", () => {
	it("collects claimed requests past their age bound", () => {
		const { request } = writeControlRequest(dir, { action: "steer", text: "old" });
		claimControlRequest(dir, request.id);
		// Rewrite the claim with an ancient timestamp, as time passing would.
		const stale = { ...request, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() };
		writeFileSync(controlAppliedPath(dir, request.id), JSON.stringify(stale));

		const result = pruneControlDir(dir, { maxAgeMs: 60 * 60 * 1000 });
		expect(result.requestsRemoved).toBe(1);
		expect(listClaimedControlRequests(dir)).toEqual([]);
	});

	it("never collects a pending request", () => {
		const { request } = writeControlRequest(dir, { action: "steer", text: "waiting" });
		const stale = { ...request, createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() };
		writeFileSync(controlRequestPath(dir, request.id), JSON.stringify(stale));

		pruneControlDir(dir, { maxAgeMs: 1000 });
		expect(listControlRequests(dir).map((row) => row.id)).toEqual([request.id]);
	});

	it("keeps the newest receipt lines and rewrites the ledger atomically", () => {
		const { request } = writeControlRequest(dir, { action: "steer", text: "many" });
		for (const state of ["scheduled", "queued", "delivered"] as const) {
			recordControlState(dir, { id: request.id, action: "steer", state, by: "child" });
		}
		const result = pruneControlDir(dir, { maxReceiptLines: 2 });
		expect(result.receiptLinesDropped).toBe(2);
		const kept = readControlReceipts(dir);
		expect(kept.map((row) => row.state)).toEqual(["queued", "delivered"]);
		expect(readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("is a no-op on a directory that does not exist", () => {
		const result = pruneControlDir(join(root, "missing", "control"));
		expect(result.requestsRemoved).toBe(0);
		expect(result.receiptLinesDropped).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Environment plumbing
// ---------------------------------------------------------------------------

describe("control dir from the environment", () => {
	it("reads the env var and ignores blank values", () => {
		expect(controlDirFromEnv({ [CONTROL_DIR_ENV]: join(root, "control") })).toBe(join(root, "control"));
		expect(controlDirFromEnv({ [CONTROL_DIR_ENV]: "   " })).toBeUndefined();
		expect(controlDirFromEnv({})).toBeUndefined();
		expect(hasControlDir({ [CONTROL_DIR_ENV]: "/tmp/x" })).toBe(true);
		expect(hasControlDir({})).toBe(false);
	});

	it("derives the default location from a task dir", () => {
		expect(controlDirFor(join(root, "bg_1"))).toBe(join(root, "bg_1", "control"));
	});
});
