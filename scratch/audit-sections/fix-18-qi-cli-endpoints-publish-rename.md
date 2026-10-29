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

### fix-18-qi-cli-endpoints-publish-rename
> Full Report: [fix-18-qi-cli-endpoints-publish-rename.md](./fix-18-qi-cli-endpoints-publish-rename.md) | Tokens: in=143,252 cached_read=0 out=10,329

Hard-cut CLI help/usage strings and environment variable names in `packages/coding-agent/src/cli/args.ts` (`printHelp`, lines 298–470) from `pi`/`PI_*`/`pi.dev` to `qi`/`QI_*` per D1 and D4.

```diff
--- a/packages/coding-agent/src/cli/args.ts
+++ b/packages/coding-agent/src/cli/args.ts
@@ -295,7 +295,7 @@
   ${APP_NAME} install <source> [-l]     Install extension source and add to settings
   ${APP_NAME} remove <source> [-l]      Remove extension source from settings
   ${APP_NAME} uninstall <source> [-l]   Alias for remove
-  ${APP_NAME} update [source|self|pi]   Update pi, extensions, or model catalogs
+  ${APP_NAME} update [source|self|qi]   Update qi, extensions, or model catalogs
   ${APP_NAME} list                      List installed extensions from settings
   ${APP_NAME} config [-l]               Open TUI to enable/disable package resources (Tab switches scope)
   ${APP_NAME} auth <command>            Print credentials or check provider readiness
@@ -342,7 +342,7 @@
   --verbose                      Force verbose startup (overrides quietStartup setting)
 --approve, -a                  Trust project-local files for this run
   --no-approve, -na              Ignore project-local files for this run
-  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
+  --offline                      Disable startup network operations (same as QI_OFFLINE=1)
   --                             End option parsing; treat remaining arguments as messages/files
   --help, -h                     Show this help
   --version, -v                  Show version number
@@ -461,12 +461,12 @@
   AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
   ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
   ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
-  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
-  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
-  PI_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no
-  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)
-  PI_AI_DEBUG                      - Enable Sentry error reporting when set to 1/true/yes (requires SENTRY_DSN)
-  SENTRY_DSN                       - Sentry DSN (https://<key>@<host>/<project>) used when PI_AI_DEBUG=1
+  QI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
+  QI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
+  QI_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no
+  QI_SHARE_VIEWER_URL              - Base URL for /share command
+  QI_AI_DEBUG                      - Enable Sentry error reporting when set to 1/true/yes (requires SENTRY_DSN)
+  SENTRY_DSN                       - Sentry DSN (https://<key>@<host>/<project>) used when QI_AI_DEBUG=1
   SENTRY_TRACES_SAMPLE_RATE        - Fraction (0..1) of root spans sent as Sentry transactions; default 0
 
 ${chalk.bold("Built-in Tool Names:")}
```
Verify: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/args.test.ts` and `grep -n 'pi\.dev\|PI_OFFLINE\|update \[source|self|pi\]' packages/coding-agent/src/cli/args.ts` (expect 0 matches) + `bun run check`.

Update official distribution constants in `packages/coding-agent/src/cli/startup-ui.ts:32-34` to `@bramburn/qi-coding-agent`, `qi`, and `.qi` per D1 and D2.

```diff
--- a/packages/coding-agent/src/cli/startup-ui.ts
+++ b/packages/coding-agent/src/cli/startup-ui.ts
@@ -29,9 +29,9 @@
 	type Theme,
 } from "../modes/interactive/theme/theme.ts";
 
