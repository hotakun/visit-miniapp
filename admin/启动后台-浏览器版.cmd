@echo off
chcp 936 >nul
rem 聚火拜访 · 管理后台启动器（调用 tools\launcher\launch-admin.ps1）
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launcher\launch-admin.ps1"