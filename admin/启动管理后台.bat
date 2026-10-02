@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo [ERROR] Node.js not found & pause & exit /b 1)
echo ============================================
echo  Juhuo Visit - Admin Server  (PORT 18080)
echo  Browser: http://localhost:18080
echo ============================================
set PORT=18080
node server.js
pause
