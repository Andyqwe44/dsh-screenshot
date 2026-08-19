# dsh-screenshot.ps1 — Capture the entire screen(s) to a PNG.
# No overlay, no interaction. The browser handles rectangle selection
# on the returned image, so there are no window z-order issues.
#
# DPI-aware: on high-DPI displays (e.g. 200% scaling) the logical
# Screen.Bounds is smaller than the physical pixels. We set process
# DPI awareness so CopyFromScreen captures at full physical
# resolution — otherwise the image is 1440x900 instead of 2880x1800.
#
# Output: base64-encoded PNG on stdout (no temp file, no disk I/O).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── DPI awareness ───────────────────────────────────────────────
$dpiCs = @"
using System;
using System.Runtime.InteropServices;
public static class DpiAware {
    [DllImport("user32.dll")]
    public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr dpiContext);
}
"@
$dpiTmp = Join-Path $env:TEMP "dsh-dpi-$(Get-Date -Format 'yyyyMMddHHmmssfff').cs"
try {
    $dpiCs | Out-File -FilePath $dpiTmp -Encoding UTF8
    Add-Type -Path $dpiTmp -ErrorAction Stop
} finally {
    Remove-Item $dpiTmp -ErrorAction SilentlyContinue
}
[DpiAware]::SetProcessDpiAwarenessContext([IntPtr](-3))

$screens = [System.Windows.Forms.Screen]::AllScreens
if ($screens.Length -eq 0) {
    Write-Error "no screens detected"
    exit 1
}

$minX = [int]::MaxValue
$minY = [int]::MaxValue
$maxX = [int]::MinValue
$maxY = [int]::MinValue

foreach ($s in $screens) {
    $b = $s.Bounds
    $minX = [Math]::Min($minX, $b.X)
    $minY = [Math]::Min($minY, $b.Y)
    $maxX = [Math]::Max($maxX, $b.X + $b.Width)
    $maxY = [Math]::Max($maxY, $b.Y + $b.Height)
}

$width = $maxX - $minX
$height = $maxY - $minY

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

foreach ($s in $screens) {
    $b = $s.Bounds
    $graphics.CopyFromScreen($b.X, $b.Y, $b.X - $minX, $b.Y - $minY, [System.Drawing.Size]::new($b.Width, $b.Height))
}

$graphics.Dispose()

# Encode to PNG in memory, then base64 for stdout transport.
$ms = New-Object System.IO.MemoryStream
$bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$pngBytes = $ms.ToArray()
$ms.Dispose()

$base64 = [Convert]::ToBase64String($pngBytes)
Write-Output $base64