# Rebrand Requirements

## Scope

This specification defines the requirements for cutting all ties between `qi` and upstream `earendil-works/pi`. In scope are the hard-cut rename of the command-line executable, workspace, published package scope, user state directories, project configuration directories, environment variables, runtime branding strings, documentation, website calls-to-action, manual migration documentation, upstream synchronization tooling removal, and complete severance of all `pi.dev` endpoints. Out of scope are automatic migration of legacy `.pi` user state, legacy command or environment aliases, third-party extension porting (`D6`), and replacement server infrastructure for version checks, telemetry, changelogs, or session sharing (`D6`).

## Requirements

### R-REBRAND-001: Command-line executable identity is `qi`

**Priority:** MUST
**Statement:** The system exposes `qi` as its sole command-line executable name without providing a `pi` executable alias.
**Rationale:** Decision D1 mandates a full hard cut with no legacy aliases. Currently `packages/coding-agent/package.json:11` maps `"pi": "dist/bundle/cli.js"`, `packages/coding-agent/package.json:41` compiles `--outfile dist/pi`, `packages/coding-agent/src/config.ts:512-513` sets `APP_NAME = piConfigName || "pi"` and `APP_TITLE = piConfigName ? APP_NAME : "π"`, and `packages/coding-agent/src/cli/startup-ui.ts:34` sets `OFFICIAL_APP_NAME = "pi"`. `APP_TITLE` in `packages/coding-agent/src/config.ts:513` becomes `"qi"` rather than `"π"` to remove all `pi`/`π` identity markers in favour of `qi` (`R1`).
**Acceptance criteria:**
- AC1: Given the coding-agent package manifest, when inspecting its executable entry map, then the only entry key is `qi` mapped to `dist/bundle/cli.js` with no `pi` key present.
- AC2: Given a standalone binary build, when the binary artifact is produced, then the output filename is `qi` (or `qi.exe` on Windows) with no `pi` binary produced.
- AC3: Given runtime configuration constants in `config.ts`, when `APP_NAME` or `APP_TITLE` is read, then both evaluate to `"qi"`.
**Source:** Decision D1 (`specs/batch/batch-context.md`), derived from `ADR-0001`

### R-REBRAND-002: Published package scope is `@bramburn/qi-*` under workspace `qi-monorepo`

**Priority:** MUST
**Statement:** The system names the root workspace `qi-monorepo` while naming all published workspace packages under the `@bramburn/qi-*` scope.
**Rationale:** Decision D2 replaces all 11 `@earendil-works/pi-*` packages with `@bramburn/qi-*` and renames the root workspace in `package.json:2` from `pi-monorepo` to `qi-monorepo`. Currently `packages/coding-agent/package.json:2,51-56` and sibling packages declare `@earendil-works/pi-*` and `scripts/fork-publish-rename.mjs:21-22` rewrites them to `@bramburn/pi-*` only during publishing. All 11 workspace `package.json` manifests and internal workspace imports are renamed in-tree to `@bramburn/qi-*` rather than rewritten transiently at publish time, eliminating the publish-time shrinkwrap drift noted in `AGENTS.md:323` (`R2`).
**Acceptance criteria:**
- AC1: Given the root workspace manifest, when reading its `name` field, then the value is `"qi-monorepo"`.
- AC2: Given all 11 publishable workspace package manifests, when inspecting their `name` fields and internal workspace dependency keys, then every package uses `@bramburn/qi-*` and zero `@earendil-works/pi-*` or `@bramburn/pi-*` package names remain.
**Source:** Decision D2 (`specs/batch/batch-context.md`), derived from `ADR-0001`

### R-REBRAND-003: User state directory and project directory use `.qi`

