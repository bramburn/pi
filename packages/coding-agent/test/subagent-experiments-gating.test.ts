import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addExperiment, type ExperimentRow, REGISTRY_VERSION } from "../src/core/subagent/experiment-registry.ts";
import { EXPERIMENT_TOOL_NAMES } from "../src/core/subagent/experiment-tools.ts";
import type { SubagentSettingsReader } from "../src/core/subagent/subagent-tool.ts";
import {
	createAllToolDefinitions,
	createAllTools,
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	createTool,
	createToolDefinition,
	type ToolName,
} from "../src/core/tools/index.ts";

const experimentNames = [...EXPERIMENT_TOOL_NAMES].sort();
const settingsWith = (experiments: boolean): SubagentSettingsReader => ({
	get: (key: string) => (key === "subagent.enableExperiments" ? experiments : undefined),
});

describe("experiment tool gating (subagent.enableExperiments)", () => {
	it("registers no experiment_* tools when the flag is off", () => {
		const defs = createAllToolDefinitions(process.cwd(), { subagent: { settings: settingsWith(false) } });
		expect(Object.keys(defs).filter((n) => n.startsWith("experiment_"))).toHaveLength(0);

		const noSetting = createAllToolDefinitions(process.cwd(), { subagent: {} });
		expect(Object.keys(noSetting).filter((n) => n.startsWith("experiment_"))).toHaveLength(0);

		const coding = createCodingTools(process.cwd(), { subagent: { settings: settingsWith(false) } });
		expect(coding.map((t) => t.name).filter((n) => n.startsWith("experiment_"))).toHaveLength(0);
	});

	it("registers all eight when the flag is on", () => {
		const defs = createAllToolDefinitions(process.cwd(), { subagent: { settings: settingsWith(true) } });
		expect(
			Object.keys(defs)
				.filter((n) => n.startsWith("experiment_"))
				.sort(),
		).toEqual(experimentNames);

		const defList = createCodingToolDefinitions(process.cwd(), { subagent: { settings: settingsWith(true) } });
		expect(
			defList
				.map((d) => d.name)
				.filter((n) => n.startsWith("experiment_"))
				.sort(),
		).toEqual(experimentNames);

		const tools = createAllTools(process.cwd(), { subagent: { settings: settingsWith(true) } });
		expect(
			Object.keys(tools)
				.filter((n) => n.startsWith("experiment_"))
				.sort(),
		).toEqual(experimentNames);
	});

	it("never registers experiment tools as read-only", () => {
		const readOnly = createReadOnlyToolDefinitions(process.cwd(), { subagent: { settings: settingsWith(true) } });
		expect(readOnly.map((d) => d.name).filter((n) => n.startsWith("experiment_"))).toHaveLength(0);
	});

	it("resolves every experiment tool by name", () => {
		for (const name of EXPERIMENT_TOOL_NAMES) {
			const def = createToolDefinition(name as ToolName, process.cwd());
			expect(def.name).toBe(name);
			const tool = createTool(name as ToolName, process.cwd());
			expect(tool.name).toBe(name);
		}
	});
});

describe("registry on-disk format (byte-compatible with the reference extension)", () => {
	const testDir = join(process.cwd(), "test-experiment-registry-tmp");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("writes JSON.stringify(data, null, 2) + trailing newline with version 1", () => {
		const row: ExperimentRow = {
			id: "exp-20260101120000-bun-ipc-worker",
			hypothesis: "IPC beats JSONL for child messages",
			approach: "bun-ipc-worker",
			worktreePath: "C:/repo/.worktrees/bun-ipc-worker",
			branch: "exp/bun-ipc-worker",
			parentCommit: "0123456789abcdef",
			startedInCwd: "C:/repo",
			status: "scaffolded",
			result: {},
			merged: false,
			createdAt: "2026-01-01T12:00:00.000Z",
			updatedAt: "2026-01-01T12:00:00.000Z",
		};
		addExperiment(testDir, row);

		const raw = readFileSync(join(testDir, ".pi-experiments", "registry.json"), "utf-8");
		const expected = `${JSON.stringify({ version: REGISTRY_VERSION, experiments: [row] }, null, 2)}\n`;
		expect(raw).toBe(expected);

		// Round-trip: the file parses back to the exact same shape and row.
		const parsed = JSON.parse(raw) as { version: number; experiments: ExperimentRow[] };
		expect(parsed.version).toBe(1);
		expect(parsed.experiments).toEqual([row]);
	});
});
