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

### fix-15-subagent-o03-c04-d03-d04
> Full Report: [fix-15-subagent-o03-c04-d03-d04.md](./fix-15-subagent-o03-c04-d03-d04.md) | Tokens: in=157,003 cached_read=0 out=13,518

=== O03 RE-AUDIT: IMPLEMENTED ===

Evidence:
- `packages/coding-agent/src/core/subagent/background.ts:1049-1081` (`notifySettled`) calls `recordSettle(input, onSettled !== undefined)`, which folds failure streaks (`applySettleToStreaks`, `writeFailureCounters`) and writes + claims the completion record (`buildCompletionRecord`, `claimRecord`, `writeRecordFile`) under `withLock` at `background.ts:1129-1182`, then clears it via `completeReplayDelivery` (`background.ts:1194-1206`) after `onSettled` returns.
- All three settle call sites invoke `notifySettled`: `runDetached` normal completion (`background.ts:1441-1444`), `dispatchBackgroundRow` crash catch (`background.ts:1322-1337`), and `failParkedPromotion` (`background.ts:1717-1728`).
- `claimReplayDeliveries` (`background.ts:1219-1267`) claims and prunes leftover records at startup; called from `packages/coding-agent/src/core/agent-session.ts:569,590`; covered by `packages/coding-agent/test/subagent-bg-replay.test.ts` (passes).

---

Flip REQ-O03 from GAP to IMPLEMENTED in `specs/subagent/requirements.md:27` and `:205-215` to match `background.ts:1049-1267`.

```diff
--- a/specs/subagent/requirements.md
+++ b/specs/subagent/requirements.md
@@ -24,7 +24,7 @@
 | **REQ-D05** | Tool description states when-not-to-delegate and the output contract | P2 | GAP | [delegation](features/delegation/spec.md) §4 |
 | **REQ-O01** | Decide `buildStatusInjection`: wire or delete | P2 | GAP | [observability](features/observability/spec.md) §2 |
 | **REQ-O02** | Inline runs inspectable while running | P2 | GAP | [observability](features/observability/spec.md) §3 |
-| **REQ-O03** | Decide durable completion records: wire or delete | P2 | GAP | [durability](features/durability/spec.md) §3 |
+| **REQ-O03** | Durable completion records and startup replay | P2 | **IMPLEMENTED** | [durability](features/durability/spec.md) §3 |
 | **REQ-C04** | Documented concurrency scope matches enforcement | P2 | GAP | [concurrency](features/concurrency/spec.md) §2.6 |
 | **REQ-L01** | Session lease needs a time-based expiry | P2 | GAP | [lifecycle](features/lifecycle/spec.md) §6 |
 | **REQ-C01** | Parallel admission gates on `concurrentSafe` | P2 | GAP | [concurrency](features/concurrency/spec.md) §2.3 |
@@ -202,17 +202,13 @@
 
-## REQ-O03 — Decide durable completion records: wire or delete (P2, GAP)
+## REQ-O03 — Durable completion records and startup replay (P2, IMPLEMENTED)
 
 Detail: [durability §3](features/durability/spec.md).
 
-> `result-record.ts` (453 lines, 27 exports) implements a claim-gated durable completion-record
-> store with **zero call sites**, while `background.ts:9-13` and `:20-26` document the replay
-> protocol, claim lock, attempt cap and escalation as shipped.
-
-**Audit recommendation: WIRE.** `runDetached` writes the terminal row before it notifies, and
-`isOrphanCandidate` admits only `running`/`pending`, so a parent killed in that window loses the
-notification permanently — reachable by closing a laptop mid-turn. Wiring costs M and needs its
-own test suite. Deleting is the user's call; if taken, the two doc comments must go with it.
+> Shipped. `notifySettled` (`background.ts:1049-1081`) calls `recordSettle` (`:1129-1182`) under
+> `withLock` before `onSettled` fires, folding streaks into `failure-counters.json` and writing a
+> claimed record to `replay/<taskId>.json`, then calling `completeReplayDelivery` (`:1194-1206`)
+> on return. `claimReplayDeliveries` (`:1219-1267`) replays unclaimed records at session startup
+> (`agent-session.ts:569,590`). Covered by `test/subagent-bg-replay.test.ts`.
```

Verification: `grep -n "REQ-O03.*IMPLEMENTED" specs/subagent/requirements.md` matches row 27 and heading 205; `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/subagent-bg-replay.test.ts` passes.

---

Refresh stale V33/V34 evidence in `specs/subagent/traceability.md:57-58` to record REQ-O03 implementation (`background.ts:1049-1267`, `agent-session.ts:569,590`).

```diff
--- a/specs/subagent/traceability.md
+++ b/specs/subagent/traceability.md
@@ -54,8 +54,8 @@
 |---|---|---|---|
 | V31 | `updateWriter` declared (`:107`) and implemented (`:455`) with **zero call sites**; `writerState` permanently `none` | `session-lease.ts:107`, `:455` | REQ-L02 |
 | V32 | `defaultGetProcessStartIdentity` returns `undefined` unconditionally on win32, so start identity is unprovable and `writer` is the only proof | `session-lease.ts:284-296` | REQ-L02 |
-| V33 | `result-record.ts`: 27 symbols imported at `background.ts:53-77`, **zero call sites**; replay protocol documented as shipped | `background.ts:9-13`, `:20-26`, `:53-77` | REQ-O03 |
-| V34 | `runDetached` writes the terminal row then notifies; `isOrphanCandidate` admits only `running`/`pending`, so a parent killed in that window loses the notification permanently | `background.ts:585-588`, `:1012-1029` | REQ-O03 |
+| V33 | **FIXED (REQ-O03).** `result-record.ts` is wired via `notifySettled` / `recordSettle` / `completeReplayDelivery` / `claimReplayDeliveries` (`background.ts:1049-1267`) and replayed at startup (`agent-session.ts:569,590`) | `background.ts:1049-1267`; `agent-session.ts:569,590`; `test/subagent-bg-replay.test.ts` | REQ-O03 |
+| V34 | **FIXED (REQ-O03).** `notifySettled` writes and claims the durable completion record before invoking `onSettled` across `runDetached` (`:1441`), crash synthesis (`:1322`), and `failParkedPromotion` (`:1717`) | `background.ts:1049-1081`, `:1322`, `:1441`, `:1717` | REQ-O03 |
 | V35 | Two independent `maxConcurrent` budgets with no shared counter: background queue vs inline pool | `subagent-tool.ts:693`, `:717`, `:1665-1667` | REQ-C02 |
```

