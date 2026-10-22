# 聚火拜访 · 管理后台启动器（PowerShell 版）
# 1) 18080 未监听 → 用 node 拉起 server.js（隐藏窗口）
# 2) 等端口就绪 → Edge --app 打开无地址栏窗口

$ErrorActionPreference = 'Continue'
$Port = 18080
$Dir  = Split-Path -Parent $MyInvocation.MyCommand.Path      # tools\launcher
$Root = Split-Path -Parent (Split-Path -Parent $Dir)        # admin\
$Url  = "http://localhost:$Port/"

function Test-Port {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(400)) { $c.Close(); return $false }
        $c.EndConnect($ar); $c.Close(); return $true
    } catch { return $false }
}

if (-not (Test-Port)) {
    $node = 'C:\Program Files\nodejs\node.exe'
    if (-not (Test-Path $node)) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("找不到 Node.js：`n$node", '聚火拜访 · 管理后台') | Out-Null
        exit 1
    }
    $env:PORT = "$Port"
    Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden
    for ($i = 0; $i -lt 40 -and -not (Test-Port); $i++) { Start-Sleep -Milliseconds 500 }
}

if (-not (Test-Port)) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("服务未能在 20 秒内监听端口 $Port。`n请在 $Root 下运行 node server.js 查看报错。", '聚火拜访 · 管理后台') | Out-Null
    exit 1
}

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }

# ⭐⭐ 2026-10-22 老板定（实测：反复点快捷方式会叠一堆窗口）：
#   **已经开着就把它激活到前台，绝不再开一个新窗口。**
if (-not ('JhWin' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class JhWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
}
$existing = Get-Process msedge -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like '*聚火拜访*' -and $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
if ($existing) {
    [void][JhWin]::ShowWindow($existing.MainWindowHandle, 9)      # 9 = SW_RESTORE（最小化的也还原）
    [void][JhWin]::SetForegroundWindow($existing.MainWindowHandle)
    exit 0
}

if (Test-Path $edge) {
    # ⚠️ 2026-10-22 修：快捷方式用 -WindowStyle Hidden 启动 powershell 时，
    #   这个「隐藏」会被子进程继承 → Edge 窗口建出来但是隐藏的（进程在、看不见）。
    #   显式指定 Normal 覆盖继承，窗口才会真的显示。
    Start-Process -FilePath $edge -ArgumentList "--app=$Url", '--window-size=1500,950' -WindowStyle Normal
} else {
    Start-Process $Url
}
exit 0
