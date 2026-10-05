/**
 * The 8 `experiment_*` tools: worktree-based comparative experiments.
 *
 * - experiment_start: fork a worktree for one approach
 * - experiment_run: run a shell command inside the worktree
 * - experiment_test: auto-detect the test runner and run it
 * - experiment_diff: what changed vs the parent commit
 * - experiment_merge: transfer the winner (cherry-pick / squash / merge)
 * - experiment_discard: remove the worktree, keep archaeology
 * - experiment_list: list experiments
 * - experiment_compare: side-by-side benchmarks and diff stats
 *
 * All state lives in the experiment registry (`.pi-experiments/registry.json`)
 * and per-experiment JSONL logs. The tools exist only when
 * `subagent.enableExperiments` is set — see `shouldRegisterExperimentTools`.
 *
 * Schema field names (`approach_name`, `experiment_id`, ...) intentionally keep
 * the reference extension's snake_case so prompts written against it carry over.
 */

import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { DEFAULT_SUBAGENT_SETTINGS } from "../defaults.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import {
	addExperiment,
	appendExperimentLogEvent,
	type ExperimentRow,
	type ExperimentStatus,
	ensureExperimentLog,
	getExperiment,
	listExperiments,
	logPath,
	makeExperimentId,
	updateExperiment,
} from "./experiment-registry.ts";
import { getBun } from "./runtime.ts";
import { runShell, runShellLine, type ShellOptions, type ShellResult } from "./shell.ts";
import type { SubagentToolOptions } from "./subagent-tool.ts";
import {
	cherryPickFromBranch,
	createWorktree,
	currentHead,
	diffVsParent,
	isGitRepo,
	pruneWorktrees,
	removeWorktree,
	squashSinceParent,
} from "./worktree.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export const EXPERIMENT_TOOL_NAMES = [
	"experiment_start",
	"experiment_run",
	"experiment_test",
	"experiment_diff",
	"experiment_merge",
	"experiment_discard",
	"experiment_list",
	"experiment_compare",
] as const;

export type ExperimentToolName = (typeof EXPERIMENT_TOOL_NAMES)[number];

// ============================================================================
// Schemas
// ============================================================================

const StartParams = Type.Object({
	hypothesis: Type.String({ description: "Falsifiable claim. One sentence. What would disprove it?" }),
	approach_name: Type.String({
		description: "Kebab-case slug for the candidate (e.g. 'bun-ipc-worker').",
		pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$",
	}),
	parent_commit: Type.Optional(Type.String({ description: "Git SHA to fork from. Default: HEAD." })),
});

const RunParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start." }),
	command: Type.String({ description: "Shell command to run inside the worktree." }),
	timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms. Default: 600000 (10 min)." })),
});

const TestParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start." }),
	filter: Type.Optional(
		Type.String({
			description:
				"Test filter passed to the runner: a test-name pattern (-t) for bun/vitest/jest, or a file/path filter after `--` for npm.",
		}),
	),
});

const DiffParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start." }),
});

const MergeParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start (the winner)." }),
	strategy: StringEnum(["cherry-pick", "squash", "merge"] as const, {
		description:
			"Transfer strategy. cherry-pick: clean atomic commit. squash: one commit from all WIP. merge: keep experimental history.",
	}),
	squash_message: Type.Optional(
		Type.String({ description: "Required when strategy='squash'. The squash commit message." }),
	),
});

const DiscardParams = Type.Object({
	experiment_id: Type.String({ description: "ID returned by experiment_start." }),
	keep_branch: Type.Optional(
		Type.Boolean({ description: "Default true. Keep the branch (and WHY_IT_FAILED.md) for archaeology." }),
	),
	reason: Type.String({ description: "One line: why this experiment was discarded." }),
});

const ListParams = Type.Object({
	status: Type.Optional(
		StringEnum(["scaffolded", "running", "completed", "failed", "merged", "discarded", "cancelled", "all"] as const, {
			description: "Filter by status. Default: all.",
		}),
	),
});