**Priority:** MUST
**Statement:** The system resolves global user state under `~/.qi/agent` (with sibling `~/.qi/analytics`) plus project state under `.qi/` without reading from `~/.pi` or `.pi/`.
**Rationale:** Decision D1 requires user state at `~/.qi/` and project state at `.qi/`, breaking `.pi` immediately. Currently `packages/coding-agent/package.json:6-8` sets `"piConfig": { "configDir": ".pi" }`, `packages/coding-agent/src/config.ts:514,540-596` sets `CONFIG_DIR_NAME = ".pi"`, `getAgentDir()` -> `~/.pi/agent`, `getAnalyticsDir()` -> `~/.pi/analytics`, and `getDebugLogPath()` -> `~/.pi/agent/pi-debug.log`, `packages/coding-agent/src/core/settings-manager.ts:360` reads `<cwd>/.pi/settings.json`, and `packages/coding-agent/src/core/session-manager.ts:375` stores sessions under `~/.pi/agent/sessions`. The package manifest configuration key at `packages/coding-agent/package.json:6` and `packages/coding-agent/src/config.ts:500` is renamed from `piConfig` to `qiConfig` with `configDir: ".qi"` (`R3`).
**Acceptance criteria:**
- AC1: Given `QI_CODING_AGENT_DIR` is unset, when path helpers in `config.ts` are called, then `CONFIG_DIR_NAME` is `".qi"`, `getAgentDir()` resolves to `~/.qi/agent`, `getAnalyticsDir()` resolves to `~/.qi/analytics`, and `getDebugLogPath()` resolves to `~/.qi/agent/qi-debug.log`.
- AC2: Given a project workspace containing `.pi/settings.json`, `.pi/agents/*.md`, or `.pi/skills/` without a `.qi/` directory, when the system loads project settings, agents, or skills, then `.pi/` is ignored and only `.qi/` is consulted.
**Source:** Decision D1 (`specs/batch/batch-context.md`), derived from `ADR-0001`

### R-REBRAND-004: Environment variables use `QI_*` with no `PI_*` fallback

**Priority:** MUST
**Statement:** The system reads all process configuration from `QI_*` environment variables while injecting `QI_*` session variables into child processes without consulting any `PI_*` environment variables.
**Rationale:** Decision D1 mandates that every current `PI_*` capability is exposed as `QI_*` and that `PI_*` breaks immediately. As documented in `packages/coding-agent/docs/environment-variables.md:1-97` and hardcoded across ~40 call sites (`packages/coding-agent/src/config.ts:440,519-520,529`, `packages/coding-agent/src/main.ts:762-765,1095`, `packages/coding-agent/src/core/settings-manager.ts:1079,1152`), most `PI_*` names are string literals that do not derive from `APP_NAME` and must be renamed explicitly.
**Acceptance criteria:**
- AC1: Given any `PI_*` environment variable is set while its `QI_*` counterpart is unset, when the system initializes or executes tools, then the `PI_*` variable has no effect.
- AC2: Given any documented or internal `QI_*` process variable (`QI_CODING_AGENT_DIR`, `QI_CODING_AGENT_SESSION_DIR`, `QI_PACKAGE_DIR`, `QI_OFFLINE`, `QI_SKIP_VERSION_CHECK`, `QI_TELEMETRY`, `QI_CACHE_RETENTION`, `QI_SHARE_VIEWER_URL`, `QI_HARDWARE_CURSOR`, `QI_CLEAR_ON_SHRINK`, `QI_HYPERLINKS`, `QI_IMAGE_PROTOCOL`, `QI_TRUE_COLOR`, `QI_TUI_ESC_TIMEOUT`, `QI_AI_DEBUG`, `QI_STARTUP_BENCHMARK`, `QI_TIMING`, `QI_ENVIRONMENT`, `QI_EXPERIMENTAL`, `QI_BUNDLED_NODE`, `QI_INSTALLER_API_BASE`, `QI_SUBAGENT_*`), when set in the process environment, then the corresponding runtime behavior is applied.
- AC3: Given a command executed by the shell tools with session environment exposure enabled, when the child process environment is constructed, then `AI_AGENT=qi`, `QI_CODING_AGENT=true`, `QI_SESSION_ID`, `QI_SESSION_FILE`, `QI_PROVIDER`, `QI_MODEL`, and `QI_REASONING_LEVEL` are set and zero `PI_*` variables are exported.
**Source:** Decision D1 (`specs/batch/batch-context.md`), derived from `ADR-0001`

