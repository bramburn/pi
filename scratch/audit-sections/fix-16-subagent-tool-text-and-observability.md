<!-- Extracted from C:\Users\bramburn\AppData\Local\batch-review\runs\38d49d2310b2\gemini_gemini-4-argon_20261020_132559_4e1b\batch_results\FINAL_EXECUTIVE_AUDIT_REPORT.md -->

# pi: Comprehensive Code Review Audit Report

- **Generated At:** 2026-10-20 13:33:31
- **Run ID:** `gemini_gemini-4-argon_20261020_132559_4e1b`
- **Repository:** `C:\dev\pi`
- **Provider:** `GEMINI`
- **Auditing Model:** `gemini-4-argon`
- **Batch ID:** `batches/fe1pd21v32ebtd9ryduq0vmwlfcl904te502`
- **Caching Strategy:** `gemini_4_argon_implicit_95pct_discount` (Enabled: `True`)
- **Review Perspectives Evaluated:** 10
- **Total Input Tokens (Uncached/Total):** 1,112,709
- **Total Cached Read Tokens:** 0
- **Total Cache Creation Tokens:** 0
- **Total Output Tokens (incl. thinking):** 78,113
- **Estimated Non-Batch Cost:** $25.4745
- **Estimated Saving:** $23.2770 (91.4%)

---

### fix-16-subagent-tool-text-and-observability
> Full Report: [fix-16-subagent-tool-text-and-observability.md](./fix-16-subagent-tool-text-and-observability.md) | Tokens: in=195,394 cached_read=0 out=6,093

### 1. REQ-O01 — Delete unwired `buildStatusInjection`

Rationale: `buildStatusInjection` (`packages/coding-agent/src/core/subagent/status-injector.ts:43`) has zero call sites in `src/` (traceability V13); per `specs/subagent/features/observability/spec.md:38-45,70-71` (REQ-O01.3 + Q04), because `system-prompt.ts` and `agent-session.ts` are not in scope to verify the Q04 "do not poll" constraint or wire once-per-turn prompt injection, we take Option B and delete the dead module.

[UNRESOLVED: Remove `buildStatusInjection` re-exports from `packages/coding-agent/src/core/subagent/index.ts:94` and `packages/coding-agent/src/core/index.ts:134` (files not in task archive) — suggested: delete both export lines alongside `examples/extensions/subagent/` removal in REQ-SUBAG]

