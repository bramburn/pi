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

### fix-14-subagent-isolation-admission
> Full Report: [fix-14-subagent-isolation-admission.md](./fix-14-subagent-isolation-admission.md) | Tokens: in=125,105 cached_read=0 out=9,589

### 1. `packages/agent/src/types.ts`

Rationale: Declare `concurrentSafe?: boolean` on `AgentTool` (`packages/agent/src/types.ts:403-427`) so parallel admission in the subagent dispatcher and tool registry can distinguish read-only tools from mutating tools (REQ-I02, `specs/subagent/features/isolation/spec.md` §4.2).

```diff
--- a/packages/agent/src/types.ts
+++ b/packages/agent/src/types.ts
@@ -425,4 +425,11 @@
 	 * If omitted, the default execution mode applies.
 	 */
 	executionMode?: ToolExecutionMode;
+	/**
+	 * Whether this tool is safe to execute concurrently across parallel subagents or tool batches (REQ-I02).
+	 * Pure read-only tools set `true`; tools that mutate files or spawn processes (`bash`, `edit`, `write`, `subagent`)
+	 * default to `false`. Parallel subagent admission serialises any batch whose tools are not all `concurrentSafe: true`.
+	 */
+	concurrentSafe?: boolean;
 }
```

---

### 2. `packages/coding-agent/src/core/subagent/types.ts`

Rationale: Add `isolation?: "none" | "worktree"` and `allowDetachedShell?: boolean` to `SubagentSpec` (`packages/coding-agent/src/core/subagent/types.ts:68-114`), and record `worktreePath?: string` on `SubagentResult` (`types.ts:276-331`) for REQ-I01 and REQ-P02.

```diff
--- a/packages/coding-agent/src/core/subagent/types.ts
+++ b/packages/coding-agent/src/core/subagent/types.ts
@@ -16,6 +16,9 @@
 import type { Message } from "@earendil-works/pi-ai";
 import type { CompletionEscalation } from "./result-record.ts";
 
+/** Worktree isolation mode for a subagent dispatch (REQ-I01). */
+export type SubagentIsolation = "none" | "worktree";
+
 /** How the orchestrator dispatched a set of subagent tasks. */
 export type SubagentMode = "single" | "parallel" | "chain" | "resume" | "dag";
 
@@ -89,6 +92,18 @@
 	tools?: string[];
 	/** Working directory for the child process. Omit to inherit the parent's cwd. */
 	cwd?: string;
+	/**
+	 * Worktree isolation mode (REQ-I01). `"worktree"` creates an isolated git worktree
+	 * before spawning and passes its path as the child's `cwd`, releasing it on settle.
+	 * Default `"none"`. Creation failure raises an E1-class error and never downgrades silently.
+	 */
+	isolation?: SubagentIsolation;
+	/**
+	 * Explicit admission for detached (`background: true`) execution when the child's
+	 * tool set is not narrowed to non-shell tools (`read`, `grep`, `find`, `ls`) (REQ-P02).
+	 */
+	allowDetachedShell?: boolean;
 	/** Persisted child session file to resume. Wins over `parentSessionFile`. */
 	sessionFile?: string;
 	/**
@@ -330,6 +345,8 @@
 	outputValidation?: SubagentOutputValidation;
 	/** Host-run verify command outcome, when the spec declared `gate`. */
 	gate?: SubagentGateOutcome;
+	/** Isolated git worktree path used by this run when `isolation: "worktree"` was requested (REQ-I01.5). */
+	worktreePath?: string;
 }
```

---

### 3. `packages/coding-agent/src/core/subagent/subagent-tool.ts`

Rationale: Expose `isolation: "none" | "worktree"` and `allowDetachedShell: boolean` in `subagentSpecProperties` and `subagentSchema` (`subagent-tool.ts:92-360`), enforce per-tool `concurrentSafe` serialisation on parallel dispatches (`subagent-tool.ts:1548-1550`, REQ-I02/REQ-C01), enforce detached-child admission (`background: true` requires `allowDetachedShell: true` or a tool set narrowed to `{read, grep, find, ls}`, REQ-P02.1–P02.4), and wire `createWorktree` / `removeWorktree` around `isolation: "worktree"` dispatches without silent downgrade and with worktree path disclosure in `finalOutput` (REQ-I01.1–I01.5).

