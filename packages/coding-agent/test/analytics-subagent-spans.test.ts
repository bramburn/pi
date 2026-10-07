/**
 * pi_subagent_tasks span lifecycle.
 *
 * Background spans settle after flushRun (a fire-and-forget task outlives the
 * turn), so endSubagentTask must close an already-flushed row in place instead
 * of silently dropping the outcome.
 *
 * CI installs with --ignore-scripts, so better-sqlite3's native bindings may be
 * absent. The row assertions need a real sqlite DB; skip them where the
 * bindings cannot load (the smoke tests below do not open the store).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endSubagentTask, getAnalyticsStore, startSubagentTask } from "../src/core/analytics-store.ts";

let sqliteBindingsAvailable = true;
try {
	const probe = new Database(":memory:");
	probe.close();
} catch {
	sqliteBindingsAvailable = false;
}

interface SpanRow {
	end_time: number | null;
	success: number | null;
	error_message: string | null;
	duration_ms: number | null;
}

let home: string;
let store: ReturnType<typeof getAnalyticsStore>;

function readSpanRow(spanId: string): SpanRow | undefined {
	const analyticsDir = join(home, "analytics");
	const dbFile = readdirSync(analyticsDir).find((f) => f.endsWith(".db"));
	if (!dbFile) return undefined;
	const db = new Database(join(analyticsDir, dbFile));
	try {
		return db
			.prepare("SELECT end_time, success, error_message, duration_ms FROM pi_subagent_tasks WHERE span_id = ?")
			.get(spanId) as SpanRow | undefined;
	} finally {
		db.close();
	}
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-analytics-test-"));
	process.env.PI_TEST_ANALYTICS_HOME = home;
	store = getAnalyticsStore();
});

afterEach(() => {
	store.close();
	delete process.env.PI_TEST_ANALYTICS_HOME;
	if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!sqliteBindingsAvailable)("pi_subagent_tasks spans", () => {
	it("records the outcome when a span settles after flushRun", () => {
		store.beginRun("session-1", null);
		startSubagentTask({ spanId: "span-1", agentName: "tester", taskLabel: "task one" });
		store.flushRun("completed");
		endSubagentTask("span-1", false, "boom");

		const row = readSpanRow("span-1");
		expect(row).toBeDefined();
		expect(row?.end_time).not.toBeNull();
		expect(row?.success).toBe(0);
		expect(row?.error_message).toBe("boom");
		expect(row?.duration_ms).not.toBeNull();
	});

	it("keeps the batched-insert fast path for spans that settle before flushRun", () => {
		store.beginRun("session-1", null);
		startSubagentTask({ spanId: "span-2", agentName: "tester", taskLabel: "task two" });
		endSubagentTask("span-2", true);
		store.flushRun("completed");

		const row = readSpanRow("span-2");
		expect(row).toBeDefined();
		expect(row?.end_time).not.toBeNull();
		expect(row?.success).toBe(1);
		expect(row?.error_message).toBeNull();
	});

	it("closes a flushed span even after a later run reset the pending map", () => {
		store.beginRun("session-1", null);
		startSubagentTask({ spanId: "span-3", agentName: "tester", taskLabel: "task three" });
		store.flushRun("completed");
		store.beginRun("session-2", null);
		endSubagentTask("span-3", true);
		store.flushRun("completed");

		const row = readSpanRow("span-3");
		expect(row).toBeDefined();
		expect(row?.success).toBe(1);
		expect(row?.end_time).not.toBeNull();
	});

	it("leaves a flushed row untouched for an unknown span id", () => {
		store.beginRun("session-1", null);
		startSubagentTask({ spanId: "span-4", agentName: "tester", taskLabel: "task four" });
		store.flushRun("completed");
		endSubagentTask("missing", true, "nope");

		expect(readSpanRow("missing")).toBeUndefined();
		const row = readSpanRow("span-4");
		expect(row?.end_time).toBeNull();
		expect(row?.success).toBeNull();
	});
});

describe("span lifecycle without an open database", () => {
	it("ignores an unknown span id without opening the store", () => {
		store.endSubagentTask("missing", true);
		expect(existsSync(join(home, "analytics"))).toBe(false);
	});

	it("keeps the public wrappers best-effort (never throw)", () => {
		expect(() => startSubagentTask({ spanId: "orphan", agentName: "tester", taskLabel: "t" })).not.toThrow();
		expect(() => endSubagentTask("orphan", false, "boom")).not.toThrow();
	});
});
