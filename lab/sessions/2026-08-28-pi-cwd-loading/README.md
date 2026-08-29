# 2026-08-28-pi-cwd-loading

## User report

> "see why our pi.exe is not loading `C:/dev/audio-lessons`. I'm running the bun one. debug."

Command attempted (best-effort reconstruction from a fragment):

```
C:/dev/pi/packages/coding-agent/dist/pi.exe >C:/dev/audio-lessons^C
```

Symptoms the user observed (their words): "not loading". The literal
command fragment contains a shell `>` redirect followed by a path and
`^C`; on PowerShell/cmd that is "redirect stdout to a file named
`<path>^C`", which is not what the user wanted.

## Hypothesis (falsifiable)

The Bun-built `pi.exe` does not change its project / cwd based on any
positional CLI argument. It always uses `process.cwd()` of the
launching shell. Therefore:

- `pi.exe C:/dev/audio-lessons` treats `C:/dev/audio-lessons` as an
  initial prompt message, **not** as a project root.
- `pi.exe >C:/dev/audio-lessons^C` (PowerShell/cmd) redirects stdout to
  a file named `C:/dev/audio-lessons^C` in the current cwd, which has
  nothing to do with "loading" the directory.
- To open a directory as the pi project, the user must `cd` into it
  first (`cd C:/dev/audio-lessons && pi.exe`) or rely on a future
  `--cwd` / `--project` flag.

Falsification: if any CLI flag, positional arg, or env var can redirect
the project cwd away from `process.cwd()`, this hypothesis is wrong.

## Plan

1. Read the parser source to confirm the positional-arg contract.
2. Trace `process.cwd()` from `main.ts:671` to the project-loading code.
3. Test the hypothesis with the actual binary: run pi.exe with a
   positional path and observe whether it (a) treats the path as a
   prompt, (b) errors out, (c) changes cwd.
4. Report findings; if the feature is missing, propose `--cwd` as the
   fix and record the gap as a D-record.

## Findings

1. **pi has no CLI surface to change the project cwd.**
   - `main.ts:671` sets `const cwd = process.cwd();` — the *only* source of project cwd.
   - `cli/args.ts:235` sends every non-`@` positional into `result.messages` (initial prompt).
   - No `--cwd`, `--project`, `--root` flag exists. The parser is permissive on
     unknown flags (they land in `unknownFlags`), so `--cwd X` is silently ignored.
   - The user's command `pi.exe C:/dev/audio-lessons` therefore treats
     `C:/dev/audio-lessons` as an *initial prompt message*, not a project path.

2. **`>C:/dev/audio-lessons^C` is a shell redirect, not a pi argument.**
   - In both PowerShell and cmd, `>` is the redirect operator. pi.exe is launched
     with **zero** args, stdout going to a file path.
   - The `^C` is either a literal caret+C (PowerShell) or an escape for control-C
     (cmd). Either way, the redirect target becomes `C:/dev/audio-lessons^C`.
   - Evidence on disk: a stale `nul` file inside `audio-lessons` shows the user
     has previously hit the same "redirect instead of arg" trap on this machine
     (PowerShell `>nul` errors with "device that was not a file" because `nul`
     is a Windows reserved device name).

3. **Even with the redirect, pi's app-mode logic demotes the TUI to print mode
   silently when stdout is not a TTY** (`main.ts:127-138`):
   ```ts
   if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
       return "print";
   }
   ```
   - With no `messages` and no stdin, `runPrintMode` waits on model init, so
     the user sees "nothing happened" / "not loading".

## Follow-up: TUI also "not loading" — same root cause, different angle (14:32 BST)

User's follow-up: "i was expecting the TUI why has it suddenly stopped with
the recent deepseek harness implementation".

Source-trace + run experiments:

1. `resolveAppMode` in `main.ts:127-138` returns `"print"` whenever
   `!process.stdout.isTTY` — the deepseek-harness work did **not** change this.
2. `runPrintMode` (`modes/print-mode.ts:33`) with **no** `messages` and **no**
   `initialMessage` does nothing and returns 0. The process exits silently.
3. Live test: launched `pi.exe` via `Start-Process -NoNewWindow` in
   PowerShell (no TTY); process exited in **< 2 s** with empty stdout and
   empty stderr. Same result with and without `--deepseek-harness`.
4. Toggling the global `deepseekHarness.enabled` from `true` to `false`
   in `~/.pi/agent/settings.json` (or `--no-extensions --no-skills ...`)
   does not change the exit behaviour. The harness is **not** the cause.

Conclusion: the deepseek harness is a red herring. The TUI is suppressed
because the launching context has no TTY, and `resolveAppMode` demotes to
print mode, which has nothing to do and exits. The user's previous "TUI
loaded" experience was in a TTY-bearing launcher; the new launcher (or
wrapper, or recent Windows / VSCode terminal change) loses the TTY.

### Verify in a real TTY
```powershell
# Real Windows Terminal / ConEmu / cmd interactive window:
& "C:\dev\pi\packages\coding-agent\dist\pi.exe"
# Or via the wrapper in PATH:
pi-bun
```
If the TUI shows here, the harness is fine. If it still does not show,
then the binary is the problem and the next step is `bun run
--cwd packages/coding-agent build:binary` against a known-good commit
(HEAD~1 = `283ab02d5` pre-`0037e08e4`).

## Status: completed (root cause identified; user's belief about the harness is a misattribution; both follow-ups fixed at the source level + new TTY-detected error message)
