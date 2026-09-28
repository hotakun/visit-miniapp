@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 重新编译壳程序（去掉铃铛）

echo ========================================
echo   重新编译壳程序（去掉标题栏铃铛）
echo ========================================
echo.

rem ---- 2026-09-28 修正：csc 不在系统 PATH，必须用全路径。按优先级自动找 ----
set "CSC="
for %%p in ("C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\Roslyn\csc.exe" "C:\Program Files\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\Roslyn\csc.exe" "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe" "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe") do if not defined CSC if exist %%p set "CSC=%%~p"

if not defined CSC (
  echo [X] 找不到 csc.exe（C# 编译器）。
  echo     请把这一屏截图发给开发者。
  echo.
  pause
  exit /b 1
)
echo [1/3] 找到编译器：
echo       %CSC%
echo       正在编译...
cd /d "%~dp0packager\shell"
rem 2026-09-28：图标不在 shell 目录里，实际在 packager\inputs\icon.ico
rem   （原来这里写裸的 icon.ico → 报 error CS7064 找不到图标文件）
"%CSC%" -target:winexe -platform:x64 -out:JuHuoVisitAdmin.new.exe -win32icon:"%~dp0packager\inputs\icon.ico" -r:lib\Microsoft.Web.WebView2.Core.dll -r:lib\Microsoft.Web.WebView2.WinForms.dll Program.cs
if errorlevel 1 (
  echo.
  echo [X] 编译失败！请把上面的报错文字截图发给开发者。
  echo.
  pause
  exit /b 1
)
echo       编译成功（编译没输出就是成功）。
echo.
echo [2/3] 关闭正在运行的壳程序...
taskkill /f /im JuHuoVisitAdmin.exe >nul 2>&1
timeout /t 2 /nobreak >nul
echo       已关闭（本来没开就跳过这步）。
echo.
echo [3/3] 替换 admin 目录里的 exe...
copy /y "JuHuoVisitAdmin.new.exe" "%~dp0admin\JuHuoVisitAdmin.exe" >nul
if errorlevel 1 (
  echo.
  echo [X] 替换失败！壳程序可能还开着。
  echo     请先手动关掉后台窗口，再双击本文件重试。
  echo.
  pause
  exit /b 1
)
echo       替换成功。
echo.
echo ========================================
echo   完成！现在重新双击 admin\启动管理后台.bat
echo   标题栏的铃铛就没有了。
echo ========================================
echo.
pause
