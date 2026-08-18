# dsh-screenshot.ps1 — Capture the entire screen(s) to a PNG file.
# No overlay, no interaction. The browser handles rectangle selection
# on the returned image, so there are no window z-order issues.
#
# Output: absolute path of the saved PNG (stdout only).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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

$tempFile = Join-Path $env:TEMP "dsh-screenshot-$(Get-Date -Format 'yyyyMMddHHmmssfff').png"
$bitmap.Save($tempFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Output $tempFile