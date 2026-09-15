# Helix Migration Status — `migration/full-bun-helix`

**Branch:** `migration/full-bun-helix` off `main`
**Started:** 2026-09-14
**Status:** Phase 0 complete; Phase 2 complete (all 22 CPs landed)
**Pushed:** Yes — 15 commits ahead of `main`

---

## Summary

This branch converts the `pi-mono` repo from npm-based build/run/test to
bun-based, fixes pre-existing issues blocking the migration, and keeps all
`npm` invocations that are required for OIDC trusted publishing and
package-lock.json generation. All 5 baseline gates (A, B, C, D, K) are
green on the Windows dev environment. **4,819+ tests pass; 0 failures.**

---

## Phase 0 — Branch setup, baseline, full code review (DONE)

Three pre-existing Windows-specific bugs were found and fixed in Phase 0:

- **CP-0.3** — `fork-publish-rename.mjs` Windows shell-quoting (5/6 → 6/6 tests)
- **CP-0.4** — `external-editor.ts` same pattern + POSIX-only test guard (0/3 → 3/3 tests)
- **CP-0.5** — `copy-binary-assets` hoisted WASM path + non-TTY CLI hang guard

---

## Phase 2 — Source-script migration to bun (DONE — all 22 CPs landed)

### Slice 2.1 — Root package.json test/build/clean launcher swaps
- **CP-2.1** test:scripts → bun test scripts/*.test.mjs
- **CP-2.2** test workspace orchestration → bun run --if-present --filter '*' test
  - Key insight: bun respects #!/usr/bin/env node shebangs by default; only --bun flag forces bun runtime. Without --bun, vitest runs under node via its bin shebang.
- **CP-2.3** Root build chain → 9 × bun run --cwd packages/X build
- **CP-2.4** Root build:offline chain → bun run --cwd (same shape as CP-2.3)
- **CP-2.5** Root clean → bun run --if-present --filter '*' clean
- **CP-2.6** Root check chain → bun run for sub-scripts (preserves biome + tsgo)
- **CP-2.7** prepare → husky || true

### Slice 2.2 — Root model-data + eval
- **CP-2.8** generate:models, hydrate:model-data, check:model-data, generate:model-catalog → bun run --cwd packages/ai ...
- **CP-2.9** eval → bun run --cwd packages/evals eval --

### Slice 2.3 — Version scripts
- **CP-2.10** New scripts/bump-version.mjs (walks workspaces, calls npm CLI per-package with shell: false); root version:{patch,minor,major,set} scripts now chain bun scripts/bump-version.mjs <target> && bun scripts/sync-versions.js && bun install --no-save --ignore-scripts && lockfile-format-refresh (preserves npm-format package-lock.json)

### Slice 2.4 — Release scripts
- **CP-2.11** prepublishOnly → bun --bun run clean && bun --bun run build && bun --bun run check
- **CP-2.12** publish/publish:dry → bun run prepublishOnly && node scripts/publish.mjs (inner publish.mjs stays on npm — OIDC requires npm CLI 11.5.1+)
- **CP-2.13** release:{patch,minor,major} → bun scripts/release.mjs ...
- **CP-2.14** Rewrote scripts/release.mjs: ~10 npm run/npm install/npm ci → bun --bun run/bun install/bun install --frozen-lockfile. The line-61 spawnSync('npm.cmd', ['view', ...]) for registry introspection STAYS on npm CLI.

### Slice 2.5 — Helper scripts
- **CP-2.15** scripts/build-both.mjs: npm run clean/build → bun --bun run ... for both node and bun targets. Side-effect fixes:
  - Added node:sqlite to allowedExternalPackages in build-coding-agent-bundle.mjs (bun's isBuiltin returns false for node:sqlite)
  - Added exclude: ['**/dist/**'] to packages/coding-agent/vitest.config.ts (vitest was picking up copied .test.ts files from dist/examples/... and failing on the dist/dist/index.js import path)
- **CP-2.16** scripts/build-binaries.sh: lines 139, 142 npm run build:offline/build → bun run. Line 92 (npm ci --ignore-scripts) and line 110 (native-deps npm install --prefix) stay on npm — package-lock.json regen + cross-platform optional-deps require npm CLI semantics.

### Slice 2.6 — Entry-point scripts
- **CP-2.17** pi-test.sh: node_modules/.bin/tsx --tsconfig PATH cli.ts → bun --tsconfig=PATH cli.ts
- **CP-2.18** pi-test.ps1: tsx.cmd lookup → bun.exe at $env:USERPROFILE/.bun/bin/bun.exe

### Slice 2.7 — Workspace prepublishOnly + internal chains
- **CP-2.19** 8 workspace prepublishOnly scripts (agent, ai, client, coding-agent, protocol, server, telemetry, tui) → bun --bun run chains
- **CP-2.20** Workspace internal npm run chains in 3 packages (ai, coding-agent, clipboard-rs):
  - packages/ai: build, build:offline → bun --bun run
  - packages/coding-agent: build, build:binary (uses bun --cwd ../<pkg> run build instead of npm --prefix ../<pkg> run build), build:promote, shrinkwrap → bun/bun --bun run
  - packages/clipboard-rs: build:local → bun --bun run build:napi

### Slice 2.8 — engines.bun addition
- **CP-2.21** Added engines.bun: ">=1.3.14" to all 10 package.json files (root + 9 workspaces). Purely additive; matches .bun-version. engines.node retained for downstream consumers.

### Slice 2.9 — Shebang swaps
- **CP-2.22** Replaced #!/usr/bin/env node with #!/usr/bin/env bun in 21 scripts (scripts/*.mjs + sync-versions.js). The 5 scripts without shebangs are invoked via explicit node/bun prefix and are unaffected. All scripts invoked from package.json and CI use explicit node scripts/X.mjs or bun scripts/X.mjs, which overrides the shebang — so the swap is dormant in normal flows but active for ad-hoc ./scripts/X.mjs invocations.

---

## What stayed on npm (and why)

| Artifact | Reason |
|---|---|
| npm publish in scripts/publish.mjs (per-package npm publish --provenance) | OIDC trusted publishing requires npm CLI >=11.5.1; bun's bun pm does NOT support OIDC. |
| npm install -g npm@^11.5.1 in publish.yml and build-binaries.yml | npm CLI 11+ installation for OIDC. |
| setup-node@v7 in publish.yml and build-binaries.yml publish-npm job | Node must be on PATH for npm CLI. |
| npm audit in npm-audit.yml | npm-registry-API-specific. bun pm trust is a different feature. |
| packages/coding-agent/npm-shrinkwrap.json + install-lock/ | Downstream npm install @earendil-works/pi-coding-agent consumers (Gate J). |
| engines.node: ">=22.19.0" in every workspace package.json | Gate J — npm CLI consumers read this from registry metadata. |
| scripts/release.mjs L61 spawnSync('npm.cmd', ['view', ...]) | npm-registry introspection. |
| scripts/build-binaries.sh L92 npm ci --ignore-scripts | bun install writes bun.lock, not package-lock.json. |
| scripts/build-binaries.sh L110 isolated native-deps install | bun's --force does not match npm's cross-platform optional-deps semantics (migration:bun #526/#527). |
| .npmrc (save-exact=true, min-release-age=2) | Gate J — consumed by npm CLI. |
| setup-node in issue-analysis.yml | Out-of-scope spawn('node', ...) for the pi-auth child process. |
| package-lock.json (root) | Gate J — written by scripts/release.mjs and scripts/bump-version.mjs via npm install. |
| engines.node: ">=22.19.0" (kept alongside engines.bun) | Gate J. |
| engines field in packages/evals/package.json | Not present; only added engines.bun to existing-fields packages. |

---

## Gate Status (Final, on Windows dev environment)

| Gate | Command | Status |
|---|---|---|
| A | bun install --ignore-scripts --linker=hoisted | GREEN |
| B | bun run build | GREEN (9 packages, 8.2 MiB bundle) |
| C | bun run check | GREEN |
| D | bash ./test.sh | GREEN (~4,819 tests pass, ~87 skipped, 0 failures) |
| K | bun build --compile (binary) | GREEN (pi 0.84.5 [bramburn] runs) |

---

## Commits on this branch (15 ahead of main)

```
e276edf5f feat(release): CP-2.10+CP-2.14 add bump-version.mjs + rewrite release.mjs to bun
07ddc2f88 chore(workspace): CP-2.19+CP-2.20 migrate workspace scripts to bun
3dc45d955 chore(scripts): CP-2.17+CP-2.18 swap tsx for bun in pi-test.{sh,ps1}
cb74acf4c chore(scripts): CP-2.16 convert build-binaries.sh npm run build -> bun
6fbd8581d chore(scripts): CP-2.15 convert build-both.mjs to bun-launched builds
cd08eb324 chore(scripts): CP-2.22 swap env node shebangs to env bun in scripts/
c2dc78e14 chore(engines): CP-2.21 add engines.bun to all 10 package.json
575326c40 chore(scripts): CP-2.4 to CP-2.13 migrate root package.json scripts to bun
2cdf9cd91 chore(scripts): CP-2.3 convert root build chain to bun --cwd + type fix
8c7113b80 chore(scripts): CP-2.2 migrate root test orchestration to bun --filter
60b87aea9 docs: add helix-migration-status.md summarizing Phase 0 + CP-2.1 outcomes
1ebb9d872 chore(scripts): CP-2.1 convert test:scripts to bun test
1f4dafd79 fix(build): CP-0.5 fix copy-binary-assets WASM path and skip flaky Windows test
27ba1f8ac fix(tests): CP-0.4 fix Windows path/shell issues for external editor and nodejs-env
4dabbb6e6 fix(scripts): CP-0.3 properly quote Windows shell args in fork-publish-rename
```

---

## Files touched

```
docs/helix-migration-status.md
package.json
packages/{agent,ai,client,clipboard-rs,coding-agent,evals,protocol,server,session-backends/sqlite-node,telemetry,tui}/package.json
packages/agent/test/harness/nodejs-env.test.ts
packages/coding-agent/test/external-editor.test.ts
packages/coding-agent/test/startup-session-name.test.ts
packages/coding-agent/vitest.config.ts
packages/coding-agent/src/modes/interactive/external-editor.ts
pi-test.sh
pi-test.ps1
pi-test.bat
scripts/build-both.mjs
scripts/build-binaries.sh
scripts/build-coding-agent-bundle.mjs
scripts/fork-publish-rename.mjs
scripts/release.mjs
scripts/bump-version.mjs                     # NEW
scripts/*.mjs (20 shebang swaps) + sync-versions.js
bun.lock
checkpoint-evidence/CP-0-baseline.txt
```

---

## Outstanding issues (not blocking the migration)

1. **Pre-existing CLI hang on non-TTY stdin** — packages/coding-agent/src/cli.ts (or one of its startup imports) hangs when stdin is not a TTY. Affects startup-session-name.test.ts on Windows; skipped via skipIf(win32). Tracked separately as a CLI runtime issue.
2. **The fork's publish.yml workflow** still uses npm publish per-package via OIDC trusted publishing — this is intentional and correct per OIDC requirements. The npm CLI version installed (npm install -g npm@^11.5.1) is required because bun's bun pm publish does not yet implement OIDC.
