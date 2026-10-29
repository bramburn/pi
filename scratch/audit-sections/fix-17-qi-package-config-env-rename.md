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

### fix-17-qi-package-config-env-rename
> Full Report: [fix-17-qi-package-config-env-rename.md](./fix-17-qi-package-config-env-rename.md) | Tokens: in=49,829 cached_read=0 out=10,420

### Summary of Changed Package & Config Files

- `package.json:2` — root workspace name `pi-monorepo` → `qi-monorepo` (D2).
- `packages/agent/package.json:2,32-33,47` — `@bramburn/qi-agent-core`, `@bramburn/qi-ai`, `@bramburn/qi-telemetry`, fork `repository.url`.
- `packages/ai/package.json:2,41,62,81` — `@bramburn/qi-ai`, bin `qi-ai`, `@bramburn/qi-telemetry`, fork `repository.url`.
- `packages/client/package.json:2,32,39,47` — `@bramburn/qi-client`, `@bramburn/qi-protocol`, fork `repository.url`.
- `packages/clipboard-rs/package.json:2,4,46` — `@bramburn/qi-clipboard-rs`.
- `packages/coding-agent/package.json:2,5-7,10-12,29,39-44,58-63,99` — `@bramburn/qi-coding-agent`, `piConfig` (`name: "qi"`, `configDir: ".qi"`), bin `qi`, `dist/qi` outfile, `@bramburn/qi-*` workspace dependencies, fork `repository.url`.
- `packages/evals/package.json:2,12-13` — `@bramburn/qi-evals`, `@bramburn/qi-ai`, `@bramburn/qi-coding-agent`.
- `packages/protocol/package.json:2,27,35` — `@bramburn/qi-protocol`, fork `repository.url`.
- `packages/server/package.json:2,32,39,47-48` — `@bramburn/qi-server`, `@bramburn/qi-ai`, `@bramburn/qi-protocol`, fork `repository.url`.
- `packages/session-backends/sqlite-node/package.json:2,4,29,37-38` — `@bramburn/qi-session-backend-sqlite-node`, `@bramburn/qi-ai`, `@bramburn/qi-agent-core`, fork `repository.url`.
- `packages/telemetry/package.json:2,4,35` — `@bramburn/qi-telemetry`, fork `repository.url`.
- `packages/tui/package.json:2,38` — `@bramburn/qi-tui`, fork `repository.url`.
- `packages/coding-agent/src/config.ts:328,354,509-528` — `APP_NAME`/`APP_TITLE`/`CONFIG_DIR_NAME` defaults to `qi`/`qi`/`.qi`, `QI_PACKAGE_DIR`, `QI_SHARE_VIEWER_URL`, sever `pi.dev/session/` default and upstream release URL.
- `packages/coding-agent/docs/environment-variables.md:1-97` — full hard-cut rename of `PI_*` and `AI_AGENT=pi` to `QI_*` and `AI_AGENT=qi`.

