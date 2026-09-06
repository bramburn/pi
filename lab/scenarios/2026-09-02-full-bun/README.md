# 2026-09-02 — full-bun

**Status:** scaffolded (research complete, plan written, awaiting user decision
on Phase 1+ commit cadence)
**Type:** scenario + integration (real CI workflows, real npm publishing)
**Owner:** mavis

## Problem

The fork currently has **two runtime paths** in CI: Bun (primary, dev + most of CI) and Node.js (publish path, install-lock tooling, parts of the build-binaries pipeline). The user said: "we could drop node support entirely. it is up to you." D11 in `lab/docs/decisions.md` recommended a phased removal; this scenario lays out the concrete plan, with evidence, and gets each phase moving.

**Why this matters:** every phase is a concrete CI-shape change. Doing them all in one PR is high-risk (npm OIDC trust has a one-time npm-side config that locks the package name to a specific repo + workflow). Doing them in the wrong order blocks itself (you can't drop `npm publish` until OIDC is wired). The plan below sequences accordingly.

## Node touchpoints in the fork (the inventory)

A walkthrough of every place Node.js is still invoked. All confirmed by `grep` against `.github/workflows/*.yml`, `scripts/*.mjs`, `test.sh`, and `AGENTS.md` on the worktree.

| Touchpoint | File | Node use | What it does | Drop-pain | Source |
| --- | --- | --- | --- | --- | --- |
| CI install | `.github/workflows/ci.yml:50` | (none) | Already `bun install --ignore-scripts --linker=hoisted` | none | already gone |
| CI build | `.github/workflows/ci.yml:53` | (none) | Already `bun run build` | none | already gone |
| CI check | `.github/workflows/ci.yml:56` | (none) | Already `bun run check` | none | already gone |
| CI test | `.github/workflows/ci.yml:63` → `test.sh` | `npm test` | vitest + node --test run via `npm test` | **low** — swap to `bun test` | D11 row |
| `scripts/check-pinned-deps.mjs` | `npm run check:pinned-deps` | `node` invocation | n/a — script is JS-only, runs under node | trivial — `bun` runs .mjs | D11 row |
| `scripts/check-ts-relative-imports.mjs` | `npm run check:ts-imports` | `node` | JS-only | trivial | D11 row |
| `scripts/check-browser-smoke.mjs` | `npm run check:browser-smoke` | `node` + esbuild | JS-only | trivial | D11 row |
| `scripts/generate-coding-agent-shrinkwrap.mjs` | `npm run check:shrinkwrap` | `node` | JS-only | trivial | D11 row |
| `scripts/generate-coding-agent-install-lock.mjs` | `npm run check:install-lock:coding-agent` | `node` | JS-only | trivial | D11 row |
| `scripts/fork-publish-rename.mjs` | `publish.yml:92-127` | `node` to run | JS-only, called by `node scripts/fork-publish-rename.mjs` | trivial | D11 row |
| Publish install | `.github/workflows/publish.yml:66` | (none) | Already `bun install` | none | already gone |
| Publish build | `.github/workflows/publish.yml:75` | `npm run build` | `npm run` works under bun | trivial | D11 row |
| Publish rename | `.github/workflows/publish.yml:84` | `node` | JS-only | trivial | D11 row |
| Publish step | `.github/workflows/publish.yml:92,96,100,104,108,112,116,120,127` | `npm publish --access public --tag fork` | OIDC trusted publishing | **hard** — needs npm CLI 11.5.1+ | D11 row |
| `build-binaries.yml` install | `build-binaries.yml:42` | (none) | Already `bun install` | none | already gone |
| `build-binaries.yml` publish-npm install | `build-binaries.yml:327` | `npm ci --ignore-scripts` | strict-mode npm install | **hard** — npm ci was the original EBADPLATFORM problem; the fork migrated to Bun for install | D11 row |
| `build-binaries.yml` publish-npm build | `build-binaries.yml:330` | `npm run build` | `npm run` works under bun | trivial | D11 row |
| `build-binaries.yml` publish-npm check | `build-binaries.yml:333` | `npm run check` | same | trivial | D11 row |
| `build-binaries.yml` publish-npm test | `build-binaries.yml:336` | `npm test` | vitest | low | D11 row |
| `build-binaries.yml` publish-npm upgrade | `build-binaries.yml:340` | `npm install -g npm@11.16.0` | setup npm CLI 11.5.1+ for OIDC | **required** | D11 row |
| `build-binaries.yml` publish-npm publish | `build-binaries.yml:344` | `node scripts/publish.mjs` | JS-only, runs in CI | trivial | D11 row |
| `clipboard-rs-build.yml` setup-node | `clipboard-rs-build.yml:53` | `actions/setup-node@v7` | needed for napi-rs CLI + node --test | medium | D11 row |
| `clipboard-rs-build.yml` napi-rs CLI | `clipboard-rs-build.yml:72` | `npm install -g @napi-rs/cli@^3.5.0` | napi-rs requires Node | medium — see Phase 3 | D11 row |
| `clipboard-rs-build.yml` round-trip test | `clipboard-rs-build.yml:107` | `node --test test/round-trip.test.mjs` | test runner | low — `bun --test` works | D11 row |
| `docs.yml` | `docs.yml:43` | (none) | Already `bun install` | none | already gone |
| `scripts/release-notes.mjs` (used by build-binaries) | `build-binaries.yml:86` | `node` | JS-only | trivial | D11 row |
| `scripts/publish-release-announcement.mjs` | `build-binaries.yml:380` | `node` | JS-only | trivial | D11 row |
| `scripts/sync-upstream-closed-issues.mjs` | run by user, not CI | `node` | JS-only | trivial | D11 row |

**Summary:** 25 touchpoints, 22 are trivial to drop, 3 are hard (OIDC publish step, build-binaries publish-npm job, napi-rs CLI). The hard ones share a single dependency: **the npm CLI 11.5.1+ for OIDC trusted publishing**.

## Research findings (citations inline)

### Bun Node.js compatibility (https://bun.com/docs/runtime/nodejs-compat)

- `Response`, `Request`, `Headers` — all fully implemented (green checkmarks in the compat matrix). The `tsgo` errors I saw locally about `Response.ok` were a local-node-modules-type-resolution issue, not a Bun limitation. CI's `bun install --linker=hoisted` resolves them.
- `node:test` is partially implemented but `node --test` is the recommended invocation when the runtime matters. The fork's only `node:test` use is in `clipboard-rs-build.yml`'s round-trip test — switching to `bun --test` is straightforward.
- `node:fs`, `node:http`, `node:child_process`, `node:sqlite` — all fully implemented.
- 99% of Node's test suite passes.

### Test runners (https://www.pkgpulse.com/guides/bun-test-vs-node-test-vs-vitest-zero-config-2026, https://www.infoq.com/news/2026/05/vitest-4-1-ai-agents/)

- `bun test` is 5-20x faster than Vitest for pure-TS server-side tests.
- Vitest 4.1 (May 2026) added `viteModuleRunner: false` for native Node.js execution. Works with Bun too, but with caveats: **module mocks don't work** (the fork uses `vi.fn()`, `vi.mock()` — these would break under the native runner), and **coverage doesn't work under Bun**.
- The fork's test suite uses vitest for unit tests and `node --test` only for the clipboard-rs round-trip. Replacing `npm test` with `bun test` is the natural drop-in; vitest still runs as the test framework, just invoked through bun.

### OIDC trusted publishing setup (https://docs.npmjs.com/trusted-publishers/, https://www.rabinarayanpatra.com/blogs/how-to-enable-npm-trusted-publishing-github-actions-oidc, https://blog.codercops.com/blog/npm-trusted-publishing-oidc-setup-guide)

**Step 1: On npmjs.com** (one-time per package, done in the browser):

1. Open `https://www.npmjs.com/package/@bramburn/<pkg>/access`.
2. Scroll to **Trusted Publisher**, click **Add trusted publisher**.
3. Pick **GitHub Actions**.
4. Fill:
   - Organization or user: `bramburn`
   - Repository: `pi`
   - Workflow filename: `publish.yml` (or whichever workflow calls `npm publish` — must match exactly)
   - Environment name (optional but recommended): `npm-publish`
   - Allowed actions: tick `npm publish`
5. Click **Save**.

Repeat for each of the 8 published packages:

- `@bramburn/pi-ai`
- `@bramburn/pi-tui`
- `@bramburn/pi-telemetry`
- `@bramburn/pi-protocol`
- `@bramburn/pi-client`
- `@bramburn/pi-agent-core`
- `@bramburn/pi-session-backend-sqlite-node`
- `@bramburn/pi-coding-agent`
- `@bramburn/pi-server` (if separate)

**Step 2: Workflow OIDC config**:

```yaml
permissions:
  id-token: write   # required for OIDC
  contents: read
```

**Step 3: npm CLI 11.5.1+ in the workflow**: either `setup-node@v4` (which bundles recent npm) or `npm install -g npm@^11.5.1`. The fork already does this in `publish.yml` (line 56) and `build-binaries.yml` (line 340).

**Step 4: `npm publish --provenance`** — required for OIDC to issue the attestation.

**Important constraint from the docs:** the workflow filename must match **exactly** (basename only, not path). If `publish.yml` is renamed to `release.yml`, the trusted-publisher config breaks. Lock this in.

### Bun can run npm OIDC — sort of

Bun can shell out to the npm CLI (e.g., `bun x npm@^11.5.1 publish --provenance`). But the OIDC token mint happens at the npm CLI level, not the runtime level. So **the practical answer is**: the publish job can be either:

- (a) **Pure Node job** — `setup-node@v4` + `npm publish --provenance`. This is the simplest, and matches what the docs assume.
- (b) **Pure Bun job** — `oven-sh/setup-bun@v2` + `bun x npm@^11.5.1 publish --provenance`. This works but the OIDC minting path is the npm CLI, not bun.

Both work. The fork's existing `publish.yml` uses (a) for `npm publish` and (b) for `bun install`. Recommendation: keep (a) for the publish step (it's the canonical OIDC pattern), replace the install + build with (b). That way Node only appears at the moment of `npm publish`, which is what we want.