-const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
-const OFFICIAL_APP_NAME = "pi";
-const OFFICIAL_CONFIG_DIR_NAME = ".pi";
+const OFFICIAL_PACKAGE_NAME = "@bramburn/qi-coding-agent";
+const OFFICIAL_APP_NAME = "qi";
+const OFFICIAL_CONFIG_DIR_NAME = ".qi";
 
 interface DistributionMetadata {
 	packageName: string;
```
Verify: `grep -n 'OFFICIAL_' packages/coding-agent/src/cli/startup-ui.ts` and `bun run check`.

Update CLI version banner and runtime env vars (`PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_STARTUP_BENCHMARK`) in `packages/coding-agent/src/main.ts:624-628,832,1072-1074` to `qi` / `QI_*` per D1.

```diff
--- a/packages/coding-agent/src/main.ts
+++ b/packages/coding-agent/src/main.ts
@@ -621,10 +621,10 @@
 export async function main(args: string[], options?: MainOptions) {
 	resetTimings();
 	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
-	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
+	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.QI_OFFLINE);
 	if (offlineMode) {
-		process.env.PI_OFFLINE = "1";
-		process.env.PI_SKIP_VERSION_CHECK = "1";
+		process.env.QI_OFFLINE = "1";
+		process.env.QI_SKIP_VERSION_CHECK = "1";
 	}
 
 	const sentryContext = initSentryIfEnabled();
@@ -829,7 +829,7 @@
 	time("parseArgs");
 
 	if (parsed.version) {
-		console.log(`pi ${VERSION} [${FORK_NAME}]`);
+		console.log(`qi ${VERSION} [${FORK_NAME}]`);
 		process.exit(0);
 	}
 
@@ -1069,9 +1069,9 @@
 		process.exit(1);
 	}
 
-	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
+	const startupBenchmark = isTruthyEnvFlag(process.env.QI_STARTUP_BENCHMARK);
 	if (startupBenchmark && appMode !== "interactive") {
-		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
+		console.error(chalk.red("Error: QI_STARTUP_BENCHMARK only supports interactive mode"));
 		process.exit(1);
 	}
 
```
Verify: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/stdout-cleanliness.test.ts` and `bun run check`.

Sever `pi.dev/api/latest-version` in `packages/coding-agent/src/utils/version-check.ts:5,50-87,95-108` and switch env guards to `QI_OFFLINE` / `QI_SKIP_VERSION_CHECK` per D1 and D4.

```diff
--- a/packages/coding-agent/src/utils/version-check.ts
+++ b/packages/coding-agent/src/utils/version-check.ts
@@ -1,8 +1,7 @@
 import { compare, valid } from "semver";
-import { fetchWithRetry } from "./management-http.ts";
-import { getPiUserAgent } from "./pi-user-agent.ts";
 
-const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
+// TODO(deferred-porting): severed upstream version-check endpoint (ADR-0002 / D4).
+const LATEST_VERSION_URL = "";
 const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;
 
 export interface LatestPiRelease {
@@ -48,43 +47,12 @@
 }
 
 export async function getLatestPiRelease(
-	currentVersion: string,
-	options: { timeoutMs?: number; retry?: boolean } = {},
+	_currentVersion: string,
+	_options: { timeoutMs?: number; retry?: boolean } = {},
 ): Promise<LatestPiRelease | undefined> {
-	if (process.env.PI_OFFLINE) return undefined;
-
-	const response = await fetchWithRetry(
-		LATEST_VERSION_URL,
-		{
-			headers: {
-				"User-Agent": getPiUserAgent(currentVersion),
-				accept: "application/json",
-			},
-		},
-		{
-			maxRetries: options.retry ? 2 : 0,
-			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
-		},
-	);
-	if (!response.ok) return undefined;
-
-	const data = (await response.json()) as {
-		packageName?: unknown;
-		version?: unknown;
-		note?: unknown;
-	};
-	if (typeof data.version !== "string" || !data.version.trim()) {
-		return undefined;
-	}
-	const packageName =
-		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
-	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
-	return {
-		version: data.version.trim(),
-		packageName,
-		...(note ? { note } : {}),
-	};
+	if (process.env.QI_OFFLINE || !LATEST_VERSION_URL) return undefined;
+	void DEFAULT_VERSION_CHECK_TIMEOUT_MS;
+	return undefined;
 }
 
 export async function getLatestPiVersion(
@@ -95,7 +63,7 @@
 }
 
 export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
-	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;
+	if (process.env.QI_SKIP_VERSION_CHECK) return undefined;
 
 	try {
 		const latestRelease = await getLatestPiRelease(currentVersion);
```
Verify: `grep -n 'pi\.dev' packages/coding-agent/src/utils/version-check.ts` (expect 0 matches) and `bun run check`.