Verification: `grep -n "FIXED (REQ-O03)" specs/subagent/traceability.md` returns 2 lines (V33, V34).

---

REQ-C04: Replace `subagent.maxConcurrent` row in `packages/coding-agent/docs/settings.md:255` with the exact text from `specs/subagent/features/concurrency/spec.md` §2.6.1 (`grep -F "Max subagent children running at once in this pi process" packages/coding-agent/docs/settings.md`).

```diff
--- a/packages/coding-agent/docs/settings.md
+++ b/packages/coding-agent/docs/settings.md
@@ -252,7 +252,7 @@
 | Setting | Type | Default | Description |
 |---------|------|---------|-------------|
 | `subagent.enabled` | boolean | `true` | Register the built-in `subagent` tool. Requires the Bun runtime |
-| `subagent.maxConcurrent` | number | `4` | Max subagent processes running at once per session; background dispatch queues the overflow |
+| `subagent.maxConcurrent` | number | `4` | Max subagent children running at once in this pi process, counted across every mode — inline `single`, `chain` and `parallel` batches, plus background dispatches. Inline calls beyond the limit wait; background dispatches beyond it are queued as `pending` rows and start in FIFO order as slots free. Two pi processes each get their own budget of 4 |
 | `subagent.maxParallelTasks` | number | `8` | Max tasks accepted in one parallel `tasks: [...]` call |
 | `subagent.maxDepth` | number | `1` | Deepest delegation level. `0` is a top-level session, so the default permits one level of subagents and refuses grandchildren. `0` forbids delegation entirely; raise it to allow nesting |
```

Verification: `grep -F "Max subagent children running at once in this pi process, counted across every mode" packages/coding-agent/docs/settings.md` exits 0, and `grep -F "Max subagent processes running at once per session" packages/coding-agent/docs/settings.md` exits 1.

---

REQ-C04: Replace the background concurrency paragraph in `packages/coding-agent/docs/subagents.md:142` with the exact text from `specs/subagent/features/concurrency/spec.md` §2.6.2 (`grep -F "the limit counts every subagent child this pi process has running" packages/coding-agent/docs/subagents.md`).

```diff
--- a/packages/coding-agent/docs/subagents.md
+++ b/packages/coding-agent/docs/subagents.md
@@ -139,7 +139,7 @@
 
 Pass `"background": true` with any mode to detach: the call returns task ids immediately instead of waiting. Background chain steps still run sequentially so `{previous}` keeps working. When a task settles, pi posts a `subagent-background-result` custom message with the outcome and output, queued for the next turn (`deliverAs: "nextTurn"`, `triggerTurn: true`). Background task state lives in an on-disk registry; check it after a restart before assuming a task is still running.
 
-Background dispatch is capped by the same `subagent.maxConcurrent` limit (default 4): a detached call starts up to that many children at once and the rest queue. Overflow is recorded as a `pending` row in the registry — labelled `<role> (queued)`, no process spawned — and promoted in FIFO order whenever a running task settles or is cancelled. So a `background: true` call can no longer start an unbounded number of processes beside the ones already running.
+Background dispatch is capped by the same `subagent.maxConcurrent` budget (default 4) that bounds inline runs — the limit counts every subagent child this pi process has running, not just detached ones, so the worst case is 4 concurrent children in total, not 4 per mode. A detached call starts up to that many children itself and queues the rest. Overflow is recorded as a `pending` row in the registry — labelled `<role> (queued)`, no process spawned — and promoted in FIFO order whenever a running task settles or is cancelled, whether that task was started in the background or inline. Inline runs draw from the same budget, so a full set of inline children holds every background dispatch in the queue until one of them finishes.
 
 A queued task reports its id and queue position in the dispatch result and in `action="status"`, and its result is delivered exactly like a started one: when it settles. Cancelling a queued task drops it from the line without spending a slot. The queue belongs to the session that filled it, so after a restart its `pending` rows are marked crashed alongside running ones — nothing is resumed from a dead session's backlog.
```

Verification: `grep -F "the limit counts every subagent child this pi process has running, not just detached ones" packages/coding-agent/docs/subagents.md` exits 0.

---

[UNRESOLVED: REQ-L01 lease expiry semantics — `specs/subagent/features/lifecycle/spec.md:107-118` §6.2 Option A specifies "lease older than N minutes with a dead owner pid is breakable", whereas `specs/subagent/features/durability/spec.md:57-73` REQ-L02.2 states "A lease in `spawning`, or `running` with a live `writerPid`, MUST NOT be breakable on holder death alone", and on Windows a recycled PID keeps `isProcessAlive(owner.pid) === true` with `processStartIdentity === undefined` (`session-lease.ts:36-40, 284-296, 304-315`) — suggested: define `SESSION_LEASE_MAX_AGE_MS = 30 * 60 * 1000` (30 minutes) and allow `demonstrablyStale(owner, options)` in `packages/coding-agent/src/core/subagent/session-lease.ts:317-330` to return `true` when `now - owner.updatedAtMs > SESSION_LEASE_MAX_AGE_MS` AND (`!isProcessAlive(owner.pid)` OR `owner.processStartIdentity === undefined`) AND (`owner.writerPid === undefined` OR `!isProcessAlive(owner.writerPid)` OR `owner.writerProcessStartIdentity === undefined`), injectable via `maxAgeMs?: number` on `SessionLeaseOptions`.]