[UNRESOLVED: Orphan-reconciliation worktree cleanup hook on `BackgroundTask` — `BackgroundTask` in `packages/coding-agent/src/core/subagent/background.ts` is not in the modifiable scope of this task, so `runOne` and `dispatchDetached` release the worktree on every in-process settle path (`completed`, `failed`, `cancelled`, `aborted`), while persisting `worktreePath` onto `BackgroundTask` rows for post-SIGKILL startup reconciliation requires a `background.ts` schema extension — suggested: add `worktreePath?: string` to `BackgroundTask` in `background.ts` and call `removeWorktree(row.cwd, row.worktreePath, { force: true })` inside `markAllRunningAsCrashed`.]

```diff
--- a/packages/coding-agent/src/core/subagent/subagent-tool.ts
+++ b/packages/coding-agent/src/core/subagent/subagent-tool.ts
@@ -100,11 +100,13 @@
 	type SubagentEventListener,
 	type SubagentGate,
 	type SubagentGateOutcome,
+	type SubagentIsolation,
 	type SubagentMode,
 	type SubagentResult,
 	type SubagentRunner,
 	type SubagentRunRequest,
 	type SubagentSpec,
 } from "./types.ts";
+import { createWorktree, removeWorktree } from "./worktree.ts";
 
 /**
  * Model-facing output cap: parallel per-task summaries, single/chain result
@@ -112,6 +114,34 @@
  * details.
  */
 export const PER_TASK_OUTPUT_CAP = 50 * 1024;
+
+/**
+ * Built-in tool capability table (REQ-I02, REQ-P02).
+ * Only pure read-only tools are `concurrentSafe: true` and eligible for un-admitted
+ * detached execution; mutating/shell tools (`bash`, `powershell`, `edit`, `write`, `subagent`)
+ * are `false` (specs/subagent/features/isolation/spec.md §4.2, traceability V28).
+ */
+export const SUBAGENT_TOOL_CONCURRENT_SAFE: Readonly<Record<string, boolean>> = {
+	read: true,
+	grep: true,
+	find: true,
+	ls: true,
+	bash: false,
+	powershell: false,
+	edit: false,
+	write: false,
+	subagent: false,
+};
+
+/**
+ * True only when a spec declares an explicit non-empty `tools` allowlist and every
+ * tool in it is marked `concurrentSafe: true` in {@link SUBAGENT_TOOL_CONCURRENT_SAFE}.
+ * Omitting `tools` inherits the full coding set (which includes `bash`, `edit`, `write`),
+ * so an omitted or empty list is never concurrent-safe or shell-free.
+ */
+export function isConcurrentSafeToolSet(tools: readonly string[] | undefined): boolean {
+	if (tools === undefined || tools.length === 0) return false;
+	return tools.every((name) => SUBAGENT_TOOL_CONCURRENT_SAFE[name.trim()] === true);
+}
 
 const subagentSpecProperties = {
 	role: Type.String({
@@ -139,6 +169,24 @@
 			description: "Working directory for the subagent. Omit to inherit this session's working directory.",
 		}),
 	),
+	isolation: Type.Optional(
+		Type.Union([Type.Literal("none"), Type.Literal("worktree")], {
+			description:
+				"Filesystem isolation for the subagent ('none' | 'worktree', default 'none'). When 'worktree', an isolated git worktree is created before spawn and passed as the child's cwd, then cleaned up when the child settles. Fails loudly if the worktree cannot be created (never silently downgrades to 'none').",
+			default: "none",
+		}),
+	),
+	allowDetachedShell: Type.Optional(
+		Type.Boolean({
+			description:
+				"Explicit admission to run a detached (`background: true`) subagent with shell or file-mutating tools. Required when `background: true` unless `tools` is narrowed to read-only tools (`read`, `grep`, `find`, `ls`).",
+		}),
+	),
 	outputSchema: Type.Optional(
 		Type.Record(Type.String(), Type.Unknown(), {
 			description:
@@ -208,6 +256,19 @@
 			description: "Working directory for the subagent. Omit to inherit this session's working directory.",
 		}),
 	),
+	isolation: Type.Optional(
+		Type.Union([Type.Literal("none"), Type.Literal("worktree")], {
+			description:
+				"Filesystem isolation for the subagent ('none' | 'worktree', default 'none'). When 'worktree', an isolated git worktree is created before spawn and passed as the child's cwd, then cleaned up when the child settles. Fails loudly if the worktree cannot be created (never silently downgrades to 'none').",
+			default: "none",
+		}),
+	),
+	allowDetachedShell: Type.Optional(
+		Type.Boolean({
+			description:
+				"Explicit admission to run a detached (`background: true`) subagent with shell or file-mutating tools. Required when `background: true` unless every dispatched spec narrows `tools` to read-only tools (`read`, `grep`, `find`, `ls`).",
+		}),
+	),
 	// The thinking levels are spelled out because TypeBox infers a literal union
 	// only from an explicit tuple — mapping `THINKING_LEVEL_OPTIONS` here yields an
 	// `undefined` static type. `test/subagent-tool.test.ts` asserts this list stays
@@ -780,6 +841,49 @@
 	return { ...settled, gate, errorMessage: gateFailureMessage(spec.role, gate) };
 }
 
+/** Mint a collision-resistant worktree slug for a subagent run (REQ-I01.2). */
+function makeSubagentWorktreeSlug(role: string): string {
+	const clean = role
+		.toLowerCase()
+		.replace(/[^a-z0-9-]+/g, "-")
+		.replace(/^-+|-+$/g, "")
+		.slice(0, 24);
+	const prefix = clean || "subagent";
+	const rand = Math.random().toString(36).slice(2, 8);
+	return `${prefix}-${Date.now().toString(36)}-${rand}`;
+}
+
+/** Append the worktree disclosure note required by REQ-I01.5. */
+function appendWorktreeNote(output: string, slug: string, worktreePath: string): string {
+	const note = `[Worktree: ${slug} at ${worktreePath}]`;
+	return output.trim() === "" ? note : `${output}\n\n${note}`;
+}
+
+/**
+ * Check REQ-P02 detached-child admission before any background task is spawned.
+ * Returns an E1-class error message naming the offending role and both remedies
+ * when `background: true` is requested without either `allowDetachedShell: true`
+ * or a `tools` allowlist restricted to `{read, grep, find, ls}`.
+ */
+export function checkDetachedAdmission(
+	specs: readonly SubagentSpec[],
+	topLevelAllowDetachedShell?: boolean,
+): string | undefined {
+	for (const spec of specs) {
+		const admitted =
+			topLevelAllowDetachedShell === true ||
+			spec.allowDetachedShell === true ||
+			isConcurrentSafeToolSet(spec.tools);
+		if (!admitted) {
+			const toolsDesc =
+				spec.tools === undefined || spec.tools.length === 0
+					? "the default tool set (includes bash, edit, write)"
+					: `tools=[${spec.tools.join(", ")}]`;
+			return `Detached subagent admission refused for "${spec.role}": background: true with ${toolsDesc} requires explicit admission. Either pass \`allowDetachedShell: true\` to grant background shell/write access,narrow \`tools\` to read-only tools (\`["read", "grep", "find", "ls"]\`), or omit \`background: true\` to run inline.`;
+		}
+	}
+	return undefined;
+}
+
 /** Run one subagent and record exactly one analytics span for it. */
 async function runOne(
 	runner: SubagentRunner,
@@ -789,8 +893,43 @@
 	parentSessionFile: string | undefined,
 	step: number | undefined,
 	signal: AbortSignal | undefined,
 	onPartial?: (snapshot: SubagentResult) => void,
+	worktreeBase = DEFAULT_SUBAGENT_SETTINGS.worktreeBase,
 ): Promise<SubagentResult> {
-	const cwd = spec.cwd ? (isAbsolute(spec.cwd) ? spec.cwd : resolvePath(baseCwd, spec.cwd)) : baseCwd;
+	const repoCwd = spec.cwd ? (isAbsolute(spec.cwd) ? spec.cwd : resolvePath(baseCwd, spec.cwd)) : baseCwd;
+	let cwd = repoCwd;
+	let createdWorktree: { slug: string; path: string } | undefined;
+	if (spec.isolation === "worktree") {
+		const slug = makeSubagentWorktreeSlug(spec.role);
+		try {
+			const wt = createWorktree(repoCwd, slug, { worktreeBase });
+			createdWorktree = { slug: wt.slug, path: wt.path };
+			cwd = wt.path;
+		} catch (err) {
+			// REQ-I01.4: Worktree creation failure MUST surface as an E1-class error and
+			// never silently downgrade to isolation: "none" in the base working tree.
+			const reason = err instanceof Error ? err.message : String(err);
+			const errorMessage = `Worktree isolation failed for subagent "${spec.role}" in ${repoCwd}: ${reason}. No child process was spawned (isolation: "worktree" never silently downgrades to "none"). Fix the repository/worktree state or set isolation: "none" if shared-tree execution is intended.`;
+			return {
+				role: spec.role,
+				task: spec.instructions,
+				exitCode: -1,
+				aborted: false,
+				finalOutput: "",
+				stderr: errorMessage,
+				usage: createEmptyUsage(),
+				...(step === undefined ? {} : { step }),
+				...(spec.gate === undefined ? {} : { gate: skippedGate(spec.gate, repoCwd, "child-failed") }),
+				messages: [],
+				errorMessage,
+			};
+		}
+	}
 	// A schema-bound child gets the format contract in its system prompt; the
 	// authored `instructions` stay the run's task text everywhere they are
 	// reported (result, in-flight snapshot, span label), so nothing downstream
@@ -799,7 +938,11 @@
 	const schemaBlock = spec.outputSchema === undefined ? undefined : buildSchemaInstruction(spec.outputSchema);
 	const childSpec: SubagentSpec =
-		schemaBlock === undefined ? spec : { ...spec, instructions: `${spec.instructions}\n\n${schemaBlock}` };
+		schemaBlock === undefined
+			? { ...spec, cwd }
+			: { ...spec, cwd, instructions: `${spec.instructions}\n\n${schemaBlock}` };
 	const request: SubagentRunRequest = {
 		spec: childSpec,
 		task: spec.instructions,
@@ -857,9 +1000,19 @@
 			: undefined;
 
 		const result = await runner.run(request, signal, listener);
 		const settled = await applyOutputContract(spec, cwd, result, signal);
+		const withWorktree: SubagentResult =
+			createdWorktree === undefined
+				? settled
+				: {
+						...settled,
+						worktreePath: createdWorktree.path,
+						finalOutput: appendWorktreeNote(settled.finalOutput, createdWorktree.slug, createdWorktree.path),
+					};
 		const failed = isFailedSubagentResult(settled);
 		endSubagentTask(spanId, !failed, failed ? (settled.errorMessage ?? `exit code ${settled.exitCode}`) : undefined);
-		return settled;
+		return withWorktree;
 	} catch (err) {
 		// The run never started (spawn failure, runner rejection): report it as a
 		// failed result rather than propagating, so the orchestrator gets a
@@ -879,7 +1032,18 @@
 			...(spec.gate === undefined ? {} : { gate: skippedGate(spec.gate, cwd, "child-failed") }),
+			...(createdWorktree === undefined ? {} : { worktreePath: createdWorktree.path }),
 			messages: [],
 			errorMessage,
 		};
+	} finally {
+		if (createdWorktree !== undefined) {
+			try {
+				removeWorktree(repoCwd, createdWorktree.path, { force: true });
+			} catch {
+				// Best-effort cleanup on settle; worktree path is still disclosed in result.
+			}
+		}
 	}
 }
 
