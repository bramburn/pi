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

### fix-12-subagent-lease-and-concurrency
> Full Report: [fix-12-subagent-lease-and-concurrency.md](./fix-12-subagent-lease-and-concurrency.md) | Tokens: in=119,796 cached_read=0 out=8,729

Rationale: Wire `SessionLeaseHandle.updateWriter` across inline and detached redirect paths (`subagent-tool.ts:965-1135`, `session-lease.ts:107,455`) to record `spawning` at dispatch and `running`+pid on `spawned` (REQ-L02); replace per-call `mapWithConcurrencyLimit` (`subagent-tool.ts:565-583,1665-1667`) and uncounted `single`/`chain` dispatches (`subagent-tool.ts:1603,1715`) with a session-scoped semaphore closed over by `createSubagentToolDefinition` that cross-accounts live inline children with `dispatchDetached` (`subagent-tool.ts:681-724`) and drains background queues on inline settle (REQ-C02, REQ-C03).

```diff
--- a/packages/coding-agent/src/core/subagent/subagent-tool.ts
+++ b/packages/coding-agent/src/core/subagent/subagent-tool.ts
@@ -478,6 +478,7 @@
 	step: number | undefined,
 	signal: AbortSignal | undefined,
 	onPartial?: (snapshot: SubagentResult) => void,
+	onEvent?: SubagentEventListener,
 ): Promise<SubagentResult> {
 	const cwd = spec.cwd ? (isAbsolute(spec.cwd) ? spec.cwd : resolvePath(baseCwd, spec.cwd)) : baseCwd;
 	// A schema-bound child gets the format contract in its system prompt; the
@@ -514,8 +515,10 @@
 		let lastText = "";
 		const liveUsage = createEmptyUsage();
 		const seen: Message[] = [];
-		const listener: SubagentEventListener | undefined = onPartial
-			? (event) => {
+		const listener: SubagentEventListener | undefined =
+			onPartial || onEvent
+				? (event) => {
+					onEvent?.(event);
 					if (event.type === "message_end" || event.type === "tool_result_end") {
 						seen.push(event.message);
 					}
@@ -539,10 +542,10 @@
 						usage: { ...liveUsage },
 						...(step === undefined ? {} : { step }),
 						messages: [...seen],
 					});
-				}
-			: undefined;
+				  }
+				: undefined;
 
 		const result = await runner.run(request, signal, listener);
 		const settled = await applyOutputContract(spec, cwd, result, signal);
@@ -565,24 +568,6 @@
 	}
 }
 
-/** Map with a bounded number of concurrently running promises, preserving order. */
-async function mapWithConcurrencyLimit<TIn, TOut>(
-	items: TIn[],
-	concurrency: number,
-	fn: (item: TIn, index: number) => Promise<TOut>,
-): Promise<TOut[]> {
-	if (items.length === 0) return [];
-	const limit = Math.max(1, Math.min(concurrency, items.length));
-	const results = new Array<TOut>(items.length);
-	let nextIndex = 0;
-	const workers = new Array(limit).fill(null).map(async () => {
-		while (true) {
-			const current = nextIndex++;
-			if (current >= items.length) return;
-			results[current] = await fn(items[current], current);
-		}
-	});
-	await Promise.all(workers);
-	return results;
-}
-
 /**
  * Cap model-facing output at PER_TASK_OUTPUT_CAP bytes (UTF-8).
  *
@@ -690,8 +675,9 @@
 	settings: () => ResolvedSubagentSettings;
 	taskId?: string;
 	onSettled?: (taskId: string, result: SubagentResult) => void;
+	liveInlineCount?: () => number;
 }): { taskId: string; started: boolean; queuePosition: number } {
-	const cap = (): number => args.settings().maxConcurrent;
+	const cap = (): number => Math.max(0, args.settings().maxConcurrent - (args.liveInlineCount?.() ?? 0));
 	let released = false;
 	const request = requestBackgroundDispatch(
 		args.registry,
@@ -725,6 +711,17 @@
 	};
 }
 
+function safeUpdateLeaseWriter(
+	lease: SessionLeaseHandle,
+	writer: { state: "none" | "spawning" | "running"; pid?: number },
+): void {
+	try {
+		lease.updateWriter(writer);
+	} catch (err) {
+		console.warn(`[subagent] ${err instanceof Error ? err.message : String(err)}`);
+	}
+}
+
 /**
  * Report a batch of detached dispatch ids, splitting work that started from
  * work that is waiting for a slot. Naming a queued task as "started" would send
@@ -769,6 +766,89 @@
 	// batch is either admitted in full or rejected in full — no partial
 	// admission, no two parallel calls slipping through the same hole.
 	let totalSpawnCount = 0;
+
+	// Session-wide concurrency budget (REQ-C02, REQ-C03): inline and background
+	// runs share one live-children cap (`subagent.maxConcurrent`). Inline runs
+	// acquire a slot on this session-scoped semaphore before spawning and release
+	// it in `finally`, draining any queued background work on settle.
+	let activeInlineCount = 0;
+	const inlineWaiters: Array<{
+		tryAcquire: () => boolean;
+		cleanup: () => void;
+	}> = [];
+
+	const getMaxConcurrent = (): number =>
+		Math.max(1, (options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS).maxConcurrent);
+
+	const getActiveBackgroundCount = (runner: SubagentRunner): number => {
+		const registry = options?.registry ?? getBackgroundRegistry();
+		const runningBg = registry.listRunning().filter((t) => t.status === "running").length;
+		const totalRunner = runner.listRunning?.().length ?? 0;
+		return Math.max(runningBg, totalRunner - activeInlineCount);
+	};
+
+	const getEffectiveBackgroundCap = (runner: SubagentRunner): number =>
+		Math.max(0, getMaxConcurrent() - activeInlineCount);
+
+	const pumpConcurrencyWaiters = (runner: SubagentRunner): void => {
+		while (inlineWaiters.length > 0) {
+			const max = getMaxConcurrent();
+			const inUse = activeInlineCount + getActiveBackgroundCount(runner);
+			if (inUse >= max) break;
+			const next = inlineWaiters.shift();
+			if (next && next.tryAcquire()) {
+				continue;
+			}
+		}
+		const bgCap = getEffectiveBackgroundCap(runner);
+		if (bgCap > 0) {
+			const registry = options?.registry ?? getBackgroundRegistry();
+			releaseBackgroundDispatch(registry, "", bgCap);
+		}
+	};
+
+	const acquireInlineSlot = (runner: SubagentRunner, signal: AbortSignal | undefined): Promise<() => void> => {
+		if (signal?.aborted) {
+			return Promise.reject(new Error("Subagent dispatch aborted while waiting for a concurrency slot."));
+		}
+		let released = false;
+		const release = (): void => {
+			if (released) return;
+			released = true;
+			activeInlineCount = Math.max(0, activeInlineCount - 1);
+			pumpConcurrencyWaiters(runner);
+		};
+		const max = getMaxConcurrent();
+		const inUse = activeInlineCount + getActiveBackgroundCount(runner);
+		if (inUse < max && inlineWaiters.length === 0) {
+			activeInlineCount += 1;
+			return Promise.resolve(release);
+		}
+		return new Promise<() => void>((resolve, reject) => {
+			const onAbort = (): void => {
+				const idx = inlineWaiters.indexOf(entry);
+				if (idx !== -1) inlineWaiters.splice(idx, 1);
+				entry.cleanup();
+				reject(new Error("Subagent dispatch aborted while waiting for a concurrency slot."));
+			};
+			const entry = {
+				tryAcquire: (): boolean => {
+					entry.cleanup();
+					if (signal?.aborted) {
+						reject(new Error("Subagent dispatch aborted while waiting for a concurrency slot."));
+						return false;
+					}
+					activeInlineCount += 1;
+					resolve(release);
+					return true;
+				},
+				cleanup: (): void => {
+					signal?.removeEventListener("abort", onAbort);
+				},
+			};
+			signal?.addEventListener("abort", onAbort, { once: true });
+			inlineWaiters.push(entry);
+		});
+	};
+
+	const runOneBounded = async (
+		runner: SubagentRunner,
+		spec: SubagentSpec,
+		baseCwd: string,
+		parent: ParentContext,
+		parentSessionFile: string | undefined,
+		step: number | undefined,
+		signal: AbortSignal | undefined,
+		onPartial?: (snapshot: SubagentResult) => void,
+		onEvent?: SubagentEventListener,
+	): Promise<SubagentResult> => {
+		const releaseSlot = await acquireInlineSlot(runner, signal);
+		try {
+			return await runOne(runner, spec, baseCwd, parent, parentSessionFile, step, signal, onPartial, onEvent);
+		} finally {
+			releaseSlot();
+		}
+	};
 
 	// ------------------------------------------------------------------------
 	// Control plane: action = status | stop | interrupt | steer | swap-model |
@@ -895,7 +975,11 @@
 			onUpdate: SubagentToolUpdateCallback | undefined;
 			background: boolean;
 		},
-		leaseControl: { handOff: () => void; release: () => void },
+		leaseControl: {
+			lease: SessionLeaseHandle;
+			handOff: () => void;
+			release: () => void;
+		},
 	): Promise<SubagentToolResult> => {
 		const { action, target } = payload;
 		if (target.kind === "inline") {
@@ -932,12 +1016,28 @@
 		const verb = action === "steer" ? "Steered" : action === "resume" ? "Resumed" : "Re-dispatched with a new model";
 		const head = `${verb} ${target.kind} run ${target.id} (role=${target.role}), resuming child session ${target.sessionFile}`;
 
+		// REQ-L02.1: mark the lease as "spawning" before the child exists, and
+		// transition to "running" with pid when the runner emits `spawned` (only
+		// when pid is a valid positive integer; otherwise stay "spawning").
+		safeUpdateLeaseWriter(leaseControl.lease, { state: "spawning" });
+		const leaseRunner: SubagentRunner = {
+			...payload.runner,
+			run: (req, sig, onEv) =>
+				payload.runner.run(req, sig, (ev) => {
+					if (ev.type === "spawned") {
+						if (typeof ev.pid === "number" && Number.isInteger(ev.pid) && ev.pid > 0) {
+							safeUpdateLeaseWriter(leaseControl.lease, { state: "running", pid: ev.pid });
+						}
+					}
+					onEv?.(ev);
+				}),
+		};
+
 		if (payload.background) {
 			const registry = options?.registry ?? getBackgroundRegistry();
 			// Routed through the capped dispatcher: a steering replacement is a new
 			// child process, and starting it beside a full set of running children
 			// is exactly the bypass this issue is about. The replacement parks
 			// behind the cap instead, still holding the lease until it settles.
 			const dispatch = dispatchDetached({
 				registry,
-				runner: payload.runner,
+				runner: leaseRunner,
 				spec,
 				task: spec.instructions,
 				cwd: target.cwd,
 				parent: payload.parent,
 				parentSessionFile: payload.parentSessionFile,
 				settings: () => options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS,
+				liveInlineCount: () => activeInlineCount,
 				// The replacement child outlives this call, so the lease is not
 				// released in the wrapper's finally — it is released when the row
 				// settles, which is the last moment the child can be writing.
@@ -961,8 +1061,8 @@
 			};
 		}
 
-		const result = await runOne(
-			payload.runner,
+		const result = await runOneBounded(
+			leaseRunner,
 			spec,
 			payload.baseCwd,
 			payload.parent,
@@ -1005,6 +1105,7 @@
 		};
 		try {
 			return await dispatchRedirect(payload, {
+				lease,
 				handOff: () => {
 					handedOff = true;
 				},
@@ -1272,10 +1373,7 @@
 			// by that same drain (its row is no longer pending). Cancelling without
 			// this would strand everything behind it until some unrelated settle
 			// happened to fire the pump.
-			releaseBackgroundDispatch(
-				registry,
-				id,
-				(options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS).maxConcurrent,
-			);
+			releaseBackgroundDispatch(registry, id, getEffectiveBackgroundCap(runner));
 			const text =
 				outcome.kind === "cancelled-queued"
 					? `Background task ${id} (role=${row.role}) was queued and had not started: marked cancelled and dropped from the concurrency queue. ${reason} No child process was launched for it.`
@@ -1488,6 +1586,7 @@
 						// change to subagent.maxConcurrent apply to the drain instead of promoting
 						// against a stale cap.
 						settings: () => options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS,
+						liveInlineCount: () => activeInlineCount,
 						onSettled: onSettled ?? options?.onBackgroundSettled,
 						...(taskId === undefined ? {} : { taskId }),
 					}).taskId;
@@ -1626,7 +1725,7 @@
 				});
 				const progress = await runDagInline(run, async (launch) => {
 					const spec = specFromInput({ ...launch.node, instructions: launch.instructions });
-					return runOne(
+					return runOneBounded(
 						runner,
 						spec,
 						cwd,
@@ -1664,7 +1763,7 @@
 							truncateModelFacingOutput(previousOutput),
 						),
 					});
-					const result = await runOne(runner, spec, cwd, parent, parentSessionFile, i + 1, signal, (snapshot) => {
+					const result = await runOneBounded(runner, spec, cwd, parent, parentSessionFile, i + 1, signal, (snapshot) => {
 						onUpdate?.({
 							content: [{ type: "text", text: snapshot.finalOutput || "(running)" }],
 							details: { mode: "chain", results: [...results, snapshot] },
@@ -1720,11 +1819,9 @@
 					});
 				};
 
-				const results = await mapWithConcurrencyLimit(
-					tasks,
-					subagentSettings.maxConcurrent,
+				const results = await Promise.all(
+					tasks.map(
 					async (task, index) => {
-						const result = await runOne(
+						const result = await runOneBounded(
 							runner,
 							specFromInput(task),
 							cwd,
@@ -1742,6 +1839,7 @@
 						emitParallelUpdate();
 						return result;
 					},
+					),
 				);
 
 				const successCount = results.filter((r) => !isFailedSubagentResult(r)).length;
@@ -1768,7 +1866,7 @@
 			// Single
 			// ----------------------------------------------------------------
 			const spec = singleSpec as SubagentSpec;
-			const result = await runOne(runner, spec, cwd, parent, parentSessionFile, undefined, signal, (snapshot) => {
+			const result = await runOneBounded(runner, spec, cwd, parent, parentSessionFile, undefined, signal, (snapshot) => {
 				onUpdate?.({
 					content: [{ type: "text", text: snapshot.finalOutput || "(running)" }],
 					details: { mode: "single", results: [snapshot] },
```

