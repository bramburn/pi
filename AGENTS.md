# Development Rules

## Planned Features

- **Per-session default model** — allow each `.pi-session` file to carry its own preferred `defaultModel`, overriding the global setting. Currently `defaultModel` is global-only (`setDefaultModelAndProvider` writes to `~/.pi/settings.json`). Plan: `docs/per-session-model-plan.md`.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `bun run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests. `npm run check` still works (calls the same scripts); use `bun run` so the run is consistent with CI.
- Never run `bun run build` or `bun test` directly unless requested by the user; CI and `./test.sh` orchestrate the full build → check → test sequence.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts"`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Test Framework Conventions

### Vitest (default)

Most packages use vitest. Run a single test file from the package root:

```bash
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts
```

Vitest does NOT recognize `describe` / `it` / `beforeAll` from `node:test`. A
`node:test` suite run under vitest silently registers zero tests and exits 0 — a
false-confidence hazard. After any conversion or new test file, verify the suite
actually executed by checking the count line (`Tests  N passed (N)`) and
confirming `N > 0` and matches the prior `node:test` subtest count.

### Node test runner

`packages/tui` uses the built-in `node:test` runner. Run with `node --test
test/specific.test.ts`. Do not migrate `packages/tui` to vitest without
explicit user approval — it is the one package that intentionally uses
`node:test` for performance and hermeticity.

### Converting node:test → vitest

Mechanical pattern when a package migrates a suite:

1. Replace `import { describe, it, beforeAll } from "node:test";` with
   `import { describe, expect, it, beforeAll } from "vitest";` (add the imports
   the file actually uses).
2. Drop `import * as assert from "node:assert/strict";` — `expect` from vitest
   replaces it.
3. Sed substitutions (run from the package root):
   - `assert.equal(a, b)` → `expect(a).toBe(b)`
   - `assert.deepEqual(a, b)` → `expect(a).toEqual(b)`
   - `assert.ok(a)` → `expect(a).toBeTruthy()`
4. Mock helper: `import { vi } from "vitest"` (NOT `node:test/mock`); use
   `vi.fn()` / `vi.mock()` / `vi.spyOn()`.
5. For test files that assert on exact error-message strings, copy the exact
   text from the production source first — do not paraphrase. If the message
   has drift, decide whether to restore production text or update the test
   (track the choice in the PR body).

