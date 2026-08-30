# runlog.md

Append-only. One row per run. Never edit past rows.

| # | When (BST) | Variable | Command (cwd → argv) | Expected | Observed | Verdict |
|---|---|---|---|---|---|---|
| 0 | 14:08 | setup | `Test-Path pi.exe` | exists | 107 MB, today 13:08 | ok |
| 1 | 14:08 | setup | `Test-Path audio-lessons` | dir exists | 201+ items | ok |
| 2 | 14:09 | recon | `pi.exe --version` | "pi X.Y.Z [...]" | `pi 0.84.3-b1 [bramburn]` | ok |
| 3 | 14:09 | recon | `pi.exe --help` | usage + flags | usage: `pi [options] [--] [@files...] [messages...]`. No `--cwd`, no `--project`, no positional-cwd. | ok |
| 4 | 14:10 | trace | grep `process.cwd()` in `src/` | shows project-cwd source | `main.ts:671: const cwd = process.cwd();` passed to `SettingsManager.create(cwd, ...)` | ok |
| 5 | 14:10 | trace | grep `parseArgs` + `messages` in `src/cli/args.ts` | positional = message | non-`@` positional → `result.messages.push(arg)` (args.ts:235). `parsed.messages` then passed as `initialMessages` (main.ts:1056) | ok |
| 6 | 14:11 | repro | `pi.exe --version` from `C:\dev\audio-lessons` | confirms cwd-driven startup | same `pi 0.84.3-b1 [bramburn]` — no project-loaded signal in version line, but it didn't fail either | ok (no crash) |
| 7 | 14:11 | n/a | `pi.exe "Read AGENTS.md" --print` (offline-ish) | runs but may hang on model | hung (waiting for model) — killed. Not relevant to the cwd question. | aborted |
| 8 | 14:12 | repro | inspect `C:\dev\audio-lessons` for accidental redirect files | `nul`, `^C`, etc. | only `nul` (0 bytes, dated 1601) — earlier ls showed 92 bytes from 2026-08-16, so it has been overwritten. PowerShell's `>nul` errors with "device that was not a file" because `nul` is a reserved device name. | evidence of accidental redirect |
| 9 | 14:14 | repro | `cmd /c dir C:\dev\audio-lessons\nul` | file not found or device | `\\.` and "File Not Found" — confirms `nul` is treated as the NUL device, not a regular file in `cmd.exe`/`dir` context. | confirms `>nul` cannot create a `nul` file in cmd |
| 10 | 14:15 | trace | `pi.exe --offline --list-models` | model list | renders fine — confirms `--offline` works | ok |
| 11 | 14:15 | probe | `pi.exe --cwd C:/dev/audio-lessons --list-models` | unknown-flag error or success | renders fine — confirms `--cwd` is silently accepted (no built-in flag) | ok |
| 12 | 14:16 | trace | `resolveAppMode` in `main.ts:127-138` | `!stdout.isTTY → "print"` | confirmed: redirect demotes TUI to print mode | ok |
| 13 | 14:18 | repro | `pi.exe C:/dev/audio-lessons "Read AGENTS.md" --print --no-tools` (offline) | runs in print mode and exits or errors | hung (waiting on model) — killed. Confirms pi goes into print mode but does not honour the positional as a cwd. | aborted (model-dependent; not needed for the cwd question) |
| 14 | 14:25 | recon | `~/.pi/agent/settings.json` | deepseekHarness.enabled state | `true` (line 33-35). So the harness is on for every session regardless of CLI. | ok |
| 15 | 14:25 | probe | `pi.exe --deepseek-harness=false` | "Error: Unknown option" | parser only accepts the boolean form; `--deepseek-harness=…` is rejected. So the only CLI way to override is the boolean form, which forces enabled=true. | ok (no way to disable from CLI) |
| 16 | 14:30 | repro | `Start-Process pi.exe --no-extensions --no-skills --no-prompt-templates --no-themes` (no TTY) | TUI starts | process exited in <2 s, empty stdout, empty stderr | print-mode path (no TTY) — silent exit |
| 17 | 14:31 | repro | same with `--deepseek-harness` boolean | TUI starts | exited in <2 s, empty stdout, empty stderr | identical — harness is not the cause |
| 18 | 16:59 | live | rebuilt worktree binary in real console (Start-Process, `--cwd c:\dev\audio-lessons\`) | TUI renders | alive t=2/4/6/8/10/12 s, title `pi` -> `π - feat-auto-20260828-fc043698`; screenshots new-tui-t{2,6,12}.png | ok |
| 19 | 17:11 | test | vitest `test/main-cwd-override.test.ts test/args.test.ts` after D5-guard exemption refactor | 88 + new guard tests | 2 files, 96/96 passed | ok |
| 20 | 17:15 | build | `bun run --cwd packages/coding-agent build:binary` (guard fix) | new pi.exe | 107,401,216 B, 17:15:14 — first attempt EPERM, old pi.exe locked by leftover live-test PID 46984; killed it, rerun OK | ok |
| 21 | 17:16 | probe | `pi.exe --list-models > %TEMP%\list.txt` (non-TTY stdout) | must NOT hit D5 block | EXIT=0, 356 model lines, 0 stderr — metadata commands exempt from D5 guard | ok |
| 22 | 17:21 | live | capture-tui-v2.ps1: rebuilt binary, `--cwd C:\dev\audio-lessons\`, PrintWindow capture | TUI renders + cwd bound | t=2 `pi`; t=6/12 `π - audio-lessons` (project in title = --cwd worked); screenshots tui-v2-t{2,6,12}-pw.png; killed test PID | ok |
| 23 | 17:29 | sandbox | literal `dist>pi.exe --cwd c:/dev/audio-lessons` in copy of dist (cmd vs PS) | see redirect behavior | cmd: `'dist' is not recognized` + **pi.exe truncated to size=0**; PS: `'dist>pi.exe' is not recognized`, file intact; clean invocation non-TTY -> D5 error exit 1 | cmd redirect destroys exe |
| 24 | 23:13 | user-report | user: "nothing happens" with worktree binary cmd; uploaded screenshot showing they actually ran `C:\dev\pi\packages\coding-agent\dist\pi.exe` (main-checkout) | reconcile | two pi.exe exist: worktree (107,401,216 B, 17:15:14) = new, main (107,471,360 B, 13:08:18) = old. user typed the main-checkout path in screenshot, so "nothing happens" came from the old binary, not the new one. `Get-Item` on worktree path returned new size/timestamp correctly. | wrong binary |
| 25 | 23:13 | cleanup | `Stop-Process` on stale pi.exe PIDs 52364 (worktree cmd 23:08:31) + 44260 (main cmd 23:08:52) | no orphan processes | both killed, no pi.exe running | ok |
