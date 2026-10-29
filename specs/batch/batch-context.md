# qi batch context — decisions, evidence, output conventions

Shared input for the qi spec/review batch (mimo-v2.6-pro). Read fully before starting.

## 1. Human decisions (binding — do not re-litigate)

| # | Decision | Value |
|---|---|---|
| D1 | Rebrand depth | **Full hard cut.** No legacy aliases. Bin becomes `qi`; env vars `QI_*` (all current `PI_*` capabilities); user state `~/.qi/`, project `.qi/`; `pi`/`PI_*`/`.pi` break immediately. No auto-migration; document manual migration. |
| D2 | Published package identity | **`@bramburn/qi-*`** (replaces `@earendil-works/pi-*`, 11 packages). Root workspace name → `qi-monorepo`. |
| D3 | Extension pinning | **Checked-in compatibility manifest**, resolved at install time; persist exact pinned version. Unknown extensions → warn + install `latest` (do not refuse). |
| D4 | Upstream couplings | Sever all earendil-controlled endpoints: `pi.dev/api/latest-version`, `pi.dev/api/report-install`, `pi.dev/api/installer/releases`, `pi.dev/install.sh`, `pi.dev/changelog`, `pi.dev/session`, `pi.dev/packages` gallery. Removals/replacements deferred to a later porting phase where noted. |
| D5 | Subagent scope | ALL actionable open items in `specs/subagent/requirements.md` are in scope: P1 DEFECTs REQ-L02/C02/C03/I04, P1 GAPs REQ-I01/I02/P02, all P2 rows. REQ-IP01 (P3 CANDIDATE) excluded — not scheduled. |
| D6 | Deferred (out of scope now) | Porting/API compatibility work, replacement endpoints (own changelog/version/share infra), telemetry replacement decisions. |
| D7 | State migrations WAIVED (2026-10-21, human) | **No `.pi` -> `.qi` or `~/.pi` -> `~/.qi` migration.** The 21 tracked `.pi/**` project files stay where they are (historical project config; runtime reads `.qi/` and simply ignores them). `~/.pi/agent` remains the live store for the running pi session; `~/.qi` is not seeded from it. The manual-migration guide in `rebrand-sweep-checklist.md` section 3 is reference-only, not planned work. |

## 2. Environment facts

- Repo: fork of `github.com/earendil-works/pi` (remote `origin`), fork remote `github.com/bramburn/pi`. Version `0.85.0-b1`.
- The tree has UNRELATED uncommitted changes (summariser env → settings-driven `compactionModel`). They are intentional and NOT part of any batch finding. Do not flag them as defects; do not propose reverting them.
- The compaction hot-swap errors in the user's screenshot originate in an extension OUTSIDE the repo: `c:/dev/ai-compact-hot-swap/index.ts` (964 lines) — its source is inlined in the fix-compaction task prompt.

## 3. Evidence tables (verified 2026-10-20 by direct read; trust path+symbol over stale line numbers)

