$ErrorActionPreference = 'Continue'
$work = Join-Path $env:TEMP 'pi-sandbox-20260828'
New-Item -ItemType Directory -Path (Join-Path $work 'dist') -Force | Out-Null
$src = 'C:\dev\pi\.worktrees\feat-auto-20260828-fc043698\packages\coding-agent\dist\pi.exe'
$exe = Join-Path $work (Join-Path 'dist' 'pi.exe')
Copy-Item $src $exe -Force
function Show-State([string]$label) {
  $f = Get-Item $exe
  "$label -> size=$($f.Length) ts=$($f.LastWriteTime.ToString('HH:mm:ss'))"
}
Show-State 'copied'

# --- Test 1: cmd.exe, literal "dist>pi.exe --cwd ..." from inside the dist dir
Copy-Item $src $exe -Force
'--- cmd.exe literal dist>pi.exe ---'
cmd /c "cd /d `"$work\dist`" && dist>pi.exe --cwd c:/dev/audio-lessons & echo CMD_EXIT=%ERRORLEVEL%"
Show-State 'after cmd literal'

# --- Test 2: PowerShell, literal "dist>pi.exe --cwd ..." from inside the dist dir
Copy-Item $src $exe -Force
'--- PowerShell literal dist>pi.exe ---'
$orig = Get-Location
Set-Location (Join-Path $work 'dist')
dist>pi.exe --cwd c:/dev/audio-lessons
"PS_EXIT=$LASTEXITCODE"
Set-Location $orig
Show-State 'after powershell literal'

# --- Test 3: clean invocation from inside dist (non-interactive agent shell, stdout not a TTY)
'--- clean invocation "pi.exe --cwd c:/dev/audio-lessons" (no redirect) ---'
Set-Location (Join-Path $work 'dist')
$out = & .\pi.exe --cwd c:/dev/audio-lessons 2>&1
"EXIT=$LASTEXITCODE"
"OUTPUT:"
$out | Select-Object -First 5
Set-Location $orig
Show-State 'after clean invocation'