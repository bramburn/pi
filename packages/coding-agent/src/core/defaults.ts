import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SubagentSettings } from "./settings-manager.ts";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Defaults for the `subagent.*` settings (native subagent capability).
 *
 * `enabled` is the master switch for the built-in `subagent` tool;
 * `enableExperiments` gates the experiment tools, registry, and dashboard.
 */
/** Every `subagent.*` setting resolved to a concrete value (no optionality). */
export type ResolvedSubagentSettings = Required<SubagentSettings>;

export const DEFAULT_SUBAGENT_SETTINGS: ResolvedSubagentSettings = {
	enabled: true,
	maxConcurrent: 4,
	maxParallelTasks: 8,
	worktreeBase: ".worktrees",
	enableExperiments: false,
	researchModeTriggerCount: 3,
	/** Max subagent spawns allowed per session, across inline and background. */
	maxTotalSpawns: 64,
	/** Per-tool-call wall-clock budget inside a child subagent. */
	toolTimeoutMs: 300_000,
};
