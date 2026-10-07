/**
 * Native subagent capability.
 *
 * The orchestrator defines each subagent inline (role + instructions, optional
 * model and tool allowlist) and dispatches it through the `subagent` tool.
 * This module owns the types, the runner seam, the supporting stores, and the
 * (flag-gated) experiments surface.
 *
 * Everything runtime-specific is confined to `runtime.ts` and
 * `bun-process-runner.ts` so the `SubagentRunner` interface can be
 * reimplemented against an in-process `AgentSession` without touching the tool
 * surface. This module is Bun-only: no `node:child_process`, no Node fallback.
 *
 * Public-API tiers (Q4): `SubagentSpec` / `SubagentRunner` / `SubagentEvent`
 * are promoted to the package root. The experiments/registry/worktree helpers
 * stay at this level — importable by other code, but not committed as
 * package-level API yet.
 */

export type { AgentDefinition, AgentScope, AgentsDir } from "./agents.ts";
export { AGENTS_DIR_NAME, agentsDirs, listAgents, parseAgentFile, resolveAgent } from "./agents.ts";
export type {
	BackgroundLogEvent,
	BackgroundRegistry,
	BackgroundTask,
	BackgroundUsage,
	TaskStatus,
} from "./background.ts";
export {
	_resetBackgroundRegistryForTests,
	BG_CUSTOM_MESSAGE_TYPE,
	getBackgroundRegistry,
	RegistryLockError,
	startBackgroundSubagent,
} from "./background.ts";
export type { BunProcessRunnerOptions } from "./bun-process-runner.ts";
export { createBunProcessRunner, getPiInvocation } from "./bun-process-runner.ts";
export {
	addExperiment,
	appendExperimentLogEvent,
	ExperimentRegistryLockError,
	type ExperimentResult,
	type ExperimentRow,
	type ExperimentStatus,
	ensureExperimentLog,
	experimentDir,
	experimentsDir,
	getExperiment,
	listExperiments,
	logPath,
	makeExperimentId,
	REGISTRY_VERSION,
	type RegistryFile,
	readRegistry,
	updateExperiment,
	withWriteLock,
	writeRegistry,
} from "./experiment-registry.ts";
export {
	createExperimentToolDefinitions,
	createExperimentTools,
	EXPERIMENT_TOOL_NAMES,
	type ExperimentToolName,
	shouldRegisterExperimentTools,
} from "./experiment-tools.ts";
export {
	type BackgroundLogRecord,
	type BackgroundLogTail,
	BG_LOG_MAX_BYTES,
	BG_LOG_MAX_RECORDS,
	backgroundLogPath,
	clearBackgroundDashboard,
	clearBackgroundLogOverlay,
	clearDashboard,
	type ExperimentsUi,
	readBackgroundLogTail,
	renderBackgroundLines,
	renderBackgroundLogLines,
	renderBackgroundPill,
	renderDashboardLines,
	renderExperimentsStatusPill,
	showBackgroundDashboard,
	showBackgroundLogOverlay,
	showDashboard,
	UI_KEYS,
} from "./experiments-dashboard.ts";
export type { DisplayItem } from "./render.ts";
export { formatTokens, formatUsageStats, getDisplayItems, renderSubagentCall, renderSubagentResult } from "./render.ts";
export { type ResearchModeOptions, ResearchModeTracker } from "./research-mode.ts";
export type { BunApi, BunReadableStream, BunShell, BunShellResult, BunSpawnOptions, BunSubprocess } from "./runtime.ts";
export { getBun, isBunRuntime } from "./runtime.ts";
export type { SavedSpec } from "./saved-specs.ts";
export { deleteSpec, listSpecs, loadSpec, saveSpec } from "./saved-specs.ts";
export type { ShellOptions, ShellResult } from "./shell.ts";
export { runGit, runShell, runShellLine } from "./shell.ts";
export { buildStatusInjection } from "./status-injector.ts";
export type { CollectedStream, StreamPump } from "./stream.ts";
export { collectStream, createStreamPump } from "./stream.ts";
export {
	createSubagentTool,
	createSubagentToolDefinition,
	PER_TASK_OUTPUT_CAP,
	resolveModelOverrides,
	type SubagentSettingsReader,
	type SubagentToolDetails,
	type SubagentToolInput,
	type SubagentToolOptions,
	shouldRegisterSubagentTool,
	subagentSchema,
} from "./subagent-tool.ts";
export type {
	SubagentEvent,
	SubagentEventListener,
	SubagentMode,
	SubagentResult,
	SubagentRunner,
	SubagentRunRequest,
	SubagentSpec,
	SubagentUsage,
} from "./types.ts";
export { createEmptyUsage, getSubagentResultOutput, isFailedSubagentResult } from "./types.ts";
export type {
	GitResult,
	WorktreeCreateResult,
	WorktreeDiffResult,
} from "./worktree.ts";
export {
	cherryPickFromBranch,
	createWorktree,
	currentHead,
	diffVsParent,
	isGitRepo,
	listWorktrees,
	pruneWorktrees,
	removeWorktree,
	squashSinceParent,
} from "./worktree.ts";
