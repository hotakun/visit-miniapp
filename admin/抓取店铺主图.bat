@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Fetch shop photos from Dianping (slow mode)
echo  about 471 stores, delay 45s each, roughly 6 hours
echo  You can close this window anytime; rerun = resume
echo ============================================
node "tools/fetch_plat_photos.js" --all --resume --delay=45 --blockwait=5
pause
