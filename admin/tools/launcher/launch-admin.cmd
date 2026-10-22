@echo off
chcp 936 >nul
rem ============================================================
rem  聚火拜访 · 管理后台启动器
rem  1) 18080 未监听则用 node 拉起 server.js（独立最小化窗口）
rem  2) 用 Edge 的 --app 模式打开一个无地址栏窗口
rem ============================================================
cd /d "%~dp0"
set "PORT=18080"
set "URL=http://localhost:18080/"

netstat -ano | findstr ":%PORT%" | findstr LISTENING >nul 2>nul
if %errorlevel%==0 goto OPEN

echo 正在启动管理后台（端口 %PORT%）...
start "JuHuoAdminServer" /min "C:\Program Files\nodejs\node.exe" "%~dp0server.js"

set /a tries=0
:WAIT
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":%PORT%" | findstr LISTENING >nul 2>nul
if %errorlevel%==0 goto OPEN
set /a tries+=1
if %tries% lss 15 goto WAIT
echo [ERROR] 服务在 30 秒内没有监听 %PORT%
echo 请在该目录命令行运行： node server.js
pause
exit /b 1

:OPEN
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --window-size=1500,950
) else (
  start "" %URL%
)
exit /b 0