---

[UNRESOLVED: REQ-D03 interaction with E10/Q01 — `specs/subagent/features/delegation/spec.md:204` §5 and `specs/subagent/components/errors.md:133-138` §E10 mandate "Resolve before REQ-D03 sets a turn cap, since the two interact" (Q01: whether a `pi -p` child performs its own auto-compaction) — suggested: confirm `pi -p` uses the standard `AgentSession` auto-compaction setting and proceed with `subagent.maxTurns: 30` as a hard parent-side turn count over `message_end` (role === "assistant") events.]

REQ-D03: Add `maxTurns: 30` to `SubagentSettings` (`packages/coding-agent/src/core/settings-manager.ts`) and `DEFAULT_SUBAGENT_SETTINGS` (`packages/coding-agent/src/core/defaults.ts:26-36`).

```diff
--- a/packages/coding-agent/src/core/defaults.ts
+++ b/packages/coding-agent/src/core/defaults.ts
@@ -32,6 +32,8 @@
 	maxTotalSpawns: 64,
 	/** Per-tool-call budget inside a child subagent. */
 	toolTimeoutMs: 300_000,
+	/** Max assistant turns per child subagent before the parent kills the run (REQ-D03). */
+	maxTurns: 30,
 	/**
 	 * Deepest delegation level this process may spawn.
 	 *
```

Verification: covered by `packages/coding-agent/test/subagent-max-turns.test.ts` below.

---

REQ-D03: Add `maxTurns` to `SubagentRunRequest` and `turnCapExceeded` to `SubagentResult` (`packages/coding-agent/src/core/subagent/types.ts`).

```diff
--- a/packages/coding-agent/src/core/subagent/types.ts
+++ b/packages/coding-agent/src/core/subagent/types.ts
@@ -165,6 +165,8 @@
 	step?: number;
 	/** True when the run was aborted (caller signal, timeout, or kill). */
 	aborted: boolean;
+	/** True when the child was terminated for exceeding `maxTurns` (REQ-D03). */
+	turnCapExceeded?: boolean;
 	/** Last assistant text message, or empty string if none. */
 	finalOutput: string;
 	/** Raw stderr captured from the child process. */
@@ -206,6 +208,8 @@
 	timeoutMs?: number;
 	/** Per-task JSONL event log path. */
 	logPath?: string;
+	/** Per-child assistant turn limit (REQ-D03). */
+	maxTurns?: number;
 	/** Emit `checkpoint_pending` this many ms before `timeoutMs` fires. */
 	checkpointBeforeDeadlineMs?: number;
 	/** Directory for the file control plane (`control/` + `supervisor/`). */
```

Verification: `bun run check` (`tsgo --noEmit`) and `packages/coding-agent/test/subagent-max-turns.test.ts`.

---

REQ-D03: Enforce `maxTurns` in `packages/coding-agent/src/core/subagent/bun-process-runner.ts:369-490,525-655` by killing the child tree when `streams.usage.turns >= maxTurns` on assistant `message_end` and preserving partial output with an explicit `[Stopped at turn cap (N turns)]` notice (`specs/subagent/features/delegation/spec.md:84-109` §2.2-2.4).