Rationale: Update `normalizeDispatchCap` in `background.ts:1091-1093` to allow `0` when all concurrency slots are occupied by live inline children (REQ-C02.2 trap in `specs/subagent/features/concurrency/spec.md` §2.4.4).

```diff
--- a/packages/coding-agent/src/core/subagent/background.ts
+++ b/packages/coding-agent/src/core/subagent/background.ts
@@ -1088,8 +1088,8 @@
 const dispatchQueues = new WeakMap<BackgroundRegistry, DispatchQueueState>();
 
 function normalizeDispatchCap(maxConcurrent: number | undefined): number {
-	if (maxConcurrent === undefined || !Number.isFinite(maxConcurrent)) return 1;
-	return Math.max(1, Math.floor(maxConcurrent));
+	if (maxConcurrent === undefined || !Number.isFinite(maxConcurrent)) return 1;
+	return Math.max(0, Math.floor(maxConcurrent));
 }
 
 function queueFor(registry: BackgroundRegistry): DispatchQueueState {
```

Rationale: Add unit tests in `packages/coding-agent/test/subagent-resume-lease.test.ts` verifying REQ-L02 (`writerState: "spawning"` on dispatch, `"running"` + `writerPid` on `spawned`, pid-less `spawned` stays `"spawning"`, and post-release `spawned` warns without crashing).