### 3.1 rebrand
- `packages/coding-agent/package.json:11` — bin `pi` → `dist/bundle/cli.js`; `:2` name; `:6` `piConfig` block.
- `packages/coding-agent/src/config.ts:509-518` — `APP_NAME = pkg.piConfig?.name || "pi"`, `APP_TITLE = "π"`, `CONFIG_DIR_NAME = ".pi"`, `FORK_NAME = "bramburn"`; `:520` `ENV_AGENT_DIR = ${APP_NAME}_CODING_AGENT_DIR`; `:540` `getAgentDir()` → `~/.pi/agent/`; `:589` analytics dir.
- `~/.pi/agent/` holds settings.json, auth.json, models.json, sessions/, themes/, tools/, bin/, extensions/, subagent-specs/. Project `.pi/` holds settings + trust; `.pi/agents/*.md`, `.pi/skills/`.
- Env vars: 18 documented in `packages/coding-agent/docs/environment-variables.md` (`PI_MODEL, PI_PROVIDER, PI_CODING_AGENT_DIR, PI_SESSION_FILE, PI_SESSION_ID, PI_REASONING_LEVEL, PI_TELEMETRY, PI_OFFLINE, PI_SKIP_VERSION_CHECK, PI_CACHE_RETENTION, PI_HARDWARE_CURSOR, PI_HYPERLINKS, PI_IMAGE_PROTOCOL, PI_PACKAGE_DIR, PI_SHARE_VIEWER_URL, PI_TRUE_COLOR, PI_TUI_ESC_TIMEOUT, ...`); more hardcoded (`PI_AI_DEBUG, PI_SUBAGENT_*, PI_BUNDLED_NODE, PI_CLEAR_ON_SHRINK, PI_INSTALLER_API_BASE, PI_STARTUP_BENCHMARK, PI_TIMING, PI_ENVIRONMENT`). ~40 distinct. Note env var names do NOT follow `APP_NAME` — they are literal.
- Counts: ~4604 `earendil` / ~2953 word-boundary `pi` occurrences (incl. package.json + .github).
- Key rename files: `packages/coding-agent/package.json`, `src/config.ts`, `src/cli/args.ts` (help text, usage), `src/main.ts:832` (`pi ${VERSION} [bramburn]`), `src/cli/startup-ui.ts:33-34` (`OFFICIAL_PACKAGE_NAME`, `OFFICIAL_APP_NAME`), `src/core/settings-manager.ts`, `src/core/session-manager.ts:501`, `src/modes/interactive/interactive-mode.ts:1360` (report-install), `scripts/fork-publish-rename.mjs` (+ test), `.github/workflows/publish.yml`, `website/docusaurus.config.ts:93`, `website/src/pages/index.tsx:116` (`npm install -g @bramburn/pi-codes`).
- Share event type `pi.share` at `src/core/session-share.ts:29`; share viewer `pi.dev/session/` at `config.ts:528`; changelog `pi.dev/changelog` at `interactive-mode.ts:4643`; version check `src/utils/version-check.ts:5`; installer releases `src/package-manager-cli.ts:50`.
- Upstream sync tooling: `scripts/sync-versions.js`, `scripts/README-sync-upstream.md`; fork-tracking policy `README.md:12-16`.

### 3.2 extensions
- Install: `pi install <source>` usage `src/cli/args.ts:295-300`; dispatch `src/main.ts:802` → `src/package-manager-cli.ts:864` (parse `:377-412`, exec `:954`) → `src/core/package-manager.ts` `install()` `:1005`, `installAndPersist()` `:1029` (persists raw source string into settings `packages[]`).
- npm install: `installNpm()` `:1808` runs `npm install <spec> --prefix ~/.pi/agent/npm`; **unpinned spec passes verbatim (`:1811`) → resolves to registry `latest`**.
- `parseSource()` `:1446`, `parseNpmSpec()` `:1731`; `pinned=true` for exact versions (`:59-66`, `:1456`); pinned skipped by updates (`:1107`, `:1204`); `getLatestNpmVersion()` `:1491`; `maxSatisfying` use at `:1526`; `installedNpmMatchesConfiguredVersion` `:1474`; git install `installGit()` `:1829` (clone + checkout ref).
- Loader: `src/core/extensions/loader.ts:57-70,111-135` aliases bundled `@earendil-works/*` modules — **no API_VERSION / minPiVersion / engines compatibility check exists anywhere**.
- No registry/catalog in code. Earendil-listed extensions = npm keyword `pi-package` + `pi.dev/packages` gallery (docs/packages.md:137).
- `examples/extensions/*` (with-deps, custom-provider-anthropic, custom-provider-gitlab-duo, sandbox, gondolin) are private workspace examples — templates, not an install channel.

