# scripts/build-both.ps1
#
# PowerShell wrapper around scripts/build-both.mjs that ensures the
# script runs from the repository root and forwards all arguments
# verbatim.
#
# Use this from PowerShell on Windows when you want ergonomic
# PowerShell-style invocation.
#
# Usage:
#   .\scripts\build-both.ps1 [options passed to build-both.mjs]

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$orchestrator = Join-Path $repoRoot 'scripts\build-both.mjs'

Set-Location $repoRoot

& node $orchestrator @args
exit $LASTEXITCODE