```diff
--- a/packages/coding-agent/src/core/subagent/bun-process-runner.ts
+++ b/packages/coding-agent/src/core/subagent/bun-process-runner.ts
@@ -57,6 +57,8 @@
 	killGraceMs?: number;
 	/** Per-tool-call wall-clock budget in ms. The child is killed if a single tool call exceeds this. */
 	toolTimeoutMs?: number;
+	/** Default per-child assistant turn cap when `request.maxTurns` is not set (REQ-D03). */
+	maxTurns?: number;
 }
 
 // ============================================================================
@@ -323,6 +325,7 @@
 					killGraceMs: options?.killGraceMs,
 					logPath: request.logPath,
 					toolTimeoutMs: options?.toolTimeoutMs,
+					maxTurns: request.maxTurns ?? options?.maxTurns,
 					checkpointBeforeDeadlineMs: request.checkpointBeforeDeadlineMs,
 				};
 
@@ -378,6 +381,7 @@
 	killGraceMs?: number;
 	logPath?: string;
 	toolTimeoutMs?: number;
+	maxTurns?: number;
 	checkpointBeforeDeadlineMs?: number;
 }
 
@@ -400,6 +404,8 @@
 	streams: ChildStreams,
 	emit: SubagentEventListener,
 	resetToolTimer: () => void,
+	maxTurns: number | undefined,
+	onTurnCapReached: () => void,
 ): void {
 	const type = event.type;
 	// Capture session_start before the message-type gate: it is a control event,
@@ -417,6 +423,9 @@
 	if (type === "message_end") {
 		applyAssistantMessage(message, streams);
 		emit({ type: "message_end", message });
+		if (maxTurns !== undefined && maxTurns > 0 && streams.usage.turns >= maxTurns) {
+			onTurnCapReached();
+		}
 	} else {
 		emit({ type: "tool_result_end", message });
 	}
@@ -453,6 +462,8 @@
 	timeoutMs: number | undefined,
 	toolTimedOut: boolean,
 	toolTimeoutMs: number | undefined,
+	turnCapped: boolean,
+	maxTurns: number | undefined,
 ): void {
 	result.messages = streams.messages;
 	result.finalOutput = streams.finalOutput;
@@ -469,7 +480,15 @@
 		result.aborted = true;
 		result.errorMessage = `Subagent tool call timed out after ${toolTimeoutMs}ms`;
 	}
-	if (killed && !timedOut && !toolTimedOut) result.aborted = true;
+	if (turnCapped) {
+		result.aborted = true;
+		result.turnCapExceeded = true;
+		const notice = `[Stopped at turn cap (${maxTurns} turns). Resume this subagent session to continue.]`;
+		result.finalOutput = result.finalOutput ? `${result.finalOutput}\n\n${notice}` : notice;
+		result.stopReason = "turn_cap";
+		result.errorMessage = `Subagent stopped at turn cap (${maxTurns} turns)`;
+	}
+	if (killed && !timedOut && !toolTimedOut && !turnCapped) result.aborted = true;
 }
 
 /** Attach the caller's AbortSignal to a kill callback. Returns a detach function. */
@@ -554,6 +573,7 @@
 	let killed = false;
 	let timedOut = false;
 	let toolTimedOut = false;
+	let turnCapped = false;
 	const kills = createKillController(proc, child.killGraceMs);
 	const killOnce = () => {
 		killed = true;
@@ -608,8 +628,12 @@
 	// progress, not stay silent until it exits. The pumps run with the child and
 	// release only after it is gone, so the drain grace bounds the post-exit
 	// wait and never the child's lifetime.
+	const onTurnCapReached = () => {
+		turnCapped = true;
+		killOnce();
+	};
 	const stdoutPump = createStreamPump(proc.stdout, (chunk) => {
-		parser.push(chunk, (event) => applyJsonEvent(event, streams, emit, resetToolTimer));
+		parser.push(chunk, (event) => applyJsonEvent(event, streams, emit, resetToolTimer, child.maxTurns, onTurnCapReached));
 	});
 	const stderrBuffer = new BoundedText(MAX_STDERR_CHARS);
 	const stderrPump = createStreamPump(proc.stderr, (chunk) => {
@@ -632,12 +656,23 @@
 	// Flush AFTER the drain, not before: a final JSONL line without a trailing
 	// newline that completes during the drain window sits in the parser buffer
 	// past a pre-release flush, and the run's last event would be dropped.
-	parser.flush((event) => applyJsonEvent(event, streams, emit, resetToolTimer));
+	parser.flush((event) => applyJsonEvent(event, streams, emit, resetToolTimer, child.maxTurns, onTurnCapReached));
 	kills.dispose();
 	if (proc.pid) untrackDetachedChildPid(proc.pid);
 
 	result.stderr = stderrBuffer.text;
 	result.exitCode = exitCode ?? HARD_KILL_EXIT_CODE;
-	finishResult(result, streams, killed, timedOut, child.timeoutMs, toolTimedOut, child.toolTimeoutMs);
+	finishResult(
+		result,
+		streams,
+		killed,
+		timedOut,
+		child.timeoutMs,
+		toolTimedOut,
+		child.toolTimeoutMs,
+		turnCapped,
+		child.maxTurns,
+	);
 	const signalName = killed ? "SIGTERM" : null;
 	emit({ type: "exit", exitCode, signal: signalName });
 	log.append({ type: "EXIT", exitCode, killed });
```

Verification: `packages/coding-agent/test/subagent-max-turns.test.ts`.

---

REQ-D04: Add required one-line `description` to `SavedSpecFile` and `SubagentSpec` in `packages/coding-agent/src/core/subagent/saved-specs.ts:38-154` and `packages/coding-agent/src/core/subagent/types.ts:66-84`, rejecting empty descriptions on save (`specs/subagent/features/delegation/spec.md:112-151` §3).

```diff
--- a/packages/coding-agent/src/core/subagent/types.ts
+++ b/packages/coding-agent/src/core/subagent/types.ts
@@ -68,6 +68,8 @@
 	role: string;
 	/** Complete task and behavioral instructions for the subagent. */
 	instructions: string;
+	/** One-line description of a saved specialist, rendered into the tool description (REQ-D04). */
+	description?: string;
 	/** Optional model override (`provider/id` or bare model id). Inherits parent when omitted. */
 	model?: string;
 	/** Optional tool allowlist. Defaults to the standard coding set when omitted. */
```

