# 2026-09-02 — ci-failures

**Status:** scaffolded (root cause found for the most recent failure; full triage
of the other open PRs still in progress)
**Type:** scenario + integration (real GitHub Actions runs, real monorepo, real
six-platform clipboard matrix)
**Owner:** mavis

## Problem

The `bramburn/pi` fork has 4 open PRs in the upstream-repo style (no draft
flag, full CI) and **main itself is red** as of the most recent push
(`fb62a169a` "Merge pull request #871 from bramburn/issue-with-subagent" →
`.github/workflows/ci.yml` failed at 19:43:53Z on the merge commit). The user
asked for a full investigation: find the failing causes, fix them, and decide
whether to keep Node.js support or drop it entirely.

## Recent CI failures (bramburn/pi, fork only)

| Run id | Branch | Conclusion | What it ran |
| --- | --- | --- | --- |
| 33675057545 | main (push, merge PR #871) | **failure** | ci.yml |
| 33674889692 | issue-with-subagent (push, merge fork/main) | **failure** | ci.yml |
| 33664432592 | fix/followups-after-pr-879 (PR #880) | **failure** | ci.yml |
| 33663685418 | fix/followups-after-pr-879 (PR #880) | **failure** | ci.yml |
| 33664433585 | (code scanning AI on PR #880) | failure | code-scanning |
| 33663863175 | (code scanning AI on PR #876) | failure | code-scanning |

**Observation:** the two **ci.yml** failures (33675057545 and 33674889692)
are the same commit (the merge propagated into both branches), and the two
**PR #880** ci.yml failures are the same head SHA. Likely one root cause:
a YAML syntax error in `.github/workflows/ci.yml` line 49. Confirmed by
inspection (see D8 below). The "code scanning AI" failures are advisory and
do not block PR merges.

## Open PRs in scope

| PR | Branch | Title | State |
| --- | --- | --- | --- |
| #880 | fix/followups-after-pr-879 | fix(ci): browser-smoke plugin + matrix path filter + regen shrinkwrap | OPEN, CI red |
| #877 | feat/rust-clipboard | fix(clipboard-rs): Cargo package name + binary-name + package.json main | OPEN, CI green (awaiting matrix) |
| #876 | feat/analytics | feat(agent+coding-agent): Phase 1 local SQLite analytics instrumentation | OPEN, CI untested here |
| #873 | fix/fork-publish-rename-deps | fix(ci): rewrite dependencies and repository.url in fork-publish-rename | OPEN, CI untested here |

## Hypothesis (falsifiable)

**H1:** The current CI failures have a single dominant root cause — a YAML
indentation regression in `.github/workflows/ci.yml` introduced when
`bun install --linker=hoisted` was added to step 41. Fixing that one block
(8 spaces of indentation for the comment + `run:` lines, instead of 1)
restores `ci.yml` to a parseable state, which lets the test step run.
Falsified if, after the fix, `ci.yml` still fails for a different reason
or if any of the open PRs has a different blocking failure.

**H2 (deferred):** Dropping Node.js from the publish + build-binaries
workflows is a separate, larger decision. It would let us:
- delete `actions/setup-node` calls from `publish.yml` and `build-binaries.yml`
- replace `npm ci`/`npm test` with `bun install`/`bun test` in the same
  workflows
- keep `npm publish` (the OIDC trusted-publishing path needs `npm` CLI
  11.5.1+, which Bun cannot currently satisfy for the publish step itself)
This needs a separate D-record and a separate session.

## Open decisions (will become D-records)

- **D8** — the YAML indentation bug in `ci.yml` is the dominant cause of
  the current CI failures on main. (See below.)
- **D9** — for the clipboard-rs matrix, the existing
  `lab/scenarios/2026-09-02-rust-clipboard` session is the right home; this
  scenario only summarises its open status.
- **D10** — "drop node support" decision is a fork-level change that
  belongs in a follow-up session, not the immediate fix.

## Plan

1. **Confirm D8 by syntax check** — re-parse `ci.yml` with Python's PyYAML
   after the proposed fix; verify no parse error.
2. **Land the YAML fix** on a fresh worktree off fork/main, push to
   `fix/ci-yml-yaml-indent`, verify the CI workflow re-runs and passes
   the parse step. The user is the gate for landing.
3. **Audit PRs #873, #876, #880** — read the diffs, look for related YAML
   indentation issues or other causes of CI failure, write per-PR notes
   under `sessions/`.
4. **Audit the existing `lab/scenarios/2026-09-02-rust-clipboard` matrix
   status** — pull the latest run from `Build @bramburn/clipboard-rs
   native prebuilds` to see if run 8 of `runlog.md` has completed and on
   which platforms. If it has, append the measured result to that
   runlog and update the scenario status.
5. **Decide on Node.js** — write a D-record (likely D11) summarising the
   options and a recommendation. The user said "it is up to you" — the
   recommendation will go in the D-record, not as a unilateral change.
6. **One PR per session** — none of the open PRs are in scope for this
   scenario; they each get their own session folder under `sessions/`
   when we touch them.

## What this is NOT

- Not a fix for the upstream `earendil-works/pi` CI — the user maintains
  a fork, and the failures listed above are all in the fork's CI.
- Not a wholesale rewrite of the build system. The fork already uses
  Bun in `ci.yml`; "drop node" is a small surgical change, not a
  migration.
- Not an attempt to unblock the failed `code scanning AI` runs on
  PRs #880 / #876. Those are advisory only and don't block merge.

## Linked work

- `lab/scenarios/2026-09-02-rust-clipboard/` — the rust-clipboard
  scenario, which this scenario summarises but does not duplicate.
- `lab/docs/decisions.md` D1–D7 — earlier lab decisions; D8+ will
  be appended here.
- `lab/docs/index.md` — catalogue of every lab session/scenario.
- `AGENTS.md` §"Bun Development" + §"Building the Project (Node.js +
  Bun)" — the long-form runtime policy this scenario's D11 will
  eventually tighten.