Sever `pi.dev/api/installer/releases` in `packages/coding-agent/src/package-manager-cli.ts:50,55,70,180-191` and update `pi` CLI command targets/env vars (`QI_MANAGED_INSTALL_ROOT`, `QI_INSTALLER_API_BASE`, `update [source|self|qi]`) per D1 and D4.

```diff
--- a/packages/coding-agent/src/package-manager-cli.ts
+++ b/packages/coding-agent/src/package-manager-cli.ts
@@ -47,12 +47,13 @@
 
 type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string } | { type: "models" };
 
-const DEFAULT_INSTALLER_API_BASE = "https://pi.dev/api/installer/releases";
+// TODO(deferred-porting): severed upstream installer releases endpoint (ADR-0002 / D4).
+const DEFAULT_INSTALLER_API_BASE = "";
 const MANAGED_INSTALL_MARKER = "managed-install.json";
 const MANAGED_RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
 
 function getActiveManagedInstallRoot(): string | undefined {
-	const configuredRoot = process.env.PI_MANAGED_INSTALL_ROOT?.trim();
+	const configuredRoot = process.env.QI_MANAGED_INSTALL_ROOT?.trim();
 	if (!configuredRoot) return undefined;
 
 	const managedRoot = resolve(configuredRoot);
@@ -67,7 +68,7 @@
 			layout?: unknown;
 			schemaVersion?: unknown;
 		};
-		if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") {
+		if (marker.kind !== "qi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") {
 			throw new Error();
 		}
 	} catch {
@@ -177,10 +178,13 @@
 	let stageDir: string | undefined;
 	try {
 		cleanupManagedStaging(managedRoot);
-		const installerApiBase = (process.env.PI_INSTALLER_API_BASE?.trim() || DEFAULT_INSTALLER_API_BASE).replace(
+		const installerApiBase = (process.env.QI_INSTALLER_API_BASE?.trim() || DEFAULT_INSTALLER_API_BASE).replace(
 			/\/+$/,
 			"",
 		);
+		if (!installerApiBase) {
+			throw new Error(`Managed ${APP_NAME} self-update is disabled: no installer release endpoint is configured.`);
+		}
 		const releaseUrl = `${installerApiBase}/${encodeURIComponent(version)}`;
 		const stagingRoot = join(managedRoot, "staging");
 		const releasesRoot = join(managedRoot, "releases");
@@ -259,7 +263,7 @@
 		case "remove":
 			return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
 		case "update":
-			return `${APP_NAME} update [source|self|pi] [--self|--extensions|--models|--all] [--extension <source>] [--approve|--no-approve] [--force]`;
+			return `${APP_NAME} update [source|self|qi] [--self|--extensions|--models|--all] [--extension <source>] [--approve|--no-approve] [--force]`;
 		case "list":
 			return `${APP_NAME} list [--approve|--no-approve]`;
 	}
@@ -323,24 +327,24 @@
 			console.log(`${chalk.bold("Usage:")}
   ${getPackageCommandUsage("update")}
 
-Update pi, installed packages, or model catalogs.
+Update qi, installed packages, or model catalogs.
 
 Options:
-  --self                  Update pi only (default when no target is given)
+  --self                  Update qi only (default when no target is given)
   --extensions            Update installed packages only
   --models                Refresh model catalogs only
-  --all                   Update pi and installed packages
+  --all                   Update qi and installed packages
   --extension <source>    Update one package only
   -a, --approve           Trust project-local files for this command
   -na, --no-approve       Ignore project-local files for this command
-  --force                 Reinstall pi even if the current version is latest
+  --force                 Reinstall qi even if the current version is latest
 
 Short forms:
-  ${APP_NAME} update                Update pi only
-  ${APP_NAME} update --all          Update pi and all extensions
+  ${APP_NAME} update                Update qi only
+  ${APP_NAME} update --all          Update qi and all extensions
   ${APP_NAME} update --models       Refresh model catalogs only
   ${APP_NAME} update <source>       Update one package
