Set-Location 'C:\dev\pi\.worktrees\bisect-503ab6d5d'
$log = 'C:\dev\pi\.worktrees\feat-auto-20260828-fc043698\lab\scenarios\2026-08-28-tui-bisect\binary-build-503ab6d5d.log'
$env:PI_ALLOW_LOCKFILE_CHANGE = '1'
"== start 503ab6d5d build $(Get-Date -Format HH:mm:ss) ==" | Out-File -FilePath $log -Append -Encoding UTF8
bun run --cwd packages/coding-agent build:binary 2>&1 | Out-File -FilePath $log -Append -Encoding UTF8
"== exit $LASTEXITCODE $(Get-Date -Format HH:mm:ss) ==" | Out-File -FilePath $log -Append -Encoding UTF8