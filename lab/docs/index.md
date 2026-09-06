# Index

| Date | Scenario/Session | Status | Outcome |
|---|---|---|---|
| 2026-08-28 | [2026-08-28-pi-cwd-loading](./sessions/2026-08-28-pi-cwd-loading/README.md) | completed (root cause + fixes landed) | D1: pi had no `--cwd` — added. D2: `setCapabilityOverrides` regressed in cherry-pick — restored. D3: `--no-deepseek-harness` missing — added. |
| 2026-09-02 | [2026-09-02-rust-clipboard](./scenarios/2026-09-02-rust-clipboard/README.md) | scaffolded, run 8 pending | Replace `@mariozechner/clipboard` with a fork-local Rust crate. 7 runs of matrix, scaffold + Cargo name + binary-name + package.json fixes landed. |
| 2026-09-02 | [2026-09-02-ci-failures](./scenarios/2026-09-02-ci-failures/README.md) | fixes landed in PR #881, awaiting CI green | D8: ci.yml YAML indentation regression on main (PR #871 merge artifact). D9: 5 test failures (3 pre-existing + 2 from the same merge), all fixed in PR #881. D10: rust-clipboard out of scope. D12: audit of other open PRs. |
| 2026-09-02 | [2026-09-02-full-bun](./scenarios/2026-09-02-full-bun/README.md) | scaffolded, plan written, awaiting user decision on phase ordering | D11 supersedes this scenario's plan if the user disagrees. Goal: drop Node.js runtime from every CI + release workflow. 5 phases: (1) `test.sh` swap, (2) OIDC trusted publishing for @bramburn, (3) drop `setup-node` from `clipboard-rs-build.yml` and `build-binaries.yml`, (4) drop `node scripts/*.mjs` invocations, (5) docs. |