const CompareParams = Type.Object({
	exp_id_1: Type.String({ description: "First experiment ID." }),
	exp_id_2: Type.String({ description: "Second experiment ID." }),
	axes: Type.Optional(
		Type.Array(Type.String(), { description: "Benchmark axes to compare. Default: all numeric fields." }),
	),
});

// ============================================================================
// Helpers
// ============================================================================

function successToolResult(message: string, details: unknown = {}): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

interface RunCommandOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** When provided, output is also appended to this per-experiment log file. */
	experimentLogPath?: string;
}

interface RunCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	truncated: boolean;
	timedOut: boolean;
	cancelled: boolean;
}

/**
 * Run one command inside a worktree and mirror its output into the
 * experiment's JSONL log chunk by chunk (`{type: "OUTPUT", stream, line}`),
 * matching the reference extension's log format.
 *
 * `command` is either a shell line (user-authored `experiment_run` commands)
 * or an argv array (detected test runners). The argv form never puts
 * user-supplied filter text on a shell command line.
 */
async function runCommand(command: string | string[], opts: RunCommandOptions): Promise<RunCommandResult> {
	const onOutput = opts.experimentLogPath
		? (stream: "stdout" | "stderr", chunk: string) => {
				appendExperimentLogEvent(opts.experimentLogPath as string, { type: "OUTPUT", stream, line: chunk });
			}
		: undefined;
	const shellOptions: ShellOptions = {
		cwd: opts.cwd,
		timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		...(opts.signal ? { signal: opts.signal } : {}),
		...(onOutput ? { onOutput } : {}),
	};
	const res: ShellResult = Array.isArray(command)
		? await runShell(command[0], command.slice(1), shellOptions)
		: await runShellLine(command, shellOptions);
	return {
		exitCode: res.exitCode,
		stdout: res.stdout,
		stderr: res.stderr,
		durationMs: res.durationMs,
		truncated: !res.complete,
		timedOut: res.timedOut,
		cancelled: res.cancelled,
	};
}

/** A detected test runner: fixed argv prefix plus the flag that carries the filter. */
export interface TestRunnerPlan {
	name: string;
	/** Executable and fixed leading arguments, e.g. `["vitest", "run"]`. */
	argv: string[];
	/** Flag before the filter value. `"--"` passes the filter as a positional (npm). */
	filterFlag: string;
}

/**
 * Build the argv for one test run. The filter is always a single argv element —
 * never quoted or interpolated into a shell line — so filters with spaces or
 * shell metacharacters reach the runner literally on every platform.
 */
export function buildTestArgv(plan: TestRunnerPlan, filter: string | undefined): string[] {
	return filter ? [...plan.argv, plan.filterFlag, filter] : [...plan.argv];
}

async function detectTestRunner(cwd: string): Promise<TestRunnerPlan | null> {
	const bun = getBun();
	// Explicit test-runner config wins over lockfiles: a mixed repo with both
	// vitest.config.* and bun.lock (like this monorepo) must run vitest, not
	// bun test. Lockfiles decide only when no runner config names one.
	if (
		(await bun.file(join(cwd, "vitest.config.ts")).exists()) ||
		(await bun.file(join(cwd, "vitest.config.js")).exists())
	) {
		return { name: "vitest", argv: ["npx", "vitest", "run"], filterFlag: "-t" };
	}
	if (
		(await bun.file(join(cwd, "jest.config.ts")).exists()) ||
		(await bun.file(join(cwd, "jest.config.js")).exists())
	) {
		return { name: "jest", argv: ["npx", "jest"], filterFlag: "-t" };
	}
	if ((await bun.file(join(cwd, "bun.lockb")).exists()) || (await bun.file(join(cwd, "bun.lock")).exists())) {
		return { name: "bun", argv: ["bun", "test"], filterFlag: "-t" };
	}
	if (await bun.file(join(cwd, "package.json")).exists()) {
		return { name: "npm", argv: ["npm", "test"], filterFlag: "--" };
	}
	return null;
}