### 3.3 subagents (fix sketches — refine with the register + feature specs, do not contradict them)
- REQ-L02 (P1 DEFECT): `session-lease.ts:107` decl, `:455` `updateWriter` impl — **0 call sites**; `:284-296` `defaultGetProcessStartIdentity` returns undefined on win32. Fix: call `updateWriter` wherever lease+child row written together; test asserting writerState ≠ "none" after dispatch.
- REQ-C02 (P1 DEFECT): bg budget `subagent-tool.ts:~693,:717`; inline pool `mapWithConcurrencyLimit` `:1665-1667`; `chain` `:1603` and `single` `:1715` bypass both. Fix: one shared per-process counter across ALL modes.
- REQ-C03 (P1 DEFECT): pool per-invocation `:565-583`; `packages/agent/src/types.ts:275` `toolExecution` defaults `"parallel"`. Fix: session-scoped semaphore mirroring `totalSpawnCount` closure `:770`, released on settle/abort.
- REQ-I04 (P1 DEFECT): `experiment-tools.ts:297-301` bare `catch{}` then `:302` writes `status:"merged"`; `worktree.ts:216-219` deletes `exp/<slug>` before `keep_branch` check (`experiment-tools.ts:613` vs `:623`); `worktree-lock.ts:112-115` `lockPath:""`. Fix: hold repo lock across composite mutation; typed error, never mark merged on failure; honour keep_branch.
- REQ-I01 (P1 GAP): no `isolation` in schema (`subagent-tool.ts:92-210`, `types.ts:66-84`); `createWorktree` gated by `enableExperiments` (`experiment-tools.ts:347`, `src/core/defaults.ts:29`). Fix: `isolation:"none"|"worktree"` per dispatch, no silent downgrade.
- REQ-I02 (P1 GAP): no `concurrentSafe` on ToolDef; `src/harness/tools/file-mutation-queue.ts:4` module-level Map (path: packages/agent/src/harness/tools/file-mutation-queue.ts). Fix: `concurrentSafe?: boolean`, default false for mutating tools.
- REQ-P02 (P1 GAP): no admission check before `background:true` (see permissions spec §3). Fix: explicit opt-in field or narrowed tool set — one field, one check.
- P2 rows and fix sketches: REQ-I03 (cross-process bash write safety, isolation §5); REQ-D03 enforce maxTurns using free `liveUsage.turns` (`:513`), graceful wrap-up (stdin "ignore" V25); REQ-D04 add `description` to SavedSpecFile (`saved-specs.ts:38-44`) + render saved agents into tool description; REQ-D05/CXT01 extend tool description (when-NOT-to-delegate, final-summary-only output contract; A/B before merging D05); REQ-O01 `buildStatusInjection` (`status-injector.ts:43`, 0 call sites) — either wire once per parent turn or delete + de-export (check "do not poll" prompt first); REQ-O02 dashboard background-only (`interactive-mode.ts:3214,4475-4494`), TUI has zero subagent code — reuse background log layout/renderer for inline runIds; REQ-O03 **re-audit first** — evidence stale, appears wired (`background.ts:1212-1307`, `agent-session.ts:569,590`, `test/subagent-bg-replay.test.ts` passes) → likely IMPLEMENTED, flip register row if confirmed; REQ-C04 docs drift — `packages/coding-agent/docs/settings.md:255` ("per session") and `docs/subagents.md:62` (DAG "at most maxConcurrent") must be replaced with concurrency spec §2.6.1/§2.6.2 exact text; REQ-L01 lease has no time expiry (`session-lease.ts:36-46`) — add ~5-line timestamp expiry or delete lease+steer/swap/resume; REQ-C01 parallel admission doesn't gate on concurrentSafe (consumes I02).
- Upstream ties to remove: `docs/subagents.md:222-224` steers to npm `pi-subagents` package; `docs/subagents.md:251-253` + `packages/coding-agent/examples/extensions/subagent/` upstream-era example. `packages/agent/src` has ZERO subagent code (verified). No remote-fetched agent defaults (`subagent/agents.ts:12-14,69` loads only local `.pi/agents/*.md`).
- Test status: 33 `test/subagent-*.ts` files; NO tests cover open rows (grep-verified); spot-runs pass (depth-guard 6/6, bg-replay + concurrency-cap 27/27).

