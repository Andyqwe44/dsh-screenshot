# computer_use.ps1 — Input simulation via Windows API.
# Used by the dsh-computer-use model-facing tools so the model can
# control the desktop: click, type, press keys, scroll, open URLs.
#
# Uses System.Windows.Forms.SendKeys (wraps SendInput) so the
# keyboard state is never corrupted — keybd_event and raw P/Invoke
# SendInput with hand-built structs both leave keys stuck in
# certain focus contexts (c, h, v, backspace break).
#
# Usage:
#   computer_use.ps1 -Action click      -X 100 -Y 200
#   computer_use.ps1 -Action move       -X 100 -Y 200
#   computer_use.ps1 -Action type       -Text "hello world"
#   computer_use.ps1 -Action key        -Key "enter"
#   computer_use.ps1 -Action key        -Key "ctrl+c"
#   computer_use.ps1 -Action scroll     -Direction down -Amount 3
#   computer_use.ps1 -Action open       -Url "https://example.com"
#   computer_use.ps1 -Action position
#
# Output: one JSON object on stdout.

param(
    [string]$Action,
    [int]$X = 0,
    [int]$Y = 0,
    [string]$Text = "",
    [string]$Key = "",
    [string]$Direction = "",
    [int]$Amount = 1,
    [string]$Url = ""
)

Add-Type -AssemblyName System.Windows.Forms

# ── Mouse via user32 (SendKeys can't do mouse) ──────────────────
$cs = @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct Pt {
    public int x;
    public int y;
}

public static class Native {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out Pt lpPoint);

    public const uint MOUSEEVENTF_LEFTDOWN  = 0x02;
    public const uint MOUSEEVENTF_LEFTUP    = 0x04;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x08;
    public const uint MOUSEEVENTF_RIGHTUP   = 0x10;
    public const uint MOUSEEVENTF_WHEEL     = 0x800;
}
"@

$tmpCs = Join-Path $env:TEMP "dsh-cu-$(Get-Date -Format 'yyyyMMddHHmmssfff').cs"
try {
    $cs | Out-File -FilePath $tmpCs -Encoding UTF8
    Add-Type -Path $tmpCs -ErrorAction Stop
} finally {
    Remove-Item $tmpCs -ErrorAction SilentlyContinue
}

# ── Helpers ─────────────────────────────────────────────────────