### R-REBRAND-005: User-visible CLI and interactive branding strings say `qi`

**Priority:** MUST
**Statement:** The system displays `qi` across all command-line help text, subcommand syntax, error diagnostics, session validation errors, plus interactive interface titles.
**Rationale:** Evidence in `packages/coding-agent/src/cli/args.ts:290-482` (`update [source|self|pi]`, `PI_OFFLINE=1`, `PI_PACKAGE_DIR`, `PI_TELEMETRY`, `PI_SHARE_VIEWER_URL`, `PI_AI_DEBUG`), `packages/coding-agent/src/main.ts:87,832` (`EXTENSION_LOAD_FAILURE_HINT`, `--version` output), and `packages/coding-agent/src/core/session-manager.ts:696` shows hardcoded `pi` and `PI_*` user-facing text.
**Acceptance criteria:**
- AC1: Given `qi --help` is executed, when standard output is read, then usage, subcommand help (`qi update [source|self|qi]`), example paths (`~/.qi/agent/sessions/...`), and environment variable descriptions contain `qi` and `QI_*` with zero `pi` or `PI_*` occurrences.
- AC2: Given `qi --version` is executed, when standard output is read, then the output begins with `qi ` followed by the version string.
**Source:** Decision D1 (`specs/batch/batch-context.md`), derived from `ADR-0001`

### R-REBRAND-006: Consistent distribution and fork identity metadata

**Priority:** MUST
**Statement:** The system identifies `@bramburn/qi-coding-agent`, `qi`, plus `.qi` as the official distribution metadata across startup checks, self-update guidance, plus version reporting.
**Rationale:** `packages/coding-agent/src/cli/startup-ui.ts:33-46` gates first-time setup on `OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent"`, `OFFICIAL_APP_NAME = "pi"`, and `OFFICIAL_CONFIG_DIR_NAME = ".pi"`, while `packages/coding-agent/src/config.ts:346` points binary self-update instructions to `https://github.com/earendil-works/pi-mono/releases/latest` and `config.ts:518` defines `FORK_NAME = "bramburn"`. `FORK_NAME = "bramburn"` is retained so `qi --version` at `packages/coding-agent/src/main.ts:832` prints `qi <version> [bramburn]` per `AGENTS.md` §Forking (`R4`).
**Acceptance criteria:**
- AC1: Given `startup-ui.ts` distribution constants, when `isOfficialDistribution` is called with runtime `PACKAGE_NAME`, `APP_NAME`, and `CONFIG_DIR_NAME`, then it returns `true` for `@bramburn/qi-coding-agent`, `qi`, and `.qi`.
- AC2: Given binary installation mode in `getSelfUpdateUnavailableInstruction` (`config.ts:346`), when update instructions are formatted, then the download URL references `https://github.com/bramburn/pi/releases/latest` (or `bramburn/qi`) and not `earendil-works/pi-mono`.
**Source:** Decisions D1, D2 (`specs/batch/batch-context.md`), derived from `ADR-0001`

### R-REBRAND-007: Zero outbound requests to upstream `pi.dev` endpoints

**Priority:** MUST
**Statement:** The system makes zero outbound network requests to any `pi.dev` domain endpoint across all startup, interactive, update, plus package-management workflows.
**Rationale:** Decision D4 mandates severing all earendil-controlled endpoints: `pi.dev/api/latest-version` (`packages/coding-agent/src/utils/version-check.ts:5`), `pi.dev/api/report-install` (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:1360`), `pi.dev/api/installer/releases` (`packages/coding-agent/src/package-manager-cli.ts:50`), `pi.dev/install.sh`, `pi.dev/changelog` (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:4643`), `pi.dev/session` (`packages/coding-agent/src/config.ts:528`), and `pi.dev/packages` (`packages/coding-agent/docs/packages.md:137`).
**Acceptance criteria:**
- AC1: Given `QI_OFFLINE` is unset and network access is enabled, when the system starts, checks for updates, reports installation, opens changelogs, or manages packages, then zero outbound requests target `pi.dev/api/latest-version`, `pi.dev/api/report-install`, `pi.dev/api/installer/releases`, `pi.dev/install.sh`, `pi.dev/changelog`, `pi.dev/session`, or `pi.dev/packages`.
- AC2: Given the runtime source files under `packages/*/src/`, when searching for the literal domain `pi.dev`, then zero matches are found.
**Source:** Decision D4 (`specs/batch/batch-context.md`), derived from `ADR-0002`, `ADR-0006`

