/**
 * End-to-end single-agent delegation through the native subagent tool
 * (plan 6.3), on the faux provider - no real provider APIs or keys.
 *
 * Scope note (recorded in the plan log): the faux provider is injected
 * in-process and cannot reach a spawned child, so the child runs behind the
 * runner seam here. The real subprocess path is covered by the Bun-gated
 * runner tests (subagent-runner.test.ts) and the implementation smokes.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { getAnalyticsStore } from "../../src/core/analytics-store.ts";
import { createSubagentTool } from "../../src/core/subagent/subagent-tool.ts";
import { createEmptyUsage, type SubagentResult, type SubagentRunner } from "../../src/core/subagent/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("native subagent tool end-to-end", () => {
	const harnesses: Harness[] = [];
	let previousAnalyticsHome: string | undefined;
	let analyticsHome: string | undefined;

	afterEach(() => {
		getAnalyticsStore().close();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		if (analyticsHome && existsSync(analyticsHome)) {
			rmSync(analyticsHome, { recursive: true, force: true });
		}
		if (previousAnalyticsHome === undefined) {
			delete process.env.PI_TEST_ANALYTICS_HOME;
		} else {
			process.env.PI_TEST_ANALYTICS_HOME = previousAnalyticsHome;
		}
		previousAnalyticsHome = undefined;
		analyticsHome = undefined;
	});

	it("delegates to a subagent and records a pi_subagent_tasks row", async () => {
		const stubRunner: SubagentRunner = {
			async run(request): Promise<SubagentResult> {
				return {
					role: request.spec.role,
					task: request.task,
					exitCode: 0,
					aborted: false,
					finalOutput: "child summary: 42",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				};
			},
		};

		const harness = await createHarness({ tools: [createSubagentTool(process.cwd(), { runner: stubRunner })] });
		harnesses.push(harness);

		// Isolated analytics DB so the assertion reads a real row without
		// touching the user's telemetry store.
		previousAnalyticsHome = process.env.PI_TEST_ANALYTICS_HOME;
		analyticsHome = join(harness.tempDir, "analytics-home");
		mkdirSync(analyticsHome, { recursive: true });
		process.env.PI_TEST_ANALYTICS_HOME = analyticsHome;
		getAnalyticsStore().beginRun("test-session", null);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { role: "scout", instructions: "find the answer" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The scout reports: 42"),
		]);

		await harness.session.prompt("delegate this");

		// The tool result carries the child summary back to the model.
		expect(harness.session.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(getMessageText(harness.session.messages[2])).toContain("child summary: 42");
		expect(getMessageText(harness.session.messages[3])).toBe("The scout reports: 42");

		// pi_subagent_tasks gained exactly one row for the dispatched run.
		// Spans are inserted when the run is flushed (after the pi_runs row,
		// which the table's foreign key requires).
		getAnalyticsStore().flushRun("completed");
		const analyticsDir = join(analyticsHome, "analytics");
		expect(existsSync(analyticsDir)).toBe(true);
		const dbFile = readdirSync(analyticsDir).find((name) => name.endsWith(".db"));
		expect(dbFile).toBeDefined();
		const db = new Database(join(analyticsDir, dbFile as string), { readonly: true });
		try {
			const rows = db
				.prepare("SELECT agent_name, task_label, success FROM pi_subagent_tasks WHERE agent_name = ?")
				.all("scout") as Array<{ agent_name: string; task_label: string; success: number }>;
			expect(rows).toHaveLength(1);
			expect(rows[0].task_label).toBe("find the answer");
			expect(rows[0].success).toBe(1);
		} finally {
			db.close();
		}
	}, 20_000);
});