function Send-Click {
    param([int]$X, [int]$Y, [string]$Button = "left", [int]$Count = 1)
    [Native]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 10

    $down = 0; $up = 0
    switch ($Button) {
        "left"  { $down = [Native]::MOUSEEVENTF_LEFTDOWN;  $up = [Native]::MOUSEEVENTF_LEFTUP }
        "right" { $down = [Native]::MOUSEEVENTF_RIGHTDOWN; $up = [Native]::MOUSEEVENTF_RIGHTUP }
        "middle"{ $down = 0x04; $up = 0x10 }
    }

    for ($i = 0; $i -lt $Count; $i++) {
        [Native]::mouse_event($down, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 5
        [Native]::mouse_event($up, 0, 0, 0, 0)
        if ($i -lt ($Count - 1)) { Start-Sleep -Milliseconds 50 }
    }

    $pt = New-Object Pt
    [Native]::GetCursorPos([ref]$pt)
    return @{ ok = $true; x = $pt.x; y = $pt.y; button = $Button; count = $Count }
}

# ── Keyboard via SendKeys ───────────────────────────────────────
# SendKeys maps our key names to the SendKeys syntax:
#   modifiers: ctrl=^  shift=+  alt=%
#   special:  enter={ENTER}  backspace={BACKSPACE}  esc={ESC}
#              tab={TAB}  space={SPACE}  delete={DELETE}
#              home={HOME}  end={END}  pageup={PGUP}  pagedown={PGDN}
#              left={LEFT}  up={UP}  right={RIGHT}  down={DOWN}

$specialKeys = @{
    'enter' = '{ENTER}'; 'return' = '{ENTER}'
    'backspace' = '{BACKSPACE}'
    'tab' = '{TAB}'
    'escape' = '{ESC}'; 'esc' = '{ESC}'
    'space' = '{SPACE}'
    'delete' = '{DELETE}'; 'del' = '{DELETE}'
    'home' = '{HOME}'
    'end' = '{END}'
    'pageup' = '{PGUP}'
    'pagedown' = '{PGDN}'
    'left' = '{LEFT}'
    'up' = '{UP}'
    'right' = '{RIGHT}'
    'down' = '{DOWN}'
    'printscreen' = '{PRTSC}'
    'insert' = '{INSERT}'
    'pause' = '{PAUSE}'
    'capslock' = '{CAPSLOCK}'
    'f1' = '{F1}'; 'f2' = '{F2}'; 'f3' = '{F3}'; 'f4' = '{F4}'; 'f5' = '{F5}'
    'f6' = '{F6}'; 'f7' = '{F7}'; 'f8' = '{F8}'; 'f9' = '{F9}'; 'f10' = '{F10}'
    'f11' = '{F11}'; 'f12' = '{F12}'
}

function Send-Type {
    param([string]$Text)
    # SendKeys.SendWait handles literal text correctly, including
    # special characters like -, +, %, ^, ~, (, ), etc.
    # Characters that are SendKeys special chars are automatically
    # escaped by SendKeys (e.g. "+" becomes "{+}")
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    return @{ ok = $true; typed = $Text.Length }
}

function Send-Key {
    param([string]$KeyStr)

    $parts = $KeyStr -split '\+'
    $modifiers = @()
    $mainKey = $parts[-1]

    for ($i = 0; $i -lt ($parts.Length - 1); $i++) {
        $modifiers += $parts[$i].ToLower()
    }

    # Build SendKeys expression
    $expr = ""
    foreach ($mod in $modifiers) {
        switch ($mod) {
            'ctrl' { $expr += '^' }
            'control' { $expr += '^' }
            'shift' { $expr += '+' }
            'alt' { $expr += '%' }
            'win' { $expr += '^{ESC}' }  # SendKeys has no direct Win key; use Ctrl+Esc
            'lwin' { $expr += '^{ESC}' }
            'rwin' { $expr += '^{{ESC}}' }
        }
    }

    # Main key
    $main = $mainKey.ToLower()
    if ($specialKeys[$main]) {
        $expr += $specialKeys[$main]
    } elseif ($main.Length -eq 1) {
        # Literal character — SendKeys auto-escapes special chars
        $expr += $main
    } else {
        return @{ ok = $false; error = "unknown key: $mainKey" }
    }

    [System.Windows.Forms.SendKeys]::SendWait($expr)
    return @{ ok = $true; key = $KeyStr }
}

function Send-Scroll {
    param([string]$Direction, [int]$Amount)
    $delta = switch ($Direction) {
        "up"     { $Amount * 120 }
        "down"   { -$Amount * 120 }
        "left"   { -$Amount * 120 }
        "right"  { $Amount * 120 }
        default  { 0 }
    }
    if ($delta -ne 0) {
        [Native]::mouse_event([Native]::MOUSEEVENTF_WHEEL, 0, 0, [uint]$delta, 0)
    }
    return @{ ok = $true; direction = $Direction; amount = $Amount; delta = $delta }
}

function Get-Position {
    $pt = New-Object Pt
    [Native]::GetCursorPos([ref]$pt)
    return @{ ok = $true; x = $pt.x; y = $pt.y }
}

function Open-Url {
    param([string]$Url)
    if ([string]::IsNullOrEmpty($Url)) {
        return @{ ok = $false; error = "url is required" }
    }
    try {
        Start-Process -FilePath $Url -ErrorAction Stop | Out-Null
        return @{ ok = $true; url = $Url }
    } catch {
        return @{ ok = $false; error = $_.Exception.Message }
    }
}

# ── Main dispatch ───────────────────────────────────────────────

$result = switch ($Action) {
    "click"    { Send-Click -X $X -Y $Y }
    "move"     {
        [Native]::SetCursorPos($X, $Y)
        Get-Position
    }
    "type"     { Send-Type -Text $Text }
    "key"      { Send-Key -KeyStr $Key }
    "scroll"   { Send-Scroll -Direction $Direction -Amount $Amount }
    "position" { Get-Position }
    "open"     { Open-Url -Url $Url }
    default    { @{ ok = $false; error = "unknown action: $Action" } }
}

$result | ConvertTo-Json -Compress