After conversion, run the test from the package root and confirm the count
line shows the expected number of tests. The full conversion (import swap +
sed substitutions + smoke test) should run `npm run check` clean before
commit — do not use `--no-verify` to bypass it.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `bun install --ignore-scripts --linker=hoisted`; CI uses the same flags. The legacy `npm install --ignore-scripts` and `npm ci --ignore-scripts` still work but are not what CI runs. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts` (or `bun install` to update `bun.lock` instead).
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Fork vs Upstream Remotes

This checkout is a fork of `earendil-works/pi` (the original upstream). Two remotes are configured:

- `origin` = `https://github.com/earendil-works/pi.git` (the upstream; read-only from this account)
- `fork` = `https://github.com/bramburn/pi.git` (the maintainer's fork; writable)

Rules:

- **Never push to `origin`.** This includes `origin/main`, `origin/<any-branch>`, and any tag pointing to an `origin` ref. All pushes — branches, tags, force-with-lease — go to `fork` only. Treat `origin` as read-only.
- **Never create a PR against `origin`**, including `origin/main` (`earendil-works/pi`). Every PR Claude opens targets `fork` (`bramburn/pi`), with `fork/main` as the base. The standard workflow is: push the branch to `fork`, then Claude opens the PR against `fork/main`. The user (not Claude) opens any PR against upstream from the GitHub UI.
- **Never auto-merge into `fork/main`.** A "Merge into fork/main" step in a test plan, follow-up list, or automation is a step Claude does **not** perform. PRs Claude opens are left for the user to review and merge. Do not include "Merge into fork/main" as an action item in PR descriptions, follow-up checklists, or any agent-issued task list.
- Before any push, double-check the remote name in the command. `git push origin <branch>` is the wrong command; `git push fork <branch>` is right.
- If a `gh` command targets `earendil-works/pi` and the API returns `user is blocked` / `HTTP 422: user is blocked`, surface the block to the user and stop. Do not retry against upstream via a different endpoint or token.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.
- **This repo is a fork of `earendil-works/pi`.** The `earendil-works/pi` repo blocks write access for external contributors — `gh issue create` silently fails with HTTP 403. Always create issues on the fork (`bramburn/pi`) unless the user explicitly confirms the upstream repo is writable.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI verifies and announces the npm release**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required. After publishing, `announce-pi-dev-release` verifies every public workspace package resolves at the exact release version and that its npm tarball is available, then writes the verified release marker to R2. `pi.dev/api/latest-version` reads that marker; it must never announce a release from npm before this job succeeds.

5. **If CI publish or announcement fails**: inspect the failed job. The publish helper is idempotent and skips package versions already present on npm; the announcement job rechecks availability before updating the R2 marker. Rerun the failed job or workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## Forking

When this repo is forked (e.g. `bramburn/pi` from `earendil-works/pi`), the fork needs build-time markers so users can tell at a glance that they are running the fork rather than upstream:

- `packages/coding-agent/src/config.ts` exports `FORK_NAME` (string) and uses it in the `pi --version` output. Format: `pi <version> [<FORK_NAME>]`.
- `packages/coding-agent/src/main.ts` references `FORK_NAME` in the `parsed.version` branch and prints `${FORK_NAME}` next to the version line.
- When changing the fork's identity (renaming, merging with another fork, dropping the fork marker), update `FORK_NAME` in `config.ts` and verify `pi --version` still prints the new marker. The output is the source of truth: if it doesn't say the right name, the constant is stale.
- Do NOT remove `FORK_NAME` to "match upstream" without explicit user instruction — the fork marker is intentional even though upstream lacks it. The fork publishes to its own npm scope and the marker tells users which scope's binaries they have installed.
- `packages/coding-agent/test/stdout-cleanliness.test.ts` `--version` assertion regex must match the fork marker. If the fork version is a pre-release (e.g. `0.84.2-b1`), the regex needs to accept the `-<suffix>` portion in addition to `<digit>.<digit>.<digit>`.

### Fork sync (origin/main -> fork main)

When upstream `earendil-works/pi` ships a new release and the fork needs to follow:

1. **Open a sync branch** off fork `main` (`git checkout -b sync/upstream-<version> fork/main`). Do not commit fork-local work to a long-lived branch.
2. **Merge `origin/main` into the sync branch**: `git merge --no-ff origin/main -m "Merge upstream <version> into bramburn/pi"`. Resolve conflicts with the table in `.pi/plans/sync-upstream-<version>.md`.
3. **Bump all workspace package versions to `<version>-b<patch>`** (e.g. `0.84.2-b1`). The fork suffix signals "fork build on the upstream baseline" without colliding with upstream tags.
4. **Regenerate `packages/coding-agent/npm-shrinkwrap.json`** via `node scripts/generate-coding-agent-shrinkwrap.mjs`.
5. **Regenerate `packages/coding-agent/install-lock/package.json` and `package-lock.json`** via `node scripts/generate-coding-agent-install-lock.mjs` so the CI `check:install-lock:coding-agent` step passes.
6. **Re-apply fork-local preserves** that were either dropped by the merge (e.g. `FORK_NAME` references in `config.ts`/`main.ts`/`stdout-cleanliness.test.ts`) or that were never merged to fork main (e.g. `validateLlmMessages` lived only on a feature branch).
7. **Append a `### Fork-local (bramburn)` section** to each package's `CHANGELOG.md` under `## [Unreleased]`.
8. **Commit, push, open a PR to fork `main`, and rely on CI** for `npm run check` + `npm run build` + `npm test`. Do not run vitest locally; CI is cleaner.
9. **After CI passes**, push the fork tag: `git tag -a v<version>-b<patch> -m "..."; git push fork v<version>-b<patch>`.

### Windows prebuild file lock

On Windows, `git merge` / `git rebase` / `git reset --hard` will fail with `unable to unlink old ... Invalid argument` when the working tree contains
`packages/tui/native/win32/prebuilds/{win32-x64,win32-arm64}/win32-console-mode.node`
and a running `pi` TUI has the prebuild mmap'd. The fork has historically
held 4+ open pi TUI processes that pin these files.

Workaround: do NOT kill the pi TUI processes (they belong to user
sessions). Instead, when a git operation fails on the prebuild:

1. Determine which blob hash the operation needs from the target commit
   (`git ls-tree <target> packages/tui/native/win32/prebuilds/win32-x64/win32-console-mode.node`).
2. `git update-index --cacheinfo 100644,<hash>,<path>` to record the target
   blob in the index without touching the working tree. Git operations that
   only need the index (e.g. `git rebase` reading the index to compute the
   merge) then proceed without trying to unlink the locked file.
3. The working tree will be dirty against the index afterwards; reset the
   index for that file (`git restore --staged <path>`) before continuing.

The prebuild mismatch between working tree (fork's 3072 byte build) and
upstream's index (4608 byte build) is benign for `npm ci` on Linux CI but
shows up locally on Windows during branch switches.

### `.github/workflows/publish.yml` (fork-only)

The fork uses a fork-local publish workflow that runs `npm publish` per
package on tag push. Two structural rules from the current implementation:

- `npm ci --ignore-scripts` MUST run at the repo root before per-package
  builds; running it inside each package subdir skips workspace-root
  devDependencies (notably `@typescript/native-preview` which provides the
  `tsgo` binary), and every package's `npm run build` then fails with
  `sh: 1: tsgo: not found`.
- A single `npm run build` at the repo root builds every package in
  dependency order (tui → telemetry → ai → agent → session-backends/sqlite-node
  → protocol → client → server → coding-agent) and populates every `dist/`.
  Subsequent `cd packages/<x> && npm publish --access public` steps just
  publish from the prebuilt dist; do not reinstall or rebuild per package.
- When upstream renames a package (e.g. `storage/sqlite-node` →
  `session-backends/sqlite-node` in v0.84.2), update the matching publish
  step's `cd` path AND the `@bramburn/<x>` package name in `name:`.
- The current workflow uses `secrets.NPM_TOKEN` which is blocked by npm 2FA
  OTP (see *Known issues* in README.md). Switch to npm trusted publishing
  via OIDC (`id-token: write` + `npm-publish` environment) once the npm
  scope is configured, matching upstream's approach.

## Bun Development

### Building with Bun

Use `bun run --cwd <pkg>` for all builds in this repo. `bun` is the primary dev
runtime; Node.js is only needed when Bun-specific behavior needs testing.

```powershell
# Install deps (621 packages, exits 1 due to husky hook — benign)
bun install

# Build packages in dependency order
bun run --cwd packages/tui build
bun run --cwd packages/telemetry build
bun run --cwd packages/ai build        # needs @smithy/types + shx (see below)
bun run --cwd packages/agent build
bun run --cwd packages/session-backends/sqlite-node build
bun run --cwd packages/protocol build
bun run --cwd packages/client build
bun run --cwd packages/server build
bun run --cwd packages/coding-agent build

# Build the standalone Bun binary (pi.exe)
bun run --cwd packages/coding-agent build:binary
# Output: packages/coding-agent/dist/pi.exe
```

### Known Bun install quirks

- `@smithy/types` and `shx` get moved to `.old_modules-*` during `bun install`'s
  npm lockfile migration and are not reinstalled. Fix: `bun add @smithy/types shx`.
- `bun install` warns about nested `overrides` in `package.json` — this is
  cosmetic; all overrides are respected.
- `bun install` exits 1 because the `husky` post-install hook fails in a non-git
  context. The install itself succeeds.

### tsgo via Bun

`tsgo` works via Bun directly:

```bash
bun run node_modules/@typescript/native-preview/bin/tsgo.js --version
bun run node_modules/@typescript/native-preview/bin/tsgo.js -p tsconfig.build.json
```

### Bun package layout

Bun does **not hoist workspace dependencies** to the workspace root
(`packages/node_modules/`). Each workspace package has its own `node_modules/`.
The `copy-binary-assets` script uses `node_modules/...` (relative to
`packages/coding-agent/`) instead of `../../node_modules/...` (npm hoisting path).
Do not reintroduce the `../../node_modules/` pattern in shell scripts.

### PowerShell BOM trap

PowerShell's `Set-Content` adds a UTF-8 BOM (`EF BB BF`) to files by default.
`JSON.parse` in Node.js and Bun rejects BOM-prefixed JSON. **Never use
`Set-Content` or `Out-File` to write JSON files.** Use Node.js instead:

```javascript
// Correct — no BOM
const fs = require('fs');
fs.writeFileSync('package.json', JSON.stringify(data, null, 2), 'utf8');
```

### Testing the Bun binary

`pi-bun` is available on PATH via `C:\Users\bramburn\.pi\agent\bin\pi-bun.cmd`.
This wrapper calls `packages/coding-agent/dist/pi.exe` directly:

```powershell
pi-bun --version     # -> pi 0.84.2-b1 (bun) [bramburn]
pi-bun --list-models
pi-bun --help
```

Rebuild the binary after any source change:

```powershell
bun run --cwd packages/coding-agent build:binary
```

### Remaining Bun runtime issues

These are tracked as `migration:bun` issues on `bramburn/pi` and do not block
the build:

- `#524` — `process.report.getReport()` not implemented (windows-self-update)
- `#525` — `process.stdin.setRawMode` silently no-ops (migrations)
- `#526` — `createRequire` + CJS native addon (clipboard-native)
- `#527` — `createRequire` + CJS WASM package (photon)
- `#780` — `copy-binary-assets` npm-hoisting path (fixed in source)

## Building the Project (Node.js + Bun)

Use `scripts/build-both.mjs` (or the matching npm script `build:both`) to
build both the Node.js and Bun targets in one shot. The script detects
which runtimes are on `PATH`, runs the build for each target that is
both enabled and supported, and reports per-target status with a reason
for any skip or failure.

```powershell
npm run build:both            # build both, skip whichever runtime is missing
npm run build:bun             # build only the Bun binary

# Same scripts, but via the platform wrapper:
node scripts/build-both.mjs --node-only
node scripts/build-both.mjs --clean
.\scripts\build-both.ps1 --node-only
bash scripts/build-both.sh --bun-only
```

### What "built" means here

- **Node target** — runs `npm run build`, which compiles TypeScript via
  `tsgo` into `dist/` for every workspace package in dependency order.
  Expected artifact: `packages/coding-agent/dist/cli.js`.
- **Bun target** — runs `bun run --cwd packages/coding-agent build:binary`,
  which compiles all packages and then `bun build --compile`s a
  standalone binary. Expected artifact: `packages/coding-agent/dist/pi`
  (or `pi.exe` on Windows).

The Node target requires `node` on `PATH`. The Bun target requires
`bun` on `PATH`. The script itself runs in Node, so the Node target
is almost always available. The Bun target is skipped (not failed) when
`bun` is missing.

### Output format

The script prints a runtime-detection block, a per-target build log,
and a summary. Every target ends in one of three states:

- `BUILT    -> <artifact path>` — build succeeded and the expected
  artifact exists on disk.
- `SKIPPED  (<reason>)` — target was not built. Reasons: `--skip-node`,
  `--skip-bun`, `node not found on PATH`, `bun not found on PATH`.
- `FAILED   (<reason>)` — build exited non-zero or the expected
  artifact is missing. The script exits with code `1` in this case.

Example (both runtimes present):

```
[build-both] Runtime detection
[build-both] -------------------
[build-both] node  v22.21.1  C:\nvm4w\nodejs\node.exe
[build-both] bun   1.3.14    C:\Users\bramburn\.bun\bin\bun.exe

[build-both] Node target (v22.21.1)
[build-both] ------------------------
[build-both] $ node-build: npm run build
... npm run build output elided ...

[build-both] Bun target (1.3.14)
[build-both] ---------------------
[build-both] $ bun-build: bun run --cwd packages/coding-agent build:binary
... bun build output elided ...

[build-both] Summary
[build-both] ---------
[build-both] node  v22.21.1  C:\nvm4w\nodejs\node.exe
[build-both] bun   1.3.14    C:\Users\bramburn\.bun\bin\bun.exe
[build-both]
[build-both] Node  (npm run build)  BUILT    -> packages/coding-agent/dist/cli.js
[build-both] Bun   (build:binary)   BUILT    -> packages/coding-agent/dist/pi.exe
[build-both] 2 built, 0 skipped, 0 failed.
```

Example with only Node (no Bun on this machine):

```
[build-both] Runtime detection
[build-both] -------------------
[build-both] node  v22.21.1  C:\nvm4w\nodejs\node.exe
[build-both] bun   not found on PATH  (install from https://bun.sh to enable the Bun target)

[build-both] Bun target
[build-both] ------------
[build-both] Bun   SKIPPED  bun not found on PATH  (install from https://bun.sh to enable the Bun target)

[build-both] Summary
[build-both] ---------
[build-both] node  v22.21.1  C:\nvm4w\nodejs\node.exe
[build-both] bun   not found on PATH
[build-both]
[build-both] Node  (npm run build)  BUILT    -> packages/coding-agent/dist/cli.js
[build-both] Bun   (build:binary)   SKIPPED  (bun not found on PATH)
[build-both] 1 built, 1 skipped, 0 failed.
```

### Exit codes

- `0` — all enabled builds succeeded (skipped targets do not fail the script)
- `1` — one or more enabled builds failed
- `2` — invalid arguments
- `3` — script is not located inside a pi-monorepo checkout

### Flags

- `--node-only` — build only the Node target (implies `--skip-bun`)
- `--bun-only` — build only the Bun target (implies `--skip-node`)
- `--skip-node` — skip the Node target
- `--skip-bun` — skip the Bun target
- `--clean` — run `npm run clean --workspaces` before building
- `--quiet` — suppress per-step command lines (only the section headers
  and per-target status are printed)
- `-h`, `--help` — show the help text

### Platform wrappers

For convenience the orchestrator is also wrapped as:

- `scripts/build-both.sh` — bash on Unix / macOS / Git Bash on Windows
- `scripts/build-both.ps1` — PowerShell on Windows

Both wrappers `cd` to the repository root and forward every argument
to `node scripts/build-both.mjs`. They exist so you can invoke
`.\scripts\build-both.ps1 --node-only` or `bash scripts/build-both.sh --bun-only`
without remembering the `node` invocation.

### When to use which

- **`npm run build`** (or `npm run build:both -- --node-only`) — Node
  only; the default for the test pipeline and `npm run check` callers.
- **`npm run build:bun`** — Bun binary only; quick iteration on the
  `build:binary` step without re-doing the Node package builds twice.
- **`npm run build:both`** — both targets; use this when you want to
  verify the two build paths end-to-end on the same tree.
- **`node scripts/build-binaries.mjs --all`** (existing) — all six
  cross-platform binaries via `build-binaries.sh`. Different scope
  (release artifacts) and not run by `build:both`.
## Documentation (website/)

The Docusaurus site lives in `website/`. Docs live under `website/docs/`.

### Adding new pages

1. Create the `.mdx` file in the appropriate subdirectory under `website/docs/`
2. Add it to the matching section in `website/sidebars.ts`
3. Run `npm run build` from `website/` to verify no broken links

### Content rules

- **Fork docs only** — `website/docs/` documents the bramburn/pi fork. Upstream documentation lives at [pi.dev/docs/latest](https://pi.dev/docs/latest).
- **Architecture docs** go in `website/docs/architecture/`
- **Fork-specific docs** (sync process, fork features) go in `website/docs/fork/`
- **No placeholders** — every page must have real content. Remove the Docusaurus tutorial/blog boilerplate before committing.
- **Images** — generate with `mmx image generate --output <name> --aspect <ratio> --prompt "<prompt>"`. Put outputs in `website/static/img/`.
- **Link format** — use relative paths for internal links. Use absolute URLs for upstream docs.

### Docusaurus config

- `url` is `https://bramburn.github.io`, `baseUrl` is `/pi/` (GitHub Pages project URL)
- `onBrokenLinks: 'throw'` — CI fails on broken links
- `blog: false` — no blog in this fork

### CI

`.github/workflows/docs.yml` deploys on push to `main` (and feature branches) when `website/**` changes. GitHub Pages URL: `https://bramburn.github.io/pi/`.

### SEO

Every doc page must have a frontmatter `id`, `title`, and `sidebar_label`. OG image is `static/img/social-card.png`.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