@@ -932,6 +1096,8 @@
 	model?: string;
 	tools?: string[];
 	cwd?: string;
+	isolation?: SubagentIsolation;
+	allowDetachedShell?: boolean;
 	thinking?: ThinkingLevel;
 	outputSchema?: Record<string, unknown>;
 	gate?: SubagentGate;
@@ -942,6 +1108,8 @@
 		...(input.model === undefined ? {} : { model: input.model }),
 		...(input.tools === undefined ? {} : { tools: input.tools }),
 		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
+		...(input.isolation === undefined ? {} : { isolation: input.isolation }),
+		...(input.allowDetachedShell === undefined ? {} : { allowDetachedShell: input.allowDetachedShell }),
 		...(input.thinking === undefined ? {} : { thinking: input.thinking }),
 		...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
 		...(input.gate === undefined ? {} : { gate: input.gate }),
@@ -1287,6 +1455,7 @@
 			"Delegate work to a subagent that runs with a fresh context and returns its final summary.",
 			"Define the subagent per call: `role` (short specialist label) and `instructions` (the complete task — the subagent never sees this conversation, so include all context it needs), optionally `model` (omit to inherit this session's model) and a `tools` allowlist.",
 			"Modes: single (`role` + `instructions`), parallel (`tasks`: independent investigations that can run at once), chain (`chain`: sequential steps where `{previous}` is replaced with the previous step's output).",
