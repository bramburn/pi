# 2026-08-28-tui-bisect

## User report (2026-08-28 23:24)

> "try different ways to resolve the TUI not opening. I am pretty sure if you look at the previous commits and spin up work trees or whatever to see what works you'll see a version that will get the TUI working."

The user is convinced an earlier commit produced a working TUI. The current main-checkout binary (13:08:18, 107,471,360 B) silently exits in their TTY. My worktree binary (17:15:14, 107,401,216 B) renders the TUI in my test environment but the user has not confirmed it works for them.

## Hypothesis (falsifiable)

At least one of three recent commits in the pi repo produces a `pi.exe` whose TUI renders successfully when launched from a real TTY console pointed at the audio-lessons project. The three candidates are chosen to cover the three suspect TUI/code paths the subagent's bisect report flagged as HIGH-risk for the TUI:

- `0037e08e4` (HEAD) — my worktree's current commit with the D1–D5 fixes
- `503ab6d5d` — `feat(coding-agent): new-session-model preference` (pre-deepseek-harness; the last commit before the harness landed)
- `5adb5211c` — `Merge origin/main: upstream v0.84.3 with fork-local preserves` (pre-TUI-sync, pre-deepseek — the v0.84.3 baseline)

A fourth candidate is the main-checkout binary already on disk at 13:08:18; we'll test that one too as the "what the user has been running" reference.

Falsification: if NONE of the three (or the existing on-disk binary) render the TUI, the regression is earlier than 5adb5211c and we need to keep walking the tree.

## Test protocol

For each candidate:
1. Create a sibling worktree pinned to the candidate commit.
2. Run `bun run --cwd packages/coding-agent build:binary`. Capture the resulting `dist\pi.exe` size + timestamp.
3. Launch the binary in a real console with `Start-Process -WindowStyle Normal -PassThru` and the args `--cwd C:\dev\audio-lessons\`.
4. Capture `MainWindowTitle` at t=2, 6, 12s. PASS criterion: title is `π - audio-lessons` by t=6s (TUI rendered with project bound). FAIL: process exits before 8s OR title never includes `π - audio-lessons`.
5. PrintWindow a screenshot for human review.
6. Append one row to `runlog.md`.

## Acceptance gates

- TUI renders: `MainWindowTitle` = `π - audio-lessons` at t=6s, stable through t=12s.
- Binary is not stuck: process alive at t=12s.
- Window content non-blank: PrintWindow capture > 4 KB.

## Status

`scaffolded` -> `buildable` (per candidate session) -> `unit-tested` (per candidate session) -> `selected` (one row in `decisions.md` after the bisect finishes).
