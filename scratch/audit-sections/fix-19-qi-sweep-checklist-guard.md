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

### fix-19-qi-sweep-checklist-guard
> Full Report: [fix-19-qi-sweep-checklist-guard.md](./fix-19-qi-sweep-checklist-guard.md) | Tokens: in=35,740 cached_read=0 out=5,720

=== FILE: specs/batch/rebrand-sweep-checklist.md ===
# qi Rebrand Sweep Checklist & Execution Strategy

Post-critical-path sweep plan for the remaining ~7,550 `earendil` (~4,604) and word-boundary `pi` (~2,953) occurrences across the repository.

**Precondition:** Critical-path tasks (`fix-17` / `fix-18`) have already landed:
- Workspace package identity (`@bramburn/qi-*`, root `qi-monorepo` in `package.json:2`).
- Core config constants (`packages/coding-agent/src/config.ts:509-540`: `APP_NAME = "qi"`, `CONFIG_DIR_NAME = ".qi"`, `ENV_AGENT_DIR`, `getAgentDir()`).
- CLI entry points, binary name (`packages/coding-agent/package.json:11`), startup banner (`packages/coding-agent/src/cli/startup-ui.ts:33-34`), `--version` output (`packages/coding-agent/src/main.ts:832`).
- Environment variables (`PI_*` → `QI_*`) and upstream endpoint severance (`pi.dev/*`).

---

## 1. Area Inventory & Batch Execution Plan

| Batch | Area / Glob | Target Patterns | Exact Grep Command | Risk | Verification Command | Re-run Tests? |
|---|---|---|---|---|---|---|
| **A1** | `packages/*/src/**` (imports & package refs) | `@earendil-works/pi-*` | `grep -rnE '@earendil-works/pi-' packages/*/src/ packages/session-backends/*/src/` | **HIGH** | `bun run check && ./test.sh` | **Yes** (full `./test.sh`) |
| **A2** | `packages/*/src/**` (runtime strings, comments, types, error messages, extension loader aliases) | `\bpi\b`, `.pi/`, `pi-session`, `pi.share`, `pi-package` | `grep -rnE '(\bpi\b|\.pi/|pi-session|pi\.share|pi-package|PI_[A-Z0-9_]+)' packages/*/src/ packages/session-backends/*/src/` | **HIGH** | `bun run check && ./test.sh` | **Yes** (per-package vitest + `packages/tui` `node --test`) |
| **A3** | `packages/*/test/**` & `packages/*/examples/**` | `@earendil-works/pi-*`, `\bpi\b`, `.pi/`, `PI_*` | `grep -rnE '(@earendil-works/pi-|\bpi\b|\.pi/|PI_[A-Z0-9_]+)' packages/*/test/ packages/coding-agent/examples/` | **MEDIUM** | `./test.sh` | **Yes** (mandatory; check test count `N > 0`) |
| **B** | `packages/coding-agent/docs/**` & `docs/**` & root `README.md`, `AGENTS.md`, `CONTRIBUTING.md` | `earendil`, `pi.dev`, `PI_*`, `~/.pi`, `.pi/`, `\bpi\b` | `grep -rnE '(earendil|pi\.dev|PI_[A-Z0-9_]+|~/.pi|\.pi/|\bpi\b)' packages/coding-agent/docs/ docs/ README.md AGENTS.md` | **LOW** | `node scripts/check-no-earendil.mjs` | No (docs only) |
| **C** | `website/**` (Docusaurus config, sidebars, docs, landing page `website/src/pages/index.tsx:116`) | `earendil`, `@bramburn/pi-`, `pi.dev`, `/pi/`, `\bpi\b` | `grep -rnE '(earendil|@bramburn/pi-|pi\.dev|\bpi\b)' website/docs/ website/src/ website/docusaurus.config.ts website/sidebars.ts` | **LOW** | `bun run --cwd website build` (`onBrokenLinks: 'throw'`) | No (website build verifies links) |
| **D** | `scripts/**` (build, shrinkwrap, install-lock, release, check scripts; `scripts/check-pinned-deps.mjs:27`) | `@earendil-works/pi-`, `pi-monorepo`, `PI_ALLOW_LOCKFILE_CHANGE`, `pi.exe` | `grep -rnE '(earendil|@bramburn/pi-|pi-monorepo|PI_[A-Z0-9_]+|\bpi\b)' scripts/` | **HIGH** | `bun run check && bun test scripts/*.test.mjs` | **Yes** (`bun run test:scripts`) |
| **E** | `.github/**` (workflows, actions, issue templates, `.github/workflows/publish.yml`) | `earendil`, `@bramburn/pi-`, `PI_*`, `pi-mono`, `\bpi\b` | `grep -rnE '(earendil|@bramburn/pi-|PI_[A-Z0-9_]+|\bpi\b)' .github/` | **MEDIUM** | `node scripts/check-no-earendil.mjs` + YAML syntax check | No |