### 3.4 compaction (root cause, verified)
- Throw sites: `packages/coding-agent/src/core/agent-session.ts:2245` (blocking `compact()`) and `:2480` (`_runBackgroundCompaction`) — fire when `prepareCompaction()` returns undefined and last branch entry isn't a compaction.
- `prepareCompaction` — `packages/coding-agent/src/core/compaction/compaction.ts:907` — returns undefined when: last entry is compaction (`:910`), `firstKeptEntry` missing (`:941`), or summarise-set empty (`:962-964`) — the "session too small" label is MISLEADING: it also means "nothing new since last compaction" or "below keepRecentTokens" (default 20000, `settings-manager.ts:1024`; harness overwrites with contextWindow*retainRatio).
- Hot-swap errors come from extension `c:/dev/ai-compact-hot-swap/index.ts:436` ("started"), `:464` ("failed") → `ctx.ui.notify(...,"error")` → `showExtensionNotify` (`interactive-mode.ts:2800`) → `showError` (`:4628`) = the red `Error: ...` lines. The extension calls `ctx.compact({onComplete,onError})` WITHOUT `background: true` (supported since commit 6ef071008, `agent-session.ts:3236`) → abort-first blocking path.
- Re-fire loop: threshold triggers pre-prompt (`agent-session.ts:769-777`) and post-run (`:2809-2812`) on `shouldCompact` (`compaction.ts:249`, near-full context) while `prepareCompaction` needs ≥20k summarisable branch tokens — `_backgroundCompaction` cleared in `finally` (`:2581`) → re-fires EVERY prompt → repeated red errors.
- Correct pattern already in tree: `_runAutoCompaction` silently skips (`if (!preparation) return false`, `~:2845`).
- Error surfaces: `compaction_end.errorMessage` `agent-session.ts:2367/:2572`; `interactive-mode.ts:3624-3636` manual→red showError, threshold→red text; calls `reportProviderError` (Sentry) even for benign skips; `event.background` not checked.
- Direction (draft as ADR-0005): typed skip reason from `prepareCompaction`; map "nothing to summarise"/"already compacted" to `compaction_end` with `skipped: true` + reason, rendered via showStatus/warning (NOT showError); no Sentry for skips; pre-check before `_startThresholdBackgroundCompaction` + latch skip flag cleared when branch grows; extension: pass `background: true`, treat skip messages as info/warning.

## 4. Output conventions (MANDATORY)

- **Spec tasks** (custom_id prefix `spec-`): emit each file as a fenced block introduced by a line `=== FILE: specs/<path> ===` and closed by `=== END FILE ===`. Content only — no surrounding commentary. Draft stage: include `[ASSUMPTION: ... — rationale: ...]` and `[UNRESOLVED: ... — suggested: ...]` markers where decisions remain open, and a final `## Traceability` section in every file. Respect GUIDE.md §3.3 size limits; one concept per file; no technology names in requirement statements (rationale blocks may cite them).
- **Fix tasks** (custom_id prefix `fix-`): emit unified diffs (`--- a/<path>` / `+++ b/<path>`) grouped by file, each preceded by a one-line rationale and followed by the test(s) that would verify it. Never propose touching unrelated areas; never revert the uncommitted summariser-model changes. If a fix needs a decision the spec leaves open, emit an `[UNRESOLVED]` line instead of inventing behaviour.
- Every finding/fix cites `path:line` evidence. Trust symbol names over line numbers if they drift.
- Do not restate the guide. Do not pad. Machine-importable output only.
