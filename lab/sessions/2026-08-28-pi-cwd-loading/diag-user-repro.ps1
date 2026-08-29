$ErrorActionPreference = 'Stop'
$exe = 'C:\dev\pi\.worktrees\feat-auto-20260828-fc043698\packages\coding-agent\dist\pi.exe'
$out = 'C:\dev\pi\.worktrees\feat-auto-20260828-fc043698\lab\sessions\2026-08-28-pi-cwd-loading\user-repro'
New-Item -ItemType Directory -Path $out -Force | Out-Null
Add-Type -AssemblyName System.Drawing
'starting user-style invocation (attached to THIS console, NOT a new window)...'
'cmd: & "$exe" --cwd C:\dev\audio-lessons\'
'  (this should either: show the TUI in this window, OR print a clear D5 error and exit 1)'
'  if it returns immediately with no output AND no exit prompt, that = "nothing happens" symptom'
'---'
$proc = Start-Process -FilePath $exe -ArgumentList '--cwd','C:\dev\audio-lessons\' -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $out 'stdout.log') -RedirectStandardError (Join-Path $out 'stderr.log')
$proc.WaitForExit(8000) | Out-Null
if (-not $proc.HasExited) {
  'still running after 8s -- means TUI is open in this console (success, but headless harness cannot see it)'
  Stop-Process -Id $proc.Id -Force
} else {
  "exited after $($proc.ExitCode)"
}
"--- stdout (first 20 lines) ---"
Get-Content (Join-Path $out 'stdout.log') -ErrorAction SilentlyContinue | Select-Object -First 20
"--- stderr (first 20 lines) ---"
Get-Content (Join-Path $out 'stderr.log') -ErrorAction SilentlyContinue | Select-Object -First 20