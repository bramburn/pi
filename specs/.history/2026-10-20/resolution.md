# Resolution Document — qi spec set (Phase D)

> One entry per marker, grouped by document type. Human answers each as ACCEPT / REJECT / DEFER (DEFER moves it to ## Known Gaps with manifest status accepted_with_gaps).

## 1. Requirements

### R1 — APP_TITLE becomes "qi" [specs/00-requirements/features/rebrand-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: APP_TITLE in packages/coding-agent/src/config.ts:513 becomes "qi" rather than "π" — rationale: D1 requires removing all pi/π identity markers in favour of qi]`
**Claim/Question:** `APP_TITLE` in `config.ts` is set to `"qi"` instead of the current `"π"`.
**Evidence:** D1 requires removing all pi/π identity markers in favour of qi (`config.ts:512-513` currently sets `APP_TITLE = piConfigName ? APP_NAME : "π"`).
**Recommendation:** ACCEPT — D1 is a full hard cut with no legacy identity markers, and ADR-0001's compliance checklist already asserts `APP_TITLE = "qi"`.
**Cost if wrong:** LOW — a single runtime display string; no state, API, or migration impact if changed later.
**Blocks:** R-REBRAND-001 (AC3), ADR-0001 compliance checklist.

### R2 — In-tree rename of all 11 workspace packages to @bramburn/qi-* [specs/00-requirements/features/rebrand-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: All 11 workspace package.json manifests and internal workspace imports are renamed in-tree to @bramburn/qi-* rather than rewritten transiently at publish time — rationale: D1 and D2 require cutting all earendil ties and eliminating publish-time shrinkwrap drift noted in AGENTS.md:323]`
**Claim/Question:** Package identity is renamed in-tree (manifests + internal imports) instead of keeping the publish-time `fork-publish-rename.mjs` rewrite.
**Evidence:** D1 and D2 require cutting all earendil ties and eliminating the publish-time shrinkwrap drift noted in AGENTS.md:323; `fork-publish-rename.mjs:21-22` currently rewrites to `@bramburn/pi-*` only at publish.
**Recommendation:** ACCEPT — D2 fixes published identity as `@bramburn/qi-*` and D1 severs earendil; in-tree rename is the only variant that also satisfies R-REBRAND-002's "zero `@bramburn/pi-*` remains" acceptance criterion.
**Cost if wrong:** HIGH — wrong or partial rename breaks publishing of all 11 packages and leaves runtime constants/lockfiles coupled to `@earendil-works`, failing D2 and R-REBRAND-002.
**Blocks:** R-REBRAND-002, ADR-0001, root + all workspace `package.json` manifests.

### R3 — Manifest key piConfig renamed to qiConfig [specs/00-requirements/features/rebrand-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: The package manifest configuration key at packages/coding-agent/package.json:6 and packages/coding-agent/src/config.ts:500 is renamed from piConfig to qiConfig with configDir ".qi" — rationale: removes the legacy piConfig identifier from runtime config]`
**Claim/Question:** The `piConfig` block in the package manifest and its reader in `config.ts` are renamed to `qiConfig` with `configDir: ".qi"`.
**Evidence:** Removes the legacy `piConfig` identifier from runtime config, consistent with D1's hard cut.
**Recommendation:** ACCEPT — ADR-0001's compliance checklist already mandates `"qiConfig": { "configDir": ".qi" }`; the key and its single reader are renamed in lockstep.
**Cost if wrong:** LOW — an internal manifest key; a rename mismatch fails immediately at startup/tests and is trivially fixed.
**Blocks:** R-REBRAND-003 (AC1), ADR-0001 compliance checklist.

### R4 — Does `qi --version` keep the "[bramburn]" suffix? [specs/00-requirements/features/rebrand-requirements.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Should qi --version retain the "[bramburn]" suffix (`qi <version> [bramburn]`) at packages/coding-agent/src/main.ts:832 or print `qi <version>` now that qi is its own brand? — suggested: Retain FORK_NAME = "bramburn" and print `qi <version> [bramburn]` per AGENTS.md §Forking unless the maintainer elects to drop the suffix]`
**Claim/Question:** Should version output remain `qi <version> [bramburn]` or become plain `qi <version>`?
**Evidence:** Suggested: retain `FORK_NAME = "bramburn"` and print `qi <version> [bramburn]` per AGENTS.md §Forking unless the maintainer elects to drop the suffix.
**Recommendation:** ACCEPT the suggested choice (retain `[bramburn]`) — D1 bans pi legacy, not fork branding, and ADR-0001's compliance checklist already asserts `qi --version` prints `qi <version> [bramburn]`; R-REBRAND-006 AC2 ("begins with `qi `") is satisfied either way.
**Cost if wrong:** LOW — cosmetic version-string formatting; a one-line change with no state impact.
**Blocks:** R-REBRAND-006, ADR-0001 compliance checklist.

### R5 — Share event type renamed pi.share → qi.share [specs/00-requirements/features/rebrand-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: Event type at packages/coding-agent/src/core/session-share.ts:29 is renamed from "pi.share" to "qi.share" — rationale: D1 hard cut of pi identifiers]`
**Claim/Question:** The session-share event type becomes `"qi.share"`.
**Evidence:** D1 hard cut of pi identifiers (`session-share.ts:29` currently emits `pi.share`).
**Recommendation:** ACCEPT — D1 covers runtime identity markers, and ADR-0002's compliance checklist already asserts `session-share.ts:29` uses `"qi.share"`; D6 defers replacement share infrastructure so nothing external depends on the old name.
**Cost if wrong:** LOW — internal event type; listeners are in-tree and rename atomically.
**Blocks:** R-REBRAND-008, ADR-0002 compliance checklist.

### R6 — Loader resolution for unported 0.85 extensions: strict D1 or temporary shim? [specs/00-requirements/features/rebrand-requirements.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Should packages/coding-agent/src/core/extensions/loader.ts:57-70,111-135 resolve only @bramburn/qi-* module specifiers (strict D1) or also alias @earendil-works/pi-* for unported 0.85 extensions (D3/D6)? — suggested: Resolve @bramburn/qi-* as primary and record any temporary 0.85 extension loader shim in ADR-0003]`
**Claim/Question:** Does the extension loader resolve only `@bramburn/qi-*`, or also alias `@earendil-works/pi-*` so pinned 0.85 extensions keep loading?
**Evidence:** Suggested: resolve `@bramburn/qi-*` as primary and record any temporary 0.85 extension loader shim in ADR-0003. `loader.ts:57-70,111-135` currently aliases `@earendil-works/*`; there is no `API_VERSION`/`engines` check anywhere.
**Recommendation:** ACCEPT the suggested choice — D1's no-alias rule enumerates bin/env/state surfaces, while D3 (pin-at-install for 0.85) and D6 (porting deferred) only make sense if pinned 0.85 extensions still resolve their `@earendil-works/pi-*` imports; scoping the shim strictly to the loader and recording it in ADR-0003 keeps the carve-out auditable. (BLOCKING)
**Cost if wrong:** HIGH — dropping the shim too early breaks every unported 0.85 extension at import resolution and nullifies D3 pinning; keeping it too broadly re-introduces earendil identity, violating D1 and R-REBRAND-009.
**Blocks:** R-REBRAND-009 (AC2), ADR-0001, ADR-0003.

### R7 — Disposition of upstream sync scripts [specs/00-requirements/features/rebrand-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: scripts/README-sync-upstream.md and scripts/fork-publish-rename.mjs are deleted while scripts/sync-versions.js is retained solely for internal @bramburn/qi-* lockstep version bumping with all @earendil-works references removed — rationale: package.json:37-39 version:patch/minor/major scripts depend on sync-versions.js]`
**Claim/Question:** Two sync docs/scripts are deleted; `sync-versions.js` stays but only for internal `@bramburn/qi-*` lockstep bumping.
**Evidence:** `package.json:37-39` `version:patch/minor/major` scripts depend on `sync-versions.js`.
**Recommendation:** ACCEPT — deleting `fork-publish-rename.mjs` follows directly from D2's in-tree rename (the script exists only to rewrite names at publish), while `sync-versions.js` remains load-bearing for version bumping per the cited `package.json` scripts.
**Cost if wrong:** LOW — script deletions are trivially reverted from git; no runtime state affected.
**Blocks:** R-REBRAND-010 (AC1), ADR-0002 compliance checklist.

### R8 — Explicit user versions override the manifest constraint [specs/00-requirements/features/extensions-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: Explicit user version or range specifications in an install command override the manifest's default constraint while emitting a warning if outside the compatible range — rationale: users testing a forked or patched extension version need an override path in packages/coding-agent/src/core/package-manager.ts:1446-1458]`
**Claim/Question:** `qi install npm:foo@2.0.0` honours the explicit version (with an out-of-range warning) instead of forcing the manifest constraint.
**Evidence:** Users testing a forked or patched extension version need an override path (`parseSource`/`parseNpmSpec` at `package-manager.ts:1446-1458`).
**Recommendation:** ACCEPT — ADR-0003 already lists this under Neutral consequences; D3 governs default (unpinned) resolution and is unaffected by an explicit, warned override.
**Cost if wrong:** LOW — the override path only activates when the user names a version explicitly; default D3 pinning is untouched.
**Blocks:** R-EXT-001 (AC2), BEHAV-EXT-INSTALL-PINNING "explicit incompatible version warns", W-04.

### R9 — Startup/-e resolution never mutates settings.json [specs/00-requirements/features/extensions-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: Startup auto-installation via resolvePackageSources() (packages/coding-agent/src/core/package-manager.ts:1246-1320) and temporary -e runs via resolveExtensionSources() (:965-972) resolve against the compatibility manifest for installation without mutating settings.json — rationale: only explicit installAndPersist() is permitted to write settings files]`
**Claim/Question:** Startup auto-install and `-e` runs resolve against the manifest but never write settings; only `installAndPersist()` persists.
**Evidence:** Only explicit `installAndPersist()` is permitted to write settings files.
**Recommendation:** ACCEPT — D3 mandates persisting exact versions at install time; keeping all other paths read-only prevents silent user-config mutation during startup and keeps installs deterministic session-to-session.
**Cost if wrong:** LOW — if persistence at startup were later desired, it can be added at those call sites without a format change.
**Blocks:** R-EXT-002.

### R10 — Persist `@<gitRef>` for manifest-matched git installs? [specs/00-requirements/features/extensions-requirements.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Whether installing an unpinned git source that matches a manifest gitUrl+gitRef should rewrite the persisted settings.json string to include @<gitRef> — suggested: yes, persist the @<gitRef> suffix in settings.json so update --extensions reconciles to that ref]`
**Claim/Question:** Should the persisted settings entry for a manifest-pinned git install include `@<gitRef>`?
**Evidence:** Suggested: yes — persist the `@<gitRef>` suffix so `update --extensions` reconciles to that ref (`installGit`/`updateGit` at `package-manager.ts:1829-1878` already pin when `source.ref` is supplied).
**Recommendation:** ACCEPT the suggested choice (yes, persist `@<gitRef>`) — D3 requires "persist exact pinned version"; BEHAV-EXT-INSTALL-PINNING and IMPL W-07 already assert the pinned string in settings.
**Cost if wrong:** MEDIUM — without persistence, updates re-resolve upstream HEAD and can silently advance the checkout to an incompatible revision, defeating D3 determinism for git sources.
**Blocks:** R-EXT-006, BEHAV "Installing an unpinned listed repository pins to the manifest default revision", W-07.

### R11 — Listed package with no compatible version: fail hard or warn+latest? [specs/00-requirements/features/extensions-requirements.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Whether a manifest-listed package with zero registry versions matching compatibleRange should fail hard with E_EXT_NO_COMPATIBLE_VERSION or warn and install latest — suggested: fail hard with E_EXT_NO_COMPATIBLE_VERSION unless --force is supplied]`
**Claim/Question:** When a manifest-listed package has no registry version satisfying `compatibleRange`, does install fail hard or degrade to `latest`?
**Evidence:** Suggested: fail hard with `E_EXT_NO_COMPATIBLE_VERSION` unless `--force` is supplied.
**Recommendation:** ACCEPT the suggested choice (fail hard unless `--force`) — D3's "warn + install latest, do not refuse" governs UNKNOWN packages only (R-EXT-004); falling back to `latest` for a LISTED package would install exactly the incompatible release D3 exists to block. This does not contradict D3. (BLOCKING)
**Cost if wrong:** MEDIUM — a hard failure blocks installs that warn+latest would have completed, requiring `--force` or an explicit version.
**Blocks:** R-EXT-007 (AC1), ADR-0003, BEHAV "Listed package with no registry version matching compatible constraint", W-02.

### R12 — REQ-O03 durable completion records already wired [specs/00-requirements/features/subagents-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: `REQ-O03` is already fully wired and tested in `background.ts:1212-1307`, `agent-session.ts:569,590`, and `test/subagent-bg-replay.test.ts` — rationale: `specs/batch/batch-context.md` §3.3 confirms the call sites exist and `test/subagent-bg-replay.test.ts` passes.]`
**Claim/Question:** `REQ-O03` is implemented — call sites exist and the replay test passes — so closure is a verify-and-flip, not a rewrite.
**Evidence:** `specs/batch/batch-context.md` §3.3 confirms the call sites exist and `test/subagent-bg-replay.test.ts` passes.
**Recommendation:** ACCEPT — D5 keeps REQ-O03 in scope; batch-context §3.3 says "re-audit first → likely IMPLEMENTED, flip register row if confirmed", which is exactly what R-SUBAG-004 AC1 mandates.
**Cost if wrong:** LOW — W-01 is explicitly a re-audit; if the evidence is stale, the missing hooks get wired before P1 work proceeds.
**Blocks:** R-SUBAG-004 (AC1), REQ-O03 register row, W-01.

### R13 — Worktree-isolated parallel tasks may run concurrently with mutating tools [specs/00-requirements/features/subagents-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: Parallel tasks that specify `isolation: "worktree"` may run concurrently even when their tool set includes mutating tools because each child mutates a disjoint worktree directory — rationale: `specs/subagent/features/isolation/spec.md` §2.4 and §5 state that worktree isolation is the containment mechanism for concurrent mutating children.]`
**Claim/Question:** `isolation: "worktree"` exempts a parallel batch from `concurrentSafe` serialization.
**Evidence:** `specs/subagent/features/isolation/spec.md` §2.4 and §5 state that worktree isolation is the containment mechanism for concurrent mutating children.
**Recommendation:** ACCEPT — without this, REQ-C01 serialization would make `isolation: "worktree"` (REQ-I01) pointless for parallelism; the isolation spec is in D5's actionable scope and states this explicitly.
**Cost if wrong:** MEDIUM — if worktree containment proves insufficient (e.g., shared `.git`/lock contention), concurrent children could corrupt the base repository.
**Blocks:** R-SUBAG-009 (AC2/AC3), W-07.

### R14 — Print-mode child auto-compaction vs maxTurns [specs/00-requirements/features/subagents-requirements.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Does a print-mode child (`qi -p --mode json`) perform its own auto-compaction during a long multi-turn run (`Q01` in `specs/subagent/traceability.md`), and should child auto-compaction be disabled or documented alongside `subagent.maxTurns: 30`? — suggested: Verify `print-mode.ts` / `agent-session.ts` auto-compaction behaviour for `-p` runs during implementation and document whether child context compacts before the 30-turn cap.]`
**Claim/Question:** Does a `-p` child auto-compact mid-run, and should that be disabled or documented against the 30-turn cap?
**Evidence:** Suggested: verify `print-mode.ts` / `agent-session.ts` behaviour during implementation and document whether child context compacts before the 30-turn cap (Q01 in `specs/subagent/traceability.md`).
**Recommendation:** ACCEPT the suggested choice — this is a verification task (GUIDE §4 Phase D: verification questions do not block approval); documentation alongside `subagent.maxTurns: 30` satisfies REQ-C04's budgets registration either way.
**Cost if wrong:** LOW — verification/documentation only; the 30-turn cap semantics and kill behavior are unchanged either way.
**Blocks:** R-SUBAG-011, W-09, `specs/subagent/components/budgets.md` (REQ-C04).

### R15 — Saved-spec render capped at 20 entries [specs/00-requirements/features/subagents-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: The rendered saved-spec list in the tool description is capped at 20 entries (sorted deterministically by name) with an explicit `...and N more (use action="list-specs")` disclosure when truncated — rationale: bounds system-prompt token growth while satisfying `REQ-D04.3`.]`
**Claim/Question:** The tool description shows at most 20 saved specs, deterministically sorted, with an overflow disclosure.
**Evidence:** Bounds system-prompt token growth while satisfying `REQ-D04.3`.
**Recommendation:** ACCEPT — a bounded, deterministic cap with explicit overflow disclosure satisfies REQ-D04.3 (D5 scope) without unbounded prompt growth; the exact number is a tunable constant.
**Cost if wrong:** LOW — a display constant; adjust after feedback (must be registered in `budgets.md` per REQ-C04).
**Blocks:** R-SUBAG-012 (AC2), W-10, `budgets.md` (REQ-C04).

### R16 — How to evaluate the REQ-D05 prompt change [specs/00-requirements/features/subagents-requirements.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: How should the `REQ-D05` prompt change be A/B evaluated given that no delegation-quality eval harness exists in the repository (`specs/subagent/features/delegation/spec.md` §4.3)? — suggested: Add a deterministic unit test asserting the required guidance clauses in `subagent-tool.ts` and run a smoke eval task set under `packages/evals` (or waive automated LLM A/B gating for this batch).]`
**Claim/Question:** With no delegation-quality eval harness, how is the prompt change validated?
**Evidence:** Suggested: deterministic unit test asserting the required guidance clauses in `subagent-tool.ts` plus a smoke eval task set under `packages/evals`, or waive automated LLM A/B gating for this batch.
**Recommendation:** ACCEPT the suggested choice — a clause-assertion test is falsifiable (GUIDE anti-pattern "unfalsifiable checklist" avoided), the smoke eval gives signal, and batch-context §3.3 notes A/B gating for D05 as something this batch may waive because no harness exists.
**Cost if wrong:** LOW — worst case the wording underperforms and is revised; no state, API, or migration impact.
**Blocks:** R-SUBAG-013 (AC1/AC2), W-11.

### R17 — buildStatusInjection: wire once-per-turn or delete? [specs/00-requirements/features/subagents-requirements.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Should `buildStatusInjection` be wired into the parent system prompt once per turn (Option A in `specs/subagent/features/observability/spec.md` §2.2, contingent on `Q04` verifying no conflict with any "do not poll" prompt instruction) or deleted and de-exported (Option B)? — suggested: Wire Option A into `agent-session.ts` once per parent turn if `SUBAGENT_USAGE` in `system-prompt.ts` has no conflicting polling prohibition; otherwise delete `status-injector.ts` and its re-exports per `REQ-O01.3`.]`
**Claim/Question:** Option A (wire status injection into the parent prompt) or Option B (delete the dead module)?
**Evidence:** Suggested: wire Option A into `agent-session.ts` once per parent turn if `SUBAGENT_USAGE` in `system-prompt.ts` has no conflicting polling prohibition; otherwise delete `status-injector.ts` and its re-exports per `REQ-O01.3` (`buildStatusInjection` at `status-injector.ts:43` has zero call sites, V13).
**Recommendation:** ACCEPT the suggested choice (conditional on the Q04 check) — both branches satisfy REQ-O01's disjunctive AC1; D5 keeps REQ-O01 in scope and the contingency prevents introducing prompt guidance that contradicts an existing "do not poll" instruction.
**Cost if wrong:** MEDIUM — wiring into a conflicting prompt misleads the parent model, while deleting forfeits the observability REQ-O01.1–.2 intended.
**Blocks:** R-SUBAG-014 (AC1), W-12, REQ-O01.

### R18 — Session lease expiry threshold = 30 minutes [specs/00-requirements/features/subagents-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: The session lease time-based expiry threshold is 30 minutes (`1_800_000` ms, six times the default 5-minute `toolTimeoutMs`) when the holder pid is dead and process-start identity is unavailable — rationale: long enough to avoid false takeover of a slow child while bounding recovery time after an uncatchable crash on Windows.]`
**Claim/Question:** Stale-lease expiry is 30 minutes, applied only when the holder pid is dead and process-start identity is unavailable.
**Evidence:** Long enough to avoid false takeover of a slow child while bounding recovery time after an uncatchable crash on Windows (win32 cannot prove process-start identity, `session-lease.ts:284-296`).
**Recommendation:** ACCEPT — implements lifecycle spec §6.2 Option A (D5 scope, REQ-L01) and gives Windows a bounded wedge time without risking takeover of live slow children; must be registered in `budgets.md` per REQ-C04.
**Cost if wrong:** MEDIUM — too short risks breaking a lease held by a live child (split-brain session writes); too long wedges `steer`/`swap-model`/`resume` after a crash.
**Blocks:** R-SUBAG-016 (AC1/AC2), W-14, `budgets.md` (REQ-C04).

### R19 — ctx.compact background skip does not invoke onError [specs/00-requirements/features/compaction-requirements.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: `ctx.compact` resolves skips without invoking `options.onError` when `background: true` is used, while external extension callers also guard `onError` for skip messages — rationale: `agent-session.ts:3240-3243` already treats `undefined` return from `compactInBackground` as a non-error no-op that skips `onComplete` and `onError`]`
**Claim/Question:** With `background: true`, `ctx.compact` resolves on skip without calling `options.onError`; external extensions additionally guard `onError` against skip text.
**Evidence:** `agent-session.ts:3240-3243` already treats an `undefined` return from `compactInBackground` as a non-error no-op that skips `onComplete` and `onError`.
**Recommendation:** ACCEPT — the claim matches code already in the tree and the direction recorded in batch-context §3.4 / ADR-0005 (skips are not errors); it is the mechanism that fixes the hot-swap red-error bug.
**Cost if wrong:** MEDIUM — if skips still reach `onError`, extensions keep rendering them as red error notifications, i.e., the original bug persists.
**Blocks:** R-COMPACTION-010 (AC1), W-05.

## 2. ADRs

### R20 — ADR-0001 in-tree rename + fork-publish-rename deletion [specs/adr/0001-qi-hard-cut-rebrand.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: All 11 workspace package.json files are renamed in-tree to @bramburn/qi-* and scripts/fork-publish-rename.mjs is deleted — rationale: D2 sets published package identity to @bramburn/qi-* and D1 requires a hard cut]`
**Claim/Question:** ADR-0001's Neutral note commits to in-tree renames and deletion of the publish-time rename script.
**Evidence:** D2 sets published package identity to `@bramburn/qi-*` and D1 requires a hard cut.
**Recommendation:** ACCEPT — same decision as R2; D2 + D1 leave no conforming alternative, and ADR-0001's alternatives section already rejects keeping the transient rewrite.
**Cost if wrong:** HIGH — publishing under the wrong identity or retaining transient rewrites re-couples runtime constants and lockfiles to `@earendil-works`, failing D2 for all 11 packages.
**Blocks:** ADR-0001, R-REBRAND-002, workspace `package.json` manifests.

### R21 — ADR-0001 loader alias: drop now or scope a shim via ADR-0003? [specs/adr/0001-qi-hard-cut-rebrand.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Should packages/coding-agent/src/core/extensions/loader.ts:57-70,111-135 retain a module-resolution alias from @earendil-works/pi-* to @bramburn/qi-* for pinned 0.85 extensions until porting (D3/D6), or drop it immediately under D1? — suggested: Drop in config/CLI surfaces immediately and scope any 0.85 extension loader shim strictly to ADR-0003]`
**Claim/Question:** Keep an `@earendil-works/pi-* → @bramburn/qi-*` module-resolution alias for pinned 0.85 extensions, or drop it under D1 immediately?
**Evidence:** Suggested: drop in config/CLI surfaces immediately and scope any 0.85 extension loader shim strictly to ADR-0003 (loader currently aliases bundled `@earendil-works/*` at `loader.ts:57-70,111-135`).
**Recommendation:** ACCEPT the suggested choice — identical decision to R6: D1's hard cut applies fully to config/CLI/state surfaces, while D3/D6 require pinned 0.85 extensions to remain loadable until porting; ADR-0003 is the right home for the one documented shim. (BLOCKING)
**Cost if wrong:** HIGH — same blast radius as R6: either the entire 0.85 extension ecosystem fails at import resolution, or legacy identity leaks past D1.
**Blocks:** ADR-0001, ADR-0003, R-REBRAND-009.

### R22 — ADR-0002 version-check and install-report stubbed to no-op [specs/adr/0002-sever-upstream-endpoints.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: checkLatestVersion() in packages/coding-agent/src/utils/version-check.ts:5 and reportInstall() in packages/coding-agent/src/modes/interactive/interactive-mode.ts:1360 are stubbed to no-op without network I/O — rationale: D4 severs pi.dev endpoints while D6 defers replacement version/telemetry infrastructure]`
**Claim/Question:** Both endpoints' call sites become network-free no-op stubs.
**Evidence:** D4 severs `pi.dev` endpoints while D6 defers replacement version/telemetry infrastructure.
**Recommendation:** ACCEPT — stubbing is the only behavior consistent with D4 (sever now) + D6 (no replacement yet); ADR-0002's checklist already requires zero `fetch` calls from these paths.
**Cost if wrong:** LOW — stubs are trivially replaced when D6 replacement infrastructure lands.
**Blocks:** ADR-0002 compliance checklist, R-REBRAND-007.

### R23 — ADR-0002 /share fallback when QI_SHARE_VIEWER_URL is unset [specs/adr/0002-sever-upstream-endpoints.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: When QI_SHARE_VIEWER_URL is unset, should /share return the raw GitHub Gist URL or abort with a configuration error? — suggested: Return the raw Gist html_url in getShareViewerUrl() when QI_SHARE_VIEWER_URL is unset so /share remains functional without pi.dev]`
**Claim/Question:** Unset `QI_SHARE_VIEWER_URL` → raw Gist URL, or a configuration error?
**Evidence:** Suggested: return the raw Gist `html_url` in `getShareViewerUrl()` when `QI_SHARE_VIEWER_URL` is unset so `/share` remains functional without `pi.dev`.
**Recommendation:** ACCEPT the suggested choice (raw Gist URL) — R-REBRAND-008 is a SHOULD offering exactly "raw gist URL or a configuration diagnostic", and the raw URL keeps `/share` functional under D4/D6 without inventing replacement infrastructure.
**Cost if wrong:** LOW — one fallback branch; a stricter error alternative can be adopted later without API change.
**Blocks:** R-REBRAND-008 (AC2), ADR-0002.

### R24 — ADR-0003 getLatestNpmVersion must query `versions --json` [specs/adr/0003-extension-compat-manifest.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: getLatestNpmVersion() in packages/coding-agent/src/core/package-manager.ts:1491-1511 will query npm view <name> versions --json when resolving a manifest range so maxSatisfying receives the full version list — rationale: npm view <name> version --json returns only the single latest dist-tag string]`
**Claim/Question:** Range resolution queries the full versions array, not the single-version command.
**Evidence:** `npm view <name> version --json` returns only the single latest dist-tag string, so `maxSatisfying` would have nothing to choose from.
**Recommendation:** ACCEPT — technically necessary for manifest-range resolution; IMPL W-03 already specifies `npm view <name> versions --json` and the mocked test plan covers it.
**Cost if wrong:** LOW — a wrong command fails loudly at resolution time and is caught by W-03's mocked tests.
**Blocks:** ADR-0003 compliance checklist, W-03, R-EXT-001.

### R25 — ADR-0003 listed-but-incompatible: fail hard or fall back to latest? [specs/adr/0003-extension-compat-manifest.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Whether a manifest-listed package with no published version matching compatibleRange should fail hard with E_EXT_NO_COMPATIBLE_VERSION or fall back to latest with a warning — suggested: fail hard with E_EXT_NO_COMPATIBLE_VERSION]`
**Claim/Question:** Same decision as R11, recorded inside ADR-0003: hard failure vs warning fallback for listed packages with no matching version.
**Evidence:** Suggested: fail hard with `E_EXT_NO_COMPATIBLE_VERSION`.
**Recommendation:** ACCEPT the suggested choice (fail hard) — mirrors R11; D3's no-refuse rule covers unknown packages only, and a fallback would nullify the manifest's checked-in authority for listed entries. (BLOCKING)
**Cost if wrong:** MEDIUM — installs of listed-but-stale packages fail instead of degrading, requiring `--force` or a manifest curation commit.
**Blocks:** ADR-0003, R-EXT-007 (AC1), BEHAV-EXT-INSTALL-PINNING.

### R26 — ADR-0004 example-extension removal needs no workspace changes [specs/adr/0004-native-subagent-self-sufficiency.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: Removing `packages/coding-agent/examples/extensions/subagent/` does not require changes to root `package.json` workspaces because only `with-deps`, `custom-provider-anthropic`, `custom-provider-gitlab-duo`, `sandbox`, and `gondolin` are listed in `package.json:7-13` — rationale: verified by direct read of root `package.json:5-14`.]`
**Claim/Question:** Deleting the example directory cannot break workspace globs because the example is not workspace-listed.
**Evidence:** Verified by direct read of root `package.json:5-14` — only the five named examples are listed.
**Recommendation:** ACCEPT — evidence is a direct file read (GUIDE §6 brownfield discipline: traceable to code); D5/ADR-0004 mandate the deletion regardless.
**Cost if wrong:** LOW — if it were workspace-listed, `bun run check` fails immediately and the workspaces array needs a one-line edit.
**Blocks:** ADR-0004 compliance checklist, W-15.

### R27 — ADR-0005 prepareCompaction kept as a compatibility wrapper [specs/adr/0005-compaction-skip-not-error.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: `prepareCompaction()` remains backwards-compatible by returning `CompactionPreparation | undefined` while a companion `prepareCompactionOutcome()` returns `{ status: "ready", preparation } | { status: "skip", reason, message }` — rationale: `prepareCompaction` is part of the public SDK surface documented in `packages/coding-agent/docs/compaction.md:208` and tested directly across existing compaction tests]`
**Claim/Question:** The old function signature survives; a new companion returns the typed outcome.
**Evidence:** `prepareCompaction` is public SDK surface documented in `docs/compaction.md:208` and tested directly across existing compaction tests.
**Recommendation:** ACCEPT — the additive companion satisfies ADR-0005's typed-skip decision without breaking documented/tested callers; IMPL W-01 already specifies exactly this shape.
**Cost if wrong:** LOW — additive API surface; even if the "public SDK" claim proved false, the wrapper costs one function.
**Blocks:** ADR-0005, W-01, R-COMPACTION-001.

### R28 — ADR-0005 blocking compact(): typed reject or resolve on skip? [specs/adr/0005-compaction-skip-not-error.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Should blocking `AgentSession.compact()` still reject with a `CompactionSkippedError` for direct RPC/SDK callers expecting a `CompactionResult`, or resolve? — suggested: Have `compactInBackground()` resolve `undefined` on skip (matching its `Promise<CompactionResult | undefined>` signature at `agent-session.ts:2389`) while blocking `compact()` rejects with a typed `CompactionSkippedError` after emitting `compaction_end` with `skipped: true` and `errorMessage: undefined`]`
**Claim/Question:** On skip, does blocking `compact()` reject (typed error) or resolve?
**Evidence:** Suggested: `compactInBackground()` resolves `undefined` (its declared `Promise<CompactionResult | undefined>` signature at `agent-session.ts:2389`); blocking `compact()` rejects with a typed `CompactionSkippedError` after emitting `compaction_end` with `skipped: true` and `errorMessage: undefined`.
**Recommendation:** ACCEPT the suggested choice — it honors existing signatures on both paths, keeps R-COMPACTION-001's "structured skip, not generic exception" intent (typed error + skipped event, not `Error("Already compacted")`), and preserves error-handling expectations of direct SDK/RPC callers. (BLOCKING)
**Cost if wrong:** MEDIUM — an untyped or unannounced change breaks RPC/SDK caller error handling, or leaves the original red-error path reachable through blocking `compact()`.
**Blocks:** ADR-0005, R-COMPACTION-001, R-COMPACTION-010, W-02.

## 3. Contracts

### R29 — Manifest keying scheme (npm name vs git key) [specs/contracts/json-schema/extension-compat-manifest.schema.json]
**Type:** assumption
**Marker:** `[ASSUMPTION: Git-only gallery extensions without an npm package name are keyed in packages by 'git:<host>/<owner>/<repo>' while npm-published extensions are keyed by their canonical npm package name — rationale: packages/coding-agent/src/core/package-manager.ts:1691-1704 uses npm:<name> and git:<host>/<path> as canonical package identities]`
**Claim/Question:** Manifest `packages` keys are canonical npm names for npm-published extensions and `git:<host>/<owner>/<repo>` for git-only ones.
**Evidence:** `package-manager.ts:1691-1704` uses `npm:<name>` and `git:<host>/<path>` as canonical package identities.
**Recommendation:** ACCEPT — the schema's own `propertyNames` pattern already encodes exactly this dual scheme, so the assumption and the contract are in agreement; it is what lets manifest lookups match `parseSource()` output.
**Cost if wrong:** MEDIUM — mismatched keys make manifest lookups miss, silently degrading installs to the unknown-package warn+latest path and defeating D3 pinning.
**Blocks:** CONTRACT-EXT-COMPAT-MANIFEST, R-EXT-005/R-EXT-006, W-01.

### R30 — Deprecated/abandoned extensions: status enum or '<0.0.0'? [specs/contracts/json-schema/extension-compat-manifest.schema.json]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Whether deprecated/abandoned extensions that never worked on 0.85 should be represented with an explicit 'status: incompatible' enum or omitted — suggested: represent via compatibleRange '<0.0.0' with notes explaining the incompatibility so the user gets E_EXT_NO_COMPATIBLE_VERSION plus the note]`
**Claim/Question:** How do manifest entries encode packages that never worked on 0.85 — a new `status: incompatible` field, or omission?
**Evidence:** Suggested: represent via `compatibleRange '<0.0.0'` with `notes` explaining the incompatibility so the user gets `E_EXT_NO_COMPATIBLE_VERSION` plus the note.
**Recommendation:** ACCEPT the suggested choice — `<0.0.0` works within the existing v1 contract (additive-only policy, no schema change), pairs coherently with R11's fail-hard answer, and surfaces the audit note to the user.
**Cost if wrong:** LOW — a representation detail; either encoding conveys incompatibility and can be revised under a v2 version bump if desired.
**Blocks:** CONTRACT-EXT-COMPAT-MANIFEST, R-EXT-007.

### R31 — Manifest keying scheme (companion examples doc) [specs/contracts/json-schema/extension-compat-manifest.examples.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: Git-only gallery extensions without an npm package name are keyed in packages by 'git:<host>/<owner>/<repo>' while npm-published extensions are keyed by their canonical npm package name — rationale: packages/coding-agent/src/core/package-manager.ts:1691-1704 uses npm:<name> and git:<host>/<path> as canonical package identities]`
**Claim/Question:** Same keying claim as R29, restated in the contract's companion examples document.
**Evidence:** `package-manager.ts:1691-1704` uses `npm:<name>` and `git:<host>/<path>` as canonical package identities.
**Recommendation:** ACCEPT — the examples file must stay in lockstep with the schema; its example entry `"git:github.com/user/custom-skill-pack"` already demonstrates the keying.
**Cost if wrong:** MEDIUM — schema/examples drift would misdirect manifest authors and CI validation of the checked-in manifest.
**Blocks:** CONTRACT-EXT-COMPAT-MANIFEST examples, W-01.

### R32 — Deprecated extensions representation (companion examples doc) [specs/contracts/json-schema/extension-compat-manifest.examples.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Whether deprecated/abandoned extensions that never worked on 0.85 should be represented with an explicit 'status: incompatible' enum or omitted — suggested: represent via compatibleRange '<0.0.0' with notes explaining the incompatibility so the user gets E_EXT_NO_COMPATIBLE_VERSION plus the note]`
**Claim/Question:** Same decision as R30, restated in the examples document.
**Evidence:** Suggested: represent via `compatibleRange '<0.0.0'` with `notes` so the user gets `E_EXT_NO_COMPATIBLE_VERSION` plus the note.
**Recommendation:** ACCEPT the suggested choice — must resolve identically to R30 so schema and examples document agree.
**Cost if wrong:** LOW — documentation-only divergence risk, caught by contract review before finalisation.
**Blocks:** CONTRACT-EXT-COMPAT-MANIFEST examples.

## 4. Behavior

### R33 — CLI prints the resolved spec after install [specs/features/extensions/install-pinning.feature]
**Type:** assumption
**Marker:** `# [ASSUMPTION: CLI output after installAndPersist displays the resolved spec (e.g. 'Installed npm:alpha-ext@1.4.2') — rationale: packages/coding-agent/src/package-manager-cli.ts:956 currently logs the raw source string]`
**Claim/Question:** Post-install confirmation shows the resolved, versioned spec rather than the raw input string.
**Evidence:** `package-manager-cli.ts:956` currently logs the raw source string.
**Recommendation:** ACCEPT — the feature's own happy-path scenario asserts "the terminal confirms installation of `npm:alpha-ext@1.4.2`", and IMPL W-05 makes `install()` return the resolved string precisely to enable this output.
**Cost if wrong:** LOW — output-string only; no persistence, API, or migration impact.
**Blocks:** R-EXT-007 happy-path scenario, W-05.

### R34 — Persist `@<gitRef>` for unpinned manifest-listed git URL? [specs/features/extensions/install-pinning.feature]
**Type:** unresolved
**Marker:** `# [UNRESOLVED: Whether installing an unpinned git URL listed in the manifest persists '@<gitRef>' into settings.json — suggested: yes, persist 'https://github.com/example/alpha-ext@v1.4.2']`
**Claim/Question:** Does settings persistence include the manifest's `@<gitRef>` for git installs?
**Evidence:** Suggested: yes — persist `https://github.com/example/alpha-ext@v1.4.2`.
**Recommendation:** ACCEPT the suggested choice (yes) — same decision as R10; the feature scenario already asserts `user settings record "https://github.com/example/alpha-ext@v1.4.2"`, so answering yes aligns the marker with the drafted Gherkin.
**Cost if wrong:** MEDIUM — without persistence, updates re-resolve upstream HEAD and can break D3's determinism for git installs.
**Blocks:** R-EXT-006 scenario, W-07.

## 5. Impl plans

### R35 — install() signature widened to Promise<string> [specs/impl/extensions-phase.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: DefaultPackageManager.install() signature can be widened from Promise<void> to Promise<string> (returning the resolved persisted source string, or keeping Promise<void> while a private helper returns the resolved source to installAndPersist) without breaking external callers — rationale: PackageManager interface in packages/coding-agent/src/core/package-manager.ts:96-110 is internal to @bramburn/qi-coding-agent]`
**Claim/Question:** `install()` may return the resolved source string without breaking external callers.
**Evidence:** The `PackageManager` interface at `package-manager.ts:96-110` is internal to `@bramburn/qi-coding-agent`.
**Recommendation:** ACCEPT — D2 fixes the package as an internal workspace module, IMPL W-05 already requires `install()`/`installAndPersist()` to return the canonical pinned string, and `tsgo --noEmit` catches any missed caller; the marker's `Promise<void>` + private-helper fallback covers the conservative case.
**Cost if wrong:** LOW — internal signature, compile-time checked; the fallback keeps the original signature at zero design cost.
**Blocks:** W-05, R-EXT-002.

### R36 — Initial contents of extension-compat-manifest.json [specs/impl/extensions-phase.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: Exact initial package list for packages/coding-agent/src/core/extension-compat-manifest.json — suggested: seed from the 0.85 snapshot of npm keyword 'pi-package' packages plus workspace examples in W-01]`
**Claim/Question:** Which packages seed the checked-in manifest at W-01?
**Evidence:** Suggested: seed from the 0.85 snapshot of npm keyword `pi-package` packages plus workspace examples in W-01 (current discovery channels: npm keyword + severed `pi.dev/packages` gallery, `docs/packages.md:137`).
**Recommendation:** ACCEPT the suggested choice — the npm keyword snapshot is registry-side and permitted (D4 severs only `pi.dev` endpoints; do not scrape `pi.dev/packages`), and D3 requires a checked-in 0.85 ecosystem snapshot (R-EXT-005).
**Cost if wrong:** MEDIUM — an under-seeded manifest silently degrades the ecosystem to warn+latest, hollowing out D3's pinning value with no visible failure.
**Blocks:** W-01, R-EXT-005.

### R37 — W-01 is verification, not a rewrite [specs/impl/subagents-phase.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: `W-01` (`REQ-O03`) will confirm that `result-record.ts` is already wired in `background.ts:1212-1307` and `agent-session.ts:569,590`, making `W-01` a verification and register-update step rather than a code rewrite — rationale: `specs/batch/batch-context.md` §3.3 verified those line ranges and confirmed `test/subagent-bg-replay.test.ts` passes.]`
**Claim/Question:** W-01 will confirm existing wiring and flip the register row rather than rewrite code.
**Evidence:** `specs/batch/batch-context.md` §3.3 verified those line ranges and confirmed `test/subagent-bg-replay.test.ts` passes.
**Recommendation:** ACCEPT — impl-side restatement of R12; W-01's own wording already covers the negative branch ("or wire any missing hook before proceeding").
**Cost if wrong:** LOW — W-01 is self-correcting: the audit either confirms wiring or adds the missing hooks before downstream work.
**Blocks:** W-01, REQ-O03.

### R38 — W-12: wire status injection or delete the module? [specs/impl/subagents-phase.md]
**Type:** unresolved
**Marker:** `[UNRESOLVED: In `W-12` (`REQ-O01`), should the implementation wire `buildStatusInjection` into the parent prompt once per turn (Option A) or delete `status-injector.ts` and its exports (Option B)? — suggested: Wire Option A if `system-prompt.ts` contains no conflicting "do not poll" instruction (`Q04`); otherwise execute Option B.]`
**Claim/Question:** Same decision as R17, from the impl plan's side: which branch does W-12 execute?
**Evidence:** Suggested: wire Option A if `system-prompt.ts` contains no conflicting "do not poll" instruction (Q04); otherwise execute Option B.
**Recommendation:** ACCEPT the suggested choice — identical conditional to R17; resolve once and apply the same answer to both the requirement and the impl plan so they cannot diverge.
**Cost if wrong:** MEDIUM — the wrong branch either injects conflicting guidance into the parent prompt or deletes still-useful observability code.
**Blocks:** W-12, R-SUBAG-014, REQ-O01.

### R39 — Branch-leaf ID uniquely tracks latch invalidation [specs/impl/compaction-phase.md]
**Type:** assumption
**Marker:** `[ASSUMPTION: The branch-leaf ID returned by `this.sessionManager.getLeafId()` uniquely identifies whether any new entry has been appended or navigated to since a threshold skip — rationale: `SessionManager` assigns a fresh entry ID to every appended message, custom entry, or branch summary and updates the leaf pointer on tree navigation (`packages/coding-agent/src/core/agent-session.ts:2426,3006,3108`)]`
**Claim/Question:** `getLeafId()` changes if and only if a new entry was appended or the active branch navigated — exactly the latch-clear condition.
**Evidence:** `SessionManager` assigns a fresh entry ID to every appended message, custom entry, or branch summary and updates the leaf pointer on tree navigation (`agent-session.ts:2426,3006,3108`).
**Recommendation:** ACCEPT — the evidence matches R-COMPACTION-005's AC2 condition ("new message entry appended or session navigates to a different branch leaf") and is what W-03's `_thresholdCompactionSkipLeafId` latch keys on.
**Cost if wrong:** MEDIUM — an ID that does not change on append leaves the skip latch stuck (compaction never re-fires → context overflow); one that changes spuriously restores the re-fire loop this fix exists to stop.
**Blocks:** R-COMPACTION-005 (AC1/AC2), W-03.

## Summary table

| # | Type | Label | File | Recommendation | Cost |
|---|---|---|---|---|---|
| R1 | assumption | APP_TITLE becomes "qi" | 00-requirements/features/rebrand-requirements.md | ACCEPT | LOW |
| R2 | assumption | In-tree rename of 11 packages to @bramburn/qi-* | 00-requirements/features/rebrand-requirements.md | ACCEPT | HIGH |
| R3 | assumption | piConfig → qiConfig manifest key | 00-requirements/features/rebrand-requirements.md | ACCEPT | LOW |
| R4 | unresolved | `qi --version` [bramburn] suffix | 00-requirements/features/rebrand-requirements.md | ACCEPT (suggested: retain suffix) | LOW |
| R5 | assumption | pi.share → qi.share event type | 00-requirements/features/rebrand-requirements.md | ACCEPT | LOW |
| R6 | unresolved | Loader alias vs strict D1 for 0.85 extensions | 00-requirements/features/rebrand-requirements.md | ACCEPT (suggested: qi primary + ADR-0003 shim) — BLOCKING | HIGH |
| R7 | assumption | Sync scripts delete/retain split | 00-requirements/features/rebrand-requirements.md | ACCEPT | LOW |
| R8 | assumption | Explicit versions override manifest (warn) | 00-requirements/features/extensions-requirements.md | ACCEPT | LOW |
| R9 | assumption | Startup/-e resolution without settings mutation | 00-requirements/features/extensions-requirements.md | ACCEPT | LOW |
| R10 | unresolved | Persist `@<gitRef>` in settings | 00-requirements/features/extensions-requirements.md | ACCEPT (suggested: yes) | MEDIUM |
| R11 | unresolved | Listed-no-match: fail hard vs warn+latest | 00-requirements/features/extensions-requirements.md | ACCEPT (suggested: fail hard) — BLOCKING | MEDIUM |
| R12 | assumption | REQ-O03 already wired and tested | 00-requirements/features/subagents-requirements.md | ACCEPT | LOW |
| R13 | assumption | Worktree isolation permits concurrent mutating tools | 00-requirements/features/subagents-requirements.md | ACCEPT | MEDIUM |
| R14 | unresolved | Child auto-compaction vs maxTurns | 00-requirements/features/subagents-requirements.md | ACCEPT (suggested: verify + document) | LOW |
| R15 | assumption | Saved-spec render cap = 20 | 00-requirements/features/subagents-requirements.md | ACCEPT | LOW |
| R16 | unresolved | REQ-D05 A/B evaluation approach | 00-requirements/features/subagents-requirements.md | ACCEPT (suggested: clause test + smoke eval / waive) | LOW |
| R17 | unresolved | buildStatusInjection wire or delete | 00-requirements/features/subagents-requirements.md | ACCEPT (suggested: conditional Option A/B) | MEDIUM |
| R18 | assumption | Session lease expiry = 30 minutes | 00-requirements/features/subagents-requirements.md | ACCEPT | MEDIUM |
| R19 | assumption | ctx.compact background skip skips onError | 00-requirements/features/compaction-requirements.md | ACCEPT | MEDIUM |
| R20 | assumption | ADR-0001 in-tree rename + script deletion | adr/0001-qi-hard-cut-rebrand.md | ACCEPT | HIGH |
| R21 | unresolved | ADR-0001 loader alias drop vs shim | adr/0001-qi-hard-cut-rebrand.md | ACCEPT (suggested: drop in config/CLI, shim via ADR-0003) — BLOCKING | HIGH |
| R22 | assumption | Version check / install report stubbed no-op | adr/0002-sever-upstream-endpoints.md | ACCEPT | LOW |
| R23 | unresolved | /share fallback: raw Gist vs config error | adr/0002-sever-upstream-endpoints.md | ACCEPT (suggested: raw Gist URL) | LOW |
| R24 | assumption | `npm view versions --json` for range resolution | adr/0003-extension-compat-manifest.md | ACCEPT | LOW |
| R25 | unresolved | Listed-no-match fail hard (ADR side) | adr/0003-extension-compat-manifest.md | ACCEPT (suggested: fail hard) — BLOCKING | MEDIUM |
| R26 | assumption | Example removal needs no workspace change | adr/0004-native-subagent-self-sufficiency.md | ACCEPT | LOW |
| R27 | assumption | prepareCompaction compat wrapper retained | adr/0005-compaction-skip-not-error.md | ACCEPT | LOW |
| R28 | unresolved | Blocking compact(): typed reject vs resolve | adr/0005-compaction-skip-not-error.md | ACCEPT (suggested: split behavior) — BLOCKING | MEDIUM |
| R29 | assumption | Manifest keying: npm name vs git:<host>/<owner>/<repo> | contracts/json-schema/extension-compat-manifest.schema.json | ACCEPT | MEDIUM |
| R30 | unresolved | Deprecated entries: status enum vs '<0.0.0' | contracts/json-schema/extension-compat-manifest.schema.json | ACCEPT (suggested: '<0.0.0' + notes) | LOW |
| R31 | assumption | Manifest keying (examples doc) | contracts/json-schema/extension-compat-manifest.examples.md | ACCEPT | MEDIUM |
| R32 | unresolved | Deprecated entries (examples doc) | contracts/json-schema/extension-compat-manifest.examples.md | ACCEPT (suggested: '<0.0.0' + notes) | LOW |
| R33 | assumption | CLI prints resolved spec after install | features/extensions/install-pinning.feature | ACCEPT | LOW |
| R34 | unresolved | Persist `@<gitRef>` for git URL (feature side) | features/extensions/install-pinning.feature | ACCEPT (suggested: yes) | MEDIUM |
| R35 | assumption | install() widened to Promise<string> | impl/extensions-phase.md | ACCEPT | LOW |
| R36 | unresolved | Initial manifest package list | impl/extensions-phase.md | ACCEPT (suggested: 0.85 npm keyword snapshot) | MEDIUM |
| R37 | assumption | W-01 is verification, not rewrite | impl/subagents-phase.md | ACCEPT | LOW |
| R38 | unresolved | W-12 wire or delete (impl side) | impl/subagents-phase.md | ACCEPT (suggested: conditional Option A/B) | MEDIUM |
| R39 | assumption | Branch-leaf ID uniquely tracks latch invalidation | impl/compaction-phase.md | ACCEPT | MEDIUM |

## Coverage

Grep verification across the 15 source files (`grep -nE '\[(ASSUMPTION|UNRESOLVED):'` for line counts, `grep -o` for marker occurrences), reconciled against this document's entries. **Every marker appears exactly once below (R1–R39, continuous across all five groups).**

| File | grep lines | [ASSUMPTION:] | [UNRESOLVED:] | Markers | Entries |
|---|---|---|---|---|---|
| 00-requirements/features/rebrand-requirements.md | 7 | 5 | 2 | 7 | R1–R7 |
| 00-requirements/features/extensions-requirements.md | 4 | 2 | 2 | 4 | R8–R11 |
| 00-requirements/features/subagents-requirements.md | 7 | 4 | 3 | 7 | R12–R18 |
| 00-requirements/features/compaction-requirements.md | 1 | 1 | 0 | 1 | R19 |
| adr/0001-qi-hard-cut-rebrand.md | 2 | 1 | 1 | 2 | R20–R21 |
| adr/0002-sever-upstream-endpoints.md | 2 | 1 | 1 | 2 | R22–R23 |
| adr/0003-extension-compat-manifest.md | 2 | 1 | 1 | 2 | R24–R25 |
| adr/0004-native-subagent-self-sufficiency.md | 1 | 1 | 0 | 1 | R26 |
| adr/0005-compaction-skip-not-error.md | 2 | 1 | 1 | 2 | R27–R28 |
| contracts/json-schema/extension-compat-manifest.schema.json | 1 | 1 | 1 | 2 | R29–R30 |
| contracts/json-schema/extension-compat-manifest.examples.md | 2 | 1 | 1 | 2 | R31–R32 |
| features/extensions/install-pinning.feature | 2 | 1 | 1 | 2 | R33–R34 |
| impl/extensions-phase.md | 2 | 1 | 1 | 2 | R35–R36 |
| impl/subagents-phase.md | 2 | 1 | 1 | 2 | R37–R38 |
| impl/compaction-phase.md | 1 | 1 | 0 | 1 | R39 |
| **Total** | **38** | **23** | **16** | **39** | **R1–R39** |

**Reconciliation (stated 38 vs counted 39):** the stated "38 total" is the count of grep-*matching lines* — `grep -nE '\[(ASSUMPTION|UNRESOLVED):'` over the 15 files returns exactly **38 lines**. The count of marker *occurrences* (`grep -o`) is **39**, because `contracts/json-schema/extension-compat-manifest.schema.json:6` carries both an `[ASSUMPTION:]` and an `[UNRESOLVED:]` inside its single `$comment` line. Both numbers are reconciled above: 38 lines → 39 markers → 39 entries (R1–R39), each appearing exactly once. Markers duplicated verbatim across companion files (schema.json ↔ examples.md: the R29/R31 and R30/R32 pairs) are retained as separate entries because each is a distinct marker occurrence in a distinct file.

## Tally: 23 assumptions, 16 unresolved, total 39 markers (38 grep-matching lines — schema.json:6 hosts two markers; every marker appears exactly once as R1–R39)
