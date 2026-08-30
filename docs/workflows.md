# Project Workflows

Opinionated architecture and process workflows enforced for this fork
(`bramburn/pi`). Each entry is a navigable index entry — for the full
spec and rules, follow the `→ AGENTS.md` link to the originating
section. Workflows are grouped by area; numbered steps are the canonical
order; "gotchas" highlight the things that bite on first encounter.

Source-of-truth note: this catalog is a *pointer*. When AGENTS.md and
this file disagree, AGENTS.md wins. When a workflow changes, update
both. Workflows marked **(fork-only)** apply to `bramburn/pi` but not
upstream `earendil-works/pi`.

## Contents

- [Build & Tooling](#build--tooling)
  - [Bun build pipeline](#bun-build-pipeline)
  - [Bun install quirks](#bun-install-quirks)
  - [build-both orchestrator](#build-both-orchestrator)
  - [tsgo via Bun](#tsgo-via-bun)
  - [pi-bun wrapper on PATH](#pi-bun-wrapper-on-path)
- [Release & Versioning](#release--versioning)
  - [Lockstep versioning](#lockstep-versioning)
  - [Pre-release smoke test](#pre-release-smoke-test)
  - [CI publish + R2 announcement](#ci-publish--r2-announcement)
  - [Changelog under `[Unreleased]`](#changelog-under-unreleased)
- [Forking & Sync **(fork-only)**](#forking--sync-fork-only)
  - [FORK_NAME marker](#fork_name-marker)
  - [Fork sync from upstream](#fork-sync-from-upstream)
  - [`.github/workflows/publish.yml` rules](#githubworkflowspublishyml-rules)
  - [Pre-commit lockfile gate](#pre-commit-lockfile-gate)
- [Platform Quirks](#platform-quirks)
  - [Windows prebuild file lock](#windows-prebuild-file-lock)
  - [PowerShell BOM trap](#powershell-bom-trap)
  - [Bash ≠ Git Bash on Windows](#bash--git-bash-on-windows)
- [Process & Collaboration](#process--collaboration)
  - [Multi-session git safety](#multi-session-git-safety)
  - [Issues & PRs workflow](#issues--prs-workflow)
  - [Changelog attribution format](#changelog-attribution-format)
  - [Local pi-test TUI loop](#local-pi-test-tui-loop)
  - [Testing rules](#testing-rules)
  - [Dependency / lockfile hygiene](#dependency--lockfile-hygiene)
- [Planned](#planned)
  - [Per-session default model](#per-session-default-model)

---

## Build & Tooling

### Bun build pipeline

Bun is the primary dev runtime; Node is only for testing Bun-specific
behavior. Workspace deps are *not* hoisted to the repo root, so any
post-build script must use the workspace-local `node_modules/...`
relative path — never the npm-hoisting `../../node_modules/...` path
that Node workspaces produce.

Canonical order (per package, in dependency order):
`tui → telemetry → ai → agent → session-backends/sqlite-node →
protocol → client → server → coding-agent`.

Canonical build:
```bash
bun run --cwd packages/coding-agent build:binary
# Output: packages/coding-agent/dist/pi.exe (~107 MB on Windows)
```

Gotchas:
- The `copy-binary-assets` script must use `node_modules/...` (relative
  to the package), not `../../node_modules/...`. Issue #780
  historically regressed on this.
- The `ai` package regenerates `models.generated.ts` during build from
  external catalogs (models.dev, NVIDIA NIM, OpenRouter, Vercel AI
  Gateway). Treat that diff as expected.

→ AGENTS.md §"Bun Development", §"Building the Project (Node.js + Bun)"

### Bun install quirks

`bun install` has three cosmetic/intentional quirks:

1. `@smithy/types` and `shx` get moved to `.old_modules-*` during the
   npm-lockfile migration. Fix: `bun add @smithy/types shx`.
2. Nested `overrides` in `package.json` produce a warning. Cosmetic —
   all overrides are respected.
3. `bun install` exits 1 because the `husky` post-install hook fails in
   a non-git context. The install itself succeeded — ignore the exit
   code.

→ AGENTS.md §"Known Bun install quirks"

### build-both orchestrator

`scripts/build-both.mjs` (and the matching `npm run build:both`,
`build:bun`, `build:node` scripts; plus `.ps1`/`.sh` wrappers)
auto-detects Node/Bun on `PATH` and runs each enabled target. It
reports three states per target:

- `BUILT    -> <artifact path>`
- `SKIPPED  (<reason>)` — does not fail the script
- `FAILED   (<reason>)` — script exits 1

Use `npm run build:both` when you want both targets verified; use
`npm run build:bun` for fast Bun iteration; use
`npm run build:both -- --node-only` for the test pipeline.

Flags: `--node-only`, `--bun-only`, `--skip-node`, `--skip-bun`,
`--clean`, `--quiet`, `-h`. Exit codes: `0` ok, `1` failure, `2` bad
args, `3` not a pi-monorepo checkout.

→ AGENTS.md §"Building the Project (Node.js + Bun)"

### tsgo via Bun

`tsgo` is `@typescript/native-preview`'s standalone binary. Bun can
invoke it directly without npm scripts:
```bash
bun run node_modules/@typescript/native-preview/bin/tsgo.js --version
bun run node_modules/@typescript/native-preview/bin/tsgo.js -p tsconfig.build.json
```

`tsgo` is required for the `packages/ai`, `packages/agent`, and
`packages/coding-agent` builds. CI installs `@typescript/native-preview`
at the repo root before any per-package `npm ci` so the binary is on
PATH.

→ AGENTS.md §"tsgo via Bun"

### pi-bun wrapper on PATH

`C:\Users\bramburn\.pi\agent\bin\pi-bun.cmd` is a thin shim that calls
`packages/coding-agent/dist/pi.exe` directly. It exists so `pi-bun
--version` etc. work from any directory without `cd`-ing into the
repo. Rebuild the underlying exe after any source change:
```powershell
bun run --cwd packages/coding-agent build:binary
```

→ AGENTS.md §"Testing the Bun binary"

---

## Release & Versioning

### Lockstep versioning

All packages share one version. There is no major. `patch` = fixes +
additions, `minor` = breaking changes. Every release updates every
package's `package.json` and `CHANGELOG.md` together via the release
script.

→ AGENTS.md §"Releasing"

### Pre-release smoke test

Before `npm run release:patch|minor`:

1. Update CHANGELOGs — confirm `/cl` was run on the latest commit on
   `main`; if not, the user must run it.
2. Build an unpublished release into `/tmp/pi-local-release` and smoke
   test from *outside* the repo so workspace files don't resolve:
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp
   # Node: --help, --version, --list-models, -p "Say exactly: ok", TUI
   # Bun:  same set
   ```
3. Run the release script:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 \
     npm_config_min_release_age=0 \
     npm run release:patch    # or release:minor
   ```
4. Push `main` and the `vX.Y.Z` tag. CI takes over from here.

`npm_config_min_release_age=0` is only for the release command — the
normal npm age gate would otherwise block the lockfile refresh when
the workspace version was published recently. Do not rerun the release
script after a tag was pushed.

→ AGENTS.md §"Releasing"

### CI publish + R2 announcement

Pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`.

- The `publish-npm` job uses **npm trusted publishing** through GitHub
  Actions OIDC with environment `npm-publish`. No local `npm publish`,
  no `npm whoami`, no OTP, no WebAuthn.
- `announce-pi-dev-release` verifies every public workspace package
  resolves at the exact release version and that the npm tarball is
  available, then writes a verified release marker to R2.
- `pi.dev/api/latest-version` reads that R2 marker — it must never
  announce a release from npm before this job succeeds.

If CI publish or announcement fails: inspect the failed job. The
publish helper is idempotent (skips versions already on npm); the
announcement job rechecks availability before updating the R2 marker.
Rerun the failed job, not the release script.

→ AGENTS.md §"Releasing" §5

### Changelog under `[Unreleased]`

Per-package `CHANGELOG.md`, one file per package under `packages/*/`.

- All new entries go under `## [Unreleased]`. Read the full section
  first; append to existing subsections; never duplicate
  (`### Breaking Changes`, `### Added`, `### Changed`, `### Fixed`,
  `### Removed`).
- Released version sections (e.g. `## [0.12.2]`) are immutable. Never
  edit them.
- Do not create changelog entries on a non-`main` branch or pull
  request.

→ AGENTS.md §"Changelog"

---

## Forking & Sync **(fork-only)**

### FORK_NAME marker

`packages/coding-agent/src/config.ts` exports `FORK_NAME: string`
(=`"bramburn"`). It appears in `pi --version` output as
`pi <version> [<FORK_NAME>]`.

- Update `FORK_NAME` when changing fork identity (rename, merge with
  another fork, drop the marker).
- The output of `pi --version` is the source of truth. If the
  constant is stale, `--version` will be stale.
- Do NOT remove `FORK_NAME` to "match upstream" without explicit user
  instruction. The marker is intentional — it tells users which npm
  scope's binary they have installed.
- `packages/coding-agent/test/stdout-cleanliness.test.ts` must accept
  the marker. For pre-release versions like `0.84.2-b1`, the regex
  must accept the `-<suffix>` portion.

→ AGENTS.md §"Forking"

### Fork sync from upstream

When upstream `earendil-works/pi` ships a new release and the fork
needs to follow:

1. **Open a sync branch** off fork `main`:
   `git checkout -b sync/upstream-<version> fork/main`.
   Do not commit fork-local work to a long-lived branch.
2. **Merge `origin/main`** with `--no-ff`:
   `git merge --no-ff origin/main -m "Merge upstream <version> into bramburn/pi"`.
   Resolve conflicts using the table in
   `.pi/plans/sync-upstream-<version>.md`.
3. **Bump all workspace package versions** to `<version>-b<patch>`
   (e.g. `0.84.2-b1`). The `-b<patch>` suffix signals "fork build on
   the upstream baseline" without colliding with upstream tags.
4. **Regenerate `packages/coding-agent/npm-shrinkwrap.json`** via
   `node scripts/generate-coding-agent-shrinkwrap.mjs`.
5. **Regenerate `packages/coding-agent/install-lock/package.json` and
   `package-lock.json`** via
   `node scripts/generate-coding-agent-install-lock.mjs` so CI's
   `check:install-lock:coding-agent` step passes.
6. **Re-apply fork-local preserves** that were dropped by the merge
   (e.g. `FORK_NAME` references in `config.ts` / `main.ts` /
   `stdout-cleanliness.test.ts`) or that never landed on fork `main`
   (e.g. `validateLlmMessages`).
7. **Append `### Fork-local (bramburn)`** to each package's
   `CHANGELOG.md` under `## [Unreleased]`.
8. **Commit, push, open a PR to fork `main`, rely on CI** for
   `npm run check` + `npm run build` + `npm test`. Do not run vitest
   locally — CI is cleaner.
9. **After CI passes**, push the fork tag:
   `git tag -a v<version>-b<patch> -m "..."; git push fork v<version>-b<patch>`.

→ AGENTS.md §"Fork sync (origin/main -> fork main)"

### `.github/workflows/publish.yml` rules

The fork-local publish workflow runs `npm publish` per package on tag
push. Two structural rules:

- `npm ci --ignore-scripts` MUST run at the **repo root** before
  per-package builds. Running it inside each package subdir skips
  workspace-root devDependencies (notably
  `@typescript/native-preview` which provides the `tsgo` binary), and
  every package's `npm run build` then fails with
  `sh: 1: tsgo: not found`.
- A single `npm run build` at the repo root builds every package in
  dependency order and populates every `dist/`. Subsequent
  `cd packages/<x> && npm publish --access public` steps just publish
  from the prebuilt dist; do not reinstall or rebuild per package.
- When upstream renames a package (e.g. `storage/sqlite-node` →
  `session-backends/sqlite-node` in v0.84.2), update the matching
  publish step's `cd` path AND the `@bramburn/<x>` package name in
  `name:`.
- The current workflow uses `secrets.NPM_TOKEN` which is blocked by
  npm 2FA OTP. **TODO**: switch to npm trusted publishing via OIDC
  (`id-token: write` + `npm-publish` environment) once the npm scope
  is configured, matching upstream's approach.

→ AGENTS.md §"`.github/workflows/publish.yml` (fork-only)"

### Pre-commit lockfile gate

Pre-commit blocks lockfile commits unless
`PI_ALLOW_LOCKFILE_CHANGE=1` is set. Do not bypass unless the user
wants the lockfile change committed. Lockfile churn is a security
event (treat npm dep and lockfile changes as reviewed code; direct
external deps stay pinned to exact versions).

→ AGENTS.md §"Dependency and Install Security"

---

## Platform Quirks

### Windows prebuild file lock

On Windows, `git merge` / `git rebase` / `git reset --hard` fail with
`unable to unlink old ... Invalid argument` when the working tree
contains:
```
packages/tui/native/win32/prebuilds/{win32-x64,win32-arm64}/win32-console-mode.node
```
and a running `pi` TUI has the prebuild mmap'd. The fork has
historically held 4+ open pi TUI processes that pin these files.

**Workaround (do NOT kill the pi TUI processes — they belong to user
sessions):**

1. Find the target blob hash:
   `git ls-tree <target> packages/tui/native/win32/prebuilds/win32-x64/win32-console-mode.node`.
2. `git update-index --cacheinfo 100644,<hash>,<path>` to record the
   target blob in the index without touching the working tree. Git
   operations that only need the index (e.g. `git rebase` reading the
   index to compute the merge) then proceed without trying to unlink
   the locked file.
3. The working tree will be dirty against the index afterwards; reset
   the index for that file (`git restore --staged <path>`) before
   continuing.

The prebuild mismatch between the working tree (fork's 3072 byte
build) and upstream's index (4608 byte build) is benign for `npm ci`
on Linux CI but shows up locally on Windows during branch switches.

→ AGENTS.md §"Windows prebuild file lock"

### PowerShell BOM trap

PowerShell's `Set-Content` adds a UTF-8 BOM (`EF BB BF`) to files by
default. `JSON.parse` in Node.js and Bun rejects BOM-prefixed JSON.

**Never use `Set-Content` or `Out-File` to write JSON files.** Use
Node.js:
```javascript
const fs = require('fs');
fs.writeFileSync('package.json', JSON.stringify(data, null, 2), 'utf8');
```

This bites in two places: ad-hoc config tweaks and CI scripts that
auto-generate `package.json`/lockfiles. PowerShell 5.1's `-Encoding
UTF8` *also* emits a BOM.

→ AGENTS.md §"PowerShell BOM trap"

### Bash ≠ Git Bash on Windows

`bash.exe` on Windows PATH may resolve to the WSL launcher
(`WindowsApps\bash.exe`) instead of Git Bash. Symptoms: garbled
UTF-16 output, WSL install prompts. Recovery: switch to `node` /
`python` for shell work; locate Git Bash explicitly via
`& "C:\Program Files\Git\bin\bash.exe" script.sh`.

→ Windows behavior reminder in session.

---

## Process & Collaboration

### Multi-session git safety

Multiple pi sessions may run in the same cwd at the same time, each
modifying different files. Git operations that touch unstaged, staged,
or untracked files outside your own changes will stomp on other
sessions' work.

Rules:
- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never
  `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging
  your files.
- `packages/ai/src/models.generated.ts` may always be included
  alongside your files (it's regenerated by builds).

**Never run** (destroys other agents' work or bypasses checks):
`git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`,
`git add -A`, `git add .`, `git commit --no-verify`.

On rebase conflicts: resolve only in files you modified. If a conflict
is in a file you did *not* modify, abort and ask the user. Never force
push.

Commit message format:
`{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

→ AGENTS.md §"Git"

### Issues & PRs workflow

**Always create issues on the fork (`bramburn/pi`)**. The upstream
`earendil-works/pi` repo blocks write access for external contributors
— `gh issue create` silently fails with HTTP 403. Only use upstream if
the user explicitly confirms it's writable.

When reviewing PRs:
- Do not run `gh pr checkout`, `git switch`, or otherwise move the
  worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show` /
  `git diff` against fetched refs to inspect PR metadata, commits, and
  patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files
  or use `git show <ref>:<path>` without switching branches.

When creating issues:
- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`,
  `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:
- Write the comment to a temp file and post with
  `gh issue/pr comment --body-file` (never multi-line markdown via
  `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line
  specified by the originating prompt (e.g. `This comment is
  AI-generated by `/wr``).

When closing issues via commit:
- Include `fixes #<n>` or `closes #<n>` in the message so merging
  auto-closes the issue. For multiple issues, repeat the keyword per
  issue (`closes #1, closes #2`); a shared keyword
  (`closes #1, #2`) only closes the first.

→ AGENTS.md §"Issues and PRs"

### Changelog attribution format

- Internal (from issues):
  `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions:
  `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

→ AGENTS.md §"Changelog" attribution block

### Local pi-test TUI loop

Run the TUI in a controlled terminal (from the repo root) for
interactive smoke testing:
```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys
tmux kill-session -t pi-test
```

The pre-release smoke test runs each artifact through this loop (bare
`pi` starts interactive mode) — see
[Pre-release smoke test](#pre-release-smoke-test).

→ AGENTS.md §"Testing pi Interactive Mode with tmux"

### Testing rules

- After code changes (not docs): `npm run check` (full output, no
  tail). Fix all errors, warnings, and infos before committing. Does
  not run tests.
- Never run `npm run build` or `npm test` unless requested by the
  user.
- Never run the full vitest suite directly: it includes e2e tests
  that activate when endpoint/auth env vars are present.
- For non-e2e tests, run `./test.sh` from the repo root. Otherwise run
  specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or
  implementation until it passes.
- For `packages/coding-agent/test/suite/`, use
  `test/suite/harness.ts` + the faux provider. No real provider APIs,
  keys, or paid tokens.
- Put issue-specific regressions under
  `packages/coding-agent/test/suite/regressions/` named
  `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run,
  edit if needed, remove when done. Don't embed multi-line scripts in
  `bash` commands.
- Never commit unless the user asks.

→ AGENTS.md §"Commands"

### Dependency / lockfile hygiene

- Treat npm dep and lockfile changes as reviewed code. Direct
  external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes
  for the target version and evaluate whether any changes may affect
  functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean /
  CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts
  unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with
  `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run
  `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with
  `--check` or `npm run check`). New deps with lifecycle scripts
  require review and an explicit allowlist entry in that script; never
  add one silently.
- Pre-commit blocks lockfile commits unless
  `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants
  the lockfile change committed.

→ AGENTS.md §"Dependency and Install Security"

---

## Planned

### Per-session default model

Goal: allow each `.pi-session` file to carry its own preferred
`defaultModel`, overriding the global setting. Currently `defaultModel`
is global-only (`setDefaultModelAndProvider` writes to
`~/.pi/settings.json`).

→ AGENTS.md §"Planned Features", `docs/per-session-model-plan.md`