### Batch Execution Rules

1. **Batch A1 + D must land before lockfile / shrinkwrap regeneration:**
   - Update `scripts/check-pinned-deps.mjs:27` (`isInternalWorkspaceDependency` checking `@bramburn/qi-`).
   - Update `scripts/generate-coding-agent-shrinkwrap.mjs` and `scripts/generate-coding-agent-install-lock.mjs`, then run:
     ```bash
     bun run shrinkwrap:coding-agent
     bun run install-lock:coding-agent
     ```
2. **Batch A2 care points:**
   - Do **not** blindly sed `\bpi\b` in math contexts (`Math.PI`, `2 * pi`, SVG/canvas geometry).
   - Extension loader (`packages/coding-agent/src/core/extensions/loader.ts:57-70,111-135`) bundled module aliases must resolve `@bramburn/qi-*` (hard cut per D1/D2).
3. **Immutable Historical Sections:**
   - Per `AGENTS.md` Changelog rules, released version headings and entries in `packages/*/CHANGELOG.md` below `## [Unreleased]` are immutable historical records and must be excluded from the CI brand guard.

---

## 2. Exclusion Policy (Enforced by `scripts/check-no-earendil.mjs`)

| Category | Paths / Globs | Policy | Rationale |
|---|---|---|---|
| **F. Deferred / Out-of-band** | `types/**`, `lab/**` | **EXCLUDED** | Experimental/ambient surfaces excluded from the rebrand sweep and CI gate. |
| **G. Historical / Scratch** | `checkpoint-evidence/**`, `scratch/**`, `research/**`, `lab/**`, `specs/.history/**`, `packages/*/CHANGELOG.md` | **EXCLUDE-FOREVER** | Historical evidence, research notes, and immutable past changelog entries must never be rewritten. |
| **H. Generated / Lock / Worktrees** | `dist/**`, `node_modules/**`, `.git/**`, `.worktrees/**`, `worktrees/**`, `.claude/**`, `package-lock.json`, `bun.lock`, `packages/coding-agent/npm-shrinkwrap.json`, `packages/coding-agent/install-lock/**`, `packages/ai/src/models.generated.ts` | **NEVER TOUCH BY HAND** | Regenerated exclusively by build/lock/codegen scripts (`bun install`, `bun run build`, `bun run shrinkwrap:coding-agent`, `bun run install-lock:coding-agent`). |

---

## 3. Manual Migration Guide for Existing Users (Deliverable for Decision D1)

Per **D1 (Full hard cut)**, `qi` provides **zero runtime fallbacks or auto-migration** from `pi`, `.pi/`, or `PI_*`. Copy the section below into `docs/migration-pi-to-qi.md` and link it from `README.md`.

```markdown
# Migrating from `pi` to `qi` (Hard Cut)

`qi` is a hard-cut rename. Legacy `pi` binary names, `~/.pi` directories, `.pi/` project directories, and `PI_*` environment variables are no longer read.

## 1. Move User State (`~/.pi` → `~/.qi`)

Close all running agent sessions, then rename your global configuration directory:

```bash
# Linux / macOS / Git Bash
mv ~/.pi ~/.qi