-  ${APP_NAME} update pi             Update pi only (self works as alias to pi)
+  ${APP_NAME} update qi             Update qi only (self works as alias to qi)
 `);
 			return;
 
@@ -512,7 +516,7 @@
 			}
 			updateTarget = { type: "extensions", source: extensionFlagSource };
 		} else if (source) {
-			const sourceIsSelf = source === "self" || source === "pi";
+			const sourceIsSelf = source === "self" || source === "qi";
 			if (sourceIsSelf) {
 				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
 			} else {
```
Verify: `grep -n 'pi\.dev\|PI_MANAGED_INSTALL_ROOT\|PI_INSTALLER_API_BASE' packages/coding-agent/src/package-manager-cli.ts` (expect 0 matches) and `bun run check`.

Sever `pi.dev/api/report-install` and `pi.dev/changelog` in `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1165,1268,1360-1378,4641-4666` and switch `PI_OFFLINE` to `QI_OFFLINE` per D1 and D4.

```diff
--- a/packages/coding-agent/src/modes/interactive/interactive-mode.ts
+++ b/packages/coding-agent/src/modes/interactive/interactive-mode.ts
@@ -1162,7 +1162,7 @@
 	async run(): Promise<void> {
 		await this.init();
 
-		if (!process.env.PI_OFFLINE) {
+		if (!process.env.QI_OFFLINE) {
 			const controller = new AbortController();
 			const timeout = setTimeout(() => controller.abort(), 15_000);
 			void refreshModelCatalogs(this.session.modelRuntime, controller.signal)
@@ -1265,7 +1265,7 @@
 	}
 
 	private async checkForPackageUpdates(): Promise<string[]> {
-		if (process.env.PI_OFFLINE) {
+		if (process.env.QI_OFFLINE) {
 			return [];
 		}
 
@@ -1357,24 +1357,10 @@
 		return undefined;
 	}
 
-	private reportInstallTelemetry(version: string): void {
-		if (process.env.PI_OFFLINE) {
-			return;
-		}
-
-		if (!isInstallTelemetryEnabled(this.settingsManager)) {
-			return;
-		}
-
-		void fetch(`https://pi.dev/api/report-install?version=${encodeURIComponent(version)}`, {
-			headers: {
-				"User-Agent": getPiUserAgent(version),
-			},
-			signal: AbortSignal.timeout(5000),
-		})
-			.then(() => undefined)
-			.catch(() => undefined);
+	private reportInstallTelemetry(_version: string): void {
+		// TODO(deferred-porting): severed upstream install telemetry endpoint (ADR-0002 / D4).
+		void isInstallTelemetryEnabled;
+		void getPiUserAgent;
 	}
 
 	private getMarkdownThemeWithSettings(): MarkdownTheme {
@@ -4640,11 +4626,8 @@
 	showNewVersionNotification(release: LatestPiRelease): void {
 		const action = theme.fg("accent", `${APP_NAME} update`);
 		const updateInstruction = theme.fg("muted", `New version ${release.version} is available. Run `) + action;
-		const changelogUrl = "https://pi.dev/changelog";
-		const changelogLink = getCapabilities().hyperlinks
-			? hyperlink(theme.fg("accent", changelogUrl), changelogUrl)
-			: theme.fg("accent", changelogUrl);
-		const changelogLine = theme.fg("muted", "Changelog: ") + changelogLink;
+		// TODO(deferred-porting): severed upstream changelog URL (ADR-0002 / D4).
+		const changelogLine = theme.fg("muted", "Run /changelog to view local release notes.");
 		const note = release.note?.trim();
 
 		this.chatContainer.addChild(new Spacer(1));
```
Verify: `grep -n 'pi\.dev\|PI_OFFLINE' packages/coding-agent/src/modes/interactive/interactive-mode.ts` (expect 0 matches) and `bun run check`.

Update share event type from `'pi.share'` to `'qi.share'` in `packages/coding-agent/src/core/session-share.ts:29` per D1.

```diff
--- a/packages/coding-agent/src/core/session-share.ts
+++ b/packages/coding-agent/src/core/session-share.ts
@@ -26,7 +26,7 @@
 	gistId: string;
 }
 
-export const SESSION_SHARE_CUSTOM_TYPE = "pi.share";
+export const SESSION_SHARE_CUSTOM_TYPE = "qi.share";
```
Verify: `grep -n 'pi\.share' packages/coding-agent/src/core/session-share.ts` (expect 0 matches) and `bun run check`.

Update `scripts/fork-publish-rename.mjs:23-26,48-61,69-77` to target `@bramburn/qi-*` (accepting either `@earendil-works/pi-*` or `@bramburn/qi-*` workspace names as idempotent no-op/rewrite) per D2.

```diff
--- a/scripts/fork-publish-rename.mjs
+++ b/scripts/fork-publish-rename.mjs
@@ -20,8 +20,8 @@
 	process.exit(2);
 }
 
