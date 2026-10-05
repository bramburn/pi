export {
	createExperimentToolDefinitions,
	createExperimentTools,
	EXPERIMENT_TOOL_NAMES,
	type ExperimentToolName,
	shouldRegisterExperimentTools,
} from "../subagent/experiment-tools.ts";
export {
	createSubagentTool,
	createSubagentToolDefinition,
	type SubagentSettingsReader,
	type SubagentToolDetails,
	type SubagentToolInput,
	type SubagentToolOptions,
	shouldRegisterSubagentTool,
} from "../subagent/subagent-tool.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	createExperimentToolDefinitions,
	createExperimentTools,
	EXPERIMENT_TOOL_NAMES,
	type ExperimentToolName,
	shouldRegisterExperimentTools,
} from "../subagent/experiment-tools.ts";
import {
	createSubagentTool,
	createSubagentToolDefinition,
	type SubagentToolOptions,
	shouldRegisterSubagentTool,
} from "../subagent/subagent-tool.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "powershell"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "subagent"
	| ExperimentToolName;
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"subagent",
	...EXPERIMENT_TOOL_NAMES,
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	subagent?: SubagentToolOptions;
}

/**
 * By-name factories are explicit opt-ins, so they enforce the same registration
 * guards as the registry paths instead of handing out flag-gated tools.
 */
function ensureSubagentToolAllowed(options?: ToolsOptions): void {
	if (shouldRegisterSubagentTool(options?.subagent)) return;
	throw new Error(
		"subagent tool requires the Bun runtime (or an injected runner) with subagent.enabled: true — use createAllToolDefinitions for conditional registration",
	);
}

function ensureExperimentToolsAllowed(options?: ToolsOptions): void {
	if (shouldRegisterExperimentTools(options?.subagent)) return;
	throw new Error("experiment tools require subagent.enableExperiments: true — use createAllToolDefinitions");
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "subagent":
			ensureSubagentToolAllowed(options);
			return createSubagentToolDefinition(cwd, options?.subagent);
		case "experiment_start":
		case "experiment_run":
		case "experiment_test":
		case "experiment_diff":
		case "experiment_merge":
		case "experiment_discard":
		case "experiment_list":
		case "experiment_compare":
			ensureExperimentToolsAllowed(options);
			return createExperimentToolDefinitions(cwd, options?.subagent)[toolName];
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "subagent":
			ensureSubagentToolAllowed(options);
			return createSubagentTool(cwd, options?.subagent);
		case "experiment_start":
		case "experiment_run":
		case "experiment_test":
		case "experiment_diff":
		case "experiment_merge":
		case "experiment_discard":
		case "experiment_list":
		case "experiment_compare":
			ensureExperimentToolsAllowed(options);
			return createExperimentTools(cwd, options?.subagent)[toolName];
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const definitions: ToolDef[] = [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
	// Not read-only: a subagent spawns full agents with write access.
	if (shouldRegisterSubagentTool(options?.subagent)) {
		definitions.push(createSubagentToolDefinition(cwd, options?.subagent));
	}
	// Experiments create worktrees and merge branches — full write access.
	if (shouldRegisterExperimentTools(options?.subagent)) {
		definitions.push(...Object.values(createExperimentToolDefinitions(cwd, options?.subagent)));
	}
	return definitions;
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Partial<Record<ToolName, ToolDef>> {
	const definitions: Partial<Record<ToolName, ToolDef>> = {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
	};
	if (shouldRegisterSubagentTool(options?.subagent)) {
		definitions.subagent = createSubagentToolDefinition(cwd, options?.subagent);
	}
	if (shouldRegisterExperimentTools(options?.subagent)) {
		Object.assign(definitions, createExperimentToolDefinitions(cwd, options?.subagent));
	}
	return definitions;
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const tools: Tool[] = [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
	if (shouldRegisterSubagentTool(options?.subagent)) {
		tools.push(createSubagentTool(cwd, options?.subagent));
	}
	if (shouldRegisterExperimentTools(options?.subagent)) {
		tools.push(...Object.values(createExperimentTools(cwd, options?.subagent)));
	}
	return tools;
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Partial<Record<ToolName, Tool>> {
	const tools: Partial<Record<ToolName, Tool>> = {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		powershell: createPowerShellTool(cwd, options?.powershell),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
	};
	if (shouldRegisterSubagentTool(options?.subagent)) {
		tools.subagent = createSubagentTool(cwd, options?.subagent);
	}
	if (shouldRegisterExperimentTools(options?.subagent)) {
		Object.assign(tools, createExperimentTools(cwd, options?.subagent));
	}
	return tools;
}