function parseTestSummary(output: string, runner: string): { passed: number; failed: number; skipped: number } {
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	const passedMatch = output.match(/(\d+)\s+pass(?:ed|ing)?/i);
	const failedMatch = output.match(/(\d+)\s+fail(?:ed|ing)?/i);
	const skippedMatch = output.match(/(\d+)\s+skip(?:ped|ping)?/i);
	if (passedMatch) passed = Number.parseInt(passedMatch[1], 10);
	if (failedMatch) failed = Number.parseInt(failedMatch[1], 10);
	if (skippedMatch) skipped = Number.parseInt(skippedMatch[1], 10);
	if (runner === "vitest" && passed === 0 && failed === 0) {
		const m = output.match(/Tests?\s+(\d+)\s+passed\s*\((\d+)\)/i);
		if (m) passed = Number.parseInt(m[1], 10);
		const f = output.match(/Tests?\s+(\d+)\s+failed\s*\((\d+)\)/i);
		if (f) failed = Number.parseInt(f[1], 10);
	}
	return { passed, failed, skipped };
}

function tailOf(s: string, lines: number): string {
	const arr = s.split("\n");
	return arr.length > lines ? `... ${arr.length - lines} earlier lines\n${arr.slice(-lines).join("\n")}` : s;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/**
 * The file-wide git failure rule: `exitCode !== 0` or `complete === false` (a
 * truncated read) makes a result untrustworthy — a failed or truncated check
 * must never pass a gate. Prefer the producer's `error` context when present.
 */
function assertGitOk(
	what: string,
	res: { exitCode: number; complete?: boolean; error?: string; stdout: string; stderr: string },
): void {
	if (res.exitCode === 0 && res.complete !== false) return;
	throw new Error(
		res.error ?? `${what} (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim() || "(no output)"}`,
	);
}

async function finalizeExperimentMerge(
	cwd: string,
	row: ExperimentRow,
	strategy: "cherry-pick" | "squash" | "merge",
	newCommit: string | undefined,
	onRegistryChanged?: () => void,
): Promise<void> {
	const logFile = logPath(cwd, row.id);
	appendExperimentLogEvent(logFile, { type: "MERGED", strategy, commit: newCommit });
	try {
		await removeWorktree(cwd, row.worktreePath, true);
	} catch {
		/* removal may fail on Windows; leave it for the user to clean up */
	}
	updateExperiment(cwd, row.id, {
		status: "merged",
		merged: true,
		mergeStrategy: strategy,
		mergeCommit: newCommit,
	});
	onRegistryChanged?.();
}

/**
 * Registration guard: the experiments surface exists only when the
 * `subagent.enableExperiments` setting is explicitly on (default off).
 */
export function shouldRegisterExperimentTools(options?: SubagentToolOptions): boolean {
	return options?.settings?.get("subagent.enableExperiments") === true;
}

// ============================================================================
// Tool definitions
// ============================================================================

export function createExperimentToolDefinitions(
	cwd: string,
	options?: SubagentToolOptions,
): Record<ExperimentToolName, ToolDefinition> {
	const onRegistryChanged = options?.onRegistryChanged;

	const experiment_start: ToolDefinition = {
		name: "experiment_start",
		label: "Experiment Start",
		description: "Fork a worktree for one experimental approach. Use once per approach when comparing 2+ candidates.",
		parameters: StartParams,
		async execute(_id, params: Static<typeof StartParams>, _signal, _onUpdate) {
			if (!(await isGitRepo(cwd))) {
				throw new Error(`Not a git repository: ${cwd}. Experimental mode requires git.`);
			}
			let parentCommit: string;
			try {
				parentCommit = params.parent_commit ?? (await currentHead(cwd));
			} catch (err) {
				throw new Error(`Could not resolve parent commit: ${err instanceof Error ? err.message : String(err)}`);
			}
			const id = makeExperimentId(params.approach_name);
			// Read live per dispatch — see SubagentToolOptions.subagentSettings.
			const worktreeBase = options?.subagentSettings?.().worktreeBase ?? DEFAULT_SUBAGENT_SETTINGS.worktreeBase;
			const work = await createWorktree(cwd, params.approach_name, parentCommit, worktreeBase);
			// complete:false means the git output was cut short — the result is
			// untrustworthy even when the exit code says success.
			if (work.exitCode !== 0 || work.complete === false) {
				throw new Error(
					work.error ??
						`git worktree add failed (exit ${work.exitCode}): ${work.stderr.trim() || work.stdout.trim()}`,
				);
			}
			const logFile = logPath(cwd, id);
			ensureExperimentLog(logFile);
			appendExperimentLogEvent(logFile, {
				type: "STARTED",
				hypothesis: params.hypothesis,
				approach: params.approach_name,
				parentCommit,
			});
			const now = new Date().toISOString();
			const row: ExperimentRow = {
				id,
				hypothesis: params.hypothesis,
				approach: params.approach_name,
				worktreePath: work.worktreePath,
				branch: work.branch,
				parentCommit,
				startedInCwd: cwd,
				status: "scaffolded",
				outputPath: logFile,
				result: {},
				merged: false,
				createdAt: now,
				updatedAt: now,
			};
			addExperiment(cwd, row);
			onRegistryChanged?.();
			return successToolResult(
				`Created experiment ${id}\n branch: ${work.branch}\n worktree: ${work.worktreePath}\n parent: ${parentCommit.slice(0, 12)}\n status: scaffolded`,
				{ id, branch: work.branch, worktree_path: work.worktreePath, status: "scaffolded" },
			);
		},
	};

	const experiment_run: ToolDefinition = {
		name: "experiment_run",
		label: "Experiment Run",
		description:
			"Run a shell command inside the experiment's worktree. Output is captured to log.jsonl and returned.",
		parameters: RunParams,
		async execute(_id, params: Static<typeof RunParams>, signal, _onUpdate) {
			const row = getExperiment(cwd, params.experiment_id);
			if (!row) throw new Error(`Unknown experiment: ${params.experiment_id}`);
			const logFile = logPath(cwd, row.id);
			ensureExperimentLog(logFile);
			appendExperimentLogEvent(logFile, {
				type: "RUN_STARTED",
				command: params.command,
				timeoutMs: params.timeout_ms,
			});
			const result = await runCommand(params.command, {
				cwd: row.worktreePath,
				...(params.timeout_ms === undefined ? {} : { timeoutMs: params.timeout_ms }),
				...(signal ? { signal } : {}),
				experimentLogPath: logFile,
			});
			appendExperimentLogEvent(logFile, {
				type: "RUN_COMPLETED",
				command: params.command,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				timedOut: result.timedOut,
				cancelled: result.cancelled,
			});
			const newStatus: ExperimentStatus =
				result.exitCode === 0 ? "completed" : result.cancelled ? "cancelled" : "failed";
			updateExperiment(cwd, row.id, { status: newStatus });
			onRegistryChanged?.();
			const summary =
				`exit ${result.exitCode} · ${result.durationMs}ms` +
				(result.timedOut ? " · TIMED OUT" : "") +
				(result.cancelled ? " · CANCELLED" : "");
			return successToolResult(
				`${summary}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`.trim(),
				{ experiment_id: row.id, exitCode: result.exitCode, durationMs: result.durationMs },
			);
		},
	};

	const experiment_test: ToolDefinition = {
		name: "experiment_test",
		label: "Experiment Test",
		description:
			"Auto-detect the test runner and run it inside the worktree. Records passed/failed counts in the registry.",
		parameters: TestParams,
		async execute(_id, params: Static<typeof TestParams>, signal, _onUpdate) {
			const row = getExperiment(cwd, params.experiment_id);
			if (!row) throw new Error(`Unknown experiment: ${params.experiment_id}`);
			const detector = await detectTestRunner(row.worktreePath);
			if (!detector) {
				throw new Error("Could not detect a test runner. Pass an explicit command via experiment_run instead.");
			}
			const argv = buildTestArgv(detector, params.filter);
			const logFile = logPath(cwd, row.id);
			ensureExperimentLog(logFile);
			appendExperimentLogEvent(logFile, { type: "TEST_STARTED", runner: detector.name, command: argv.join(" ") });
			const result = await runCommand(argv, {
				cwd: row.worktreePath,
				...(signal ? { signal } : {}),
				experimentLogPath: logFile,
			});
			const { passed, failed, skipped } = parseTestSummary(`${result.stdout}\n${result.stderr}`, detector.name);
			appendExperimentLogEvent(logFile, {
				type: "TEST_COMPLETED",
				runner: detector.name,
				exitCode: result.exitCode,
				passed,
				failed,
				skipped,
			});
			updateExperiment(cwd, row.id, {
				status: failed > 0 || result.exitCode !== 0 ? "failed" : "completed",
				result: { ...row.result, testPassed: passed, testFailed: failed, testSkipped: skipped },
			});
			onRegistryChanged?.();
			return successToolResult(
				`runner: ${detector.name}\nexit: ${result.exitCode}\n` +
					`passed: ${passed} · failed: ${failed} · skipped: ${skipped}\n\n` +
					tailOf(result.stdout, 50),
				{ experiment_id: row.id, runner: detector.name, passed, failed, skipped },
			);
		},
	};

	const experiment_diff: ToolDefinition = {
		name: "experiment_diff",
		label: "Experiment Diff",
		description: "Show what changed in the experiment's worktree vs the parent commit.",
		parameters: DiffParams,
		async execute(_id, params: Static<typeof DiffParams>) {
			const row = getExperiment(cwd, params.experiment_id);
			if (!row) throw new Error(`Unknown experiment: ${params.experiment_id}`);
			const diff = await diffVsParent(row.worktreePath, row.parentCommit);
			if (diff.raw.exitCode !== 0 || diff.raw.complete === false) {
				throw new Error(
					diff.raw.error ??
						`git diff failed (exit ${diff.raw.exitCode}): ${diff.raw.stderr.trim() || diff.raw.stdout.trim()}`,
				);
			}
			const commitList =
				diff.commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join("\n") || "(no commits yet)";
			return successToolResult(
				`files changed: ${diff.filesChanged}\ninsertions: ${diff.insertions}\ndeletions: ${diff.deletions}\ncommits:\n${commitList}\n\n--- diff (truncated) ---\n${tailOf(diff.diff, 80)}`,
				{
					experiment_id: row.id,
					files_changed: diff.filesChanged,
					insertions: diff.insertions,
					deletions: diff.deletions,
					commits: diff.commits,
				},
			);
		},
	};

	const experiment_merge: ToolDefinition = {
		name: "experiment_merge",
		label: "Experiment Merge",
		description: "Transfer the winning experiment back to the main worktree via cherry-pick, squash, or merge.",
		parameters: MergeParams,
		async execute(_id, params: Static<typeof MergeParams>) {
			const row = getExperiment(cwd, params.experiment_id);
			if (!row) throw new Error(`Unknown experiment: ${params.experiment_id}`);
			if (row.merged) throw new Error(`Experiment ${row.id} is already merged.`);
			// Read live per dispatch — see SubagentToolOptions.subagentSettings.
			const worktreeBase = options?.subagentSettings?.().worktreeBase ?? DEFAULT_SUBAGENT_SETTINGS.worktreeBase;

			// Refuse to merge if the main worktree has uncommitted changes (ignoring
			// the registry dir and the worktree base, which are expected untracked).
			const status = await runShellLine(
				`git status --porcelain -- . :!./.pi-experiments :!./.pi-experiments/ :!./${worktreeBase} :!./${worktreeBase}/`,
				{ cwd },
			);
			// A failed or truncated status check must not pass the clean-tree gate.
			assertGitOk("git status failed", status);
			if (status.stdout.trim().length > 0) {
				throw new Error(
					`Main worktree has uncommitted changes. Commit or stash them before merging an experiment.\n${status.stdout}`,
				);
			}

			if (params.strategy === "cherry-pick") {
				const head = await runShell("git", ["rev-parse", row.branch], { cwd });
				assertGitOk(`Could not resolve ${row.branch}`, head);
				const pick = await cherryPickFromBranch(cwd, row.branch, head.stdout.trim());
				if (pick.exitCode !== 0 || pick.complete === false) {
					throw new Error(
						pick.error ??
							`Cherry-pick failed (exit ${pick.exitCode}): ${pick.stderr.trim() || pick.stdout.trim()}`,
					);
				}
				await finalizeExperimentMerge(cwd, row, "cherry-pick", pick.newCommit, onRegistryChanged);
				return successToolResult(
					`Cherry-picked ${row.branch} into main as ${pick.newCommit?.slice(0, 7) ?? "(no commit)"}`,
				);
			}

			if (params.strategy === "squash") {
				if (!params.squash_message) {
					throw new Error("strategy='squash' requires squash_message.");
				}
				const sq = await squashSinceParent(cwd, row.branch, row.parentCommit, params.squash_message);
				if (sq.exitCode !== 0 || sq.complete === false) {
					throw new Error(
						sq.error ?? `Squash failed (exit ${sq.exitCode}): ${sq.stderr.trim() || sq.stdout.trim()}`,
					);
				}
				if (sq.wasNoOp) {
					throw new Error("No commits to squash. The experiment worktree has no commits beyond the parent.");
				}
				await finalizeExperimentMerge(cwd, row, "squash", sq.newCommit, onRegistryChanged);
				return successToolResult(
					`Squashed ${row.branch} into main as ${sq.newCommit?.slice(0, 7) ?? "(no commit)"}`,
				);
			}

			const merge = await runShell(
				"git",
				["merge", "--no-ff", row.branch, "-m", `Merge experiment ${row.id} (${row.approach})`],
				{ cwd },
			);
			assertGitOk("Merge failed", merge);
			const head = await runShell("git", ["rev-parse", "HEAD"], { cwd });
			assertGitOk("Could not resolve HEAD after merge", head);
			const newCommit = head.stdout.trim();
			await finalizeExperimentMerge(cwd, row, "merge", newCommit, onRegistryChanged);
			return successToolResult(`Merged ${row.branch} into main as ${newCommit?.slice(0, 7) ?? "(unknown)"}`);
		},
	};

	const experiment_discard: ToolDefinition = {
		name: "experiment_discard",
		label: "Experiment Discard",
		description:
			"Remove the worktree and mark the experiment as discarded. The branch is kept by default with WHY_IT_FAILED.md for archaeology.",
		parameters: DiscardParams,
		async execute(_id, params: Static<typeof DiscardParams>) {
			const row = getExperiment(cwd, params.experiment_id);
			if (!row) throw new Error(`Unknown experiment: ${params.experiment_id}`);
			const keepBranch = params.keep_branch ?? true;
			if (keepBranch) {
				const whyPath = join(row.worktreePath, "WHY_IT_FAILED.md");
				try {
					await getBun().write(
						whyPath,
						`# Why this experiment failed\n\n` +
							`**Approach:** ${row.approach}\n` +
							`**Hypothesis:** ${row.hypothesis}\n` +
							`**Discarded at:** ${new Date().toISOString()}\n\n` +
							`## Reason\n\n${params.reason}\n\n` +
							`## Original result\n\n\`\`\`json\n${JSON.stringify(row.result, null, 2)}\n\`\`\`\n`,
					);
					await runShellLine('git add WHY_IT_FAILED.md && git commit -m "experiment: record discard reason"', {
						cwd: row.worktreePath,
					});
				} catch {
					/* worktree may already be unwriteable; continue with removal */
				}
			}
			const removed = await removeWorktree(cwd, row.worktreePath, true);
			if (removed.exitCode !== 0 || removed.complete === false) {
				throw new Error(
					`${removed.error ?? `git worktree remove failed (exit ${removed.exitCode}): ${removed.stderr.trim()}`}\n\n` +
						`On Windows this often means MAX_PATH or a handle lock. Move the build dir aside and retry:\n` +
						` Move-Item "${row.worktreePath}\\node_modules" "${row.worktreePath}\\__nm_backup" -Force\n` +
						` git worktree remove --force "${row.worktreePath}"`,
				);
			}
			await pruneWorktrees(cwd);
			if (!keepBranch) {
				await runShell("git", ["branch", "-D", row.branch], { cwd });
			}
			updateExperiment(cwd, row.id, { status: "discarded" });
			onRegistryChanged?.();
			return successToolResult(
				`Discarded ${row.id} (${row.approach}). Branch ${keepBranch ? "kept" : "deleted"}: ${row.branch}`,
			);
		},
	};

	const experiment_list: ToolDefinition = {
		name: "experiment_list",
		label: "Experiment List",
		description: "List experiments, optionally filtered by status.",
		parameters: ListParams,
		async execute(_id, params: Static<typeof ListParams>) {
			const status = (params.status as ExperimentStatus | "all" | undefined) ?? "all";
			const rows = listExperiments(cwd, status);
			if (rows.length === 0) {
				return successToolResult(`No experiments${status === "all" ? "" : ` with status ${status}`}.`);
			}
			const text = rows
				.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
				.map(
					(r) => `[${r.status}] ${r.approach} ${r.id} (${r.createdAt.slice(0, 16)}) ${truncate(r.hypothesis, 60)}`,
				)
				.join("\n");
			return successToolResult(`${rows.length} experiment(s):\n\n${text}`);
		},
	};

	const experiment_compare: ToolDefinition = {
		name: "experiment_compare",
		label: "Experiment Compare",
		description: "Side-by-side diff of two experiments' benchmarks, tests, and diff stats.",
		parameters: CompareParams,
		async execute(_id, params: Static<typeof CompareParams>) {
			const a = getExperiment(cwd, params.exp_id_1);
			const b = getExperiment(cwd, params.exp_id_2);
			if (!a) throw new Error(`Unknown experiment: ${params.exp_id_1}`);
			if (!b) throw new Error(`Unknown experiment: ${params.exp_id_2}`);
			const axes = params.axes ?? Object.keys({ ...a.result.benchmarks, ...b.result.benchmarks });
			const lines: string[] = [];
			for (const axis of axes) {
				const av = a.result.benchmarks?.[axis];
				const bv = b.result.benchmarks?.[axis];
				if (typeof av !== "number" || typeof bv !== "number") continue;
				const winner = av < bv ? a.approach : b.approach;
				lines.push(`${axis}: ${a.approach}=${av} vs ${b.approach}=${bv} -> winner=${winner}`);
			}
			const text =
				`Comparing ${a.approach} (${a.id}) vs ${b.approach} (${b.id})\n\n` +
				`hypotheses:\n A: ${a.hypothesis}\n B: ${b.hypothesis}\n\n` +
				`tests: A=${a.result.testPassed ?? "?"}P/${a.result.testFailed ?? "?"}F ` +
				`B=${b.result.testPassed ?? "?"}P/${b.result.testFailed ?? "?"}F\n\n` +
				(lines.length > 0 ? `benchmarks:\n${lines.join("\n")}\n` : "(no comparable benchmarks)\n");
			return successToolResult(text);
		},
	};

	return {
		experiment_start,
		experiment_run,
		experiment_test,
		experiment_diff,
		experiment_merge,
		experiment_discard,
		experiment_list,
		experiment_compare,
	};
}

/** Wrapped AgentTool variants for the core runtime, mirroring `createSubagentTool`. */
export function createExperimentTools(
	cwd: string,
	options?: SubagentToolOptions,
): Record<ExperimentToolName, AgentTool> {
	const defs = createExperimentToolDefinitions(cwd, options);
	return {
		experiment_start: wrapToolDefinition(defs.experiment_start),
		experiment_run: wrapToolDefinition(defs.experiment_run),
		experiment_test: wrapToolDefinition(defs.experiment_test),
		experiment_diff: wrapToolDefinition(defs.experiment_diff),
		experiment_merge: wrapToolDefinition(defs.experiment_merge),
		experiment_discard: wrapToolDefinition(defs.experiment_discard),
		experiment_list: wrapToolDefinition(defs.experiment_list),
		experiment_compare: wrapToolDefinition(defs.experiment_compare),
	};
}