+			"Isolation & background admission: set `isolation: 'worktree'` to run a child in an isolated git worktree rather than the shared working tree; parallel tasks that include mutating/shell tools (`bash`, `edit`, `write`) are serialised automatically unless `tools` is narrowed to read-only tools (`read`, `grep`, `find`, `ls`); `background: true` requires either `allowDetachedShell: true` or `tools` narrowed to read-only tools.",
 			"Control: `action` manages runs instead of starting one — 'status' lists unfinished runs (with any filed control requests, their receipt state, and the questions a run has asked you), 'stop'/'interrupt' end one, 'steer' (`id` + `message`) redirects a run against its own child session, 'swap-model' (`id` + `model`) does the same on a new model, 'supervisor' (`id` + `replyTo` + `message`) answers a question a run asked with `contact_supervisor`, 'resume' (`id` + optional `message`) re-dispatches a run that has already settled against the child session it left behind, and 'save-spec'/'list-specs'/'delete-spec' manage stored dispatches. Target ids come from a 'status' listing. Controlling a run whose child has detached is not lost: steer/stop/interrupt file the request in the run's control inbox and the child picks it up itself.",
 		].join(" "),
 		promptSnippet: "Delegate work to a subagent with a fresh context (role + instructions per call)",
@@ -1443,6 +1612,18 @@
 				);
 			}
 