### R-REBRAND-008: Session sharing fallback without `pi.dev/session`

**Priority:** SHOULD
**Statement:** The system should construct session share links from `QI_SHARE_VIEWER_URL` when configured, or if `QI_SHARE_VIEWER_URL` is unset, it must omit any `pi.dev/session` URL in favour of the raw gist URL.
**Rationale:** `packages/coding-agent/src/config.ts:526-531` defaults `getShareViewerUrl` to `https://pi.dev/session/#<gistId>` and `packages/coding-agent/src/core/session-share.ts:29` emits event type `pi.share`. Decision D4 severs `pi.dev/session` while Decision D6 defers replacement share viewer infrastructure. The event type at `packages/coding-agent/src/core/session-share.ts:29` is renamed from `"pi.share"` to `"qi.share"` (`R5`), and when `QI_SHARE_VIEWER_URL` is unset `getShareViewerUrl()` returns the raw Gist `html_url` (`R23`).
**Acceptance criteria:**
- AC1: Given `QI_SHARE_VIEWER_URL` is set to `https://viewer.example.com/session/`, when a session is shared, then the viewer URL uses `https://viewer.example.com/session/#<gistId>`.
- AC2: Given `QI_SHARE_VIEWER_URL` is unset, when a session is shared, then the raw GitHub Gist URL is returned and no `pi.dev/session` URL is returned or displayed.
**Source:** Decisions D4, D6 (`specs/batch/batch-context.md`), derived from `ADR-0002`

### R-REBRAND-009: No `earendil` identifiers in runtime configuration surfaces

**Priority:** MUST
**Statement:** The system contains no `earendil` or `earendil-works` strings in runtime configuration modules or command-line entrypoints, while the extension loader resolves `@bramburn/qi-*` module specifiers as primary alongside a strictly-scoped temporary shim for unported 0.85 extensions.
**Rationale:** Evidence in `packages/coding-agent/src/config.ts:346,511`, `packages/coding-agent/src/cli/startup-ui.ts:33`, and `packages/coding-agent/src/core/extensions/loader.ts:57-70,111-135` shows runtime references to `@earendil-works/*` and `earendil-works`. Under `R6` and `R21`, `packages/coding-agent/src/core/extensions/loader.ts:57-70,111-135` resolves `@bramburn/qi-*` as primary and retains a temporary `@earendil-works/pi-*` -> `@bramburn/qi-*` module-resolution shim strictly inside `loader.ts` (governed by `ADR-0003`) until 0.85 extension porting completes; all other config and CLI surfaces remain hard-cut.
**Acceptance criteria:**
- AC1: Given `packages/coding-agent/src/config.ts`, `packages/coding-agent/src/cli/**`, `packages/coding-agent/src/main.ts`, and `packages/*/package.json`, when searching for `earendil`, then zero matches exist.
- AC2: Given an extension that imports `@bramburn/qi-coding-agent`, `@bramburn/qi-ai`, `@bramburn/qi-agent-core`, or `@bramburn/qi-tui` (or a pinned 0.85 extension importing the temporary `@earendil-works/pi-*` shim in `loader.ts`), when loaded by the extension loader, then the bundled module resolves without error.
**Source:** Decisions D1, D2, D3, D4, D6 (`specs/batch/batch-context.md`), derived from `ADR-0001`, `ADR-0003`

### R-REBRAND-010: Upstream synchronization tooling is removed or disabled

