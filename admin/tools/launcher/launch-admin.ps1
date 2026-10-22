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

# ⭐⭐ 2026-10-22 老板实测（「你看看现在有几个窗口？都乱了呀」）：
#   Edge 把**多个 app 窗口塞在同一个进程里**，而 `Get-Process | MainWindowTitle` 每个进程只报一个 →
#   按它判断"是否已开着"完全失效、越点越多。改成 **Win32 枚举所有可见顶层窗口**按标题找；
#   找到多于一个就**把多余的关掉**，只留一个并置前。
if (-not ('JhWins' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class JhWins {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static List<IntPtr> Find(string needle, int[] pids) {
    var res = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      if (t.Length == 0 || t.IndexOf(needle) < 0) return true;
      int pid; GetWindowThreadProcessId(h, out pid);
      for (int i = 0; i < pids.Length; i++) { if (pids[i] == pid) { res.Add(h); break; } }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
}
# 用字符码拼「聚火拜访」，避免脚本编码不小心变坏时匹配不上
$needle = [string][char]0x805A + [char]0x706B + [char]0x62DC + [char]0x8BBF
$epids = @(Get-Process msedge -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$wins = [JhWins]::Find($needle, [int[]]$epids)
if ($wins.Count -gt 0) {
    for ($i = 1; $i -lt $wins.Count; $i++) {
        [void][JhWins]::PostMessageW($wins[$i], 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE：多余的关掉
    }
    [void][JhWins]::ShowWindow($wins[0], 9)          # 9 = SW_RESTORE（最小化的也还原）
    [void][JhWins]::SetForegroundWindow($wins[0])
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
