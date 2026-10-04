import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS } from "../src/core/defaults.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("subagent.* settings", () => {
	const testDir = join(process.cwd(), "test-subagent-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("falls back to documented defaults when unset", () => {
		const manager = SettingsManager.inMemory({});
		expect(manager.getSubagentEnabled()).toBe(true);
		expect(manager.getSubagentMaxConcurrent()).toBe(4);
		expect(manager.getSubagentMaxParallelTasks()).toBe(8);
		expect(manager.getSubagentWorktreeBase()).toBe(".worktrees");
		expect(manager.getSubagentEnableExperiments()).toBe(false);
		expect(manager.getSubagentResearchModeTriggerCount()).toBe(3);
		expect(DEFAULT_SUBAGENT_SETTINGS).toEqual({
			enabled: true,
			maxConcurrent: 4,
			maxParallelTasks: 8,
			worktreeBase: ".worktrees",
			enableExperiments: false,
			researchModeTriggerCount: 3,
		});
	});

	it("round-trips all six keys through settings.json", () => {
		const written = {
			subagent: {
				enabled: false,
				maxConcurrent: 7,
				maxParallelTasks: 3,
				worktreeBase: "wt-base",
				enableExperiments: true,
				researchModeTriggerCount: 5,
			},
		};
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(written, null, 2), "utf-8");

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getSubagentEnabled()).toBe(false);
		expect(manager.getSubagentMaxConcurrent()).toBe(7);
		expect(manager.getSubagentMaxParallelTasks()).toBe(3);
		expect(manager.getSubagentWorktreeBase()).toBe("wt-base");
		expect(manager.getSubagentEnableExperiments()).toBe(true);
		expect(manager.getSubagentResearchModeTriggerCount()).toBe(5);

		// The keys survive on disk exactly as written (no migration swallow).
		const onDisk = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as typeof written;
		expect(onDisk.subagent).toEqual(written.subagent);
	});

	it("survives a manager reload from disk", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ subagent: { maxParallelTasks: 2, enableExperiments: true } }),
			"utf-8",
		);
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getSubagentMaxParallelTasks()).toBe(2);
		expect(manager.getSubagentEnableExperiments()).toBe(true);
		await manager.reload();
		expect(manager.getSubagentMaxParallelTasks()).toBe(2);
		expect(manager.getSubagentEnableExperiments()).toBe(true);
		// Unset keys stay at defaults across reload.
		expect(manager.getSubagentMaxConcurrent()).toBe(4);
	});

	it("clamps out-of-range numbers and rejects wrong types", () => {
		const manager = SettingsManager.inMemory({
			subagent: {
				maxConcurrent: -5,
				maxParallelTasks: 0,
				researchModeTriggerCount: 2.7,
				worktreeBase: "",
			},
		});
		expect(manager.getSubagentMaxConcurrent()).toBe(1);
		expect(manager.getSubagentMaxParallelTasks()).toBe(1);
		expect(manager.getSubagentResearchModeTriggerCount()).toBe(2);
		expect(manager.getSubagentWorktreeBase()).toBe(".worktrees");

		const wrongTypes = SettingsManager.inMemory({ subagent: { maxConcurrent: 4 } });
		expect(wrongTypes.getSubagentMaxConcurrent()).toBe(4);

		// Wrong types arrive through hand-edited JSON; the getters must fall back.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ subagent: { maxConcurrent: "many", enabled: "yes", enableExperiments: 1, worktreeBase: 42 } }),
			"utf-8",
		);
		const fromFile = SettingsManager.create(projectDir, agentDir);
		expect(fromFile.getSubagentMaxConcurrent()).toBe(4);
		expect(fromFile.getSubagentEnabled()).toBe(true);
		expect(fromFile.getSubagentEnableExperiments()).toBe(false);
		expect(fromFile.getSubagentWorktreeBase()).toBe(".worktrees");
	});
});
