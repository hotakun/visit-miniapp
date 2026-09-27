@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo ==================================================
echo  Backfill mallCode  (codes with 2+ letters: AA021)
echo  Only mallCode is written. Existing codes are skipped.
echo ==================================================
echo.
echo [1/2] Preview (dry-run, no write)...
echo.
node "tools/run_adminapi.js" backfillMallCode "{\"apply\":false}"
echo.
set /p YN=Apply the changes above? (y/N) 
if /i not "%YN%"=="y" (echo. & echo Cancelled. & pause & exit /b)
echo.
echo [2/2] Writing...
node "tools/run_adminapi.js" backfillMallCode "{\"apply\":true}"
echo.
echo Done. If it failed, re-upload cloud function adminapi first.
pause
