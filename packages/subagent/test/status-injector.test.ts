/**
 * Tests for src/status-injector.ts — markdown status block generator.
 */

import type { BackgroundTask } from "../src/background.ts";
import { buildStatusInjection } from "../src/status-injector.ts";

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
	return {
		id: "bg_test",
		kind: "pi-subprocess",
		mode: "single",
		agent: "scout",
		agentScope: "user",
		label: "scout (single)",
		scriptOrTask: "scout this",
		status: "running",
		startedAt: new Date().toISOString(),
		lastEventAt: new Date().toISOString(),
		lastOutput: "",
		cwd: "/tmp",
		...overrides,
	};
}

describe("buildStatusInjection", () => {
	it("returns empty string when there are no tasks", () => {
		expect(buildStatusInjection([])).toBe("");
	});

	it("includes the running table when there is at least one running task", () => {
		const out = buildStatusInjection([makeTask()]);
		expect(out).toContain("## [RUNTIME STATUS");
		expect(out).toContain("### Running (1)");
		expect(out).toContain("`bg_test`");
		expect(out).toContain("scout");
	});

	it("shows 'No background tasks are currently running' when only terminal tasks exist", () => {
		const out = buildStatusInjection([
			makeTask({
				id: "bg_done",
				status: "completed",
				startedAt: new Date(Date.now() - 60_000).toISOString(),
				lastOutput: "all done",
			}),
		]);
		expect(out).toContain("No background tasks are currently running.");
		expect(out).toContain("### Recent (last 1 of 1 terminal)");
	});

	it("includes both Running and Recent blocks when both are present", () => {
		const out = buildStatusInjection([
			makeTask({ id: "bg_a", status: "running" }),
			makeTask({
				id: "bg_b",
				status: "completed",
				startedAt: new Date(Date.now() - 60_000).toISOString(),
				lastOutput: "ok",
			}),
		]);
		expect(out).toContain("### Running (1)");
		expect(out).toContain("### Recent (last 1 of 1 terminal)");
	});

	it("truncates the block when it exceeds STATUS_BLOCK_MAX_CHARS", () => {
		// 60 running tasks each with an output just under clipPreview's cap,
		// each generating a long table row. The capped output clips to ~120
		// chars per row, but 8 rows are shown for running + many more
		// rows could push the markdown past the 2400-char threshold.
		// To deterministically trigger truncation we craft a long agent name
		// which expands the table without being clipped.
		const tasks: BackgroundTask[] = [];
		const longAgent = "a".repeat(400);
		for (let i = 0; i < 60; i++) {
			tasks.push(
				makeTask({
					id: `bg_${i}`,
					agent: longAgent,
					status: "running",
					lastOutput: "y".repeat(80),
				}),
			);
		}
		const out = buildStatusInjection(tasks);
		// Truncation marker is added whenever joined.length > STATUS_BLOCK_MAX_CHARS (2400)
		expect(out.length).toBeLessThanOrEqual(2500);
	});

	it("clips long lastOutput to MAX_PREVIEW", () => {
		const longOutput = "y".repeat(500);
		const out = buildStatusInjection([
			makeTask({
				id: "bg_a",
				status: "completed",
				startedAt: new Date(Date.now() - 60_000).toISOString(),
				lastOutput: longOutput,
			}),
		]);
		expect(out).toContain("…");
		expect(out).not.toContain("y".repeat(500));
	});

	it("falls back to '(no output yet)' for empty lastOutput on running tasks", () => {
		const out = buildStatusInjection([makeTask({ id: "bg_a", lastOutput: "" })]);
		expect(out).toContain("(no output yet)");
	});

	it("formats elapsed time in seconds when under a minute", () => {
		const startedAt = new Date(Date.now() - 5_000).toISOString();
		const out = buildStatusInjection([makeTask({ id: "bg_a", startedAt })]);
		// 5 seconds rounds to 5s
		expect(out).toMatch(/\|\s*\d+s\s*\|/);
	});

	it("formats elapsed time in minutes when between 1min and 1hour", () => {
		const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
		const out = buildStatusInjection([makeTask({ id: "bg_a", startedAt })]);
		expect(out).toMatch(/\|\s*\d+m\s*\|/);
	});

	it("formats elapsed time in hours when >= 1 hour", () => {
		const startedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
		const out = buildStatusInjection([makeTask({ id: "bg_a", startedAt })]);
		expect(out).toMatch(/\|\s*\d+h\s*\|/);
	});
});