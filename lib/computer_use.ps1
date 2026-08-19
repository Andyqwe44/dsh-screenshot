# computer_use.ps1 — Input simulation via Windows API.
# Used by the dsh-computer-use model-facing tools so the model can
# control the desktop: click, type, press keys, scroll, open URLs.
#
# Uses SendInput with C#-built INPUT structs (not keybd_event, not
# SendKeys) so the keyboard state is never corrupted. The structs
# are created by a static C# helper to avoid PowerShell's broken
# value-type marshaling with FieldOffset unions.
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

# ── Compile P/Invoke types from a temp .cs file ─────────────────
$cs = @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct Pt {
    public int x;
    public int y;
}

[StructLayout(LayoutKind.Explicit)]
public struct InputUnion {
    [FieldOffset(0)] public KEYBD kb;
    [FieldOffset(0)] public MOUSEINPUT mi;
}

[StructLayout(LayoutKind.Sequential)]
public struct INPUT {
    public int type;
    public InputUnion di;
}

[StructLayout(LayoutKind.Sequential)]
public struct KEYBD {
    public short wVk;
    public short wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint flags;
    public uint time;
    public IntPtr dwExtraInfo;
}

public static class Native {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out Pt lpPoint);

    [DllImport("user32.dll")]
    public static extern short VkKeyScan(char c);

    [DllImport("user32.dll")]
    public static extern uint SendInput(uint nInputs, [In, MarshalAs(UnmanagedType.LPArray)] INPUT[] pInputs, int cbSize);

    // C#-built INPUT structs — avoids PowerShell's broken value-type
    // marshaling with FieldOffset unions.
    public static INPUT KeyDown(short vk) {
        return new INPUT {
            type = INPUT_KEYBOARD,
            di = new InputUnion {
                kb = new KEYBD { wVk = vk, wScan = 0, dwFlags = 0, dwExtraInfo = IntPtr.Zero }
            }
        };
    }
    public static INPUT KeyUp(short vk) {
        return new INPUT {
            type = INPUT_KEYBOARD,
            di = new InputUnion {
                kb = new KEYBD { wVk = vk, wScan = 0, dwFlags = KEYEVENTF_KEYUP, dwExtraInfo = IntPtr.Zero }
            }
        };
    }

    public const uint MOUSEEVENTF_LEFTDOWN  = 0x02;
    public const uint MOUSEEVENTF_LEFTUP    = 0x04;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x08;
    public const uint MOUSEEVENTF_RIGHTUP   = 0x10;
    public const uint MOUSEEVENTF_WHEEL     = 0x800;
    public const uint KEYEVENTF_KEYUP        = 0x02;
    public const int  INPUT_KEYBOARD        = 1;
}
"@

$tmpCs = Join-Path $env:TEMP "dsh-cu-$(Get-Date -Format 'yyyyMMddHHmmssfff').cs"
try {
    $cs | Out-File -FilePath $tmpCs -Encoding UTF8
    Add-Type -Path $tmpCs -ErrorAction Stop
} finally {
    Remove-Item $tmpCs -ErrorAction SilentlyContinue
}

