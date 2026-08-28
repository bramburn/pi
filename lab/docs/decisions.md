# Decisions

Append-only D-records. Each one links to the source session.

## D1 â€” pi.exe has no CLI surface to change the project cwd (2026-08-28)
Source: `lab/sessions/2026-08-28-pi-cwd-loading/`

**Claim type:** `[inference]` from source reading, `[measured]` from one probe
run with `--cwd` (silently accepted) and one redirected-launch hang.

**Context:** User ran `pi.exe >C:/dev/audio-lessons^C` and reported
"not loading".

**Root cause:** Three issues stack, in order of severity:

1. pi has no `--cwd` / `--project` / positional-cwd support. The project cwd
   is set from `process.cwd()` exactly once at startup
   (`packages/coding-agent/src/main.ts:671`). Every non-`@` positional arg
   becomes an *initial prompt* via `parseArgs` in
   `packages/coding-agent/src/cli/args.ts:235` and is then passed to
   `initialMessages` in `main.ts:1056`.
2. The user's literal command is a *shell redirect*, not a pi argument.
   `>C:/dev/audio-lessons^C` means "redirect pi's stdout to a file named
   `C:/dev/audio-lessons^C`". pi is launched with zero args.
3. `resolveAppMode` (`main.ts:127-138`) silently demotes the TUI to
   `print` mode whenever stdout is not a TTY, so the redirect turns
   interactive pi into a print-mode run that waits on a model with no
   prompt â€” visible to the user as "not loading".

**Workaround (today):**
```powershell
cd C:/dev/audio-lessons
& "C:/dev/pi/packages/coding-agent/dist/pi.exe"
```

**Proposed fix (separate work):** add `--cwd <dir>` to `parseArgs`,
validated as an existing directory, then `process.chdir(parsed.cwd)`
before `main.ts:671` reads `process.cwd()`. Filing as a follow-up
lab session (`2026-08-28-pi-cwd-flag`) before any code change.

## D2 â€” `setCapabilityOverrides` regression in cherry-pick (2026-08-28)
Source: same session, observed at 14:32 BST.

**Claim type:** `[measured]` from `git show 0037e08e4`; the line
disappeared in the cherry-pick fix.

The cherry-pick fix `0037e08e4 fix: resolve API mismatches from
cherry-pick merge` accidentally removed
`setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides())`
from `cli/startup-ui.ts:78`. As a result, user-set
`terminal.images` / `terminal.trueColor` / `terminal.hyperlinks` overrides
in `settings.json` were silently ignored by the TUI.

**Fix:** restore the call. Landed together with D1 + D3 in the same
session.

## D3 â€” `--no-deepseek-harness` missing (2026-08-28)
Source: same session, observed at 14:32 BST.

**Claim type:** `[measured]` from live `pi.exe --deepseek-harness=false`
returning `Error: Unknown option: --deepseek-harness`.

The deepseek-harness CLI surface only accepted the boolean form
`--deepseek-harness` (sets to `true`). There was no way to disable
the bundle from the command line, so a user with
`~/.pi/agent/settings.json:33` `"deepseekHarness": { "enabled": true }`
could not override it per-run.

**Fix:** add `--no-deepseek-harness` to `parseArgs`, plumb through to
`settingsManager.setDeepseekHarnessEnabled(false)` in `main.ts:906`.

## D4 â€” `require("./x.ts")` broke the Bun binary build (2026-08-28)
Source: build attempt at 15:53 BST.

**Claim type:** `[measured]` from `bun run --cwd packages/coding-agent build:binary`
failing with `Could not resolve "./deepseek-harness-profile.ts"`.

`SettingsManager.getDeepseekHarnessSettings` lazily loaded
`MINIMAX_PROFILE` via `require("./deepseek-harness-profile.ts")`. This
works under tsgo (which uses the source loader) and under Node's
`--experimental-strip-types` runtime, but esbuild's bundler used by
`bun build --compile` cannot resolve a `.ts` extension through
`require`. Result: the binary could not be built at all. This was a
silent build break â€” running the old `dist/pi.exe` still worked, so
nobody noticed until a fresh build was attempted.

**Fix:** replace the lazy `require` with a static
`import { MINIMAX_PROFILE } from "./deepseek-harness-profile.ts"`.
The profile module only imports the `DeepseekHarnessSettings` *type*
from `settings-manager.ts`, which is erased at compile time, so the
runtime import is cycle-free. Confirmed by full `build:binary` succeeding
at 15:58 BST.

## D5 â€” Silent print-mode exit when launched without a TTY (2026-08-28)
Source: same session, follow-up at 15:54 BST.

**Claim type:** `[measured]` from `Start-Process pi.exe` in PowerShell
showing the process exits in <2 s with empty stdout and empty stderr.

