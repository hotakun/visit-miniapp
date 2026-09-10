@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
node upload_dist.js
echo.
pause
