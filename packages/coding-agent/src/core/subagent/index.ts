/**
 * Native subagent capability.
 *
 * The orchestrator defines each subagent inline (role + instructions, optional
 * model and tool allowlist) and dispatches it through the `subagent` tool.
 * This module owns the types, the runner seam, and the supporting stores.
 *
 * Everything runtime-specific is confined to `runtime.ts` and
 * `bun-process-runner.ts` so the `SubagentRunner` interface can be
 * reimplemented against an in-process `AgentSession` without touching the tool
 * surface. This module is Bun-only: no `node:child_process`, no Node fallback.
 */

export type {
	BackgroundLogEvent,
	BackgroundRegistry,
	BackgroundTask,
	BackgroundUsage,
	TaskStatus,
} from "./background.ts";
export { _resetBackgroundRegistryForTests, getBackgroundRegistry, RegistryLockError } from "./background.ts";
export type { BunProcessRunnerOptions } from "./bun-process-runner.ts";
export { createBunProcessRunner, getPiInvocation } from "./bun-process-runner.ts";
export { getBun, isBunRuntime } from "./runtime.ts";
export type { BunApi, BunReadableStream, BunShell, BunShellResult, BunSpawnOptions, BunSubprocess } from "./runtime.ts";
export type { ShellOptions, ShellResult } from "./shell.ts";
export { runGit, runShell, runShellLine } from "./shell.ts";
export { collectStream, createStreamPump } from "./stream.ts";
export type { CollectedStream, StreamPump } from "./stream.ts";
export { buildStatusInjection } from "./status-injector.ts";
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