`resolveAppMode` (`main.ts:127-138`) returns `"print"` whenever stdout
is not a TTY. In print mode with no messages and no stdin, `runPrintMode`
(`modes/print-mode.ts:33`) does nothing and returns 0. The process
exits silently, which from the user's perspective is indistinguishable
from a broken TUI. Particularly nasty when the user is running pi from
a launcher that loses TTY (VSCode "Run in Output", piped launchers, etc.).

**Fix:** add an explicit pre-flight check in `main.ts` right after
`resolveAppMode`: if the user did not pass `--print`, did not pass
`--mode`, has no positional messages, no `@file` args, AND
`!process.stdout.isTTY` â†’ print a clear red error to stderr and exit
with code 1. The message tells the user to run from Windows Terminal,
ConEmu, or plain cmd.exe, or pass `--print` for non-interactive mode.

The check uses `!process.stdout.isTTY` rather than `=== false` so it
also catches the `undefined` case (piped stdio in some PowerShell
contexts).

## D6 — D5 exemption + pasted `dir>exe` redirect trap (2026-08-28)
Source: same session, guard refactor at 17:11 BST + sandbox probe at 17:29 BST.

**Claim type:** `[measured]` via test run and sandbox `Copy-Item` + literal
`dist>pi.exe --cwd ...` repro at 17:29 BST.

Two follow-ups after D5 landed:

1. **D5 over-fired on metadata commands.** `pi --list-models > file` and
   `pi --help | …` hit the no-TTY block and exited 1, even though those
   commands print to stdout and never need the TUI. Fix: extract the guard
   into `shouldBlockInteractiveNonTTY(parsed, stdoutIsTTY)` in `main.ts`
   (exported, unit-tested), which also excludes `isPlainRuntimeMetadataCommand`
   (`--help`, `--list-models`). Verified: `--list-models > file` ? EXIT=0,
   356 lines, 0 stderr.

2. **User pasted invocation `…dist>pi.exe --cwd c:/dev/audio-lessons` still
   "not working".** Empirical repro in a sandbox copy:
   - cmd.exe: `dist>pi.exe --cwd …` ? `'dist' is not recognized` **and the
     redirect TRUNCATES pi.exe to 0 bytes** (observed size=0).
   - PowerShell: `dist>pi.exe --cwd …` ? `'dist>pi.exe' is not recognized`
     (whole token), file intact.
   - Clean `pi.exe --cwd c:/dev/audio-lessons` in a non-TTY ? D5 error,
     exit 1.

   Conclusion: when the user's pasted command line shows `<cwd>>` directly
   before the program name, the `>` is ambiguous between the cmd default
   prompt glyph (`$P$G`) and a literal redirect. Verify shell + paste shape
   before touching code; check binary integrity (size) if cmd was involved,
   since a literal redirect can zero the exe. The real binary was intact
   (107,401,216 B, 17:15:14) and the TUI renders in a real console
   (runlog rows 18, 22) with `--cwd` binding the session title to the
   project (`p - audio-lessons`).

## D7 — User is invoking the OLD main-checkout binary, not the new worktree binary (2026-08-28)
Source: same session, follow-up at 23:13 BST after the user reported
"nothing happens" with my recommended command.

**Claim type:** `[measured]` from `Get-Item` of both paths and the
screenshot the user attached showing their typed command.

Two `pi.exe` exist on the user's machine:
- `C:\dev\pi\.worktrees\feat-auto-20260828-fc043698\packages\coding-agent\dist\pi.exe` — NEW, 107,401,216 B, 17:15:14. Contains D1–D5 fixes.
- `C:\dev\pi\packages\coding-agent\dist\pi.exe` — OLD, 107,471,360 B, 13:08:18. Pre-dates all my fixes. The `pi-bun.cmd` wrapper at `C:\Users\bramburn\.pi\agent\bin\pi-bun.cmd` points here.

The user typed the **main-checkout** path (per their screenshot). The
new binary's TUI was proven working in runlog row 22; that was against
the worktree binary. The user's "nothing happens" is the OLD binary
silently exiting on no-TTY (it has none of D1–D5, including the
clear-error guard).

**Why this happens:** I cannot write to `C:\dev\pi\packages\coding-agent\dist\pi.exe`
from this session (safety policy — it's outside the worktree workspace).
The user must run the `Copy-Item` themselves. Until that copy lands, every
worktree-only fix is invisible to a user who types the main-checkout path
by muscle memory.

**Fix (one command, run from elevated PowerShell):**
```powershell
Copy-Item -Force 'C:\dev\pi\.worktrees\feat-auto-20260828-fc043698\packages\coding-agent\dist\pi.exe' 'C:\dev\pi\packages\coding-agent\dist\pi.exe'
```

After the copy, the main-checkout `pi.exe` IS the new binary. Both paths
then resolve to the same TUI-working build.

**Cross-project lesson:** any "fix the binary" work done inside a worktree
must end with either (a) an explicit promotion step the user runs to copy
the binary to its main-checkout location, or (b) the user retrained to
type the worktree path. If you only fix and don't promote, the next
"still broken" report is almost always "the user is on the old binary".