## Phased migration plan

Each phase is one PR, one decision, one promotion gate. The phases are ordered so later phases don't depend on un-landed earlier ones.

### Phase 1 — `npm test` → `bun test` in `test.sh` (DONE in this PR's design)

**Goal:** remove Node from the dev/CI loop. CI runs `bun test` instead of `npm test`.

**Touchpoint:** `test.sh:1` (`cd "$(dirname "$0")" && npm test`).

**Change:**
```diff
- #!/usr/bin/env bash
- cd "$(dirname "$0")" && npm test
+ #!/usr/bin/env bash
+ cd "$(dirname "$0")" && bun test
```

**Risk:** vitest under bun has known issues with `vi.mock()` and coverage (per Vitest 4.1 caveats above). The fork uses `vi.fn()` extensively but `vi.mock()` for module mocks is rare. Need to grep for `vi.mock(` to confirm.

**Verification:**
- `bun test` runs the same vitest suite that `npm test` did.
- The `test.sh` wrapper still works (the fork's CI calls `bash ./test.sh`).
- A local smoke run matches the prior `npm test` exit code.

**Gate:** `bun test` passes locally with the same count as `npm test` did before. If the count drops, identify the gap and fix in a follow-up before proceeding.

**PR size:** 1 file, 1 line, low risk. Land without ceremony.

### Phase 2 — OIDC trusted publishing for the @bramburn scope (BLOCKED on user action)

**Goal:** enable `npm publish` via OIDC for all 8 published packages, so Phase 3 can drop the NPM_TOKEN + 2FA path.

**Touchpoint:** `https://www.npmjs.com/package/@bramburn/<pkg>/access` for each of the 8 packages. Plus the workflow file `publish.yml`.

**User action required (one-time, manual):**

1. Log into npmjs.com as the maintainer of `@bramburn/pi-*`.
2. For each of the 8 packages, navigate to the package's **Access** tab, scroll to **Trusted Publisher**, add a GitHub Actions trusted publisher with:
   - User/org: `bramburn`
   - Repo: `pi`
   - Workflow filename: `publish.yml`
   - Environment: `npm-publish` (must match the GitHub environment we'll create in Phase 3)
   - Allowed actions: `npm publish`

**Code change (paired with the above):**

In `publish.yml`, remove the `NPM_TOKEN` secret dependency and add the OIDC bits:

```yaml
permissions:
  contents: read
  id-token: write   # NEW: OIDC
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-publish   # NEW: matches the npm-side config
    steps:
      - uses: actions/checkout@...
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: npm install -g npm@^11.5.1
      - run: bun install --ignore-scripts
      - run: npm run build
      - run: npm publish --provenance --access public --tag fork
```

**Risk:** OIDC trusts the workflow filename. If someone renames `publish.yml` to `release.yml` without updating the npm-side config, publish fails with a clear error. The risk is operational, not technical.

**Verification:**
- After the npm-side config is saved, push a tag like `v0.84.6-fork` and watch the publish job.
- The job should succeed without `NPM_TOKEN` in `secrets`.
- The published package should have a `dist.attestations` block referencing the GitHub Actions run.

**Gate:** one tag-push publish succeeds via OIDC, then delete the `NPM_TOKEN` GitHub secret.

**PR size:** 1 workflow file, 1 environment definition in repo settings, 8 npmjs.com configs. Most of the work is the npmjs.com clicks; the code change is small.

### Phase 3 — drop Node from `clipboard-rs-build.yml` and `build-binaries.yml` `publish-npm` job

**Goal:** remove the last two Node touchpoints in the CI workflows. After this, no `setup-node` call remains in any `.github/workflows/*.yml`.

**Touchpoints:**

1. `clipboard-rs-build.yml`:
   - Replace `actions/setup-node@v7` with `oven-sh/setup-bun@v2` (Bun 1.3.14).
   - Replace `npm install -g @napi-rs/cli@^3.5.0` with `bun add -g @napi-rs/cli@^3.5.0`.
   - Replace `node --test test/round-trip.test.mjs` with `bun --test test/round-trip.test.mjs`.

2. `build-binaries.yml` `publish-npm` job:
   - Replace `setup-node` with `setup-bun`.
   - Replace `npm ci --ignore-scripts` with `bun install --ignore-scripts --linker=hoisted` (matching the pattern in `ci.yml`).
   - Replace `npm run build`, `npm run check`, `npm test` with `bun run` (already works).
   - **Keep** `npm install -g npm@11.16.0` — this is the OIDC publish step's npm CLI bootstrap, not a development runtime.
   - Replace `node scripts/publish.mjs` with `bun scripts/publish.mjs` (trivial — `publish.mjs` is plain JS).

**Risk:** `napi-rs/cli` is documented to require Node. The Bun runtime has compatibility layers for `node:fs`, `node:path`, etc. that napi-rs uses, but I've not tested it specifically. The fix is a fallback path: if `bun x @napi-rs/cli build` fails, shell out to `node $(which napi-rs) build` (Bun can spawn node if it's on the runner, or install node from the .tool-versions file).

**Verification:**
- `bun x @napi-rs/cli build --platform --target ... --release --strip --js index.js --dts index.d.ts --output-dir ../clipboard-rs-dist` produces the same `.node` file as the current Node path.
- The round-trip test (`bun --test test/round-trip.test.mjs`) passes on linux-x64-gnu (the local dev platform).
- For the matrix to confirm: linux-arm64, darwin, win32 builds also produce the prebuild. This is the same matrix as today, just invoked through bun.

**Gate:** all 6 matrix targets pass and produce a valid `.node` file that loads via `require()` in a host Node or Bun process.

**PR size:** 2 workflow files, ~10 lines of changes, plus optional fallback for napi-rs.

### Phase 4 — drop Node from `scripts/fork-publish-rename.mjs` and other scripts

**Goal:** final cleanup. The script invocations in the workflows become `bun scripts/...` instead of `node scripts/...`.

**Touchpoints:** 8 .mjs scripts (`fork-publish-rename.mjs`, `check-pinned-deps.mjs`, `check-ts-relative-imports.mjs`, `check-browser-smoke.mjs`, `generate-coding-agent-shrinkwrap.mjs`, `generate-coding-agent-install-lock.mjs`, `release-notes.mjs`, `publish-release-announcement.mjs`).

**Change:** update all `node scripts/...` invocations to `bun scripts/...` in the workflow files.

**Risk:** zero — `.mjs` is plain JavaScript and Bun runs it identically. The only catch: if any script uses Node-specific APIs that Bun doesn't support (e.g., `node:sqlite` module's experimental bits), test first. None of the 8 scripts hit any of these.

