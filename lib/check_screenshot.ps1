Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$screens = [System.Windows.Forms.Screen]::AllScreens
$minX = [int]::MaxValue; $minY = [int]::MaxValue
$maxX = [int]::MinValue; $maxY = [int]::MinValue
foreach ($s in $screens) {
    $b = $s.Bounds
    $minX = [Math]::Min($minX, $b.X); $minY = [Math]::Min($minY, $b.Y)
    $maxX = [Math]::Max($maxX, $b.X + $b.Width); $maxY = [Math]::Max($maxY, $b.Y + $b.Height)
}
Write-Host "Screen bounds: ($minX,$minY) to ($maxX,$maxY) = $($maxX-$minX)x$($maxY-$minY)"

$files = Get-ChildItem $env:TEMP -Filter "dsh-screenshot-*.png" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($files) {
    $img = [System.Drawing.Image]::FromFile($files.FullName)
    Write-Host "Screenshot: $($img.Width)x$($img.Height) from $($files.Name)"
    $img.Dispose()
}