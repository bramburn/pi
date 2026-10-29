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

### fix-13-subagent-worktree-locking
> Full Report: [fix-13-subagent-worktree-locking.md](./fix-13-subagent-worktree-locking.md) | Tokens: in=99,702 cached_read=0 out=6,207

Rationale: Add `reason: "unresolved" | "contended"`, `repoRoot`, and `lockPath: string | null` to `WorktreeLockError` (`worktree-lock.ts:69-77`, `:112-115`), report spent stale-break budget in `heldMessage` (`:203-206`, `:241-246`), and pass `repoRoot` on both failure paths (REQ-I04.3, REQ-I04.4).

```diff
--- a/packages/coding-agent/src/core/subagent/worktree-lock.ts
+++ b/packages/coding-agent/src/core/subagent/worktree-lock.ts
@@ -66,13 +66,22 @@
  */
 const CORRUPT_LOCK_STALE_MS = 30_000;
 
+export type WorktreeLockErrorReason = "unresolved" | "contended";
+
 /** Thrown when the lock stays held past the wait budget, or the repo cannot be locked. */
 export class WorktreeLockError extends Error {
-	readonly lockPath: string;
-	constructor(message: string, lockPath: string) {
+	readonly lockPath: string | null;
+	readonly reason: WorktreeLockErrorReason;
+	readonly repoRoot: string;
+	constructor(
+		message: string,
+		lockPath: string | null,
+		opts?: { reason?: WorktreeLockErrorReason; repoRoot?: string },
+	) {
 		super(message);
 		this.name = "WorktreeLockError";
 		this.lockPath = lockPath;
+		this.reason = opts?.reason ?? (lockPath === null || lockPath === "" ? "unresolved" : "contended");
+		this.repoRoot = opts?.repoRoot ?? "";
 	}
 }
 
@@ -111,7 +120,8 @@
 		const detail = res.stderr.trim() || res.stdout.trim() || "(no output)";
 		throw new WorktreeLockError(
 			`cannot lock worktree mutations: git rev-parse --git-common-dir failed in ${repoRoot} (exit ${res.exitCode}): ${detail}`,
-			"",
+			null,
+			{ reason: "unresolved", repoRoot },
 		);
 	}
 	return join(resolvePath(repoRoot, out), WORKTREE_LOCK_FILE_NAME);
@@ -200,16 +210,19 @@
 	}
 }
 
-function heldMessage(record: LockRecord | undefined, lockPath: string): string {
+function heldMessage(record: LockRecord | undefined, lockPath: string, brokeStaleLock: boolean): string {
 	const holder = record ? `pid ${record.pid} since ${new Date(record.startedAt).toISOString()}` : "unknown pid";
-	return `another run is mutating worktrees in this repo (${holder}) [${lockPath}]`;
+	const budgetNote = brokeStaleLock ? "; stale-break budget (1) was spent" : "";
+	return `another run is mutating worktrees in this repo (${holder}${budgetNote}) [${lockPath}]`;
 }
 
 /**
  * Acquire the exclusive lock, waiting up to `waitMs`. Returns the
  * per-acquisition token that release() must match.
  */
-async function acquireLock(lockPath: string, waitMs: number): Promise<string> {
+async function acquireLock(lockPath: string, waitMs: number, repoRoot: string): Promise<string> {
 	const deadline = Date.now() + waitMs;
 	let brokeStaleLock = false;
 	let delay = RETRY_BASE_MS;
@@ -230,7 +243,13 @@
 		const snapshot = readSnapshot(lockPath);
 		if (snapshot === undefined) {
 			// Someone just released — retry promptly, but never spin.
-			if (Date.now() >= deadline) throw new WorktreeLockError(heldMessage(undefined, lockPath), lockPath);
+			if (Date.now() >= deadline) {
+				throw new WorktreeLockError(heldMessage(undefined, lockPath, brokeStaleLock), lockPath, {
+					reason: "contended",
+					repoRoot,
+				});
+			}
 			await sleep(delay);
 			delay = Math.min(delay * 2, RETRY_MAX_MS);
 			continue;
@@ -245,7 +264,10 @@
 			continue;
 		}
 		if (Date.now() >= deadline) {
-			throw new WorktreeLockError(heldMessage(record, lockPath), lockPath);
+			throw new WorktreeLockError(heldMessage(record, lockPath, brokeStaleLock), lockPath, {
+				reason: "contended",
+				repoRoot,
+			});
 		}
 		await sleep(delay);
 		delay = Math.min(delay * 2, RETRY_MAX_MS);
@@ -288,7 +310,7 @@
 	opts?: { waitMs?: number },
 ): Promise<T> {
 	const lockPath = await resolveWorktreeLockPath(repoRoot);
-	const token = await acquireLock(lockPath, opts?.waitMs ?? DEFAULT_WORKTREE_LOCK_WAIT_MS);
+	const token = await acquireLock(lockPath, opts?.waitMs ?? DEFAULT_WORKTREE_LOCK_WAIT_MS, repoRoot);
 	try {
 		return await action();
 	} finally {
```

