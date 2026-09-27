@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Test: can we fetch from Dianping with current IP?
echo  (tries 1 store; if blocked it waits 5 min then stops)
echo ============================================
node "tools/fetch_plat_photos.js" --limit=1 --delay=45 --blockwait=5
pause
