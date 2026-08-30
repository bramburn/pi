$ErrorActionPreference = 'Continue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT2 { public int Left; public int Top; public int Right; public int Bottom; }
public static class Win32B {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT2 rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
}
'@
$exe = 'C:\dev\pi\.worktrees\feat-auto-20260828-fc043698\packages\coding-agent\dist\pi.exe'
$outDir = 'C:\dev\pi\.worktrees\feat-auto-20260828-fc043698\lab\sessions\2026-08-28-pi-cwd-loading'
Add-Type -AssemblyName System.Drawing
$p = Start-Process -FilePath $exe -ArgumentList '--cwd C:\dev\audio-lessons\' -WindowStyle Normal -PassThru
foreach ($t in @(2, 6, 12)) {
  Start-Sleep -Seconds $t
  $p.Refresh()
  $alive = -not $p.HasExited
  $title = ''
  $h = [IntPtr]::Zero
  if ($alive) { $title = $p.MainWindowTitle; $h = $p.MainWindowHandle }
  "t=${t}s alive=$alive title='$title' hwnd=$h"
  if ($alive -and $h -ne [IntPtr]::Zero) {
    $rect = New-Object RECT2
    [Win32B]::GetWindowRect($h, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left; $ht = $rect.Bottom - $rect.Top
    if ($w -gt 0 -and $ht -gt 0) {
      $bmp = New-Object System.Drawing.Bitmap($w, $ht)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      $ok = [Win32B]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
      $g.ReleaseHdc($hdc)
      $g.Dispose()
      $path = Join-Path $outDir "tui-v2-t$t-$(if ($ok) { 'pw' } else { 'copy' }).png"
      if ($ok) {
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        "saved $path (PrintWindow)"
      } else {
        try {
          $g2 = [System.Drawing.Graphics]::FromImage($bmp)
          $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
          $g2.Dispose()
          $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
          "saved $path (CopyFromScreen fallback)"
        } catch {
          "capture failed: $($_.Exception.Message)"
        }
      }
      $bmp.Dispose()
    } else {
      "window rect invalid ($w x $ht), skipping capture"
    }
  }
}
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; "killed pid $($p.Id) after proof" }