Tests verifying `packages/coding-agent/src/core/subagent/worktree-lock.ts`:
- `test/subagent-worktree-lock.test.ts`: assert `resolveWorktreeLockPath` failure throws `WorktreeLockError` with `reason === "unresolved"`, `lockPath === null`, and `repoRoot` set; assert contended lock after breaking one stale lock throws `WorktreeLockError` with `reason === "contended"`, `lockPath` populated, `repoRoot` set, and message containing `"stale-break budget (1) was spent"`.

Rationale: Add `deleteBranch` parameter (default `true`) to `removeWorktree` / `removeWorktreeLocked` (`worktree.ts:204-228`) so `exp/<slug>` survives when `keep_branch` is true, and export `discardWorktree` to run worktree remove + prune + conditional branch deletion inside a single `withWorktreeLock` acquisition (REQ-I04.1, REQ-I04.5).

```diff
--- a/packages/coding-agent/src/core/subagent/worktree.ts
+++ b/packages/coding-agent/src/core/subagent/worktree.ts
@@ -201,18 +201,29 @@
  * Runs under the repo worktree lock (see `createWorktree`), so it cannot race
  * a concurrent create or prune. Throws `WorktreeLockError` on lock contention
  * timeout.
  */
-export async function removeWorktree(repoRoot: string, worktreePath: string, force: boolean): Promise<GitResult> {
-	return withWorktreeLock(repoRoot, () => removeWorktreeLocked(repoRoot, worktreePath, force));
+export async function removeWorktree(
+	repoRoot: string,
+	worktreePath: string,
+	force: boolean,
+	deleteBranch: boolean = true,
+): Promise<GitResult> {
+	return withWorktreeLock(repoRoot, () => removeWorktreeLocked(repoRoot, worktreePath, force, deleteBranch));
 }
 
-async function removeWorktreeLocked(repoRoot: string, worktreePath: string, force: boolean): Promise<GitResult> {
+export async function removeWorktreeLocked(
+	repoRoot: string,
+	worktreePath: string,
+	force: boolean,
+	deleteBranch: boolean = true,
+): Promise<GitResult> {
 	const args = ["worktree", "remove", worktreePath];
 	if (force) args.push("--force");
 	const res = await git(args, repoRoot);
 	if (res.exitCode !== 0) return res;
+	if (!deleteBranch) return res;
 
 	const branch = `exp/${basename(worktreePath)}`;
 	const branchCheck = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
 	if (branchCheck.exitCode !== 0) return res;
 	const deleted = await git(["branch", "-D", branch], repoRoot);
@@ -225,6 +236,24 @@
 	return res;
 }
 
+/**
+ * Composite discard mutation: remove the worktree, prune stale worktree admin
+ * dirs, and (when `keepBranch` is false) delete `exp/<slug>` — all inside a
+ * single repo-lock acquisition so no concurrent `createWorktree` can interleave
+ * between remove and prune.
+ */
+export async function discardWorktree(
+	repoRoot: string,
+	worktreePath: string,
+	opts: { force: boolean; keepBranch: boolean },
+): Promise<GitResult> {
+	return withWorktreeLock(repoRoot, async () => {
+		const removed = await removeWorktreeLocked(repoRoot, worktreePath, opts.force, !opts.keepBranch);
+		if (removed.exitCode !== 0 || removed.complete === false) return removed;
+		await git(["worktree", "prune"], repoRoot);
+		return removed;
+	});
+}
+
 /**
  * Drop admin data for worktrees whose directories are gone. Runs under the
  * repo worktree lock: an unlocked prune could delete the admin directory of a
```

Tests verifying `packages/coding-agent/src/core/subagent/worktree.ts`:
- `test/subagent-worktree.test.ts`: assert `removeWorktree(repoRoot, path, true, false)` removes the worktree directory while leaving `refs/heads/exp/<slug>` intact; assert `discardWorktree(repoRoot, path, { force: true, keepBranch: true })` acquires the worktree lock once across remove + prune and preserves `exp/<slug>`; assert `discardWorktree` with `keepBranch: false` deletes `exp/<slug>` inside the same lock acquisition.