[UNRESOLVED: APP_TITLE choice — suggested: 'qi']
[UNRESOLVED: Exact file:line locations and full enumeration of PI_SUBAGENT_* and other literal PI_* occurrences across packages/*/src not present in the 14-file task archive — suggested: run `git grep -n '\bPI_' packages/*/src` and replace every literal `PI_` env var read/write with `QI_` with no fallback]

---

Rationale: Rename root monorepo package from `pi-monorepo` to `qi-monorepo` per D2 (`package.json:2`).
```diff
--- a/package.json
+++ b/package.json
@@ -1,5 +1,5 @@
 {
-	"name": "pi-monorepo",
+	"name": "qi-monorepo",
 	"private": true,
 	"type": "module",
 	"workspaces": [
```
Verify: `node -e "const p = require('./package.json'); if (p.name !== 'qi-monorepo') process.exit(1);"`

Rationale: Rename `@earendil-works/pi-agent-core` to `@bramburn/qi-agent-core`, update internal workspace deps to `@bramburn/qi-*`, and point `repository.url` to `bramburn/pi.git` (`packages/agent/package.json:2,32-33,47`).
```diff
--- a/packages/agent/package.json
+++ b/packages/agent/package.json
@@ -1,5 +1,5 @@
 {
-	"name": "@earendil-works/pi-agent-core",
+	"name": "@bramburn/qi-agent-core",
 	"version": "0.85.0-b1",
 	"description": "General-purpose agent with transport abstraction, state management, and attachment support",
 	"type": "module",
@@ -29,8 +29,8 @@
 		"prepublishOnly": "bun --bun run build"
 	},
 	"dependencies": {
-		"@earendil-works/pi-ai": "^0.85.0-b1",
-		"@earendil-works/pi-telemetry": "^0.85.0-b1",
+		"@bramburn/qi-ai": "^0.85.0-b1",
+		"@bramburn/qi-telemetry": "^0.85.0-b1",
 		"diff": "8.0.4",
 		"ignore": "7.0.5",
 		"typebox": "1.3.7",
@@ -44,7 +44,7 @@
 	"license": "MIT",
 	"repository": {
 		"type": "git",
-		"url": "git+https://github.com/earendil-works/pi.git",
+		"url": "git+https://github.com/bramburn/pi.git",
 		"directory": "packages/agent"
 	},
 	"engines": {
```
Verify: `bun run check`

Rationale: Rename `@earendil-works/pi-ai` to `@bramburn/qi-ai`, rename bin `pi-ai` to `qi-ai`, update `@bramburn/qi-telemetry` dep, and point `repository.url` to `bramburn/pi.git` (`packages/ai/package.json:2,41,62,81`).
```diff
--- a/packages/ai/package.json
+++ b/packages/ai/package.json
@@ -1,5 +1,5 @@
 {
-	"name": "@earendil-works/pi-ai",
+	"name": "@bramburn/qi-ai",
 	"version": "0.85.0-b1",
 	"description": "Unified LLM API with automatic model discovery and provider configuration",
 	"type": "module",
@@ -38,7 +38,7 @@
 		}
 	},
 	"bin": {
-		"pi-ai": "dist/cli.js"
+		"qi-ai": "dist/cli.js"
 	},
 	"files": [
 		"dist",
@@ -59,7 +59,7 @@
 	"dependencies": {
 		"@anthropic-ai/sdk": "0.91.1",
 		"@aws-sdk/client-bedrock-runtime": "3.1048.0",
-		"@earendil-works/pi-telemetry": "^0.85.0-b1",
+		"@bramburn/qi-telemetry": "^0.85.0-b1",
 		"@google/genai": "1.52.0",
 		"@smithy/node-http-handler": "4.7.3",
 		"@smithy/types": "4.17.2",
@@ -78,7 +78,7 @@
 	"license": "MIT",
 	"repository": {
 		"type": "git",
-		"url": "git+https://github.com/earendil-works/pi.git",
+		"url": "git+https://github.com/bramburn/pi.git",
 		"directory": "packages/ai"
 	},
 	"engines": {
```
Verify: `bun run check`

Rationale: Rename `@earendil-works/pi-client` to `@bramburn/qi-client`, update `@bramburn/qi-protocol` dep, and point `repository.url` to `bramburn/pi.git` (`packages/client/package.json:2,32,39,47`).
```diff
--- a/packages/client/package.json
+++ b/packages/client/package.json
@@ -1,7 +1,7 @@
 {
-	"name": "@earendil-works/pi-client",
+	"name": "@bramburn/qi-client",
 	"version": "0.85.0-b1",
-	"description": "Transport-neutral client for remote pi sessions over framed CBOR bytes",
+	"description": "Transport-neutral client for remote qi sessions over framed CBOR bytes",
 	"type": "module",
 	"main": "./dist/index.js",
 	"types": "./dist/index.d.ts",
@@ -29,21 +29,21 @@
 		"prepublishOnly": "bun --bun run clean && bun --bun run build"
 	},
 	"keywords": [
-		"pi",
+		"qi",
 		"client",
 		"protocol",
 		"cbor",
 		"binary"
 	],
 	"author": "Earendil Works",
 	"license": "MIT",
 	"repository": {
 		"type": "git",
-		"url": "git+https://github.com/earendil-works/pi.git",
+		"url": "git+https://github.com/bramburn/pi.git",
 		"directory": "packages/client"
 	},
 	"engines": {
 		"node": ">=22.19.0",
 		"bun": ">=1.3.14"
 	},
 	"dependencies": {
-		"@earendil-works/pi-protocol": "^0.85.0-b1"
+		"@bramburn/qi-protocol": "^0.85.0-b1"
 	},
 	"devDependencies": {
```
Verify: `bun run check`

Rationale: Rename `@bramburn/pi-clipboard-rs` to `@bramburn/qi-clipboard-rs` (`packages/clipboard-rs/package.json:2,4,46`).
```diff
--- a/packages/clipboard-rs/package.json
+++ b/packages/clipboard-rs/package.json
@@ -1,7 +1,7 @@
 {
-	"name": "@bramburn/pi-clipboard-rs",
+	"name": "@bramburn/qi-clipboard-rs",
 	"version": "0.85.0-b1",
-	"description": "Fork-local cross-platform clipboard native addon (Rust + napi-rs) for pi-coding-agent. Replaces @mariozechner/clipboard. Built on all 6 target platforms by .github/workflows/clipboard-rs-build.yml.",
+	"description": "Fork-local cross-platform clipboard native addon (Rust + napi-rs) for qi-coding-agent. Replaces @mariozechner/clipboard. Built on all 6 target platforms by .github/workflows/clipboard-rs-build.yml.",
 	"type": "module",
 	"main": "./index.js",
 	"types": "./index.d.ts",
@@ -43,7 +43,7 @@
 		"napi",
 		"napi-rs",
 		"addon",
-		"pi"
+		"qi"
 	],
 	"author": "bramburn",
 	"license": "MIT",
```
Verify: `bun run check`

Rationale: Rename `@earendil-works/pi-coding-agent` to `@bramburn/qi-coding-agent`, set `piConfig` to `name: "qi"` and `configDir: ".qi"`, rename bin to `qi` and binary outfile to `dist/qi`, update `@bramburn/qi-*` dependencies, and point `repository.url` to `bramburn/pi.git` (`packages/coding-agent/package.json:2,5-12,42,58-63,99`).
```diff
--- a/packages/coding-agent/package.json
+++ b/packages/coding-agent/package.json
@@ -1,13 +1,14 @@
 {
-	"name": "@earendil-works/pi-coding-agent",
+	"name": "@bramburn/qi-coding-agent",
 	"version": "0.85.0-b1",
 	"description": "Coding agent CLI with read, bash, edit, write tools and session management",
 	"type": "module",
 	"piConfig": {
-		"configDir": ".pi"
+		"name": "qi",
+		"configDir": ".qi"
 	},
 	"//build-binary": "Note: build:binary also invokes the full node build chain (via the embedded 'bun --bun run build' step) because the bundle's dist/cli.js must exist before 'bun build --compile' can include it. This is intentional and is why 'bun run build-both' runs the node build twice when --bun-only is not used.",
 	"bin": {
-		"pi": "dist/bundle/cli.js"
+		"qi": "dist/bundle/cli.js"
 	},
 	"main": "./dist/index.js",
 	"types": "./dist/index.d.ts",
@@ -39,7 +40,7 @@
 		"clean": "shx rm -rf dist",
 		"build": "bun --bun run build:unbundled && bun ../../scripts/build-coding-agent-bundle.mjs",
 		"build:unbundled": "tsgo -p tsconfig.build.json && shx chmod +x dist/cli.js dist/rpc-entry.js && bun --bun run copy-assets",
-		"build:binary": "bun --cwd ../tui run build && bun --cwd ../telemetry run build && bun --cwd ../ai run build && bun --cwd ../agent run build && bun --cwd ../protocol run build && bun --cwd ../client run build && bun --bun run build && bun build --compile --no-compile-autoload-bunfig ./src/bun/cli.ts ./src/utils/image-resize-worker.ts --outfile dist/pi && bun --bun run copy-binary-assets && bun --bun run build:promote",
+		"build:binary": "bun --cwd ../tui run build && bun --cwd ../telemetry run build && bun --cwd ../ai run build && bun --cwd ../agent run build && bun --cwd ../protocol run build && bun --cwd ../client run build && bun --bun run build && bun build --compile --no-compile-autoload-bunfig ./src/bun/cli.ts ./src/utils/image-resize-worker.ts --outfile dist/qi && bun --bun run copy-binary-assets && bun --bun run build:promote",
 		"build:promote": "bun ../../scripts/promote-binary.mjs",
 		"copy-assets": "shx mkdir -p dist/modes/interactive/theme && shx cp src/modes/interactive/theme/*.json dist/modes/interactive/theme/ && shx mkdir -p dist/modes/interactive/assets && shx cp src/modes/interactive/assets/*.png dist/modes/interactive/assets/ && shx mkdir -p dist/core/export-html/vendor && shx cp src/core/export-html/template.html src/core/export-html/template.css src/core/export-html/template.js dist/core/export-html/ && shx cp src/core/export-html/vendor/*.js dist/core/export-html/vendor/",
 		"copy-binary-assets": "shx cp package.json dist/ && shx cp README.md dist/ && shx cp CHANGELOG.md dist/ && shx mkdir -p dist/theme && shx cp src/modes/interactive/theme/*.json dist/theme/ && shx mkdir -p dist/assets && shx cp src/modes/interactive/assets/*.png dist/assets/ && shx mkdir -p dist/export-html/vendor && shx cp src/core/export-html/template.html dist/export-html/ && shx cp src/core/export-html/vendor/*.js dist/export-html/vendor/ && shx cp -r docs dist/ && shx cp -r examples dist/ && shx cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm dist/",
@@ -48,12 +49,12 @@
 		"prepublishOnly": "bun --bun run clean && bun --bun run build && bun --bun run shrinkwrap"
 	},
 	"dependencies": {
-		"@earendil-works/pi-agent-core": "^0.85.0-b1",
+		"@bramburn/qi-agent-core": "^0.85.0-b1",
 		"better-sqlite3": "11.9.1",
-		"@earendil-works/pi-ai": "^0.85.0-b1",
-		"@earendil-works/pi-client": "^0.85.0-b1",
-		"@earendil-works/pi-protocol": "^0.85.0-b1",
-		"@earendil-works/pi-tui": "^0.85.0-b1",
+		"@bramburn/qi-ai": "^0.85.0-b1",
+		"@bramburn/qi-client": "^0.85.0-b1",
+		"@bramburn/qi-protocol": "^0.85.0-b1",
+		"@bramburn/qi-tui": "^0.85.0-b1",
 		"@sentry/node": "10.72.0",
 		"@silvia-odwyer/photon-node": "0.3.4",
 		"chalk": "5.6.2",
@@ -96,7 +97,7 @@
 	"license": "MIT",
 	"repository": {
 		"type": "git",
-		"url": "git+https://github.com/earendil-works/pi.git",
+		"url": "git+https://github.com/bramburn/pi.git",
 		"directory": "packages/coding-agent"
 	},
 	"engines": {
```
Verify: `bun run check`

Rationale: Rename `@earendil-works/pi-evals` to `@bramburn/qi-evals` and update workspace devDependencies to `@bramburn/qi-*` (`packages/evals/package.json:2,12-13`).
```diff
--- a/packages/evals/package.json
+++ b/packages/evals/package.json
@@ -1,5 +1,5 @@
 {
-	"name": "@earendil-works/pi-evals",
+	"name": "@bramburn/qi-evals",
 	"version": "0.85.0-b1",
 	"private": true,
 	"type": "module",
@@ -9,8 +9,8 @@
 		"test": "vitest --run --config vitest.test.config.ts"
 	},
 	"devDependencies": {
-		"@earendil-works/pi-ai": "^0.85.0-b1",
-		"@earendil-works/pi-coding-agent": "^0.85.0-b1",
+		"@bramburn/qi-ai": "^0.85.0-b1",
+		"@bramburn/qi-coding-agent": "^0.85.0-b1",
 		"@types/node": "22.19.19",
 		"shx": "0.4.0",
 		"typescript": "5.9.3",
```
Verify: `bun run check`

Rationale: Rename `@earendil-works/pi-protocol` to `@bramburn/qi-protocol` and point `repository.url` to `bramburn/pi.git` (`packages/protocol/package.json:2,27,35`).
```diff
--- a/packages/protocol/package.json
+++ b/packages/protocol/package.json
@@ -1,7 +1,7 @@
 {
-	"name": "@earendil-works/pi-protocol",
+	"name": "@bramburn/qi-protocol",
 	"version": "0.85.0-b1",
-	"description": "Transport-neutral CBOR protocol for remote pi sessions",
+	"description": "Transport-neutral CBOR protocol for remote qi sessions",
 	"type": "module",
 	"main": "./dist/index.js",
 	"types": "./dist/index.d.ts",
@@ -24,7 +24,7 @@
 		"prepublishOnly": "bun --bun run clean && bun --bun run build"
 	},
 	"keywords": [
-		"pi",
+		"qi",
 		"protocol",
 		"cbor",
 		"binary",
@@ -32,7 +32,7 @@
 	"license": "MIT",
 	"repository": {
 		"type": "git",
-		"url": "git+https://github.com/earendil-works/pi.git",
+		"url": "git+https://github.com/bramburn/pi.git",
 		"directory": "packages/protocol"
 	},
 	"engines": {
```
Verify: `bun run check`

Rationale: Rename `@earendil-works/pi-server` to `@bramburn/qi-server`, update `@bramburn/qi-*` dependencies, and point `repository.url` to `bramburn/pi.git` (`packages/server/package.json:2,32,39,47-48`).
```diff
--- a/packages/server/package.json
+++ b/packages/server/package.json
@@ -1,7 +1,7 @@
 {
-	"name": "@earendil-works/pi-server",
+	"name": "@bramburn/qi-server",
 	"version": "0.85.0-b1",
-	"description": "experimental server package for pi",
+	"description": "experimental server package for qi",
 	"type": "module",
 	"main": "./dist/index.js",
 	"types": "./dist/index.d.ts",
@@ -29,14 +29,14 @@
 		"prepublishOnly": "bun --bun run clean && bun --bun run build"
 	},
 	"keywords": [
-		"pi",
+		"qi",
 		"server"
 	],
 	"author": "Earendil Works",
 	"license": "MIT",
 	"repository": {
 		"type": "git",
-		"url": "git+https://github.com/earendil-works/pi.git",
+		"url": "git+https://github.com/bramburn/pi.git",
 		"directory": "packages/server"
 	},
 	"engines": {
 		"node": ">=22.19.0",
 		"bun": ">=1.3.14"
 	},
 	"dependencies": {
-		"@earendil-works/pi-ai": "^0.85.0-b1",
-		"@earendil-works/pi-protocol": "^0.85.0-b1"
+		"@bramburn/qi-ai": "^0.85.0-b1",
+		"@bramburn/qi-protocol": "^0.85.0-b1"
 	},
 	"devDependencies": {
```
Verify: `bun run check`

Rationale: Rename `@earendil-works/pi-session-backend-sqlite-node` to `@bramburn/qi-session-backend-sqlite-node`, update `@bramburn/qi-*` dependencies, and point `repository.url` to `bramburn/pi.git` (`packages/session-backends/sqlite-node/package.json:2,4,29,37-38`).
```diff
--- a/packages/session-backends/sqlite-node/package.json
+++ b/packages/session-backends/sqlite-node/package.json
@@ -1,7 +1,7 @@
 {
-	"name": "@earendil-works/pi-session-backend-sqlite-node",
+	"name": "@bramburn/qi-session-backend-sqlite-node",
 	"version": "0.85.0-b1",
-	"description": "Node sqlite session backend for @earendil-works/pi-agent-core sessions",
+	"description": "Node sqlite session backend for @bramburn/qi-agent-core sessions",
 	"type": "module",
 	"main": "./dist/index.js",
 	"types": "./dist/index.d.ts",
@@ -26,15 +26,15 @@
 	"license": "MIT",
 	"repository": {
 		"type": "git",
-		"url": "git+https://github.com/earendil-works/pi.git",
+		"url": "git+https://github.com/bramburn/pi.git",
 		"directory": "packages/session-backends/sqlite-node"
 	},
 	"engines": {
 		"node": ">=22.19.0",
 		"bun": ">=1.3.14"
 	},
 	"dependencies": {
-		"@earendil-works/pi-ai": "^0.85.0-b1",
-		"@earendil-works/pi-agent-core": "^0.85.0-b1"
+		"@bramburn/qi-ai": "^0.85.0-b1",
+		"@bramburn/qi-agent-core": "^0.85.0-b1"
 	},
 	"devDependencies": {
```
Verify: `bun run check`

Rationale: Rename `@earendil-works/pi-telemetry` to `@bramburn/qi-telemetry` and point `repository.url` to `bramburn/pi.git` (`packages/telemetry/package.json:2,4,35`).
```diff
--- a/packages/telemetry/package.json
+++ b/packages/telemetry/package.json
@@ -1,7 +1,7 @@
 {
-	"name": "@earendil-works/pi-telemetry",
+	"name": "@bramburn/qi-telemetry",
 	"version": "0.85.0-b1",
-	"description": "Vendor-neutral telemetry contracts and typed schema utilities for pi",
+	"description": "Vendor-neutral telemetry contracts and typed schema utilities for qi",
 	"type": "module",
 	"main": "./dist/index.js",
 	"types": "./dist/index.d.ts",
@@ -32,7 +32,7 @@
 	"license": "MIT",
 	"repository": {
 		"type": "git",
-		"url": "git+https://github.com/earendil-works/pi.git",
+		"url": "git+https://github.com/bramburn/pi.git",
 		"directory": "packages/telemetry"
 	},
 	"engines": {
```
Verify: `bun run check`

Rationale: Rename `@earendil-works/pi-tui` to `@bramburn/qi-tui` and point `repository.url` to `bramburn/pi.git` (`packages/tui/package.json:2,38`).
```diff
--- a/packages/tui/package.json
+++ b/packages/tui/package.json
@@ -1,5 +1,5 @@
 {
-	"name": "@earendil-works/pi-tui",
+	"name": "@bramburn/qi-tui",
 	"version": "0.85.0-b1",
 	"description": "Terminal User Interface library with differential rendering for efficient text-based applications",
 	"type": "module",
@@ -35,7 +35,7 @@
 	"license": "MIT",
 	"repository": {
 		"type": "git",
-		"url": "git+https://github.com/earendil-works/pi.git",
+		"url": "git+https://github.com/bramburn/pi.git",
 		"directory": "packages/tui"
 	},
 	"engines": {
```
Verify: `bun run check`

Rationale: Update `packages/coding-agent/src/config.ts` defaults to `qi`/`qi`/`.qi`/`@bramburn/qi-coding-agent`, rename `PI_PACKAGE_DIR` and `PI_SHARE_VIEWER_URL` to `QI_PACKAGE_DIR` and `QI_SHARE_VIEWER_URL` with no legacy fallback, point binary download instructions to `bramburn/pi`, and remove the `https://pi.dev/session/` share viewer default (`packages/coding-agent/src/config.ts:328,354,509-528`).
```diff
--- a/packages/coding-agent/src/config.ts
+++ b/packages/coding-agent/src/config.ts
@@ -325,7 +325,7 @@
 	const method = detectInstallMethod();
 	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
 	if (method === "bun-binary") {
-		return `Download from: https://github.com/earendil-works/pi-mono/releases/latest`;
+		return `Download from: https://github.com/bramburn/pi/releases/latest`;
 	}
 	const command = getSelfUpdateCommandForMethod(method, packageName, target, npmCommand);
 	if (command) {
@@ -351,7 +351,7 @@
 
 export function getPackageDir(): string {
 	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
-	const envDir = process.env.PI_PACKAGE_DIR;
+	const envDir = process.env.QI_PACKAGE_DIR;
 	if (envDir) {
 		return normalizePath(envDir);
 	}
@@ -506,27 +506,29 @@
 }
 
 const piConfigName: string | undefined = pkg.piConfig?.name;
-export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
-export const APP_NAME: string = piConfigName || "pi";
-export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
-export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
+export const PACKAGE_NAME: string = pkg.name || "@bramburn/qi-coding-agent";
+export const APP_NAME: string = piConfigName || "qi";
+export const APP_TITLE: string = piConfigName ? APP_NAME : "qi";
+export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".qi";
 export const VERSION: string = pkg.version || "0.0.0";
 
-// Mark this build as the bramburn fork so `pi --version` and other surfaces
+// Mark this build as the bramburn fork so `qi --version` and other surfaces
 // can show that the user is running the fork rather than the upstream build.
 export const FORK_NAME: string = "bramburn";
 
-// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
+// e.g., QI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
 export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
 export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;
 
 export function expandTildePath(path: string): string {
 	return normalizePath(path);
 }
 
-const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";
+// TODO(deferred-porting): provide a qi-hosted share viewer or offline export fallback once replacement infra is defined (D4/D6).
+const DEFAULT_SHARE_VIEWER_URL = "";
 
 /** Get the share viewer URL for a gist ID. */
 export function getShareViewerUrl(gistId: string): string {
-	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
-	return `${baseUrl}#${gistId}`;
+	const baseUrl = process.env.QI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
+	return baseUrl ? `${baseUrl}#${gistId}` : `#${gistId}`;
 }
```
Verify: `bun run check && git grep -n 'PI_' packages/coding-agent/src/config.ts` (expect 0 matches)

Rationale: Update `packages/coding-agent/docs/environment-variables.md` in full so every `PI_*` variable and `AI_AGENT=pi` marker is documented as `QI_*` and `AI_AGENT=qi` with `.qi` paths and no `pi.dev` references (`packages/coding-agent/docs/environment-variables.md:1-97`).
```diff
--- a/packages/coding-agent/docs/environment-variables.md
+++ b/packages/coding-agent/docs/environment-variables.md
@@ -1,49 +1,49 @@
 # Environment Variables
 
-Pi uses environment variables in three ways:
+Qi uses environment variables in three ways:
 
-- Variables such as `PI_OFFLINE` configure the Pi process.
-- Pi sets process markers so child processes can identify Pi as the launching agent.
-- Commands run by the LLM-callable shell tools receive `PI_*` variables describing the current session.
+- Variables such as `QI_OFFLINE` configure the Qi process.
+- Qi sets process markers so child processes can identify Qi as the launching agent.
+- Commands run by the LLM-callable shell tools receive `QI_*` variables describing the current session.
 
 Provider API-key variables are documented separately in [Providers](providers.md#environment-variables-or-auth-file).
 
 ## Process Marker
 
 The CLI and RPC entry points set two process markers:
 
-- `AI_AGENT=pi` is a generic marker that lets tooling identify Pi as the agent that launched the process.
-- `PI_CODING_AGENT=true` is Pi-specific and lets child processes detect that they run inside Pi.
+- `AI_AGENT=qi` is a generic marker that lets tooling identify Qi as the agent that launched the process.
+- `QI_CODING_AGENT=true` is Qi-specific and lets child processes detect that they run inside Qi.
 
-Child processes inherit both markers. They are not session-specific and are not set automatically when Pi is embedded through the SDK.
+Child processes inherit both markers. They are not session-specific and are not set automatically when Qi is embedded through the SDK.
 
 ## Shell Tool Session Environment
 
-Commands run by the `bash` and `powershell` tools receive the current Pi session state:
+Commands run by the `bash` and `powershell` tools receive the current Qi session state:
 
 | Variable | Description |
 |----------|-------------|
-| `PI_SESSION_ID` | Current session ID |
-| `PI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
-| `PI_PROVIDER` | Currently selected model provider |
-| `PI_MODEL` | Currently selected model ID |
-| `PI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
+| `QI_SESSION_ID` | Current session ID |
+| `QI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
+| `QI_PROVIDER` | Currently selected model provider |
+| `QI_MODEL` | Currently selected model ID |
+| `QI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
 
-The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Pi. `PI_PROVIDER` and `PI_MODEL` identify the selected Pi model, not a different upstream model that a router may choose internally.
+The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Qi. `QI_PROVIDER` and `QI_MODEL` identify the selected Qi model, not a different upstream model that a router may choose internally.
 
 When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:
 
 ```bash
-printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
-printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
+printf '%s/%s\n' "$QI_PROVIDER" "$QI_MODEL"
+printf 'reasoning=%s session=%s\n' "$QI_REASONING_LEVEL" "$QI_SESSION_ID"
 ```
 
 The session file can be inspected directly when the session is persistent:
 
 ```bash
-if [ -n "$PI_SESSION_FILE" ]; then
-  tail -n 1 "$PI_SESSION_FILE"
+if [ -n "$QI_SESSION_FILE" ]; then
+  tail -n 1 "$QI_SESSION_FILE"
 fi
 ```
 
@@ -51,7 +51,7 @@
 
 ### Custom Shell Tools
 
-Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Pi. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:
+Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Qi. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:
 
 ```typescript
 const bashTool = createBashTool(cwd, {
@@ -70,26 +70,26 @@
 });
 ```
 
-When disabled, Pi removes inherited values for these variables so nested Pi processes do not expose stale parent-session metadata.
+When disabled, Qi removes inherited values for these variables so nested Qi processes do not expose stale parent-session metadata.
 
-## Pi Process Configuration
+## Qi Process Configuration
 
-These variables are read by Pi itself:
+These variables are read by Qi itself:
 
 | Variable | Description |
 |----------|-------------|
-| `PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent` |
-| `PI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
-| `PI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
-| `PI_OFFLINE` | Disable startup network operations, including update checks, package updates, and install/update telemetry |
-| `PI_SKIP_VERSION_CHECK` | Disable the `pi.dev` latest-version request |
-| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
-| `PI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
-| `PI_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
-| `PI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
-| `PI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
-| `PI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
-| `PI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
-| `PI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
+| `QI_CODING_AGENT_DIR` | Override the config directory; default is `~/.qi/agent` |
+| `QI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
+| `QI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
+| `QI_OFFLINE` | Disable startup network operations, including update checks, package updates, and install/update telemetry |
+| `QI_SKIP_VERSION_CHECK` | Disable the latest-version check |
+| `QI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
+| `QI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
+| `QI_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
+| `QI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
+| `QI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
+| `QI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
+| `QI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
+| `QI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
 | `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
 | `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |
```
Verify: `git grep -c 'PI_' packages/coding-agent/docs/environment-variables.md` (expect 0) and `git grep -c 'QI_' packages/coding-agent/docs/environment-variables.md` (expect >= 24).

---