```diff
--- a/packages/coding-agent/test/subagent-resume-lease.test.ts
+++ b/packages/coding-agent/test/subagent-resume-lease.test.ts
@@ -1,3 +1,6 @@
+// Verification tests for REQ-L02 lease writer state wiring:
+// node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/subagent-resume-lease.test.ts
+
+import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { describe, expect, it, vi } from "vitest";
+import { createBackgroundRegistry } from "../src/core/subagent/background.ts";
+import {
+	acquireSessionLease,
+	inspectSessionLease,
+	SessionLeaseConflictError,
+} from "../src/core/subagent/session-lease.ts";
+import { createSubagentToolDefinition } from "../src/core/subagent/subagent-tool.ts";
+import { createEmptyUsage, type SubagentRunner } from "../src/core/subagent/types.ts";
+
+describe("REQ-L02: redirect lease writer state wiring", () => {
+	it("records writerState 'spawning' at dispatch and 'running' + writerPid on spawned event", async () => {
+		const dir = join(tmpdir(), `lease-l02-${Date.now()}-${Math.random().toString(36).slice(2)}`);
+		mkdirSync(dir, { recursive: true });
+		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
+		process.env.PI_CODING_AGENT_DIR = dir;
+		try {
+			const sessionFile = join(dir, "child-session.jsonl");
+			writeFileSync(sessionFile, "{}\n", "utf8");
+			const registry = createBackgroundRegistry({ rootDir: join(dir, "bg") });
+			const taskId = registry.add({
+				role: "worker",
+				task: "initial",
+				cwd: dir,
+			});
+			registry.update(taskId, {
+				status: "completed",
+				sessionFile,
+				finishedAt: new Date().toISOString(),
+			});
+
+			let inspectedDuringSpawn: ReturnType<typeof inspectSessionLease> | undefined;
+			let inspectedDuringRun: ReturnType<typeof inspectSessionLease> | undefined;
+
+			const runner: SubagentRunner = {
+				run: async (_req, _sig, onEvent) => {
+					inspectedDuringSpawn = inspectSessionLease(sessionFile);
+					onEvent?.({ type: "spawned", pid: 42424 });
+					inspectedDuringRun = inspectSessionLease(sessionFile);
+					return {
+						role: "worker",
+						task: "resumed",
+						exitCode: 0,
+						aborted: false,
+						finalOutput: "done",
+						stderr: "",
+						usage: createEmptyUsage(),
+						messages: [],
+					};
+				},
+			};
+
+			const tool = createSubagentToolDefinition(dir, { runner, registry });
+			await tool.execute("call-1", { action: "resume", id: taskId }, undefined, undefined, {} as never);
+
+			expect(inspectedDuringSpawn?.state).toBe("owned");
+			if (inspectedDuringSpawn?.state === "owned") {
+				expect(inspectedDuringSpawn.owner.writerState).toBe("spawning");
+				expect(inspectedDuringSpawn.owner.writerPid).toBeUndefined();
+			}
+			expect(inspectedDuringRun?.state).toBe("owned");
+			if (inspectedDuringRun?.state === "owned") {
+				expect(inspectedDuringRun.owner.writerState).toBe("running");
+				expect(inspectedDuringRun.owner.writerPid).toBe(42424);
+			}
+			expect(inspectSessionLease(sessionFile).state).toBe("free");
+		} finally {
+			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
+			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
+			rmSync(dir, { recursive: true, force: true });
+		}
+	});
+
+	it("keeps writerState 'spawning' when spawned event carries no pid, and warns without throwing if lease was already released", async () => {
+		const dir = join(tmpdir(), `lease-l02-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
+		mkdirSync(dir, { recursive: true });
+		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
+		process.env.PI_CODING_AGENT_DIR = dir;
+		try {
+			const sessionFile = join(dir, "child-session-2.jsonl");
+			writeFileSync(sessionFile, "{}\n", "utf8");
+			const registry = createBackgroundRegistry({ rootDir: join(dir, "bg") });
+			const taskId = registry.add({ role: "worker", task: "initial", cwd: dir });
+			registry.update(taskId, {
+				status: "completed",
+				sessionFile,
+				finishedAt: new Date().toISOString(),
+			});
+
+			let inspectedAfterPidlessSpawn: ReturnType<typeof inspectSessionLease> | undefined;
+			let lateEventCallback: ((ev: { type: "spawned"; pid?: number }) => void) | undefined;
+
+			const runner: SubagentRunner = {
+				run: async (_req, _sig, onEvent) => {
+					onEvent?.({ type: "spawned", pid: undefined });
+					inspectedAfterPidlessSpawn = inspectSessionLease(sessionFile);
+					lateEventCallback = onEvent as typeof lateEventCallback;
+					return {
+						role: "worker",
+						task: "resumed",
+						exitCode: 0,
+						aborted: false,
+						finalOutput: "ok",
+						stderr: "",
+						usage: createEmptyUsage(),
+						messages: [],
+					};
+				},
+			};
+
+			const tool = createSubagentToolDefinition(dir, { runner, registry });
+			await tool.execute("call-2", { action: "resume", id: taskId }, undefined, undefined, {} as never);
+
+			expect(inspectedAfterPidlessSpawn?.state).toBe("owned");
+			if (inspectedAfterPidlessSpawn?.state === "owned") {
+				expect(inspectedAfterPidlessSpawn.owner.writerState).toBe("spawning");
+			}
+
+			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
+			try {
+				expect(() => lateEventCallback?.({ type: "spawned", pid: 99999 })).not.toThrow();
+				expect(warnSpy).toHaveBeenCalled();
+			} finally {
+				warnSpy.mockRestore();
+			}
+		} finally {
+			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
+			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
+			rmSync(dir, { recursive: true, force: true });
+		}
+	});
+});
```

Rationale: Add `packages/coding-agent/test/subagent-shared-concurrency.test.ts` verifying REQ-C02 and REQ-C03 acceptance criteria (shared inline + background cap, queued background promotion when inline child settles, single/chain/parallel counting against the shared semaphore, and concurrent tool calls sharing one session-scoped budget).

```diff
--- /dev/null
+++ b/packages/coding-agent/test/subagent-shared-concurrency.test.ts
@@ -0,0 +1,196 @@
+import { mkdirSync, rmSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { afterEach, beforeEach, describe, expect, it } from "vitest";
+import { DEFAULT_SUBAGENT_SETTINGS, type ResolvedSubagentSettings } from "../src/core/defaults.ts";
+import { createBackgroundRegistry } from "../src/core/subagent/background.ts";
+import { createSubagentToolDefinition } from "../src/core/subagent/subagent-tool.ts";
+import {
+	createEmptyUsage,
+	type SubagentRunningInfo,
+	type SubagentRunner,
+	type SubagentRunRequest,
+} from "../src/core/subagent/types.ts";
+
+interface ControlledChild {
+	request: SubagentRunRequest;
+	resolve: (output?: string) => void;
+}
+
+function createControlledRunner() {
+	const active = new Map<string, SubagentRunningInfo>();
+	const pending: ControlledChild[] = [];
+	let maxObservedConcurrent = 0;
+	let seq = 0;
+
+	const runner: SubagentRunner = {
+		listRunning: () => Array.from(active.values()),
+		run: (request) => {
+			const runId = `run-${++seq}`;
+			active.set(runId, {
+				runId,
+				role: request.spec.role,
+				task: request.task,
+				cwd: request.cwd,
+				startedAt: new Date().toISOString(),
+			});
+			if (active.size > maxObservedConcurrent) {
+				maxObservedConcurrent = active.size;
+			}
+			return new Promise((resolve) => {
+				pending.push({
+					request,
+					resolve: (output = `ok:${request.spec.role}`) => {
+						active.delete(runId);
+						resolve({
+							role: request.spec.role,
+							task: request.task,
+							exitCode: 0,
+							aborted: false,
+							finalOutput: output,
+							stderr: "",
+							usage: createEmptyUsage(),
+							messages: [],
+						});
+					},
+				});
+			});
+		},
+	};
+
+	return {
+		runner,
+		pending,
+		getActiveCount: () => active.size,
+		getMaxObservedConcurrent: () => maxObservedConcurrent,
+	};
+}
+
+const tick = () => new Promise((r) => setTimeout(r, 15));
+
+describe("REQ-C02 & REQ-C03: shared session-scoped subagent concurrency budget", () => {
+	let tempDir: string;
+	let prevAgentDir: string | undefined;
+
+	beforeEach(() => {
+		tempDir = join(tmpdir(), `subagent-shared-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
+		mkdirSync(tempDir, { recursive: true });
+		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
+		process.env.PI_CODING_AGENT_DIR = tempDir;
+	});
+
+	afterEach(() => {
+		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
+		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
+		rmSync(tempDir, { recursive: true, force: true });
+	});
+
+	it("parks background dispatch when 4 inline children are running and promotes when one settles", async () => {
+		const h = createControlledRunner();
+		const registry = createBackgroundRegistry({ rootDir: join(tempDir, "bg") });
+		const settings: ResolvedSubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS, maxConcurrent: 4 };
+		const tool = createSubagentToolDefinition(tempDir, {
+			runner: h.runner,
+			registry,
+			subagentSettings: () => settings,
+		});
+
+		const inlineCall = tool.execute(
+			"c1",
+			{
+				tasks: [
+					{ role: "t1", instructions: "work 1" },
+					{ role: "t2", instructions: "work 2" },
+					{ role: "t3", instructions: "work 3" },
+					{ role: "t4", instructions: "work 4" },
+				],
+			},
+			undefined,
+			undefined,
+			{} as never,
+		);
+
+		await tick();
+		expect(h.getActiveCount()).toBe(4);
+
+		const bgRes = await tool.execute(
+			"c2",
+			{ role: "bg1", instructions: "bg work", background: true },
+			undefined,
+			undefined,
+			{} as never,
+		);
+		const bgId = bgRes.details?.taskIds?.[0] as string;
+		expect(bgId).toBeDefined();
+		expect(h.getActiveCount()).toBe(4);
+		expect(registry.snapshot().tasks.find((t) => t.id === bgId)?.status).toBe("pending");
+
+		// Settle one inline child -> queued background task must promote and spawn
+		h.pending.shift()?.resolve();
+		await tick();
+		expect(h.getActiveCount()).toBe(4);
+		expect(h.pending.some((p) => p.request.spec.role === "bg1")).toBe(true);
+
+		while (h.pending.length > 0) {
+			h.pending.shift()?.resolve();
+			await tick();
+		}
+		await inlineCall;
+		expect(h.getMaxObservedConcurrent()).toBeLessThanOrEqual(4);
+	});
+
+	it("enforces maxConcurrent across concurrent parallel, single, and chain tool invocations in one session", async () => {
+		const h = createControlledRunner();
+		const registry = createBackgroundRegistry({ rootDir: join(tempDir, "bg") });
+		const settings: ResolvedSubagentSettings = { ...DEFAULT_SUBAGENT_SETTINGS, maxConcurrent: 4 };
+		const tool = createSubagentToolDefinition(tempDir, {
+			runner: h.runner,
+			registry,
+			subagentSettings: () => settings,
+		});
+
+		const p1 = tool.execute(
+			"call-p1",
+			{
+				tasks: [
+					{ role: "a1", instructions: "1" },
+					{ role: "a2", instructions: "2" },
+					{ role: "a3", instructions: "3" },
+					{ role: "a4", instructions: "4" },
+				],
+			},
+			undefined,
+			undefined,
+			{} as never,
+		);
+		const p2 = tool.execute(
+			"call-p2",
+			{
+				tasks: [
+					{ role: "b1", instructions: "1" },
+					{ role: "b2", instructions: "2" },
+					{ role: "b3", instructions: "3" },
+					{ role: "b4", instructions: "4" },
+				],
+			},
+			undefined,
+			undefined,
+			{} as never,
+		);
+		const singleCall = tool.execute(
+			"call-s1",
+			{ role: "s1", instructions: "single" },
+			undefined,
+			undefined,
+			{} as never,
+		);
+		const chainCall = tool.execute(
+			"call-ch1",
+			{ chain: [{ role: "c1", instructions: "step 1" }, { role: "c2", instructions: "step 2 {previous}" }] },
+			undefined,
+			undefined,
+			{} as never,
+		);
+
+		await tick();
+		expect(h.getActiveCount()).toBe(4);
+
+		while (h.pending.length > 0) {
+			expect(h.getActiveCount()).toBeLessThanOrEqual(4);
+			h.pending.shift()?.resolve();
+			await tick();
+		}
+
+		await Promise.all([p1, p2, singleCall, chainCall]);
+		expect(h.getMaxObservedConcurrent()).toBe(4);
+	});
+});
```

Verification:
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/subagent-resume-lease.test.ts`
- `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/subagent-shared-concurrency.test.ts`

---