Rationale: Remove the bare `catch {}` around `removeWorktree` in `finalizeExperimentMerge` (`experiment-tools.ts:297-308`) and run the entire `experiment_merge` check-and-mutate body and `experiment_discard` (including `WHY_IT_FAILED.md` commit + `discardWorktree`) under a single `withWorktreeLock` acquisition so lock contention or worktree removal failure surfaces as a typed error and never marks the row `merged` or `discarded` (`experiment-tools.ts:505-630`, REQ-I04.1, REQ-I04.2, REQ-I04.5).

```diff
--- a/packages/coding-agent/src/core/subagent/experiment-tools.ts
+++ b/packages/coding-agent/src/core/subagent/experiment-tools.ts
@@ -42,10 +42,11 @@
 	cherryPickFromBranch,
 	createWorktree,
 	currentHead,
+	discardWorktree,
 	diffVsParent,
 	isGitRepo,
-	pruneWorktrees,
-	removeWorktree,
+	removeWorktreeLocked,
 	squashSinceParent,
 } from "./worktree.ts";
+import { withWorktreeLock } from "./worktree-lock.ts";
 
 const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
@@ -294,11 +295,12 @@
 ): Promise<void> {
 	const logFile = logPath(cwd, row.id);
 	appendExperimentLogEvent(logFile, { type: "MERGED", strategy, commit: newCommit });
-	try {
-		await removeWorktree(cwd, row.worktreePath, true);
-	} catch {
-		/* removal may fail on Windows; leave it for the user to clean up */
+	const removed = await removeWorktreeLocked(cwd, row.worktreePath, true, true);
+	if (removed.exitCode !== 0 || removed.complete === false) {
+		throw new Error(
+			removed.error ??
+				`git worktree remove failed after ${strategy} (exit ${removed.exitCode}): ${removed.stderr.trim() || removed.stdout.trim()}`,
+		);
 	}
 	updateExperiment(cwd, row.id, {
 		status: "merged",
@@ -512,59 +514,61 @@
 			// Read live per dispatch — see SubagentToolOptions.subagentSettings.
 			const worktreeBase = options?.subagentSettings?.().worktreeBase ?? DEFAULT_SUBAGENT_SETTINGS.worktreeBase;
 
-			// Refuse to merge if the main worktree has uncommitted changes (ignoring
-			// the registry dir and the worktree base, which are expected untracked).
-			const status = await runShellLine(
-				`git status --porcelain -- . :!./.pi-experiments :!./.pi-experiments/ :!./${worktreeBase} :!./${worktreeBase}/`,
-				{ cwd },
-			);
-			// A failed or truncated status check must not pass the clean-tree gate.
-			assertGitOk("git status failed", status);
-			if (status.stdout.trim().length > 0) {
-				throw new Error(
-					`Main worktree has uncommitted changes. Commit or stash them before merging an experiment.\n${status.stdout}`,
+			return withWorktreeLock(cwd, async () => {
+				// Refuse to merge if the main worktree has uncommitted changes (ignoring
+				// the registry dir and the worktree base, which are expected untracked).
+				const status = await runShellLine(
+					`git status --porcelain -- . :!./.pi-experiments :!./.pi-experiments/ :!./${worktreeBase} :!./${worktreeBase}/`,
+					{ cwd },
 				);
-			}
+				// A failed or truncated status check must not pass the clean-tree gate.
+				assertGitOk("git status failed", status);
+				if (status.stdout.trim().length > 0) {
+					throw new Error(
+						`Main worktree has uncommitted changes. Commit or stash them before merging an experiment.\n${status.stdout}`,
+					);
+				}
 
-			if (params.strategy === "cherry-pick") {
-				const head = await runShell("git", ["rev-parse", row.branch], { cwd });
-				assertGitOk(`Could not resolve ${row.branch}`, head);
-				const pick = await cherryPickFromBranch(cwd, row.branch, head.stdout.trim());
-				if (pick.exitCode !== 0 || pick.complete === false) {
-					throw new Error(
-						pick.error ??
-							`Cherry-pick failed (exit ${pick.exitCode}): ${pick.stderr.trim() || pick.stdout.trim()}`,
+				if (params.strategy === "cherry-pick") {
+					const head = await runShell("git", ["rev-parse", row.branch], { cwd });
+					assertGitOk(`Could not resolve ${row.branch}`, head);
+					const pick = await cherryPickFromBranch(cwd, row.branch, head.stdout.trim());
+					if (pick.exitCode !== 0 || pick.complete === false) {
+						throw new Error(
+							pick.error ??
+								`Cherry-pick failed (exit ${pick.exitCode}): ${pick.stderr.trim() || pick.stdout.trim()}`,
+						);
+					}
+					await finalizeExperimentMerge(cwd, row, "cherry-pick", pick.newCommit, onRegistryChanged);
+					return successToolResult(
+						`Cherry-picked ${row.branch} into main as ${pick.newCommit?.slice(0, 7) ?? "(no commit)"}`,
 					);
 				}
-				await finalizeExperimentMerge(cwd, row, "cherry-pick", pick.newCommit, onRegistryChanged);
-				return successToolResult(
-					`Cherry-picked ${row.branch} into main as ${pick.newCommit?.slice(0, 7) ?? "(no commit)"}`,
-				);
-			}
 
-			if (params.strategy === "squash") {
-				if (!params.squash_message) {
-					throw new Error("strategy='squash' requires squash_message.");
-				}
-				const sq = await squashSinceParent(cwd, row.branch, row.parentCommit, params.squash_message);
-				if (sq.exitCode !== 0 || sq.complete === false) {
-					throw new Error(
-						sq.error ?? `Squash failed (exit ${sq.exitCode}): ${sq.stderr.trim() || sq.stdout.trim()}`,
+				if (params.strategy === "squash") {
+					if (!params.squash_message) {
+						throw new Error("strategy='squash' requires squash_message.");
+					}
+					const sq = await squashSinceParent(cwd, row.branch, row.parentCommit, params.squash_message);
+					if (sq.exitCode !== 0 || sq.complete === false) {
+						throw new Error(
+							sq.error ?? `Squash failed (exit ${sq.exitCode}): ${sq.stderr.trim() || sq.stdout.trim()}`,
+						);
+					}
+					if (sq.wasNoOp) {
+						throw new Error("No commits to squash. The experiment worktree has no commits beyond the parent.");
+					}
+					await finalizeExperimentMerge(cwd, row, "squash", sq.newCommit, onRegistryChanged);
+					return successToolResult(
+						`Squashed ${row.branch} into main as ${sq.newCommit?.slice(0, 7) ?? "(no commit)"}`,
 					);
 				}
-				if (sq.wasNoOp) {
-					throw new Error("No commits to squash. The experiment worktree has no commits beyond the parent.");
-				}
-				await finalizeExperimentMerge(cwd, row, "squash", sq.newCommit, onRegistryChanged);
-				return successToolResult(
-					`Squashed ${row.branch} into main as ${sq.newCommit?.slice(0, 7) ?? "(no commit)"}`,
+
+				const merge = await runShell(
+					"git",
+					["merge", "--no-ff", row.branch, "-m", `Merge experiment ${row.id} (${row.approach})`],
+					{ cwd },
 				);
-			}
-
-			const merge = await runShell(
-				"git",
-				["merge", "--no-ff", row.branch, "-m", `Merge experiment ${row.id} (${row.approach})`],
-				{ cwd },
-			);
-			assertGitOk("Merge failed", merge);
-			const head = await runShell("git", ["rev-parse", "HEAD"], { cwd });
-			assertGitOk("Could not resolve HEAD after merge", head);
-			const newCommit = head.stdout.trim();
-			await finalizeExperimentMerge(cwd, row, "merge", newCommit, onRegistryChanged);
-			return successToolResult(`Merged ${row.branch} into main as ${newCommit?.slice(0, 7) ?? "(unknown)"}`);
+				assertGitOk("Merge failed", merge);
+				const head = await runShell("git", ["rev-parse", "HEAD"], { cwd });
+				assertGitOk("Could not resolve HEAD after merge", head);
+				const newCommit = head.stdout.trim();
+				await finalizeExperimentMerge(cwd, row, "merge", newCommit, onRegistryChanged);
+				return successToolResult(`Merged ${row.branch} into main as ${newCommit?.slice(0, 7) ?? "(unknown)"}`);
+			});
 		},
 	};
 
@@ -577,36 +581,35 @@
 			const row = getExperiment(cwd, params.experiment_id);
 			if (!row) throw new Error(`Unknown experiment: ${params.experiment_id}`);
 			const keepBranch = params.keep_branch ?? true;
-			if (keepBranch) {
-				const whyPath = join(row.worktreePath, "WHY_IT_FAILED.md");
-				try {
-					await getBun().write(
-						whyPath,
-						`# Why this experiment failed\n\n` +
-							`**Approach:** ${row.approach}\n` +
-							`**Hypothesis:** ${row.hypothesis}\n` +
-							`**Discarded at:** ${new Date().toISOString()}\n\n` +
-							`## Reason\n\n${params.reason}\n\n` +
-							`## Original result\n\n\`\`\`json\n${JSON.stringify(row.result, null, 2)}\n\`\`\`\n`,
-					);
-					await runShellLine('git add WHY_IT_FAILED.md && git commit -m "experiment: record discard reason"', {
-						cwd: row.worktreePath,
-					});
-				} catch {
-					/* worktree may already be unwriteable; continue with removal */
+			const removed = await withWorktreeLock(cwd, async () => {
+				if (keepBranch) {
+					const whyPath = join(row.worktreePath, "WHY_IT_FAILED.md");
+					try {
+						await getBun().write(
+							whyPath,
+							`# Why this experiment failed\n\n` +
+								`**Approach:** ${row.approach}\n` +
+								`**Hypothesis:** ${row.hypothesis}\n` +
+								`**Discarded at:** ${new Date().toISOString()}\n\n` +
+								`## Reason\n\n${params.reason}\n\n` +
+								`## Original result\n\n\`\`\`json\n${JSON.stringify(row.result, null, 2)}\n\`\`\`\n`,
+						);
+						await runShellLine(
+							'git add WHY_IT_FAILED.md && git commit -m "experiment: record discard reason"',
+							{ cwd: row.worktreePath },
+						);
+					} catch {
+						/* worktree may already be unwriteable; continue with removal */
+					}
 				}
-			}
-			const removed = await removeWorktree(cwd, row.worktreePath, true);
+				const res = await removeWorktreeLocked(cwd, row.worktreePath, true, !keepBranch);
+				if (res.exitCode !== 0 || res.complete === false) return res;
+				await runShell("git", ["worktree", "prune"], { cwd });
+				return res;
+			});
 			if (removed.exitCode !== 0 || removed.complete === false) {
 				throw new Error(
 					`${removed.error ?? `git worktree remove failed (exit ${removed.exitCode}): ${removed.stderr.trim()}`}\n\n` +
 						`On Windows this often means MAX_PATH or a handle lock. Move the build dir aside and retry:\n` +
 						` Move-Item "${row.worktreePath}\\node_modules" "${row.worktreePath}\\__nm_backup" -Force\n` +
 						` git worktree remove --force "${row.worktreePath}"`,
 				);
 			}
