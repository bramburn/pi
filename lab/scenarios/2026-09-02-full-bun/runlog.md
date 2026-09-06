# Runlog — 2026-09-02-full-bun

Append-only. One row per inspection or per attempted phase. Never edit past
rows; add a new row to supersede.

| Run | Date (BST) | Commit | Status | Notes |
| --- | --- | --- | --- | --- |
| 0 | 2026-09-02 21:30 | (scenario only) | scaffolded | Created scenario folder, README, experiment.toml. Research + plan written, no code changes. |
| 1 | 2026-09-02 21:35 | (read) | measured | Walked every `.github/workflows/*.yml` and every `scripts/*.mjs` invocation. 25 Node touchpoints total: 22 trivial (just `node script.mjs` → `bun script.mjs` swap), 3 hard (OIDC publish, build-binaries publish-npm job, napi-rs CLI install). Inventory in `README.md` §"Node touchpoints in the fork". |
| 2 | 2026-09-02 21:40 | (read) | measured | Fetched `https://docs.npmjs.com/trusted-publishers/` and 3 secondary sources. OIDC trusted publishing is well-documented: 1-time npmjs.com config (per package), `permissions: id-token: write` in the workflow, `npm install -g npm@^11.5.1`, `npm publish --provenance`. Workflow filename pins to a basename — renaming breaks the trust. |
| 3 | 2026-09-02 21:42 | (read) | measured | Fetched `https://bun.com/docs/runtime/nodejs-compat` for the Bun 1.3.14 era. `Response`, `Request`, `Headers`, `node:fs`, `node:http`, `node:child_process`, `node:sqlite` all fully implemented. `node:test` partially implemented (the fork only uses `node --test` in `clipboard-rs-build.yml`, which is a simple `node --test test/round-trip.test.mjs` invocation — trivially swappable to `bun --test`). 99% of Node's test suite passes against Bun. |
| 4 | 2026-09-02 21:44 | (read) | measured | Verified the local `tsgo --noEmit` "Response.ok does not exist" errors I saw earlier are NOT a Bun limitation — they're a local-`node_modules` type-resolution issue (the worktree's `@types/node` resolution doesn't match what `bun install --linker=hoisted` produces in CI). CI's resolve is correct. No code action needed; this confirms the fork can move to Bun without losing `Response`/`Request`/`Headers` typing. |
| 5 | 2026-09-02 21:45 | (read) | measured | Bun + vitest: per Vitest 4.1 release notes, `viteModuleRunner: false` is the option to run tests natively, but with Bun the `vi.mock()` and coverage features are known-broken. The fork uses `vi.fn()` extensively but `vi.mock(` is rare. Need to grep before Phase 1 lands. |
| 6 | 2026-09-02 21:50 | (decision pending) | blocked | Awaiting user direction on phase ordering + which phases to actually execute. Three options: (a) execute phases 1→5 sequentially, one PR per phase; (b) bundle 1+4 (the trivial swaps) into one PR, then 2, then 3+5; (c) only do Phase 1+2 and treat 3-5 as deferred. Recommendation per plan: (a) — phased, low-risk, one PR per phase. |
