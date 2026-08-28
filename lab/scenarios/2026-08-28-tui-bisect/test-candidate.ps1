$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public struct RECT3 { public int Left, Top, Right, Bottom; }
public static class Win32C {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT3 r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
'@
Add-Type -AssemblyName System.Drawing
param(
  [Parameter(Mandatory)] [string] $ExePath,
  [Parameter(Mandatory)] [string] $Label,
  [Parameter(Mandatory)] [string] $Cwd,
  [string] $OutDir = 'C:\dev\pi\.worktrees\feat-auto-20260828-fc043698\lab\scenarios\2026-08-28-tui-bisect\screenshots',
  [int] $HoldSeconds = 14
)
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$shot = Join-Path $OutDir "$Label.png"
$meta = Join-Path $OutDir "$Label.meta.txt"
'launching {0}: {1} --cwd {2}' -f $Label, $ExePath, $Cwd | Tee-Object -FilePath $meta
$p = Start-Process -FilePath $ExePath -ArgumentList @('--cwd', $Cwd) -WindowStyle Normal -PassThru
$titles = @()
$aliveAt = @()
$sizes = @()
for ($i=2; $i -le $HoldSeconds; $i+=2) {
  Start-Sleep -Seconds 2
  $p.Refresh()
  $alive = -not $p.HasExited
  $title = ''
  $h = [IntPtr]::Zero
  if ($alive) { $title = $p.MainWindowTitle; $h = $p.MainWindowHandle }
  $titles += $title
  $aliveAt += $alive
  't={0}s alive={1} title="{2}"' -f $i, $alive, $title | Tee-Object -FilePath $meta -Append
  if ($alive -and $h -ne [IntPtr]::Zero -and $i -ge 6) {
    $r = New-Object RECT3
    if ([Win32C]::GetWindowRect($h, [ref]$r)) {
      $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
      if ($w -gt 0 -and $ht -gt 0) {
        $bmp = New-Object System.Drawing.Bitmap($w, $ht)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $ok = [Win32C]::PrintWindow($h, $hdc, 2)
        $g.ReleaseHdc($hdc)
        $g.Dispose()
        if ($ok) {
          $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
          $bmp.Dispose()
          'screenshot: {0} ({1}x{2})' -f $shot, $w, $ht | Tee-Object -FilePath $meta -Append
        } else {
          $bmp.Dispose()
          'screenshot: PrintWindow failed' | Tee-Object -FilePath $meta -Append
        }
      }
    }
  }
}
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; 'killed pid {0}' -f $p.Id | Tee-Object -FilePath $meta -Append } else { 'exited with code {0}' -f $p.ExitCode | Tee-Object -FilePath $meta -Append }
'--- summary ---' | Tee-Object -FilePath $meta -Append
'titles: {0}' -f ($titles -join ' | ') | Tee-Object -FilePath $meta -Append
'verdict: {0}' -f (if ($titles -contains "π - audio-lessons") { 'PASS' } else { 'FAIL' }) | Tee-Object -FilePath $meta -Append