-			await pruneWorktrees(cwd);
-			if (!keepBranch) {
-				await runShell("git", ["branch", "-D", row.branch], { cwd });
-			}
 			updateExperiment(cwd, row.id, { status: "discarded" });
```

Tests verifying `packages/coding-agent/src/core/subagent/experiment-tools.ts`:
- `test/subagent-experiment-tools.test.ts` (and `test/subagent-worktree.test.ts`):
  1. **Contention / removal failure never marks merged (REQ-I04.2):** hold `<git-common-dir>/pi-worktree.lock` with a live pid (or fail `git worktree remove`), invoke `experiment_merge` / `experiment_discard`, assert `WorktreeLockError` (with `reason: "contended"` and non-empty `lockPath`) or removal `Error` is thrown and `getExperiment(cwd, id)` retains `merged: false` and its pre-call `status` (never `"merged"` or `"discarded"`).
  2. **`keep_branch` preserves `exp/<slug>` (REQ-I04.5):** run `experiment_start` then `experiment_discard` with `keep_branch: true` (and default omitted), assert `git show-ref --verify refs/heads/exp/<slug>` exits `0` and contains the `WHY_IT_FAILED.md` commit; with `keep_branch: false`, assert the branch is deleted.
  3. **Single repo-lock acquisition across composite mutation (REQ-I04.1):** spy on `openSync` for `pi-worktree.lock` during `experiment_discard` and `experiment_merge`, assert the lock file is acquired and unlinked exactly once for the entire composite check-and-mutate sequence.
  4. **Unresolved lock path diagnostics (REQ-I04.3) and stale-break budget message (REQ-I04.4):** invoke worktree lock in a non-repo cwd and assert `err instanceof WorktreeLockError`, `err.reason === "unresolved"`, `err.lockPath === null`, `err.repoRoot === cwd`; contend against a stale lock replaced by a second stale lock and assert the error message includes `"stale-break budget (1) was spent"`.

---
