@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo [ERROR] Node.js not found & pause & exit /b 1)
echo ============================================
echo  Juhuo Visit - Admin Server  (PORT 8581)
echo  Browser: http://localhost:8581
echo ============================================
set PORT=8581
node server.js
pause
