param(
    [Parameter(Mandatory=$false)]
    [string]$Action = "play_top",
    [Parameter(Mandatory=$false)]
    [string]$Query = "",
    [Parameter(Mandatory=$false)]
    [switch]$SystemMedia,
    [Parameter(Mandatory=$false)]
    [switch]$Force
)

$code = @"
using System;
using System.Text;
using System.Drawing;
using System.Threading;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Diagnostics;

public class NativeMediaControl {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenWindowStation(string lpszWinSta, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessWindowStation(IntPtr hWinSta);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    public static extern short VkKeyScan(char ch);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP   = 0x0202;
    public const uint MK_LBUTTON     = 0x0001;
    public const uint WM_KEYDOWN     = 0x0100;
    public const uint WM_KEYUP       = 0x0101;
    public const uint WM_CHAR        = 0x0102;

    public const uint WM_APPCOMMAND = 0x0319;
    public const int APPCOMMAND_MEDIA_PLAY_PAUSE = 14;
    public const int APPCOMMAND_MEDIA_NEXTTRACK = 11;
    public const int APPCOMMAND_MEDIA_PREVTRACK = 12;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    public static IntPtr FindSpotifyWindow() {
        // Strategy 1: Check Process.GetProcessesByName("Spotify")
        try {
            var procs = Process.GetProcessesByName("Spotify");
            foreach (var p in procs) {
                if (p.MainWindowHandle != IntPtr.Zero) {
                    RECT r;
                    GetWindowRect(p.MainWindowHandle, out r);
                    int w = r.Right - r.Left;
                    int h = r.Bottom - r.Top;
                    if (w > 320 && h > 200) {
                        var sb = new StringBuilder(256);
                        GetWindowText(p.MainWindowHandle, sb, 256);
                        string t = sb.ToString().Trim();
                        if (!string.IsNullOrEmpty(t) && !t.Equals("Spotify", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("Spotify Free", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("Spotify Premium", StringComparison.OrdinalIgnoreCase)) {
                            return p.MainWindowHandle;
                        }
                    }
                }
            }
        } catch {}

        // Strategy 2: Gather all Spotify PIDs and inspect all top-level windows
        var spotifyPids = new HashSet<uint>();
        try {
            foreach (var p in Process.GetProcessesByName("Spotify")) {
                spotifyPids.Add((uint)p.Id);
            }
        } catch {}

        IntPtr foundTitle = IntPtr.Zero;
        IntPtr foundMain = IntPtr.Zero;

        EnumWindowsProc proc = (hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            bool isSpotify = spotifyPids.Contains(pid);
            if (!isSpotify) {
                try {
                    var p = Process.GetProcessById((int)pid);
                    if (p.ProcessName.Equals("Spotify", StringComparison.OrdinalIgnoreCase)) {
                        isSpotify = true;
                    }
                } catch {}
            }
            if (isSpotify) {
                RECT r;
                GetWindowRect(hWnd, out r);
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (w > 320 && h > 200) {
                    var sb = new StringBuilder(256);
                    GetWindowText(hWnd, sb, 256);
                    string t = sb.ToString().Trim();
                    if (!string.IsNullOrEmpty(t) && !t.Equals("Spotify", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("Spotify Free", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("Spotify Premium", StringComparison.OrdinalIgnoreCase)) {
                        foundTitle = hWnd;
                        return false; // Found window with playing song title!
                    }
                    if (foundMain == IntPtr.Zero) {
                        foundMain = hWnd;
                    }
                }
            }
            return true;
        };

        // Try standard EnumWindows first
        EnumWindows(proc, IntPtr.Zero);
        if (foundTitle != IntPtr.Zero) return foundTitle;
        if (foundMain != IntPtr.Zero) return foundMain;

        // Try EnumDesktopWindows if standard didn't locate it
        try {
            IntPtr hwinsta = OpenWindowStation("WinSta0", false, 0x037F);
            if (hwinsta != IntPtr.Zero) SetProcessWindowStation(hwinsta);
            IntPtr hdesk = OpenDesktop("Default", 0, false, 0x01FF);
            if (hdesk != IntPtr.Zero) {
                EnumDesktopWindows(hdesk, proc, IntPtr.Zero);
            }
        } catch {}

        return foundTitle != IntPtr.Zero ? foundTitle : foundMain;
    }

    public static IntPtr FindRenderWidget(IntPtr parent) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(parent, (hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            if (sb.ToString().Contains("Chrome_RenderWidgetHostHWND")) {
                RECT r;
                GetWindowRect(hWnd, out r);
                if (r.Right - r.Left > 300) {
                    found = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static void Click(IntPtr hWnd, int x, int y, bool doubleClick = false) {
        IntPtr lParam = (IntPtr)((y << 16) | (x & 0xFFFF));
        PostMessage(hWnd, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lParam);
        Thread.Sleep(50);
        PostMessage(hWnd, WM_LBUTTONUP, IntPtr.Zero, lParam);

        if (doubleClick) {
            Thread.Sleep(80);
            PostMessage(hWnd, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lParam);
            Thread.Sleep(50);
            PostMessage(hWnd, WM_LBUTTONUP, IntPtr.Zero, lParam);
        }
    }

    public static void SendKey(IntPtr hWnd, byte vk) {
        uint scan = MapVirtualKey((uint)vk, 0);
        IntPtr lParamDown = (IntPtr)(1 | (scan << 16));
        IntPtr lParamUp = (IntPtr)(1 | (scan << 16) | (1 << 30) | (1 << 31));
        PostMessage(hWnd, WM_KEYDOWN, (IntPtr)vk, lParamDown);
        Thread.Sleep(15);
        PostMessage(hWnd, WM_KEYUP, (IntPtr)vk, lParamUp);
    }

    public static void SendChar(IntPtr hWnd, char c) {
        short vkScan = VkKeyScan(c);
        byte vk = (byte)(vkScan & 0xFF);
        uint scan = MapVirtualKey((uint)vk, 0);
        IntPtr lParam = (IntPtr)(1 | (scan << 16));
        PostMessage(hWnd, WM_CHAR, (IntPtr)c, lParam);
        Thread.Sleep(16);
    }

    public static Point FindGreenPlayButton(IntPtr hWnd) {
        RECT r;
        GetWindowRect(hWnd, out r);
        int w = r.Right - r.Left;
        int h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return Point.Empty;

        using (Bitmap bmp = new Bitmap(w, h)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                IntPtr hdc = g.GetHdc();
                bool ok = PrintWindow(hWnd, hdc, 2);
                g.ReleaseHdc(hdc);
                if (!ok) return Point.Empty;

                long sumX = 0;
                long sumY = 0;
                int count = 0;

                int startY = 120;
                int endY = Math.Min(h - 80, 380);
                int startX = 160;
                int endX = Math.Min(w - 40, (int)(w * 0.88));

                for (int y = startY; y < endY; y += 2) {
                    for (int x = startX; x < endX; x += 2) {
                        Color c = bmp.GetPixel(x, y);
                        // Spotify green: R < 65, G > 175, B < 125
                        if (c.G > 175 && c.R < 65 && c.B < 125) {
                            sumX += x;
                            sumY += y;
                            count++;
                        }
                    }
                }

                if (count >= 20) {
                    return new Point((int)(sumX / count), (int)(sumY / count));
                }
            }
        }
        return Point.Empty;
    }

    public static bool SearchAndPlay(IntPtr mainHwnd, string query) {
        IntPtr render = FindRenderWidget(mainHwnd);
        if (render == IntPtr.Zero) return false;

        // Its own link goes to the results whatever the size of the window and wherever the focus is.
        // Clicking the search bar by coordinates broke whenever the layout changed.
        System.Diagnostics.Process.Start("spotify:search:" + Uri.EscapeDataString(query));
        Thread.Sleep(1800);

        // Try clicking green play button / top card up to 4 attempts
        var sb = new StringBuilder(256);
        for (int attempt = 0; attempt < 4; attempt++) {
            Point playBtn = FindGreenPlayButton(mainHwnd);
            if (playBtn.IsEmpty) {
                RECT r;
                GetWindowRect(mainHwnd, out r);
                int w = r.Right - r.Left;
                playBtn = new Point(Math.Min(630, (int)(w * 0.63)), 180);
            }

            Click(render, playBtn.X, playBtn.Y);
            Thread.Sleep(600);

            GetWindowText(mainHwnd, sb, 256);
            string t = sb.ToString().Trim();
            bool isPlaying = (!string.IsNullOrEmpty(t) && !t.Equals("Spotify", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("Spotify Free", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("Spotify Premium", StringComparison.OrdinalIgnoreCase));

            if (isPlaying) {
                return true;
            }

            // Fallback: double-click top result card body
            RECT rCard;
            GetWindowRect(mainHwnd, out rCard);
            int wCard = rCard.Right - rCard.Left;
            int cardX = Math.Min(480, (int)(wCard * 0.45));
            Click(render, cardX, 220, true);
            Thread.Sleep(600);

            GetWindowText(mainHwnd, sb, 256);
            t = sb.ToString().Trim();
            if (!string.IsNullOrEmpty(t) && !t.Equals("Spotify", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("Spotify Free", StringComparison.OrdinalIgnoreCase) && !t.StartsWith("Spotify Premium", StringComparison.OrdinalIgnoreCase)) {
                return true;
            }
        }

        return true;
    }

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    public static void SystemMediaKey(byte key) {
        keybd_event(key, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 2, UIntPtr.Zero);
    }

    public static void NextTrack(IntPtr hWnd) {
        if (hWnd != IntPtr.Zero) {
            SendMessage(hWnd, WM_APPCOMMAND, hWnd, (IntPtr)(APPCOMMAND_MEDIA_NEXTTRACK << 16));
        }
    }

    public static void PrevTrack(IntPtr hWnd) {
        if (hWnd != IntPtr.Zero) {
            SendMessage(hWnd, WM_APPCOMMAND, hWnd, (IntPtr)(APPCOMMAND_MEDIA_PREVTRACK << 16));
        }
    }

    public static void PlayPause(IntPtr hWnd) {
        if (hWnd != IntPtr.Zero) {
            SendMessage(hWnd, WM_APPCOMMAND, hWnd, (IntPtr)(APPCOMMAND_MEDIA_PLAY_PAUSE << 16));
        }
    }
}
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing -ErrorAction SilentlyContinue

function Get-SystemPlaybackStatus {
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1
        $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
        $task = $asTask.MakeGenericMethod($managerType).Invoke($null, @($managerType::RequestAsync()))
        if (-not $task.Wait(2000)) { return $null }
        $session = $task.Result.GetCurrentSession()
        if ($null -eq $session) { return $null }
        return [string]$session.GetPlaybackInfo().PlaybackStatus
    } catch {
        return $null
    }
}

if ($SystemMedia) {
    $action = $Action.ToLower()
    if ($action -eq "play" -or $action -eq "pause") {
        $status = Get-SystemPlaybackStatus
        if ($action -eq "play" -and $status -eq "Playing") { return }
        if ($action -eq "pause" -and $null -ne $status -and $status -ne "Playing") { return }
    }
    $key = switch ($action) {
        "next" { 0xB0 }
        "prev" { 0xB1 }
        default { 0xB3 }
    }
    [NativeMediaControl]::SystemMediaKey([byte]$key)
    return
}

$hwnd = [NativeMediaControl]::FindSpotifyWindow()
$title = ""
$isPlaying = $false
if ($hwnd -ne [IntPtr]::Zero) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][NativeMediaControl]::GetWindowText($hwnd, $sb, 256)
    $title = $sb.ToString().Trim()
    $isPlaying = ($title -ne "" -and $title -ne "Spotify" -and $title -ne "Spotify Free" -and $title -ne "Spotify Premium")
}

switch ($Action.ToLower()) {
    "status" {
        @{ isPlaying = $isPlaying; title = $title; hwnd = [int64]$hwnd } | ConvertTo-Json -Compress
        return
    }
    "get_title" {
        Write-Output $title
        return
    }
    "next" {
        [NativeMediaControl]::NextTrack($hwnd)
    }
    "prev" {
        [NativeMediaControl]::PrevTrack($hwnd)
    }
    "play" {
        # Only toggle if not currently playing
        if (-not $isPlaying) {
            [NativeMediaControl]::PlayPause($hwnd)
        }
    }
    "pause" {
        # Only toggle if currently playing
        if ($isPlaying) {
            [NativeMediaControl]::PlayPause($hwnd)
        }
    }
    "play_pause" {
        [NativeMediaControl]::PlayPause($hwnd)
    }
    "change_top" {
        try {
            $targetHwnd = $hwnd
            if ($targetHwnd -eq [IntPtr]::Zero) {
                for ($i = 0; $i -lt 15; $i++) {
                    $targetHwnd = [NativeMediaControl]::FindSpotifyWindow()
                    if ($targetHwnd -ne [IntPtr]::Zero) { break }
                    Start-Sleep -Milliseconds 250
                }
            }

            if ($targetHwnd -ne [IntPtr]::Zero) {
                if ($Query -ne "") {
                    [void][NativeMediaControl]::SearchAndPlay($targetHwnd, $Query)
                } else {
                    [NativeMediaControl]::NextTrack($targetHwnd)
                }
            }
        } catch {}
    }
    "play_top" {
        if ($Force) {
            & $MyInvocation.MyCommand.Path -Action "change_top" -Query $Query
            return
        }
        try {
            $targetHwnd = $hwnd
            if ($targetHwnd -eq [IntPtr]::Zero) {
                for ($i = 0; $i -lt 15; $i++) {
                    $targetHwnd = [NativeMediaControl]::FindSpotifyWindow()
                    if ($targetHwnd -ne [IntPtr]::Zero) { break }
                    Start-Sleep -Milliseconds 250
                }
            }

            if ($targetHwnd -ne [IntPtr]::Zero) {
                # Check if this exact requested song is already playing
                $sb = New-Object System.Text.StringBuilder 256
                [void][NativeMediaControl]::GetWindowText($targetHwnd, $sb, 256)
                $initTitle = $sb.ToString().Trim()
                $alreadyPlaying = ($initTitle -ne "" -and $initTitle -ne "Spotify" -and $initTitle -ne "Spotify Free" -and $initTitle -ne "Spotify Premium")

                if ($Query -ne "" -and $alreadyPlaying -and $initTitle.ToLower().Contains($Query.ToLower())) {
                    return
                }

                if ($Query -ne "") {
                    [void][NativeMediaControl]::SearchAndPlay($targetHwnd, $Query)
                } else {
                    if (-not $alreadyPlaying) {
                        [NativeMediaControl]::PlayPause($targetHwnd)
                    }
                }
            }
        } catch {}
    }
    default {
        [NativeMediaControl]::PlayPause($hwnd)
    }
}