+			// ----------------------------------------------------------------
+			// Detached-child admission (REQ-P02, permissions/spec.md §3).
+			// Checked before the spawn budget is committed so a refused background
+			// call does not consume spawn slots or start any task in a batch.
+			// ----------------------------------------------------------------
+			if (params.background === true) {
+				const admissionProblem = checkDetachedAdmission(dispatchedSpecs, params.allowDetachedShell);
+				if (admissionProblem !== undefined) {
+					throw new Error(admissionProblem);
+				}
+			}
+
 			// ----------------------------------------------------------------
 			// Session-wide spawn budget (subagent.maxTotalSpawns)
 			//
@@ -1494,16 +1675,38 @@
 					spec: SubagentSpec,
 					taskId: string | undefined,
 					onSettled?: (taskId: string, result: SubagentResult) => void,
-				): string =>
-					dispatchDetached({
+				): string => {
+					const repoCwd = resolveTaskCwd(spec);
+					let taskCwd = repoCwd;
+					let createdWorktree: { slug: string; path: string } | undefined;
+					if (spec.isolation === "worktree") {
+						const slug = makeSubagentWorktreeSlug(spec.role);
+						try {
+							const wt = createWorktree(repoCwd, slug, { worktreeBase: subagentSettings.worktreeBase });
+							createdWorktree = { slug: wt.slug, path: wt.path };
+							taskCwd = wt.path;
+						} catch (err) {
+							const reason = err instanceof Error ? err.message : String(err);
+							throw new Error(
+								`Worktree isolation failed for subagent "${spec.role}" in ${repoCwd}: ${reason}. No child process was spawned (isolation: "worktree" never silently downgrades to "none"). Fix the repository/worktree state or set isolation: "none" if shared-tree execution is intended.`,
+							);
+						}
+					}
+					const settledHandler = onSettled ?? options?.onBackgroundSettled;
+					return dispatchDetached({
 						registry,
 						runner,
-						spec,
+						spec: { ...spec, cwd: taskCwd },
 						task: spec.instructions,
-						cwd: resolveTaskCwd(spec),
+						cwd: taskCwd,
 						parent,
 						parentSessionFile,
 						// Live getter rather than the `subagentSettings` snapshot above: the release
 						// half of this closure runs when the task settles, which can be long after this
 						// call returned. Reading the cap at settle time is what lets a mid-session
 						// change to subagent.maxConcurrent apply to the drain instead of promoting
 						// against a stale cap.
 						settings: () => options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS,
-						onSettled: onSettled ?? options?.onBackgroundSettled,
+						onSettled: (settledTaskId, result) => {
+							const enriched: SubagentResult =
+								createdWorktree === undefined
+									? result
+									: {
+											...result,
+											worktreePath: createdWorktree.path,
+											finalOutput: appendWorktreeNote(
+												result.finalOutput,
+												createdWorktree.slug,
+												createdWorktree.path,
+											),
+										};
+							if (createdWorktree !== undefined) {
+								try {
+									removeWorktree(repoCwd, createdWorktree.path, { force: true });
+								} catch {
+									/* best-effort */
+								}
+							}
+							settledHandler?.(settledTaskId, enriched);
+						},
 						...(taskId === undefined ? {} : { taskId }),
 					}).taskId;
+				};
 
 				const taskIds: string[] = [];
@@ -1657,6 +1860,7 @@
 						launch.level + 1,
 						launch.signal,
 						launch.onPartial,
+						subagentSettings.worktreeBase,
 					);
 				});
 				const results = run.getResults();