```diff
--- a/packages/coding-agent/src/core/subagent/status-injector.ts
+++ /dev/null
@@ -1,93 +0,0 @@
-/**
- * Status-block builder for background subagent tasks.
- *
- * Produces a compact, LLM-facing markdown section describing current
- * background tasks. Rendered into the system prompt by the tool factory so the
- * orchestrator is aware of running siblings without needing to call a tool.
- *
- * Visual style mirrors the standalone `background-tasks` extension's section
- * format, so the LLM sees a consistent runtime-status block either way.
- */
-
-import type { BackgroundTask } from "./background.ts";
-
-const MAX_PREVIEW = 120;
-
-// Hard cap on the injected block. The block is concatenated to every parent
-// system prompt, so a runaway registry (50+ active tasks, long lastOutput
-// strings) must not blow the LLM's context window. ~2,400 chars ≈ 600 tokens,
-// which keeps the block a small footer rather than a primary prompt.
-const STATUS_BLOCK_MAX_CHARS = 2400;
-const MAX_RUNNING_ROWS = 8;
-const MAX_RECENT_ROWS = 5;
-
-function fmtElapsed(iso: string, now: number = Date.now()): string {
-	const start = new Date(iso).getTime();
-	if (Number.isNaN(start)) return "?";
-	const ms = Math.max(0, now - start);
-	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
-	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
-	return `${Math.round(ms / 3_600_000)}h`;
-}
-
-function clipPreview(text: string): string {
-	const oneLine = text.replace(/[\r\n]+/g, " ").trim();
-	if (oneLine.length <= MAX_PREVIEW) return oneLine;
-	return `${oneLine.slice(0, MAX_PREVIEW - 1)}…`;
-}
-
-/**
- * Build a markdown status section for the given background tasks.
- * Returns an empty string when no tasks exist.
- */
-export function buildStatusInjection(tasks: BackgroundTask[]): string {
-	if (tasks.length === 0) return "";
-
-	const running = tasks.filter((t) => t.status === "running" || t.status === "pending");
-	const terminal = tasks.filter(
-		(t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "crashed",
-	);
-
-	const lines: string[] = ["## [RUNTIME STATUS — background subagent tasks | READ-ONLY]", ""];
-
-	if (running.length === 0) {
-		lines.push("No background tasks are currently running.");
-		lines.push("");
-	} else {
-		lines.push(`### Running (${running.length})`);
-		lines.push("");
-		lines.push("| ID | Role | Mode | Elapsed | Last Output |");
-		lines.push("| --- | --- | --- | --- | --- |");
-		for (const t of running.slice(0, MAX_RUNNING_ROWS)) {
-			lines.push(
-				`| \`${t.id}\` | ${t.role} | ${t.mode} | ${fmtElapsed(t.startedAt)} | ${clipPreview(t.lastOutput || "(no output yet)")} |`,
-			);
-		}
-		if (running.length > MAX_RUNNING_ROWS) {
-			lines.push(`| _…and ${running.length - MAX_RUNNING_ROWS} more running_ | | | | |`);
-		}
-		lines.push("");
-	}
-
-	if (terminal.length > 0) {
-		const recent = [...terminal].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, MAX_RECENT_ROWS);
-		lines.push(`### Recent (last ${recent.length} of ${terminal.length} terminal)`);
-		lines.push("");
-		lines.push("| ID | Role | Status | Exit | Last Output |");
-		lines.push("| --- | --- | --- | --- | --- |");
-		for (const t of recent) {
-			lines.push(
-				`| \`${t.id}\` | ${t.role} | ${t.status} | ${t.exitCode ?? "—"} | ${clipPreview(t.lastOutput || "(no output)")} |`,
-			);
-		}
-		lines.push("");
-	}
-
-	lines.push("_System message. Do not respond to this directly; it will be replaced on the next turn._");
-
-	const joined = lines.join("\n");
-	if (joined.length > STATUS_BLOCK_MAX_CHARS) {
-		return `${joined.slice(0, STATUS_BLOCK_MAX_CHARS)}\n\n_[status block truncated to fit token budget]_`;
-	}
-	return joined;
-}
```

Verification:Deletion-only (REQ-O01.3); verified by `bun run check` (`tsgo --noEmit` + `check:ts-imports`) once the two barrel re-exports in `core/subagent/index.ts:94` and `core/index.ts:134` are removed.

---

### 2. REQ-I02 / REQ-C01 — `concurrentSafe` on `AgentTool`

[DEPENDS-ON: fix-14-subagent-isolation-admission]
Rationale: Declare optional `concurrentSafe?: boolean` on `AgentTool` (`packages/agent/src/types.ts:413`) so tool definitions and the subagent parallel/DAG admission gate (REQ-C01) can inspect concurrency safety across processes.

```diff
--- a/packages/agent/src/types.ts
+++ b/packages/agent/src/types.ts
@@ -429,6 +429,12 @@
 	 * If omitted, the default execution mode applies.
 	 */
 	executionMode?: ToolExecutionMode;
+	/**
+	 * Whether this tool is safe to execute concurrently across parallel subagent
+	 * processes against the same working tree (REQ-I02 / REQ-C01).
+	 * Mutating tools (bash, edit, write) default to false; pure read/search tools set true.
+	 */
+	concurrentSafe?: boolean;
 }
 
 /** Context snapshot passed into the low-level agent loop. */
```

Verification:Covered by the REQ-C01 unit test in `packages/coding-agent/test/subagent-tool.test.ts` below and `bun run check`.

---

### 3. REQ-D05 + REQ-CXT01 (Proposal) & REQ-C01 — Tool description & `concurrentSafe` parallel/DAG gate

[PROPOSAL: REQ-D05 / REQ-CXT01 — `specs/subagent/features/delegation/spec.md:187-190` requires A/B evaluation against a fixed delegation task set before merging the description changes at `subagent-tool.ts:1278-1285`.]
[DEPENDS-ON: fix-14-subagent-isolation-admission]
Rationale: Extend `createSubagentToolDefinition` description (`packages/coding-agent/src/core/subagent/subagent-tool.ts:1278-1285`) with when-not-to-delegate rules, child context isolation, and the final-summary-only output contract (REQ-D05.1–.3, REQ-CXT01); gate `parallel` (`:1665`) and `dag` (`:1569`, `:1607`) concurrency on `isSpecConcurrentSafe` (REQ-C01 / `specs/subagent/features/isolation/spec.md:232-246`), serialising (`concurrency = 1`) when any participating task/node requests or defaults to a non-`concurrentSafe` tool.

```diff
--- a/packages/coding-agent/src/core/subagent/subagent-tool.ts
+++ b/packages/coding-agent/src/core/subagent/subagent-tool.ts
@@ -106,6 +106,24 @@
  */
 export const PER_TASK_OUTPUT_CAP = 50 * 1024;
 