# PowerShell (Windows)
Move-Item -Path "$HOME\.pi" -Destination "$HOME\.qi"
```

This preserves `agent/settings.json`, `agent/auth.json`, `agent/models.json`, `agent/sessions/`, `agent/themes/`, `agent/tools/`, `agent/bin/`, `agent/extensions/`, and `agent/subagent-specs/`.

## 2. Move Project State (`.pi/` → `.qi/`)

In each repository where you have project-scoped settings, custom agents (`.pi/agents/*.md`), or skills (`.pi/skills/`):

```bash
git mv .pi .qi
# Or if untracked:
mv .pi .qi
```

Update `.gitignore` entries from `.pi/` to `.qi/` if applicable.

## 3. Rename Environment Variables (`PI_*` → `QI_*`)

Update your shell profile (`~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`, or Windows Environment Variables) and CI secrets:

| Old (`pi`) | New (`qi`) |
|---|---|
| `PI_CODING_AGENT_DIR` | `QI_CODING_AGENT_DIR` |
| `PI_PACKAGE_DIR` | `QI_PACKAGE_DIR` |
| `PI_MODEL` / `PI_PROVIDER` | `QI_MODEL` / `QI_PROVIDER` |
| `PI_REASONING_LEVEL` | `QI_REASONING_LEVEL` |
| `PI_SESSION_FILE` / `PI_SESSION_ID` | `QI_SESSION_FILE` / `QI_SESSION_ID` |
| `PI_OFFLINE` | `QI_OFFLINE` |
| `PI_TELEMETRY` | `QI_TELEMETRY` |
| `PI_CACHE_RETENTION` | `QI_CACHE_RETENTION` |
| `PI_HARDWARE_CURSOR` / `PI_TRUE_COLOR` / `PI_HYPERLINKS` / `PI_IMAGE_PROTOCOL` | `QI_HARDWARE_CURSOR` / `QI_TRUE_COLOR` / `QI_HYPERLINKS` / `QI_IMAGE_PROTOCOL` |
| `PI_TUI_ESC_TIMEOUT` / `PI_CLEAR_ON_SHRINK` | `QI_TUI_ESC_TIMEOUT` / `QI_CLEAR_ON_SHRINK` |
| `PI_SUBAGENT_*` | `QI_SUBAGENT_*` |
| `PI_AI_DEBUG` / `PI_TIMING` / `PI_STARTUP_BENCHMARK` | `QI_AI_DEBUG` / `QI_TIMING` / `QI_STARTUP_BENCHMARK` |
| `PI_ALLOW_LOCKFILE_CHANGE` | `QI_ALLOW_LOCKFILE_CHANGE` |

## 4. Update CLI Invocations & Wrapper Scripts

Replace `pi` with `qi` in all scripts, aliases, editor integrations, and tmux helpers. Reinstall global packages under the `@bramburn/qi-coding-agent` scope.
```

---

## Traceability

- **Realises:** `REQ-REBRAND` (D1 full hard cut, D2 `@bramburn/qi-*` package identity, D4 sever upstream endpoints)
- **Depends on ADRs:** `ADR-0001`, `ADR-0002`
- **References:** `scripts/check-no-earendil.mjs`, `scripts/check-pinned-deps.mjs:1-66`, `package.json:14-48`
=== END FILE ===

Rationale: Add `scripts/check-no-earendil.mjs` (plus its initial empty baseline file `scripts/qi-brand-allowlist.json` and `scripts/check-pinned-deps.mjs:27` workspace prefix update) to guard CI against `earendil` and `pi`-brand regressions across code, docs, and config surfaces while honouring the exclusion policy and `--list` / `--json` modes.

```diff
--- /dev/null
+++ b/scripts/qi-brand-allowlist.json
@@ -0,0 +1,4 @@
+{
+	"ignoreFiles": [],
+	"ignoreLinePatterns": []
+}
--- /dev/null
+++ b/scripts/check-no-earendil.mjs
@@ -0,0 +1,148 @@
+import { existsSync, readdirSync, readFileSync } from "node:fs";
+import { extname, join } from "node:path";
+
+const args = new Set(process.argv.slice(2));
+const listMode = args.has("--list");
+const jsonMode = args.has("--json");
+
+// Directories excluded from traversal (Categories F, G, H in specs/batch/rebrand-sweep-checklist.md)
+const ignoredDirectories = new Set([
+	".git",
+	".worktrees",
+	"worktrees",
+	".claude",
+	"dist",
+	"node_modules",
+	".artifacts",
+	"types",
+	"lab",
+	"checkpoint-evidence",
+	"scratch",
+	"research",
+	"install-lock",
+]);
+
+// Specific files excluded (lockfiles, generated artifacts, immutable historical specs/changelogs)
+const ignoredFiles = new Set([
+	"package-lock.json",
+	"bun.lock",
+	"packages/coding-agent/npm-shrinkwrap.json",
+	"packages/ai/src/models.generated.ts",
+	"scripts/check-no-earendil.mjs",
+	"scripts/qi-brand-allowlist.json",
+	"specs/batch/batch-context.md",
+	"specs/batch/rebrand-sweep-checklist.md",
+]);
+
+const scannedExtensions = new Set([
+	".ts",
+	".tsx",
+	".js",
+	".mjs",
+	".cjs",
+	".json",
+	".md",
+	".mdx",
+	".yml",
+	".yaml",
+	".sh",
+	".ps1",
+	".cmd",
+	".feature",
+]);
+
+const allowlistPath = "scripts/qi-brand-allowlist.json";
+const allowlist = existsSync(allowlistPath)
+	? JSON.parse(readFileSync(allowlistPath, "utf8"))
+	: { ignoreFiles: [], ignoreLinePatterns: [] };
+const allowlistFiles = new Set(allowlist.ignoreFiles ?? []);
+const allowlistRegexes = (allowlist.ignoreLinePatterns ?? []).map((p) => new RegExp(p));
+
+const rules = [
+	{
+		id: "earendil-ref",
+		description: "Upstream earendil reference",
+		pattern: /earendil(?:-works)?/i,
+	},
+	{
+		id: "pi-package-scope",
+		description: "Legacy pi package scope (@earendil-works/pi-* or @bramburn/pi-*)",
+		pattern: /@(?:earendil-works|bramburn)\/pi-[a-z0-9-]+/,
+	},
+	{
+		id: "pi-dev-endpoint",
+		description: "Upstream pi.dev endpoint or URL",
+		pattern: /\bpi\.dev\b/,
+	},
+	{
+		id: "pi-env-var",
+		description: "Legacy PI_* environment variable",
+		pattern: /\bPI_(?:CODING_AGENT_DIR|PACKAGE_DIR|MODEL|PROVIDER|SESSION_FILE|SESSION_ID|REASONING_LEVEL|TELEMETRY|OFFLINE|SKIP_VERSION_CHECK|CACHE_RETENTION|HARDWARE_CURSOR|HYPERLINKS|IMAGE_PROTOCOL|SHARE_VIEWER_URL|TRUE_COLOR|TUI_ESC_TIMEOUT|AI_DEBUG|SUBAGENT_[A-Z0-9_]+|BUNDLED_NODE|CLEAR_ON_SHRINK|INSTALLER_API_BASE|STARTUP_BENCHMARK|TIMING|ENVIRONMENT|ALLOW_LOCKFILE_CHANGE)\b/,
+	},
+	{
+		id: "pi-config-dir",
+		description: "Legacy ~/.pi or .pi/ directory path",
+		pattern: /(?:~\/\.pi\b|['"`\s(]\.pi\/)/,
+	},
+	{
+		id: "pi-brand-token",
+		description: "Legacy pi brand identifier (pi-monorepo, pi-coding-agent, piConfig, pi.share, .pi-session)",
+		pattern: /\b(?:pi-monorepo|pi-coding-agent|piConfig|pi\.share|pi-session|pi-package)\b/,
+	},
+];
+
+function shouldSkipFile(relPath) {
+	if (ignoredFiles.has(relPath) || allowlistFiles.has(relPath)) return true;
+	if (relPath.startsWith("specs/.history/")) return true;
+	if (relPath.endsWith("/CHANGELOG.md") || relPath === "CHANGELOG.md") return true;
+	const ext = extname(relPath);
+	return !scannedExtensions.has(ext);
+}
+
+const candidateFiles = [];
+
+function walk(dir) {
+	for (const entry of readdirSync(dir, { withFileTypes: true })) {
+		const relPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
+		if (entry.isDirectory()) {
+			if (!ignoredDirectories.has(entry.name)) {
+				walk(relPath);
+			}
+			continue;
+		}
+		if (entry.isFile() && !shouldSkipFile(relPath)) {
+			candidateFiles.push(relPath);
+		}
+	}
+}
+
+walk(".");
+
+const findings = [];
+
+for (const file of candidateFiles.sort()) {
+	const content = readFileSync(file, "utf8");
+	const lines = content.split(/\r?\n/);
+	for (let i = 0; i < lines.length; i++) {
+		const line = lines[i];
+		if (allowlistRegexes.some((rx) => rx.test(`${file}:${line}`))) continue;
+		for (const rule of rules) {
+			const match = line.match(rule.pattern);
+			if (match) {
+				findings.push({
+					file,
+					line: i + 1,
+					rule: rule.id,
+					match: match[0],
+					snippet: line.trim().slice(0, 140),
+				});
+			}
+		}
+	}
+}
+
+if (jsonMode) {
+	console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
+} else if (listMode) {
+	for (const f of findings) {
+		console.log(`${f.file}:${f.line} [${f.rule}] ${f.match}`);
+	}
+} else if (findings.length > 0) {
+	console.error(`Found ${findings.length} prohibited pi/earendil brand occurrence(s):`);
+	for (const f of findings.slice(0, 100)) {
+		console.error(`  ${f.file}:${f.line} [${f.rule}] ${f.match} -> ${f.snippet}`);
+	}
+	if (findings.length > 100) {
+		console.error(`  ... and ${findings.length - 100} more (run with --list or --json for full output).`);
+	}
+	process.exit(1);
+}
+
+if (findings.length > 0) {
+	process.exit(1);
+}
--- a/scripts/check-pinned-deps.mjs
+++ b/scripts/check-pinned-deps.mjs
@@ -24,7 +24,7 @@
 }
 
 function isInternalWorkspaceDependency(name) {
-	return name.startsWith("@earendil-works/pi-") || name.startsWith("@earendil-works/pi-");
+	return name.startsWith("@bramburn/qi-");
 }
 
 function isNonRegistrySpecifier(specifier) {
```

Verification:
- Run `node scripts/check-no-earendil.mjs --list` and `node scripts/check-no-earendil.mjs --json` to verify output formatting and exit code `1` while legacy occurrences remain, and exit code `0` once sweep batches A–E complete.
- Add unit test in `scripts/check-no-earendil.test.mjs` (run via `bun test scripts/*.test.mjs`) asserting that excluded paths (`types/`, `lab/`, `checkpoint-evidence/`, `scratch/`, `research/`, `dist/`, `package-lock.json`, `bun.lock`) are skipped and prohibited tokens (`@earendil-works/pi-ai`, `pi.dev`, `PI_CODING_AGENT_DIR`, `~/.pi/agent`) trigger a non-zero exit.

Rationale: Wire `check:qi-brand` into `package.json:18-24` so `bun run check:qi-brand` and `bun run check` execute `node scripts/check-no-earendil.mjs`.

```diff
--- a/package.json
+++ b/package.json
@@ -15,9 +15,10 @@
 		"clean": "bun run --if-present --filter '*' clean",
 		"build": "bun run --cwd packages/tui build && bun run --cwd packages/telemetry build && bun run --cwd packages/ai build && bun run --cwd packages/agent build && bun run --cwd packages/session-backends/sqlite-node build && bun run --cwd packages/protocol build && bun run --cwd packages/client build && bun run --cwd packages/server build && bun run --cwd packages/coding-agent build",
 		"build:offline": "bun run --cwd packages/tui build && bun run --cwd packages/telemetry build && bun run --cwd packages/ai build:offline && bun run --cwd packages/agent build && bun run --cwd packages/session-backends/sqlite-node build && bun run --cwd packages/protocol build && bun run --cwd packages/client build && bun run --cwd packages/server build && bun run --cwd packages/coding-agent build",
-		"check": "biome check --write --error-on-warnings --no-errors-on-unmatched . && bun run check:pinned-deps && bun run check:ts-imports && bun run check:shrinkwrap && bun run check:install-lock:coding-agent && tsgo --noEmit && bun run check:browser-smoke",
+		"check": "biome check --write --error-on-warnings --no-errors-on-unmatched . && bun run check:pinned-deps && bun run check:qi-brand && bun run check:ts-imports && bun run check:shrinkwrap && bun run check:install-lock:coding-agent && tsgo --noEmit && bun run check:browser-smoke",
 		"check:browser-smoke": "node scripts/check-browser-smoke.mjs",
 		"check:pinned-deps": "node scripts/check-pinned-deps.mjs",
+		"check:qi-brand": "node scripts/check-no-earendil.mjs",
 		"check:shrinkwrap": "node scripts/generate-coding-agent-shrinkwrap.mjs --check",
 		"check:install-lock:coding-agent": "node scripts/generate-coding-agent-install-lock.mjs --check",
 		"check:ts-imports": "node scripts/check-ts-relative-imports.mjs",
```

Verification:
- Run `bun run check:qi-brand` from the repo root and confirm it invokes `node scripts/check-no-earendil.mjs`.

---