@@ -1686,12 +1890,22 @@
 							truncateModelFacingOutput(previousOutput),
 						),
 					});
-					const result = await runOne(runner, spec, cwd, parent, parentSessionFile, i + 1, signal, (snapshot) => {
-						onUpdate?.({
-							content: [{ type: "text", text: snapshot.finalOutput || "(running)" }],
-							details: { mode: "chain", results: [...results, snapshot] },
-						});
-					});
+					const result = await runOne(
+						runner,
+						spec,
+						cwd,
+						parent,
+						parentSessionFile,
+						i + 1,
+						signal,
+						(snapshot) => {
+							onUpdate?.({
+								content: [{ type: "text", text: snapshot.finalOutput || "(running)" }],
+								details: { mode: "chain", results: [...results, snapshot] },
+							});
+						},
+						subagentSettings.worktreeBase,
+					);
 					results.push(result);
 					if (isFailedSubagentResult(result)) {
 						// A thrown error becomes tool-error content verbatim (agent-loop
@@ -1748,9 +1962,21 @@
 					});
 				};
 
+				// REQ-I02 / REQ-C01: Parallel admission gates on per-tool `concurrentSafe`.
+				// A batch containing any task with mutating/shell tools (unless isolated in its
+				// own worktree) serialises (`concurrency = 1`) rather than running concurrently
+				// against the same working tree.
+				const batchIsConcurrentSafe = tasks.every(
+					(task) =>
+						(task.isolation ?? params.isolation) === "worktree" || isConcurrentSafeToolSet(task.tools),
+				);
+				const effectiveConcurrency = batchIsConcurrentSafe ? subagentSettings.maxConcurrent : 1;
+
 				const results = await mapWithConcurrencyLimit(
 					tasks,
-					subagentSettings.maxConcurrent,
+					effectiveConcurrency,
 					async (task, index) => {
 						const result = await runOne(
 							runner,
-							specFromInput(task),
+							specFromInput({
+								...task,
+								isolation: task.isolation ?? params.isolation,
+							}),
 							cwd,
 							parent,
 							parentSessionFile,
@@ -1759,6 +1985,7 @@
 								allResults[index] = snapshot;
 								emitParallelUpdate();
 							},
+							subagentSettings.worktreeBase,
 						);
 						allResults[index] = result;
 						settled[index] = true;
@@ -1793,12 +2020,22 @@
 			// Single
 			// ----------------------------------------------------------------
 			const spec = singleSpec as SubagentSpec;
-			const result = await runOne(runner, spec, cwd, parent, parentSessionFile, undefined, signal, (snapshot) => {
-				onUpdate?.({
-					content: [{ type: "text", text: snapshot.finalOutput || "(running)" }],
-					details: { mode: "single", results: [snapshot] },
-				});
-			});
+			const result = await runOne(
+				runner,
+				spec,
+				cwd,
+				parent,
+				parentSessionFile,
+				undefined,
+				signal,
+				(snapshot) => {
+					onUpdate?.({
+						content: [{ type: "text", text: snapshot.finalOutput || "(running)" }],
+						details: { mode: "single", results: [snapshot] },
+					});
+				},
+				subagentSettings.worktreeBase,
+			);
 			if (isFailedSubagentResult(result)) {
 				// Same cap as the chain throw above: thrown error.message becomes
 				// tool-error content verbatim and has no tool details attached.
```

---

### Verification Tests

#### `packages/coding-agent/test/subagent-isolation-permissions.test.ts`

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	checkDetachedAdmission,
	createSubagentToolDefinition,
	isConcurrentSafeToolSet,
	SUBAGENT_TOOL_CONCURRENT_SAFE,
	subagentSchema,
} from "../src/core/subagent/subagent-tool.ts";
import { createEmptyUsage, type SubagentRunRequest, type SubagentRunner } from "../src/core/subagent/types.ts";

function initTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "qi-subagent-iso-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
	writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
	execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
	return dir;
}

describe("REQ-I02: AgentTool.concurrentSafe and parallel serialisation", () => {
	it("accepts concurrentSafe on AgentTool and classifies built-in tools", () => {
		const dummyTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read file",
			parameters: Type.Object({}),
			concurrentSafe: true,
			execute: async () => ({ content: [], details: undefined }),
		};
		expect(dummyTool.concurrentSafe).toBe(true);
		expect(SUBAGENT_TOOL_CONCURRENT_SAFE.read).toBe(true);
		expect(SUBAGENT_TOOL_CONCURRENT_SAFE.edit).toBe(false);
		expect(SUBAGENT_TOOL_CONCURRENT_SAFE.write).toBe(false);
		expect(SUBAGENT_TOOL_CONCURRENT_SAFE.bash).toBe(false);
		expect(isConcurrentSafeToolSet(["read", "grep"])).toBe(true);
		expect(isConcurrentSafeToolSet(["read", "edit"])).toBe(false);
		expect(isConcurrentSafeToolSet(undefined)).toBe(false);
	});

	it("serialises parallel tasks that include mutating tools and runs read-only tasks concurrently", async () => {
		let active = 0;
		let maxActive = 0;
		const runner: SubagentRunner = {
			async run(req) {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((r) => setTimeout(r, 30));
				active -= 1;
				return {
					role: req.spec.role,
					task: req.task,
					exitCode: 0,
					aborted: false,
					finalOutput: "ok",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				};
			},
		};

		const def = createSubagentToolDefinition(process.cwd(), { runner });

		// Mutating tools (edit) -> serialised (maxActive === 1)
		maxActive = 0;
		await def.execute(
			"call-mut",
			{
				tasks: [
					{ role: "w1", instructions: "edit a", tools: ["read", "edit"] },
					{ role: "w2", instructions: "edit b", tools: ["read", "edit"] },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(maxActive).toBe(1);

		// Read-only tools (read, grep) -> concurrent (maxActive === 2)
		maxActive = 0;
		await def.execute(
			"call-ro",
			{
				tasks: [
					{ role: "r1", instructions: "read a", tools: ["read", "grep"] },
					{ role: "r2", instructions: "read b", tools: ["read", "ls"] },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(maxActive).toBe(2);
	});
});

describe("REQ-I01: isolation schema and worktree plumbing", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const d of tempDirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("validates isolation: 'none' | 'worktree' in subagentSchema", () => {
		expect(
			Value.Check(subagentSchema, {
				role: "worker",
				instructions: "do work",
				isolation: "worktree",
			}),
		).toBe(true);
		expect(
			Value.Check(subagentSchema, {
				role: "worker",
				instructions: "do work",
				isolation: "invalid",
			}),
		).toBe(false);
	});

	it("spawns inside an isolated git worktree, discloses its path in finalOutput, and cleans up on settle", async () => {
		const repo = initTempGitRepo();
		tempDirs.push(repo);

		let observedCwd = "";
		let existedDuringRun = false;
		const runner: SubagentRunner = {
			async run(req: SubagentRunRequest) {
				observedCwd = req.cwd;
				existedDuringRun = existsSync(req.cwd);
				return {
					role: req.spec.role,
					task: req.task,
					exitCode: 0,
					aborted: false,
					finalOutput: "done in worktree",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				};
			},
		};

		const def = createSubagentToolDefinition(repo, { runner });
		const res = await def.execute(
			"call-wt",
			{ role: "iso-worker", instructions: "implement feature", isolation: "worktree" },
			undefined,
			undefined,
			{} as never,
		);

		expect(existedDuringRun).toBe(true);
		expect(observedCwd).not.toBe(repo);
		expect(observedCwd).toContain(".worktrees");
		const text = res.content[0]?.type === "text" ? res.content[0].text : "";
		expect(text).toContain("[Worktree:");
		expect(text).toContain(observedCwd);
		// Worktree is cleaned up on settle
		expect(existsSync(observedCwd)).toBe(false);
	});

	it("never silently downgrades when worktree creation fails", async () => {
		const nonGitDir = mkdtempSync(join(tmpdir(), "qi-non-git-"));
		tempDirs.push(nonGitDir);

		let spawned = false;
		const runner: SubagentRunner = {
			async run() {
				spawned = true;
				throw new Error("should not spawn");
			},
		};

		const def = createSubagentToolDefinition(nonGitDir, { runner });
		await expect(
			def.execute(
				"call-wt-fail",
				{ role: "iso-worker", instructions: "try worktree", isolation: "worktree" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/Worktree isolation failed.*never silently downgrades/i);
		expect(spawned).toBe(false);
	});
});

describe("REQ-P02: detached background child admission check", () => {
	it("refuses background: true with default or shell tool sets unless allowDetachedShell: true", async () => {
		let spawned = false;
		const runner: SubagentRunner = {
			async run() {
				spawned = true;
				return {
					role: "bg",
					task: "t",
					exitCode: 0,
					aborted: false,
					finalOutput: "ok",
					stderr: "",
					usage: createEmptyUsage(),
					messages: [],
				};
			},
		};

		const def = createSubagentToolDefinition(process.cwd(), { runner });
		await expect(
			def.execute(
				"call-bg-refused",
				{ role: "bg-worker", instructions: "run in bg", background: true },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/Detached subagent admission refused.*allowDetachedShell: true/i);
		expect(spawned).toBe(false);
	});

	it("admits background: true when tools are narrowed to read-only or allowDetachedShell is true", () => {
		expect(
			checkDetachedAdmission([{ role: "scout", instructions: "scan", tools: ["read", "grep"] }], false),
		).toBeUndefined();
		expect(
			checkDetachedAdmission([{ role: "worker", instructions: "build", allowDetachedShell: true }], false),
		).toBeUndefined();
		expect(
			checkDetachedAdmission([{ role: "worker", instructions: "build", tools: ["read", "bash"] }], false),
		).toMatch(/Detached subagent admission refused/);
	});
});
```

---