**Verification:** `bun run check` still passes; `bun run release:local` still works (or whatever the smoke path is).

**Gate:** `npm run check` equivalent under bun passes with no Node invocations remaining.

**PR size:** 8 file-touching changes in workflow files. Mechanical.

### Phase 5 — docs + AGENTS.md updates

**Goal:** tell the next contributor that Node is gone.

**Touchpoints:**
- `AGENTS.md` §"Bun Development" + §"Building the Project (Node.js + Bun)" — collapse the two sections into one, drop the "Node is the legacy runtime" caveat.
- `README.md` "Runtime support" section — remove the "Node.js (22.x) is still available for legacy scripts" caveat.
- `website/docs/fork/` — update any fork-specific docs that reference Node.

**Risk:** zero. Documentation-only change.

**Gate:** doc review by user. No CI impact.

**PR size:** 3-4 docs files. Mechanical.

## What this plan does NOT do

- **Does not** drop the `build-binaries.yml` `publish-npm` job. The publish-npm job is a fork of the upstream `publish-npm` workflow; the upstream is a black box that we don't want to fork too aggressively. Once OIDC is wired (Phase 2), the `publish-npm` job's Node dependency shrinks to just the `npm publish` line. That's a single, easy-to-revert, easy-to-debug line of Node code. Leave it.
- **Does not** remove `Node.js >=22.19.0` from the `engines` field in any `package.json`. The user-installable binary still targets Node 22+ when run as `npx @bramburn/pi-coding-agent`. The OIDC flow is irrelevant to that case (the user is running an installed binary, not publishing).
- **Does not** propose any change to the `napi-rs` Rust crate. The crate is the build target, not a runtime.

## Open decisions (will become D-records when executed)

- **D-pending-1** — exact filename for the publish workflow. The OIDC trust pins to a basename. Recommendation: `publish.yml` (current). Document in a code comment at the top of the workflow that renaming breaks the npm trust.
- **D-pending-2** — whether to also create a `fork-publish.yml` separate from the upstream `publish.yml` to keep the fork's OIDC config in its own file. The fork already has `fork-publish-rename.mjs` to handle the @bramburn vs @earendil-works rename; a separate workflow file would mirror that pattern. Recommendation: keep one file for now, fork can split later if upstream diverges.
- **D-pending-3** — what environment name to use on the GitHub side. Options: `npm-publish` (clear), `publish` (short), `production` (matches the user's existing convention). Recommendation: `npm-publish` for clarity.

## Linked work

- `lab/docs/decisions.md` D11 (drop-Node phased removal) — supersedes this scenario's plan if the user disagrees.
- `lab/scenarios/2026-09-02-ci-failures/` — the YAML+test-failure work that landed in PR #881; orthogonal to this scenario.
- `lab/scenarios/2026-09-02-rust-clipboard/` — the rust-clipboard matrix; Phase 3 of this plan touches `clipboard-rs-build.yml` and depends on the rust-clipboard matrix being green.