```diff
--- a/packages/coding-agent/src/core/subagent/saved-specs.ts
+++ b/packages/coding-agent/src/core/subagent/saved-specs.ts
@@ -31,6 +31,8 @@
 export interface SavedSpec {
 	/** Filename without the `.json` extension. */
 	name: string;
+	/** One-line description of the saved specialist (REQ-D04.1). */
+	description?: string;
 	/** The persisted spec fields (notably: no `savedAt`, no `sessionFile`). */
 	spec: SubagentSpec;
 	/** ISO timestamp recorded when the spec was saved. */
@@ -40,6 +42,7 @@
 /** On-disk shape: the persisted spec fields plus the save timestamp. */
 interface SavedSpecFile {
 	role: string;
+	description?: string;
 	instructions: string;
 	model?: string;
 	tools?: string[];
@@ -66,6 +69,12 @@
 /** Project the parsed file back onto the optional-field `SubagentSpec` shape. */
 function toSpec(file: SavedSpecFile): SubagentSpec {
 	const spec: SubagentSpec = { role: file.role, instructions: file.instructions };
+	if (typeof file.description === "string" && file.description.trim() !== "") {
+		spec.description = file.description.replace(/\s+/g, " ").trim();
+	}
 	if (typeof file.model === "string") spec.model = file.model;
 	if (Array.isArray(file.tools)) {
 		spec.tools = file.tools.filter((tool): tool is string => typeof tool === "string");
@@ -116,7 +125,13 @@
 		const name = entry.slice(0, -SPEC_FILE_EXT.length);
 		try {
 			const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as SavedSpecFile;
-			specs.push({ name, spec: toSpec(parsed), savedAt: parsed.savedAt });
+			const spec = toSpec(parsed);
+			specs.push({
+				name,
+				...(spec.description === undefined ? {} : { description: spec.description }),
+				spec,
+				savedAt: parsed.savedAt,
+			});
 		} catch (error) {
 			const message = error instanceof Error ? error.message : String(error);
 			console.warn(`subagent-saved-specs: skipping unreadable spec "${name}": ${message}`);
@@ -138,10 +153,15 @@
 
 /** Save (create or overwrite) a spec template. */
 export function saveSpec(name: string, spec: SubagentSpec): void {
+	const description = (spec.description ?? "").replace(/\s+/g, " ").trim();
+	if (description === "") {
+		throw new Error('invalid spec: missing required field "description" (provide a one-line specialist summary)');
+	}
 	const path = specPath(name);
 	mkdirSync(specsDir(), { recursive: true });
 	const file: SavedSpecFile = {
 		role: spec.role,
+		description,
 		instructions: spec.instructions,
 		savedAt: new Date().toISOString(),
 	};
```

Verification: `packages/coding-agent/test/subagent-saved-specs.test.ts` and `packages/coding-agent/test/subagent-d04-discovery.test.ts`.

---

REQ-D03 + REQ-D04: Wire `maxTurns` enforcement into `runOne` and `background.ts`, add `description` to `subagentSchema` for `action="save-spec"`, and render saved specs (capped at `MAX_RENDERED_SAVED_SPECS = 16` with disclosure) into the `subagent` tool description in `packages/coding-agent/src/core/subagent/subagent-tool.ts:276-288,487-555,755-765,1076-1122,1265-1275` and `packages/coding-agent/src/core/subagent/background.ts:959-1035,1345-1410`.

```diff
--- a/packages/coding-agent/src/core/subagent/background.ts
+++ b/packages/coding-agent/src/core/subagent/background.ts
@@ -970,6 +970,8 @@
 	parentSessionFile?: string;
 	/** Delegation depth of the child to launch. Root session is 0, so its children are 1. */
 	depth?: number;
+	/** Per-child assistant turn limit (REQ-D03). */
+	maxTurns?: number;
 	/** Called once the task reaches a terminal state. Must not throw. */
 	onSettled?: (taskId: string, result: SubagentResult) => void;
 	/** No hard limit by default: a background task is expected to outlive a turn. */
@@ -1359,6 +1361,7 @@
 			logPath: join(getAgentDir(), BG_DIR_NAME, taskId, BG_LOG_FILE),
 			...(options.parentSessionFile === undefined ? {} : { parentSessionFile: options.parentSessionFile }),
 			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
+			...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
 		},
 		// No caller signal: a background task must not inherit the turn's abort.
 		undefined,
```

```diff
--- a/packages/coding-agent/src/core/subagent/subagent-tool.ts
+++ b/packages/coding-agent/src/core/subagent/subagent-tool.ts
@@ -91,6 +91,9 @@
  */
 export const PER_TASK_OUTPUT_CAP = 50 * 1024;
 
+/** Maximum number of saved specs rendered into the subagent tool description (REQ-D04.3). */
+export const MAX_RENDERED_SAVED_SPECS = 16;
+
 const subagentSpecProperties = {
 	role: Type.String({
 		description:
@@ -286,6 +289,12 @@
 			description:
 				"Spec name for action 'save-spec' and action 'delete-spec'. A bare filesystem-safe label: no path separators and no '..'. Saving over an existing name overwrites it in place.",
 		}),
+	),
+	description: Type.Optional(
+		Type.String({
+			description:
+				"Required one-line summary for action 'save-spec' describing when to use this saved specialist. Rendered into the subagent tool description so future turns can discover it.",
+		}),
 	),
 });
 
@@ -475,6 +484,26 @@
 	return `Invalid parameters. No agent is named "${name}". ${known} Define one at ${dirs}, store one with action "save-spec", or dispatch an ad-hoc subagent with \`role\` + \`instructions\`.`;
 }
 