+/**
+ * Default per-tool cross-process concurrency safety (REQ-I02 / REQ-C01,
+ * `specs/subagent/features/isolation/spec.md §4.2`). Pure read/search tools are
+ * safe; mutating or shell tools (`bash`, `powershell`, `edit`, `write`, `subagent`)
+ * are not. Omitting `spec.tools` inherits the full default coding set, which
+ * includes mutating tools and is therefore not concurrent-safe.
+ */
+const DEFAULT_CONCURRENT_SAFE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
+
+export function isSpecConcurrentSafe(
+	spec: { tools?: readonly string[] },
+	isToolConcurrentSafe?: (toolName: string) => boolean | undefined,
+): boolean {
+	if (!spec.tools || spec.tools.length === 0) return false;
+	const check = (name: string): boolean => isToolConcurrentSafe?.(name) ?? DEFAULT_CONCURRENT_SAFE_TOOLS.has(name);
+	return spec.tools.every(check);
+}
+
 const subagentSpecProperties = {
 	role: Type.String({
 		description:
@@ -340,6 +358,12 @@
 	 * registry and the task log.
 	 */
 	onBackgroundSettled?: (taskId: string, result: SubagentResult) => void;
+	/**
+	 * Query whether a named tool is marked `concurrentSafe: true` (REQ-I02 / REQ-C01).
+	 * Falls back to the built-in read-only allowlist (`read`, `grep`, `find`, `ls`)
+	 * when omitted.
+	 */
+	isToolConcurrentSafe?: (toolName: string) => boolean | undefined;
 	/** Background registry. Defaults to the on-disk singleton. Injectable for tests. */
 	registry?: BackgroundRegistry;
 	/** Called after experiment registry mutations so the UI can refresh its status pill. */
@@ -1276,8 +1300,10 @@
 		name: "subagent",
 		label: "Subagent",
 		description: [
-			"Delegate work to a subagent that runs with a fresh context and returns its final summary.",
-			"Define the subagent per call: `role` (short specialist label) and `instructions` (the complete task — the subagent never sees this conversation, so include all context it needs), optionally `model` (omit to inherit this session's model) and a `tools` allowlist.",
+			"Delegate work to a subagent that runs in a fresh, isolated context.",
+			"Output contract: you receive ONLY the subagent's final summary (capped at 50 KiB), never its intermediate tool calls or transcript, and the subagent cannot see this conversation.",
+			"When NOT to delegate: do not delegate single-file edits, known-location lookups (`read`/`grep`/`find` you can run in 1-2 calls), or tasks that depend on conversation history you cannot concisely inline into `instructions`.",
+			"Define the subagent per call: `role` (short specialist label) and `instructions` (the complete self-contained task), optionally `model` (omit to inherit this session's model) and a `tools` allowlist.",
 			"Modes: single (`role` + `instructions`), parallel (`tasks`: independent investigations that can run at once), chain (`chain`: sequential steps where `{previous}` is replaced with the previous step's output).",
 			"Control: `action` manages runs instead of starting one — 'status' lists unfinished runs (with any filed control requests, their receipt state, and the questions a run has asked you), 'stop'/'interrupt' end one, 'steer' (`id` + `message`) redirects a run against its own child session, 'swap-model' (`id` + `model`) does the same on a new model, 'supervisor' (`id` + `replyTo` + `message`) answers a question a run asked with `contact_supervisor`, 'resume' (`id` + optional `message`) re-dispatches a run that has already settled against the child session it left behind, and 'save-spec'/'list-specs'/'delete-spec' manage stored dispatches. Target ids come from a 'status' listing. Controlling a run whose child has detached is not lost: steer/stop/interrupt file the request in the run's control inbox and the child picks it up itself.",
 		].join(" "),
@@ -1566,9 +1592,14 @@
 					// reference) closes its own registry row via onSyntheticSettle.
 					const runId = makeDagRunId();
 					const ids = dag.map(() => registry.makeTaskId());
+					const dagConcurrentSafe = dag.every((node) =>
+						isSpecConcurrentSafe(node, options?.isToolConcurrentSafe),
+					);
+					const effectiveDagMaxConcurrent = dagConcurrentSafe ? subagentSettings.maxConcurrent : 1;
 					const run = createDagRun({
 						nodes: dag,
 						runId,
+						maxConcurrent: effectiveDagMaxConcurrent,
 						signal,
 						taskIds: ids,
 						onSyntheticSettle: (index, result) => {
@@ -1619,10 +1650,14 @@
 			// ----------------------------------------------------------------
 			if (dag.length > 0) {
 				const runId = makeDagRunId();
+				const dagConcurrentSafe = dag.every((node) =>
+					isSpecConcurrentSafe(node, options?.isToolConcurrentSafe),
+				);
+				const effectiveDagMaxConcurrent = dagConcurrentSafe ? subagentSettings.maxConcurrent : 1;
 				const run = createDagRun({
 					nodes: dag,
 					runId,
-					maxConcurrent: subagentSettings.maxConcurrent,
+					maxConcurrent: effectiveDagMaxConcurrent,
 					signal,
 					onUpdate: (progress) => {
 						onUpdate?.({
@@ -1725,9 +1760,14 @@
 					});
 				};
 
+				const batchConcurrentSafe = tasks.every((task) =>
+					isSpecConcurrentSafe(task, options?.isToolConcurrentSafe),
+				);
+				const effectiveConcurrency = batchConcurrentSafe ? subagentSettings.maxConcurrent : 1;
+
 				const results = await mapWithConcurrencyLimit(
 					tasks,
-					subagentSettings.maxConcurrent,
+					effectiveConcurrency,
 					async (task, index) => {
 						const result = await runOne(
 							runner,
```

Verification (`packages/coding-agent/test/subagent-tool.test.ts`):
- Assert `createSubagentToolDefinition(cwd).description` contains `"When NOT to delegate"`, `"ONLY the subagent's final summary"`, and `"cannot see this conversation"` (REQ-D05.1–.3, REQ-CXT01).
- Dispatch `tasks` of 3 specs with `tools: ["read", "edit"]` (or omitted `tools`) under `maxConcurrent: 4` with an instrumented `SubagentRunner` tracking peak in-flight runs; assert `maxInFlight === 1` (serialised, REQ-C01).
- Dispatch `tasks` of 3 specs with `tools: ["read", "grep"]` under `maxConcurrent: 4`; assert `maxInFlight === 3` (concurrent, REQ-C01).

---

### 4. REQ-O02 — Include live inline runs in `/subagents` dashboard and log overlay

Rationale: `toggleBackgroundDashboard`, `openBackgroundLogOverlay`, and `updateSubagentStatusPills` (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:4475-4560`) read only `getBackgroundRegistry().snapshot().tasks`, making inline runs invisible while running; convert `session.getSubagentRunner?.().listRunning()` (`RunningSubagent` from `bun-process-runner.ts:345`) into `BackgroundTask`-shaped rows (tagged `mode: "inline"`) and read their `<inlineTaskDir(id)>/log.jsonl` when selected in the log overlay.

[UNRESOLVED: `bun-process-runner.ts` and `experiments-dashboard.ts` are not in the task archive; `bun-process-runner.ts` must tee child JSONL events to `join(inlineTaskDir(runId), "log.jsonl")` and `experiments-dashboard.ts` `readBackgroundLogTail` / `showBackgroundLogOverlay` must render through `getDisplayItems` / `formatToolCall` (`render.ts:122-149`) per REQ-O02.1 and REQ-O02.3 — suggested: wire the runner JSONL write in `bun-process-runner.ts` and add a fallback path check in `readBackgroundLogTail(id)` for `inlineTaskDir(id)`]

```diff
--- a/packages/coding-agent/src/modes/interactive/interactive-mode.ts
+++ b/packages/coding-agent/src/modes/interactive/interactive-mode.ts
@@ -122,6 +122,7 @@
 import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
 import type { SourceInfo } from "../../core/source-info.ts";
 import { type BackgroundTask, getBackgroundRegistry } from "../../core/subagent/background.ts";
+import { inlineTaskDir } from "../../core/subagent/subagent-tool.ts";
 import { listExperiments } from "../../core/subagent/experiment-registry.ts";
 import {
 	clearBackgroundDashboard,
@@ -2087,6 +2088,9 @@
 					this.pendingTools.set(event.toolCallId, component);
 				}
 				component.markExecutionStarted();
+				if (event.toolName === "subagent") {
+					this.updateSubagentStatusPills();
+				}
 				this.ui.requestRender();
 				break;
 			}
@@ -2095,6 +2099,9 @@
 				const component = this.pendingTools.get(event.toolCallId);
 				if (component) {
 					component.updateResult({ ...event.partialResult, isError: false }, true);
+					if (event.toolName === "subagent") {
+						this.updateSubagentStatusPills();
+					}
 					this.ui.requestRender();
 				}
 				break;
@@ -4465,6 +4472,33 @@
 		}
 	}
 
+	/**
+	 * Collect both live inline subagent runs (from the session's runner, if exposed)
+	 * and background registry rows into a unified list for the `/subagents` dashboard
+	 * and footer pill (REQ-O02.2).
+	 */
+	private collectDashboardTasks(): BackgroundTask[] {
+		const bgTasks = getBackgroundRegistry().snapshot().tasks.slice();
+		const sessionWithRunner = this.session as unknown as {
+			getSubagentRunner?: () => {
+				listRunning?: () => Array<{
+					runId: string;
+					role: string;
+					task: string;
+					cwd: string;
+					startedAt: string;
+					pid?: number;
+					model?: string;
+					sessionFile?: string;
+				}>;
+			};
+		};
+		const inlineRuns = sessionWithRunner.getSubagentRunner?.()?.listRunning?.() ?? [];
+		const inlineTasks: BackgroundTask[] = inlineRuns.map((run) => ({
+			id: run.runId,
+			role: run.role,
+			task: run.task,
+			mode: "single",
+			status: "running",
+			cwd: run.cwd,
+			startedAt: run.startedAt,
+			ownerPid: process.pid,
+			lastOutput: "(inline run in flight)",
+			...(run.pid === undefined ? {} : { pid: run.pid }),
+			...(run.model === undefined ? {} : { model: run.model }),
+			...(run.sessionFile === undefined ? {} : { sessionFile: run.sessionFile }),
+		}));
+		return [...inlineTasks, ...bgTasks].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
+	}
+
 	/**
 	 * Background-task dashboard toggle (the Fleet TUI surface for `/subagents`).
 	 * Mirrors `toggleExperimentsDashboard`: each invocation either opens or
@@ -4481,10 +4515,7 @@
 			this.closeBackgroundDashboard();
 			return;
 		}
-		const tasks = getBackgroundRegistry()
-			.snapshot()
-			.tasks.slice()
-			.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
+		const tasks = this.collectDashboardTasks();
 		this.bgDashboardTasks = tasks;
 		this.bgDashboardSelectedRow = 0;
 		showBackgroundDashboard(this.createExperimentsUi(), theme, tasks, 0);
@@ -4530,7 +4561,19 @@
 
 	/** Open the log-tail overlay for one task. The dashboard is the dispatcher. */
 	private openBackgroundLogOverlay(task: BackgroundTask): void {
-		const tail = readBackgroundLogTail(task.id);
+		let tail = readBackgroundLogTail(task.id);
+		if (tail.length === 0 && !task.id.startsWith("bg_")) {
+			const inlineLogPath = path.join(inlineTaskDir(task.id), "log.jsonl");
+			try {
+				if (fs.existsSync(inlineLogPath)) {
+					tail = fs
+						.readFileSync(inlineLogPath, "utf8")
+						.split(/\r?\n/)
+						.filter((line) => line.trim().length > 0)
+						.slice(-40);
+				}
+			} catch {}
+		}
 		showBackgroundLogOverlay(this.createExperimentsUi(), theme, task, tail);
 		this.bgLogOverlayOpen = true;
 		this.setBackgroundDashboardNavigation(false);
@@ -4564,9 +4607,11 @@
 		// The registry is user-level and spans every session and project — count
 		// only this session's project. renderBackgroundPill returns undefined at
 		// zero total, which clears the pill.
-		const tasks = getBackgroundRegistry()
-			.snapshot()
-			.tasks.filter((t) => path.resolve(t.cwd) === cwd);
+		const tasks = this.collectDashboardTasks().filter((t) => path.resolve(t.cwd) === cwd);
+		if (this.bgDashboardOpen) {
+			this.bgDashboardTasks = this.collectDashboardTasks();
+			showBackgroundDashboard(this.createExperimentsUi(), theme, this.bgDashboardTasks, this.bgDashboardSelectedRow);
+		}
 		this.setExtensionStatus(
 			UI_KEYS.BG_STATUS_KEY,
 			renderBackgroundPill(
```

Verification (`packages/coding-agent/test/subagent-dashboard-inline.test.ts`):
- Stub `session.getSubagentRunner().listRunning()` returning one in-flight inline run (`runId: "run-uuid-1"`, `role: "scout"`, `startedAt`, `cwd`) alongside one background registry row (`bg_1`); invoke `/subagents` (`toggleBackgroundDashboard`) and assert `bgDashboardTasks` contains both `"run-uuid-1"` and `"bg_1"` sorted by `startedAt` descending, and that opening the log overlay on `"run-uuid-1"` reads `<inlineTaskDir("run-uuid-1")>/log.jsonl` (REQ-O02.1, REQ-O02.2).

---