**Priority:** MUST
**Statement:** The system removes or disables all scripts plus documentation workflows that synchronize versions or merge history from `earendil-works/pi`.
**Rationale:** `scripts/sync-versions.js`, `scripts/README-sync-upstream.md`, `scripts/fork-publish-rename.mjs`, `README.md:12-16`, and `AGENTS.md:273-290` maintain an upstream sync workflow against `earendil-works/pi` that is obsolete once `qi` severing is complete. `scripts/README-sync-upstream.md`, `scripts/fork-publish-rename.mjs`, and `scripts/fork-publish-rename.test.mjs` are deleted while `scripts/sync-versions.js` is retained solely for internal `@bramburn/qi-*` lockstep version bumping (`package.json:37-39`) with all `@earendil-works` references removed (`R7`).
**Acceptance criteria:**
- AC1: Given the `scripts/` directory, when inspecting files and contents, then `scripts/README-sync-upstream.md` and `scripts/fork-publish-rename.mjs` (plus its test) do not exist and `scripts/sync-versions.js` contains zero `earendil` references.
- AC2: Given `README.md`, when reading the release and repository overview, then upstream sync tracking claims (`Tracks origin/main (earendil-works/pi)`) are absent.
**Source:** Decision D4 (`specs/batch/batch-context.md`), derived from `ADR-0002`

### R-REBRAND-011: Distribution documentation and website describe `qi` installation

**Priority:** MUST
**Statement:** The system documentation plus website landing pages specify `qi` with `@bramburn/qi-coding-agent` for installation, usage, plus package references.
**Rationale:** `README.md:1-164` references `@earendil-works/pi-*` and `pi.dev`, `packages/coding-agent/docs/environment-variables.md` documents `PI_*`, `packages/coding-agent/docs/packages.md:137` links to `pi.dev/packages`, and `website/docusaurus.config.ts:93` plus `website/src/pages/index.tsx:116` instruct users to run `npm install -g @bramburn/pi-codes`.
**Acceptance criteria:**
- AC1: Given `README.md`, `packages/coding-agent/docs/environment-variables.md`, and `packages/coding-agent/docs/packages.md`, when inspecting package names, command examples, and gallery links, then all references use `qi`, `@bramburn/qi-*`, `~/.qi`, and `QI_*` with zero `pi.dev` links.
- AC2: Given `website/docusaurus.config.ts` and `website/src/pages/index.tsx`, when inspecting the site configuration and install call-to-action, then the install command specifies `@bramburn/qi-coding-agent`.
**Source:** Decisions D1, D2, D4 (`specs/batch/batch-context.md`), derived from `ADR-0001`, `ADR-0002`

### R-REBRAND-012: Manual migration is documented with zero automatic state migration

**Priority:** MUST
**Statement:** The system documents manual steps for migrating user state from `~/.pi` or `.pi` to `~/.qi` or `.qi` while performing zero automatic copying, symlinking, or reading of legacy state at runtime.
**Rationale:** Decision D1 explicitly forbids automatic migration and requires documenting manual migration so existing `pi` state is never silently mutated or shared with `qi` (`packages/coding-agent/src/migrations.ts`, `packages/coding-agent/src/main.ts:878`).
**Acceptance criteria:**
- AC1: Given a host where `~/.pi/agent/settings.json` exists and `~/.qi/` does not exist, when `qi` starts and runs startup migrations (`runMigrations`), then `~/.pi/` is untouched and `~/.qi/` is not populated from `~/.pi/`.
- AC2: Given `README.md`, when inspecting the migration section, then explicit instructions are provided for copying `~/.pi` to `~/.qi`, renaming `.pi` to `.qi`, and replacing `PI_*` environment variables with `QI_*`.
**Source:** Decision D1 (`specs/batch/batch-context.md`), derived from `ADR-0001`

## Traceability

- **Realised by contracts / behaviors / impl plans:** None (`REQ-REBRAND` is governed directly by accepted ADRs `ADR-0001`, `ADR-0002`, and `ADR-0006`).
- **Depends on ADRs:** `ADR-0001`, `ADR-0002`, `ADR-0006`.
- **References specs:** `REQ-EXT`, `ADR-0003`.