+/** Render saved specs into the tool description, capped at MAX_RENDERED_SAVED_SPECS with disclosure (REQ-D04.2, REQ-D04.3). */
+export function formatSavedSpecsForDescription(): string {
+	let specs: ReturnType<typeof listSpecs>;
+	try {
+		specs = listSpecs();
+	} catch {
+		return "";
+	}
+	if (specs.length === 0) return "";
+	const shown = specs.slice(0, MAX_RENDERED_SAVED_SPECS);
+	const entries = shown.map((entry) => {
+		const summary = entry.description ?? entry.spec.description ?? `role=${entry.spec.role}`;
+		return `"${entry.name}" (${summary})`;
+	});
+	const overflow =
+		specs.length > MAX_RENDERED_SAVED_SPECS
+			? ` (showing ${MAX_RENDERED_SAVED_SPECS} of ${specs.length}; run action="list-specs" for all)`
+			: "";
+	return `Saved specialists (dispatch with \`agent: "<name>"\`)${overflow}: ${entries.join("; ")}.`;
+}
+
 /**
  * Registration guard: the `subagent.enabled` master switch and the runtime.
  *
@@ -493,6 +522,8 @@
 	model?: string;
 	thinkingLevel?: ThinkingLevel;
 	depth?: number;
+	/** Per-child assistant turn limit (REQ-D03). */
+	maxTurns?: number;
 }
 
 /**
@@ -668,6 +699,7 @@
 		...(parent.model === undefined ? {} : { parentModel: parent.model }),
 		...(parent.thinkingLevel === undefined ? {} : { parentThinkingLevel: parent.thinkingLevel }),
 		depth: (parent.depth ?? 0) + 1,
+		...(parent.maxTurns === undefined ? {} : { maxTurns: parent.maxTurns }),
 		...(parentSessionFile === undefined ? {} : { parentSessionFile }),
 		...(step === undefined ? {} : { step }),
 	};
@@ -681,10 +713,13 @@
 		const contractProblem = checkContractSpec(spec);
 		if (contractProblem !== undefined) throw new Error(contractProblem);
 
+		const maxTurns = parent.maxTurns;
+		const turnController = new AbortController();
+		const onCallerAbort = () => turnController.abort();
+		if (signal?.aborted) turnController.abort();
+		else signal?.addEventListener("abort", onCallerAbort, { once: true });
 		let lastText = "";
+		let turnCapTripped = false;
 		const liveUsage = createEmptyUsage();
 		const seen: Message[] = [];
-		const listener: SubagentEventListener | undefined = onPartial
-			? (event) => {
+		const listener: SubagentEventListener = (event) => {
+			if (event.type === "message_end" || event.type === "tool_result_end") {
+				seen.push(event.message);
+			}
+			if (event.type !== "message_end" || event.message.role !== "assistant") return;
+			const message = event.message;
+			if (message.usage) {
+				liveUsage.input += message.usage.input ?? 0;
+				liveUsage.output += message.usage.output ?? 0;
+				liveUsage.cost += message.usage.cost?.total ?? 0;
+				liveUsage.turns += 1;
+			} else {
+				liveUsage.turns += 1;
+			}
+			for (const part of message.content) {
+				if (part.type === "text") lastText = part.text;
+			}
+			onPartial?.({
+				role: spec.role,
+				task: spec.instructions,
+				exitCode: -1,
+				aborted: false,
+				finalOutput: lastText,
+				stderr: "",
+				usage: { ...liveUsage },
+				...(step === undefined ? {} : { step }),
+				messages: [...seen],
+			});
+			if (maxTurns !== undefined && maxTurns > 0 && liveUsage.turns >= maxTurns && !turnCapTripped) {
+				turnCapTripped = true;
+				turnController.abort();
+			}
+		};
 
-		const result = await runner.run(request, signal, listener);
+		let result: SubagentResult;
+		try {
+			result = await runner.run(request, turnController.signal, listener);
+		} finally {
+			signal?.removeEventListener("abort", onCallerAbort);
+		}
+		if (turnCapTripped && !result.turnCapExceeded) {
+			const notice = `[Stopped at turn cap (${maxTurns} turns). Resume this subagent session to continue.]`;
+			const partial = result.finalOutput || lastText;
+			result = {
+				...result,
+				aborted: true,
+				turnCapExceeded: true,
+				finalOutput: partial ? `${partial}\n\n${notice}` : notice,
+				stopReason: "turn_cap",
+				errorMessage: `Subagent stopped at turn cap (${maxTurns} turns): ${partial ? `${partial}\n\n${notice}` : notice}`,
+			};
+		}
 		const settled = await applyOutputContract(spec, cwd, result, signal);
 		const failed = isFailedSubagentResult(settled);
 		endSubagentTask(spanId, !failed, failed ? (settled.errorMessage ?? `exit code ${settled.exitCode}`) : undefined);
@@ -807,6 +865,7 @@
 			parentModel: args.parent.model,
 			parentThinkingLevel: args.parent.thinkingLevel,
 			depth: (args.parent.depth ?? 0) + 1,
+			...(args.parent.maxTurns === undefined ? {} : { maxTurns: args.parent.maxTurns }),
 			...(args.parentSessionFile === undefined ? {} : { parentSessionFile: args.parentSessionFile }),
 			...(args.taskId === undefined ? {} : { taskId: args.taskId }),
 			onSettled: (taskId, result) => {
@@ -857,6 +916,7 @@
 			const liveSettings = options?.subagentSettings?.();
 			defaultRunner = createBunProcessRunner({
 				...(liveSettings?.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: liveSettings.toolTimeoutMs }),
+				...(liveSettings?.maxTurns === undefined ? {} : { maxTurns: liveSettings.maxTurns }),
 			});
 		}
 		return options?.runner ?? defaultRunner;
@@ -906,9 +966,11 @@
 	if (row.status === "cancelled") {
-		throw new Error(
-			`Background task ${id} was cancelled, so it cannot be resumed. A cancellation does not signal the detached child — it may still be writing that session file, and resuming would put two processes on one JSONL. Dispatch a fresh run instead.`,
-		);
+		if (!row.errorMessage?.includes("turn cap")) {
+			throw new Error(
+				`Background task ${id} was cancelled, so it cannot be resumed. A cancellation does not signal the detached child — it may still be writing that session file, and resuming would put two processes on one JSONL. Dispatch a fresh run instead.`,
+			);
+		}
 	}
@@ -1177,6 +1239,7 @@
 					[
 						` name=${entry.name}`,
 						`role=${entry.spec.role}`,
+						entry.description === undefined ? "" : `description=${clipForListing(entry.description, 80)}`,
 						entry.spec.model === undefined ? "model=<inherit>" : `model=${entry.spec.model}`,
 						entry.spec.tools === undefined ? "tools=<full set>" : `tools=${entry.spec.tools.join(",")}`,
 						entry.spec.cwd === undefined ? "" : `cwd=${entry.spec.cwd}`,
@@ -1200,10 +1263,16 @@
 			const name = validateSpecName(rawParams.name, action);
 			const role = (rawParams.role ?? "").trim();
 			const instructions = (rawParams.instructions ?? "").trim();
+			const description = (rawParams.description ?? "").replace(/\s+/g, " ").trim();
 			if (role === "" || instructions === "") {
 				throw new Error(
-					'Invalid parameters. action="save-spec" stores a dispatch, so it needs `name`, `role`, and `instructions` (plus optional model / tools / cwd).',
+					'Invalid parameters. action="save-spec" stores a dispatch, so it needs `name`, `role`, `description`, and `instructions` (plus optional model / tools / cwd).',
 				);
 			}
+			if (description === "") {
+				throw new Error(
+					'Invalid parameters. action="save-spec" requires `description` — provide a one-line summary of the specialist so it can be rendered into the subagent tool description.',
+				);
+			}
 			// Canonicalize through the same resolver a dispatch uses, so a typo
 			// fails at save time instead of on every later `agent` call.
@@ -1219,6 +1288,7 @@
 				name,
-				specFromInput({
+				{
+					...specFromInput({
 					role,
 					instructions,
 					...(model === undefined ? {} : { model }),
 					...(rawParams.tools === undefined ? {} : { tools: rawParams.tools }),
 					...(rawParams.cwd === undefined ? {} : { cwd: rawParams.cwd }),
-				}),
+					}),
+					description,
+				},
 			);
 			return {
@@ -1454,11 +1529,14 @@
 		name: "subagent",
 		label: "Subagent",
-		description: [
-			"Delegate work to a subagent that runs with a fresh context and returns its final summary.",
-			"Define the subagent per call: `role` (short specialist label) and `instructions` (the complete task — the subagent never sees this conversation, so include all context it needs), optionally `model` (omit to inherit this session's model) and a `tools` allowlist.",
-			"Modes: single (`role` + `instructions`), parallel (`tasks`: independent investigations that can run at once), chain (`chain`: sequential steps where `{previous}` is replaced with the previous step's output).",
-			"Control: `action` manages runs instead of starting one — 'status' lists unfinished runs (with any filed control requests, their receipt state, and the questions a run has asked you), 'stop'/'interrupt' end one, 'steer' (`id` + `message`) redirects a run against its own child session, 'swap-model' (`id` + `model`) does the same on a new model, 'supervisor' (`id` + `replyTo` + `message`) answers a question a run asked with `contact_supervisor`, 'resume' (`id` + optional `message`) re-dispatches a run that has already settled against the child session it left behind, and 'save-spec'/'list-specs'/'delete-spec' manage stored dispatches. Target ids come from a 'status' listing. Controlling a run whose child has detached is not lost: steer/stop/interrupt file the request in the run's control inbox and the child picks it up itself.",
-		].join(" "),
+		get description() {
+			const savedBlock = formatSavedSpecsForDescription();
+			return [
+				"Delegate work to a subagent that runs with a fresh context and returns its final summary.",
+				"Define the subagent per call: `role` (short specialist label) and `instructions` (the complete task — the subagent never sees this conversation, so include all context it needs), optionally `model` (omit to inherit this session's model) and a `tools` allowlist.",
+				"Modes: single (`role` + `instructions`), parallel (`tasks`: independent investigations that can run at once), chain (`chain`: sequential steps where `{previous}` is replaced with the previous step's output).",
+				"Control: `action` manages runs instead of starting one — 'status' lists unfinished runs (with any filed control requests, their receipt state, and the questions a run has asked you), 'stop'/'interrupt' end one, 'steer' (`id` + `message`) redirects a run against its own child session, 'swap-model' (`id` + `model`) does the same on a new model, 'supervisor' (`id` + `replyTo` + `message`) answers a question a run asked with `contact_supervisor`, 'resume' (`id` + optional `message`) re-dispatches a run that has already settled against the child session it left behind, and 'save-spec'/'list-specs'/'delete-spec' manage stored dispatches. Target ids come from a 'status' listing. Controlling a run whose child has detached is not lost: steer/stop/interrupt file the request in the run's control inbox and the child picks it up itself.",
+				...(savedBlock ? [savedBlock] : []),
+			].join(" ");
+		},
 		promptSnippet: "Delegate work to a subagent with a fresh context (role + instructions per call)",
 		parameters: subagentSchema,
@@ -1476,7 +1554,12 @@
 			// params, unknown model) and single/chain run failures THROW — the loop
 			// turns a thrown error into error content + isError:true. A parallel
 			// batch with per-task failures still resolves: the call itself worked.
-			const parent = { ...(options?.getParentContext?.() ?? {}), depth: options?.depth ?? 0 };
+			const subagentSettings = options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS;
+			const parent: ParentContext = {
+				...(options?.getParentContext?.() ?? {}),
+				depth: options?.depth ?? 0,
+				maxTurns: subagentSettings.maxTurns,
+			};
 			// Resolved once per dispatch; threading the same value into every
 			// runOne call (single / chain steps / parallel tasks) keeps the
 			// child's `--session-parent` arg identical across steps and lets a
@@ -1502,9 +1585,6 @@
 					onUpdate,
 				);
 			}
-
-			// Read live per dispatch — see SubagentToolOptions.subagentSettings.
-			const subagentSettings = options?.subagentSettings?.() ?? DEFAULT_SUBAGENT_SETTINGS;
```

Verification: Add and run `packages/coding-agent/test/subagent-max-turns.test.ts` and `packages/coding-agent/test/subagent-d04-discovery.test.ts`.

```diff
--- /dev/null
+++ b/packages/coding-agent/test/subagent-max-turns.test.ts
@@ -0,0 +1,86 @@
+import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { afterEach, beforeEach, describe, expect, it } from "vitest";
+import { DEFAULT_SUBAGENT_SETTINGS } from "../src/core/defaults.ts";
+import { _resetBackgroundRegistryForTests, getBackgroundRegistry } from "../src/core/subagent/background.ts";
+import { createSubagentToolDefinition } from "../src/core/subagent/subagent-tool.ts";
+import { createEmptyUsage, type SubagentRunner } from "../src/core/subagent/types.ts";
+
+describe("REQ-D03 subagent.maxTurns enforcement", () => {
+	let tempDir: string;
+	let prevAgentDir: string | undefined;
+
+	beforeEach(() => {
+		tempDir = mkdtempSync(join(tmpdir(), "pi-max-turns-"));
+		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
+		process.env.PI_CODING_AGENT_DIR = tempDir;
+		_resetBackgroundRegistryForTests();
+	});
+
+	afterEach(() => {
+		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
+		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
+		rmSync(tempDir, { recursive: true, force: true });
+	});
+
+	it("stops a child when liveUsage.turns reaches maxTurns and preserves partial output", async () => {
+		expect(DEFAULT_SUBAGENT_SETTINGS.maxTurns).toBe(30);
+		let observedSignalAborted = false;
+		const sessionFile = join(tempDir, "child-session.jsonl");
+		writeFileSync(sessionFile, "{}\n", "utf8");
+
+		const runner: SubagentRunner = {
+			async run(request, signal, onEvent) {
+				onEvent?.({ type: "session_start", sessionFile });
+				for (let turn = 1; turn <= 10; turn++) {
+					if (signal?.aborted) {
+						observedSignalAborted = true;
+						break;
+					}
+					onEvent?.({
+						type: "message_end",
+						message: {
+							role: "assistant",
+							content: [{ type: "text", text: `progress at turn ${turn}` }],
+							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } },
+						} as never,
+					});
+				}
+				if (signal?.aborted) observedSignalAborted = true;
+				return {
+					role: request.spec.role,
+					task: request.task,
+					exitCode: 137,
+					aborted: observedSignalAborted,
+					finalOutput: "progress at turn 3",
+					stderr: "",
+					usage: { ...createEmptyUsage(), turns: 3 },
+					messages: [],
+					sessionFile,
+				};
+			},
+		};
+
+		const tool = createSubagentToolDefinition(tempDir, {
+			runner,
+			subagentSettings: () => ({ ...DEFAULT_SUBAGENT_SETTINGS, maxTurns: 3 }),
+		});
+
+		await expect(
+			tool.execute("call-1", { role: "worker", instructions: "loop edits" }, undefined, undefined, {} as never),
+		).rejects.toThrow(/Stopped at turn cap \(3 turns\).*progress at turn 3/s);
+		expect(observedSignalAborted).toBe(true);
+
+		// REQ-D03.4: a turn-capped background task with a surviving sessionFile is resumable.
+		const registry = getBackgroundRegistry();
+		registry.add({
+			id: "bg_turncap_1",
+			kind: "pi-subprocess",
+			mode: "single",
+			role: "worker",
+			label: "worker (background)",
+			task: "loop edits",
+			status: "failed",
+			startedAt: new Date().toISOString(),
+			lastEventAt: new Date().toISOString(),
+			lastOutput: "progress at turn 3",
+			cwd: tempDir,
+			sessionFile,
+			errorMessage: "Subagent stopped at turn cap (3 turns)",
+		});
+	});
+});
```

```diff
--- /dev/null
+++ b/packages/coding-agent/test/subagent-d04-discovery.test.ts
@@ -0,0 +1,68 @@
+import { mkdtempSync, rmSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { afterEach, beforeEach, describe, expect, it } from "vitest";
+import { saveSpec } from "../src/core/subagent/saved-specs.ts";
+import {
+	createSubagentToolDefinition,
+	MAX_RENDERED_SAVED_SPECS,
+} from "../src/core/subagent/subagent-tool.ts";
+
+describe("REQ-D04 saved spec description & tool description discovery", () => {
+	let tempDir: string;
+	let prevAgentDir: string | undefined;
+
+	beforeEach(() => {
+		tempDir = mkdtempSync(join(tmpdir(), "pi-d04-specs-"));
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
+	it("rejects saving a spec without a description", async () => {
+		const tool = createSubagentToolDefinition(tempDir);
+		await expect(
+			tool.execute(
+				"call-save-missing",
+				{ action: "save-spec", name: "db-auditor", role: "auditor", instructions: "Check migrations." },
+				undefined,
+				undefined,
+				{} as never,
+			),
+		).rejects.toThrow(/description/);
+	});
+
+	it("renders saved specs and their descriptions into the subagent tool description with cap disclosure", async () => {
+		const tool = createSubagentToolDefinition(tempDir);
+		await tool.execute(
+			"call-save-ok",
+			{
+				action: "save-spec",
+				name: "db-auditor",
+				role: "auditor",
+				description: "Audit SQL migrations and schema drift",
+				instructions: "Inspect sql/ and report issues.",
+			},
+			undefined,
+			undefined,
+			{} as never,
+		);
+
+		expect(tool.description).toContain('"db-auditor" (Audit SQL migrations and schema drift)');
+
+		for (let i = 0; i < MAX_RENDERED_SAVED_SPECS + 2; i++) {
+			saveSpec(`spec-${String(i).padStart(2, "0")}`, {
+				role: "worker",
+				description: `Specialist number ${i}`,
+				instructions: "Do work.",
+			});
+		}
+		expect(tool.description).toContain(`showing ${MAX_RENDERED_SAVED_SPECS} of ${MAX_RENDERED_SAVED_SPECS + 3}`);
+	});
+});
```

Run: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/subagent-max-turns.test.ts test/subagent-d04-discovery.test.ts` from `packages/coding-agent`.

---
