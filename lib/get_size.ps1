Add-Type -AssemblyName System.Windows.Forms
$s = [System.Windows.Forms.Screen]::PrimaryScreen
Write-Host "屏幕: $($s.Bounds.Width)x$($s.Bounds.Height)"
Write-Host "Bounds: $($s.Bounds)"