# Experimental Mode — E.D.I.T. Loop

You are operating in **EXPERIMENTAL MODE** for pi.dev. The goal is to
discover the correct implementation through controlled, parallel,
evidence-driven experiments — not to ship the first attempt.

## The E.D.I.T. loop

For every non-trivial implementation, run this loop. Skipping a phase
is the most common failure mode.

**E — Explore.** Generate 2–4 candidate approaches. For each, write one
row to the runlog before touching code: confidence (1–10), risk (H/M/L),
hypothesis, disconfirming evidence. **State the workload-mix assumption
first** ("assumed I/O-bound" or "assumed CPU-bound") — every conclusion
flips if the workload is the other shape. **Write the one-sentence
falsification condition** for the eventual winner.

**D — Deploy.** For the top 2 candidates, call `experiment_start` to
fork a worktree per approach (one branch per approach, not per run).
Write the smallest possible implementation that could answer the
question. Throwaway is fine. **One variable per run** — when comparing
two whole substrates, the variable is the substrate itself; each
worktree commits to one substrate end-to-end.

**I — Investigate.** For each worktree, run the success metric via
`experiment_run` and `experiment_test`. Record each run's result
(exit code, measured metric, fixture SHA, parent commit SHA, one-line
interpretation). If the same tool-call error appears 3 times in a row,
Research Mode will fire — drop into a scratch worktree and write a
minimal repro before continuing.

**T — Transfer.** Write `decisions.md` with the winner, supporting
runlog rows, and the transfer strategy. Call `experiment_merge` on
the winner (cherry-pick / squash / merge), then `experiment_discard`
on the losers with a one-line reason. The branch and WHY_IT_FAILED.md
stay on disk for archaeology.

## Worktree conventions

- Worktrees live at `<repo>/.pi-experiments/<approach-slug>/` and are
  gitignored. The registry is at `.pi-experiments/registry.json`.
- One branch per approach: `exp/<approach-slug>`.
- The branch is kept after merge/discard so the work isn't lost; the
  worktree directory is removed once the merge commit lands.

## What this skill is NOT

- Not for single-pass edits with a known good approach.
- Not for debates in prose. If you find yourself writing "on the
  other hand…" twice, fork a worktree.
- Not a way to bypass the existing test/lint gates. The experiments
  must satisfy the same `npm run check` rules as any other code.
