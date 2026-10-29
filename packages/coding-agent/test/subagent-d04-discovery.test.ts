/**
 * REQ-D04: saved specs carry a required one-line `description`, and the
 * description renders the saved-specialist roster into the `subagent` tool
 * description with the cap disclosed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { saveSpec } from "../src/core/subagent/saved-specs.ts";
import { createSubagentToolDefinition, MAX_RENDERED_SAVED_SPECS } from "../src/core/subagent/subagent-tool.ts";

describe("REQ-D04 saved spec description & tool description discovery", () => {
	let tempDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-d04-specs-"));
		prevAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = tempDir;
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = prevAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects saving a spec without a description", async () => {
		const tool = createSubagentToolDefinition(tempDir);
		await expect(
			tool.execute(
				"call-save-missing",
				{ action: "save-spec", name: "db-auditor", role: "auditor", instructions: "Check migrations." },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/description/);
	});

	it("rejects a whitespace-only description", async () => {
		const tool = createSubagentToolDefinition(tempDir);
		await expect(
			tool.execute(
				"call-save-blank",
				{
					action: "save-spec",
					name: "db-auditor",
					role: "auditor",
					description: "   \n\t ",
					instructions: "Check migrations.",
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/description/);
	});

	it("renders saved specs and their descriptions into the subagent tool description with cap disclosure", async () => {
		const tool = createSubagentToolDefinition(tempDir);
		await tool.execute(
			"call-save-ok",
			{
				action: "save-spec",
				name: "db-auditor",
				role: "auditor",
				description: "Audit SQL migrations and schema drift",
				instructions: "Inspect sql/ and report issues.",
			},
			undefined,
			undefined,
			{} as never,
		);

		expect(tool.description).toContain('"db-auditor" (Audit SQL migrations and schema drift)');

		for (let i = 0; i < MAX_RENDERED_SAVED_SPECS + 2; i++) {
			saveSpec(`spec-${String(i).padStart(2, "0")}`, {
				role: "worker",
				description: `Specialist number ${i}`,
				instructions: "Do work.",
			});
		}
		expect(tool.description).toContain(`showing ${MAX_RENDERED_SAVED_SPECS} of ${MAX_RENDERED_SAVED_SPECS + 3}`);
	});

	it("lists the description alongside each spec in action=list-specs", async () => {
		const tool = createSubagentToolDefinition(tempDir);
		await tool.execute(
			"call-save-list",
			{
				action: "save-spec",
				name: "scout",
				role: "scout",
				description: "Fast read-only reconnaissance",
				instructions: "Scan the repo.",
			},
			undefined,
			undefined,
			{} as never,
		);
		const result = await tool.execute("call-list", { action: "list-specs" }, undefined, undefined, {} as never);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("name=scout");
		expect(text).toContain("description=Fast read-only reconnaissance");
	});
});