# ── Virtual-key code table ──────────────────────────────────────
$VK = @{
    'backspace' = 0x08; 'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D
    'shift' = 0x10; 'control' = 0x11; 'ctrl' = 0x11; 'alt' = 0x12
    'pause' = 0x13; 'capslock' = 0x14; 'escape' = 0x1B; 'space' = 0x20
    'pageup' = 0x21; 'pagedown' = 0x22; 'end' = 0x23; 'home' = 0x24
    'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
    'printscreen' = 0x2C; 'insert' = 0x2D; 'delete' = 0x2E; 'del' = 0x2E
    '0' = 0x30; '1' = 0x31; '2' = 0x32; '3' = 0x33; '4' = 0x34
    '5' = 0x35; '6' = 0x36; '7' = 0x37; '8' = 0x38; '9' = 0x39
    'a' = 0x41; 'b' = 0x42; 'c' = 0x43; 'd' = 0x44; 'e' = 0x45
    'f' = 0x46; 'g' = 0x47; 'h' = 0x48; 'i' = 0x49; 'j' = 0x4A
    'k' = 0x4B; 'l' = 0x4C; 'm' = 0x4D; 'n' = 0x4E; 'o' = 0x4F
    'p' = 0x50; 'q' = 0x51; 'r' = 0x52; 's' = 0x53; 't' = 0x54
    'u' = 0x55; 'v' = 0x56; 'w' = 0x57; 'x' = 0x58; 'y' = 0x59
    'z' = 0x5A
    'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74
    'f6' = 0x75; 'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79
    'f11' = 0x7A; 'f12' = 0x7B
    'lwin' = 0x5C; 'rwin' = 0x5D
    'numpad0' = 0x60; 'numpad1' = 0x61; 'numpad2' = 0x62; 'numpad3' = 0x63
    'numpad4' = 0x64; 'numpad5' = 0x65; 'numpad6' = 0x66; 'numpad7' = 0x67
    'numpad8' = 0x68; 'numpad9' = 0x69
    'multiply' = 0x6A; 'add' = 0x6B; 'subtract' = 0x6D; 'decimal' = 0x6E
    'divide' = 0x6F
    'oem1' = 0xBA; 'oem2' = 0xBF; 'oem3' = 0xC0
    'oem4' = 0xDB; 'oem5' = 0xDC; 'oem6' = 0xDD; 'oem7' = 0xDE
}

# ── Helpers ─────────────────────────────────────────────────────

function Send-Inputs {
    param([INPUT[]]$Inputs)
    if ($Inputs.Length -eq 0) { return }
    [Native]::SendInput([uint]$Inputs.Length, $Inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([typeof](INPUT)))
}

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

function Send-Type {
    param([string]$Text)
    $typed = 0
    foreach ($c in $Text.ToCharArray()) {
        $vk = [Native]::VkKeyScan($c)
        if ($vk -eq -1) { continue }
        $virtualKey = $vk -band 0xFF
        $shiftState = ($vk -shr 8) -band 0xFF

        $inputs = New-Object System.Collections.Generic.List[INPUT]

        if ($shiftState -eq 1) {
            $inputs.Add([Native]::KeyDown(0x10))
        }

        $inputs.Add([Native]::KeyDown([short]$virtualKey))
        $inputs.Add([Native]::KeyUp([short]$virtualKey))

        if ($shiftState -eq 1) {
            $inputs.Add([Native]::KeyUp(0x10))
        }

        Send-Inputs -Inputs $inputs.ToArray()
        Start-Sleep -Milliseconds 1
        $typed++
    }
    return @{ ok = $true; typed = $typed }
}

function Send-Key {
    param([string]$KeyStr)

    $parts = $KeyStr -split '\+'
    $modifiers = @()
    $mainKey = $parts[-1]

    for ($i = 0; $i -lt ($parts.Length - 1); $i++) {
        $modifiers += $parts[$i].ToLower()
    }

    $inputs = New-Object System.Collections.Generic.List[INPUT]

    foreach ($mod in $modifiers) {
        $vk = $VK[$mod]
        if ($vk) { $inputs.Add([Native]::KeyDown([short]$vk)) }
    }

    $vk = $VK[$mainKey.ToLower()]
    if ($vk) {
        $inputs.Add([Native]::KeyDown([short]$vk))
        $inputs.Add([Native]::KeyUp([short]$vk))
    } else {
        $ch = $mainKey[0]
        $vkScan = [Native]::VkKeyScan($ch)
        if ($vkScan -ne -1) {
            $virtualKey = $vkScan -band 0xFF
            $inputs.Add([Native]::KeyDown([short]$virtualKey))
            $inputs.Add([Native]::KeyUp([short]$virtualKey))
        }
    }

    for ($i = $modifiers.Length - 1; $i -ge 0; $i--) {
        $vk = $VK[$modifiers[$i]]
        if ($vk) { $inputs.Add([Native]::KeyUp([short]$vk)) }
    }

    Send-Inputs -Inputs $inputs.ToArray()
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