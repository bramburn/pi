import { describe, expect, it } from "vitest";
import { isBunRuntime } from "../src/core/subagent/runtime.ts";
import { createTool, createToolDefinition, type ToolsOptions } from "../src/core/tools/index.ts";

/**
 * The by-name factories (createTool / createToolDefinition) must enforce the
 * same registration guards as the registry paths (createAllToolDefinitions),
 * throwing instead of silently handing out flag-gated tools.
 */

const experimentsOff: ToolsOptions = { subagent: { settings: { get: () => false } } };
const experimentsOn: ToolsOptions = {
	subagent: { settings: { get: (key: string) => key === "subagent.enableExperiments" } },
};
const subagentDisabled: ToolsOptions = {
	subagent: { settings: { get: (key: string) => (key === "subagent.enabled" ? false : undefined) } },
};

describe("by-name tool factories enforce registration guards", () => {
	it("createTool('experiment_start') throws when subagent.enableExperiments is off", () => {
		expect(() => createTool("experiment_start", process.cwd(), experimentsOff)).toThrow(
			/subagent\.enableExperiments/,
		);
	});

	it("createTool('experiment_start') throws without a settings reader (default off)", () => {
		expect(() => createTool("experiment_start", process.cwd())).toThrow(/subagent\.enableExperiments/);
	});

	it("createToolDefinition('experiment_list') throws when the flag is off", () => {
		expect(() => createToolDefinition("experiment_list", process.cwd(), experimentsOff)).toThrow(
			/subagent\.enableExperiments/,
		);
	});

	it("createTool('experiment_start') works when the flag is on", () => {
		const tool = createTool("experiment_start", process.cwd(), experimentsOn);
		expect(tool.name).toBe("experiment_start");
	});

	it("createTool('subagent') throws when subagent.enabled is off", () => {
		expect(() => createTool("subagent", process.cwd(), subagentDisabled)).toThrow(/subagent\.enabled/);
	});

	it("createToolDefinition('subagent') throws when subagent.enabled is off", () => {
		expect(() => createToolDefinition("subagent", process.cwd(), subagentDisabled)).toThrow(/subagent\.enabled/);
	});

	it.skipIf(isBunRuntime())("createTool('subagent') throws without an injected runner on non-Bun runtimes", () => {
		expect(() => createTool("subagent", process.cwd())).toThrow(/Bun runtime/);
	});
});