-const WORKSPACE_PREFIX = "@earendil-works/pi-";
-const FORK_PREFIX = "@bramburn/pi-";
+const WORKSPACE_PREFIX = "@earendil-works/pi-";
+const FORK_PREFIX = "@bramburn/qi-";
 const UPSTREAM_REPO_URL = "git+https://github.com/earendil-works/pi.git";
 const FORK_REPO_URL = "git+https://github.com/bramburn/pi.git";
 
@@ -45,12 +45,14 @@
 	process.exit(2);
 }
 
-if (!pkg.name?.startsWith(WORKSPACE_PREFIX)) {
-	console.error(`name "${pkg.name}" is not under ${WORKSPACE_PREFIX}; aborting`);
+if (!pkg.name?.startsWith(WORKSPACE_PREFIX) && !pkg.name?.startsWith(FORK_PREFIX)) {
+	console.error(`name "${pkg.name}" is not under ${WORKSPACE_PREFIX} or ${FORK_PREFIX}; aborting`);
 	process.exit(2);
 }
 
 const oldName = pkg.name;
-const newName = FORK_PREFIX + oldName.slice(WORKSPACE_PREFIX.length);
+const newName = oldName.startsWith(WORKSPACE_PREFIX)
+	? FORK_PREFIX + oldName.slice(WORKSPACE_PREFIX.length)
+	: oldName;
 pkg.name = newName;
 
 // Rewrite workspace deps in every dep section. Skips registry aliases
```
Verify: `bun test scripts/*.test.mjs` and `grep -n '@bramburn/pi-' scripts/fork-publish-rename.mjs` (expect 0 matches).

Update `.github/workflows/publish.yml:69-133` step names and comments to `@bramburn/qi-*` per D2.

```diff
--- a/.github/workflows/publish.yml
+++ b/.github/workflows/publish.yml
@@ -66,65 +66,65 @@
       # plus the `npm-publish` environment lets npm CLI auto-detect the OIDC
       # token from the GitHub Actions environment. Do NOT set NODE_AUTH_TOKEN
       # here — that would force the legacy token path and re-trigger 2FA.
-      - name: Publish @bramburn/pi-ai
+      - name: Publish @bramburn/qi-ai
         run: |
           # scripts/fork-publish-rename.mjs swaps the package name to
-          # @bramburn/pi-ai, runs the rest of the command line, then
-          # restores the original @earendil-works/pi-ai name. This way
+          # @bramburn/qi-ai, runs the rest of the command line, then
+          # restores the original package.json on exit. This way
           # npm publish publishes under the trusted-publisher-protected
           # name while the workspace name on disk stays untouched.
  # scripts/publish-with-skip.mjs makes the step idempotent: a version
  # that's already on npm is treated as success, but any other failure
  # (notably ENEEDAUTH when the trusted publisher config on npmjs.com is
  # missing) surfaces as a step failure.
  node scripts/fork-publish-rename.mjs packages/ai node scripts/publish-with-skip.mjs packages/ai npm publish --access public --tag fork
 
-      - name: Publish @bramburn/pi-tui
+      - name: Publish @bramburn/qi-tui
         run: |
           node scripts/fork-publish-rename.mjs packages/tui node scripts/publish-with-skip.mjs packages/tui npm publish --access public --tag fork
 
-      - name: Publish @bramburn/pi-telemetry
+      - name: Publish @bramburn/qi-telemetry
         run: |
           node scripts/fork-publish-rename.mjs packages/telemetry node scripts/publish-with-skip.mjs packages/telemetry npm publish --access public --tag fork
 
-      - name: Publish @bramburn/pi-protocol
+      - name: Publish @bramburn/qi-protocol
         run: |
           node scripts/fork-publish-rename.mjs packages/protocol node scripts/publish-with-skip.mjs packages/protocol npm publish --access public --tag fork
 
-      - name: Publish @bramburn/pi-client
+      - name: Publish @bramburn/qi-client
         run: |
           node scripts/fork-publish-rename.mjs packages/client node scripts/publish-with-skip.mjs packages/client npm publish --access public --tag fork
 
-      - name: Publish @bramburn/pi-agent-core
+      - name: Publish @bramburn/qi-agent-core
         run: |
           node scripts/fork-publish-rename.mjs packages/agent node scripts/publish-with-skip.mjs packages/agent npm publish --access public --tag fork
 
-      - name: Publish @bramburn/pi-session-backend-sqlite-node
+      - name: Publish @bramburn/qi-session-backend-sqlite-node
         run: |
           node scripts/fork-publish-rename.mjs packages/session-backends/sqlite-node node scripts/publish-with-skip.mjs packages/session-backends/sqlite-node npm publish --access public --tag fork
 
-      - name: Publish @bramburn/pi-coding-agent
+      - name: Publish @bramburn/qi-coding-agent
         run: |
           node scripts/fork-publish-rename.mjs packages/coding-agent node scripts/publish-with-skip.mjs packages/coding-agent npm publish --access public --tag fork
 
-      - name: Publish @bramburn/pi-server
+      - name: Publish @bramburn/qi-server
         run: |
           node scripts/fork-publish-rename.mjs packages/server node scripts/publish-with-skip.mjs packages/server npm publish --access public --tag fork
 
-      - name: Publish @bramburn/pi-clipboard-rs
+      - name: Publish @bramburn/qi-clipboard-rs
         # Source name is already in the bramburn/ namespace (no fork-publish-rename needed).
         # The prebuilds/* dir is built by .github/workflows/clipboard-rs-build.yml on the
         # same tag and committed to the repo before this step runs; if it's empty the
         # published tarball is still valid JS metadata, just without per-platform binaries.
         run: |
           node scripts/publish-with-skip.mjs packages/clipboard-rs npm publish --access public --tag fork
```
Verify: `grep -n '@bramburn/pi-' .github/workflows/publish.yml` (expect 0 matches).

Add ADR-0002 banner note to `scripts/sync-versions.js:1-12` marking upstream sync disabled while preserving workspace lockstep version synchronization.

```diff
--- a/scripts/sync-versions.js
+++ b/scripts/sync-versions.js
@@ -1,6 +1,8 @@
 #!/usr/bin/env bun
 
 /**
+ * NOTE (ADR-0002): Upstream sync with earendil-works/pi is DISABLED. This script
+ * is retained solely for internal qi-monorepo workspace lockstep version sync.
  * Validates lockstep versions for published packages, then synchronizes
  * internal dependency versions in all workspace packages, including private ones.
  *
```
Verify: `grep -n 'ADR-0002' scripts/sync-versions.js` and `bun run check`.

Update `README.md:1-101` branding, badge, package table, and fork-tracking policy to `qi` / `@bramburn/qi-*` and mark upstream sync disabled per D1, D2, D4, and ADR-0002.

```diff
--- a/README.md
+++ b/README.md
@@ -1,21 +1,16 @@
-<p align="center">
-  <a href="https://pi.dev">
-    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
-  </a>
-</p>
 <p align="center">
-  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
+  <a href="https://www.npmjs.com/package/@bramburn/qi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@bramburn/qi-coding-agent?style=flat-square" /></a>
 </p>
 
-# Pi Coding Agent — bramburn fork
+# Qi Coding Agent
 
-Fork of [earendil-works/pi](https://github.com/earendil-works/pi) maintained by
+Hardened fork of `pi` maintained by
 [Kaps Ramburn](https://github.com/bramburn) (`nitrogen@gmail.com`).
 
-Current fork release: **v0.84.2-b1** (fork version on the upstream v0.84.2
-baseline). Tracks `origin/main` (earendil-works/pi) and re-applies the fork
-markers after each sync.
+Current release: **v0.85.0-b1**. **Upstream sync is DISABLED (ADR-0002):** `qi`
+has permanently severed ties with `earendil-works/pi` and `pi.dev` endpoints and
+no longer tracks or merges `origin/main`.
 
 > **Runtime: Bun (primary), Node.js (legacy).** The fork has migrated its
 > CI, build, and most scripts to Bun. Node.js is still supported for legacy
@@ -42,16 +37,16 @@
 - `bun run` can execute the existing `package.json` scripts (including
   the chained `cd && npm run build` build pipeline) without rewriting
   them.
-- `bun build --compile` produces a single-file binary (`pi.exe` on
-  Windows, `pi` on Unix) without external runtime; the Node target still
+- `bun build --compile` produces a single-file binary (`qi.exe` on
+  Windows, `qi` on Unix) without external runtime; the Node target still
   ships for users who prefer it.
 
 To install Bun: <https://bun.sh/docs/installation>.
 
 ## Differences from upstream
 
-- `pi --version` prints `pi <version> [bramburn]` (fork marker, see
-  `packages/coding-agent/src/config.ts` `FORK_NAME`).
+- `qi --version` prints `qi <version> [bramburn]` (fork marker, see
+  `packages/coding-agent/src/config.ts` `FORK_NAME`).
 - Workspace packages are published under the `@bramburn/qi-*` npm scope on tag
   push via `.github/workflows/publish.yml` (currently blocked by npm 2FA OTP,
   see *Known issues* below).
@@ -64,7 +59,7 @@
   - **Per-sibling `toolResult` emission** in parallel tool batches (no
     orphans when one sibling stalls). `packages/agent/src/agent-loop.ts`.
   - **Per-session default model** (planned, not yet implemented) — allow each
-    `.pi-session` file to carry its own `defaultModel`, overriding the global
+    session file to carry its own `defaultModel`, overriding the global
     setting. See `docs/per-session-model-plan.md` for the architecture plan.
   - **Scrollback-jump guard** while streaming with the viewport scrolled up.
     The pre-v0.84 fix targeted the old class-based `TuiMainScreen`; upstream
@@ -74,25 +69,24 @@
   - **`validateLlmMessages()` extension-transform check** in
     `packages/agent/src/agent-loop.ts`, with regression test in
     `packages/agent/test/validate-llm-messages.test.ts`.
-- Workspace package versions are `0.84.2-b1` (pre-release suffix on the
-  upstream `0.84.2` baseline). The `--version` test regex accepts the
+- Workspace package versions are `0.85.0-b1`. The `--version` test regex accepts the
   pre-release suffix.
-- Workspace npm scope stays at `@earendil-works/*` for workspace resolution;
-  only the published scope switches to `@bramburn/*`.
+- All packages are named and published under `@bramburn/qi-*`.
 
 ## All packages
 
 | Package | Description |
 |---------|-------------|
-| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
-| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
-| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
-| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
-| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
-| **[@earendil-works/pi-protocol](packages/protocol)** | Transport-neutral CBOR protocol schemas for remote pi sessions |
-| **[@earendil-works/pi-client](packages/client)** | Remote pi session client (`RemoteSession` controller) |
-| **[@earendil-works/pi-server](packages/server)** | Remote pi session server |
-| **[@earendil-works/pi-session-backend-sqlite-node](packages/session-backends/sqlite-node)** | Node sqlite session backend for v4 SessionRepo |
+| **[@bramburn/qi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
+| **[@bramburn/qi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
+| **[@bramburn/qi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
+| **[@bramburn/qi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
+| **[@bramburn/qi-tui](packages/tui)** | Terminal UI library with differential rendering |
+| **[@bramburn/qi-protocol](packages/protocol)** | Transport-neutral CBOR protocol schemas for remote qi sessions |
+| **[@bramburn/qi-client](packages/client)** | Remote qi session client (`RemoteSession` controller) |
+| **[@bramburn/qi-server](packages/server)** | Remote qi session server |
+| **[@bramburn/qi-session-backend-sqlite-node](packages/session-backends/sqlite-node)** | Node sqlite session backend for v4 SessionRepo |
 
-If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/README.md](packages/coding-agent/README.md) for details.
+If you need stronger boundaries, containerize or sandbox Qi. See [packages/coding-agent/README.md](packages/coding-agent/README.md) for details.
```
Verify: `grep -n 'pi\.dev\|@earendil-works/' README.md` (expect 0 matches).

Update Docusaurus site title, navbar title, announcement bar, and footer in `website/docusaurus.config.ts:6,74-96,150-161` to `qi` branding and remove `pi.dev` links per D1 and D4.

```diff
--- a/website/docusaurus.config.ts
+++ b/website/docusaurus.config.ts
@@ -3,7 +3,7 @@
 import type * as Preset from '@docusaurus/preset-classic';
 
 const config: Config = {
-  title: 'pi — Local AI Coding Agent',
+  title: 'qi — Local AI Coding Agent',
   tagline: 'A self-extensible, local-first AI coding agent that runs on your machine with your credentials.',
   favicon: 'img/favicon.svg',
 
@@ -71,22 +71,22 @@
     metadata: [
       {
         name: 'keywords',
-        content: 'AI coding agent, local AI, Claude, GPT, coding assistant, CLI, pi, pi.dev',
+        content: 'AI coding agent, local AI, Claude, GPT, coding assistant, CLI, qi',
       },
       {name: 'twitter:card', content: 'summary_large_image'},
       {name: 'og:type', content: 'website'},
-      {name: 'og:site_name', content: 'pi — Local AI Coding Agent'},
+      {name: 'og:site_name', content: 'qi — Local AI Coding Agent'},
     ],
 
     announcementBar: {
       id: 'v0842',
       content:
-        'You are reading the <strong>bramburn/pi</strong> fork docs. For the upstream project visit <a href="https://pi.dev/docs/latest" target="_blank" rel="noopener noreferrer">pi.dev/docs/latest</a>.',
+        'You are reading the <strong>qi</strong> coding agent documentation.',
       backgroundColor: '#1a1f2e',
       textColor: '#e0e6f0',
       isCloseable: true,
     },
 
     navbar: {
-      title: 'pi [bramburn fork]',
+      title: 'qi',
       logo: {
-        alt: 'pi logo',
+        alt: 'qi logo',
         src: 'img/logo.svg',
         srcDark: 'img/logo-dark.svg',
       },
@@ -145,15 +145,10 @@
           title: 'Community',
           items: [
             {label: 'GitHub', href: 'https://github.com/bramburn/pi'},
-            {
-              label: 'Upstream (earendil-works/pi)',
-              href: 'https://github.com/earendil-works/pi',
-            },
-            {label: 'pi.dev', href: 'https://pi.dev'},
           ],
         },
       ],
-      copyright: `Built with Docusaurus. pi is MIT-licensed. The bramburn/pi fork is MIT-licensed. Copyright ${new Date().getFullYear()} bramburn.`,
+      copyright: `Built with Docusaurus. qi is MIT-licensed. Copyright ${new Date().getFullYear()} bramburn.`,
     },
 
     prism: {
```
Verify: `grep -n 'pi\.dev' website/docusaurus.config.ts` (expect 0 matches) and `cd website && npm run build`.

Update homepage install CTA and feature blurb in `website/src/pages/index.tsx:96-99,116` to `@bramburn/qi-coding-agent` and `qi` branding per D1, D2, and D4.

```diff
--- a/website/src/pages/index.tsx
+++ b/website/src/pages/index.tsx
@@ -93,8 +93,8 @@
                 description="A full terminal UI with a scrollback buffer, syntax highlighting, and keybindings you already know."
               />
               <Feature
-                title="Fork of pi.dev"
-                description="This is the bramburn/pi fork. It diverges from upstream in build tooling, release process, and selected features."
+                title="Hardened fork"
+                description="qi is a hardened, standalone fork with native Bun runtime support, native subagents, and pinned extension compatibility."
                 link="/docs/fork/why-fork"
                 linkLabel="See what's different"
               />
@@ -113,7 +113,7 @@
               Quick install
             </Heading>
             <pre className={styles.installCode}>
-              <code>npm install -g @bramburn/pi-codes</code>
+              <code>npm install -g @bramburn/qi-coding-agent</code>
             </pre>
             <p className={styles.installNote}>
               Or download a prebuilt binary from the{' '}
```
Verify: `grep -n 'pi\.dev\|pi-codes' website/src/pages/index.tsx` (expect 0 matches) and `cd website && npm run build`.

---
