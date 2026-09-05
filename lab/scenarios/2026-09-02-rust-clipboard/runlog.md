# Runlog — 2026-09-02-rust-clipboard

Append-only. One row per experimental run. Never edit past rows; add a new row
to supersede.

| Run | Date (BST) | Commit | Status | Notes |
| --- | --- | --- | --- | --- |
| 0 | 2026-09-02 14:43 | (scenario only) | scaffolded | Created scenario folder, README, experiment.toml. No code yet. |
| 1 | 2026-09-02 14:46 | 3ef16e013 | scaffolded (CI) | First push. Pushed `packages/clipboard-rs/` skeleton + `clipboard-rs-build.yml`. CI failed in 1s with `Error when evaluating 'runs-on' for job 'build'. ... Unexpected value ''`. |
| 2 | 2026-09-02 14:48 | e3b90dd38 | scaffolded (CI fix) | Wrap matrix array in `target:` key so `matrix.target.runs-on` resolves. Re-pushed. PR #875 opened. CI queued. |
| 3 | 2026-09-02 14:58 | 6468d44ae (main) | buildable? | PR #875 merged to main. Matrix ran on all 6 platforms. **All 6 failed** at the `Build native addon` step with `error: invalid character '@' in package name: '@bramburn/clipboard-rs'`. Cargo rejects the npm-scoped name. |
| 4 | 2026-09-02 15:04 | 78c5e4bd2 | buildable? | Fix on the experiment branch: bare `pi-clipboard-rs` cargo name, `--binary-name clipboard-rs` flag, package.json `main` at root, `addon_marker` from `env!`. PR #877 opened. CI re-running. |
| 5 | 2026-09-02 15:08 | a7a860acc | buildable? | Merge conflict on PR #877: add/add on 4 files. Resolved with regular merge + `--ours` (kept the head's fixed version). |
| 6 | 2026-09-02 15:10 | c62b3b54f | buildable? | Local `cargo check` on Windows revealed two more bugs that would have hit CI: `napi-build = "3.0"` doesn't exist (only `2.4.x`); arboard 3.x default features link against X11 / Wayland. Pinned `napi-build = "2.1"` and added `libxcb1-dev` + `libwayland-dev` apt-get installs for both Linux matrix targets. |
| 7 | 2026-09-02 15:18 | fe4852402 | buildable? | Lazy `.node` require in `index.js` so importing on a platform without a prebuild doesn't throw ENOENT at module-load time. Platform-aware test that skips the round-trip on headless Linux (no DISPLAY / WAYLAND_DISPLAY) but still verifies the addon loads. Cargo.lock generated and tracked. |
| 8 | (pending) | (pending) | (pending) | Next matrix run. The 4 fixes from runs 4-7 should clear `cargo metadata` (run 3), `cargo build` (run 6), and the test step (run 7). If any platform still fails, it'll be a platform-specific arboard or linker issue recorded as a new run. |
