@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   检查云端云函数有没有重传（只读，不改任何东西）
echo ============================================
echo.
echo [1/2] login 云函数  —— 决定手机上能不能出「三身份选择页」
set CF=login
node tools\run_adminapi.js ver
echo.
echo [2/2] tasks 云函数  —— 防重 / 加新店 / 业务员身份认人
set CF=tasks
node tools\run_adminapi.js selfCheck
echo.
echo ============================================
echo  怎么看结果：
echo    login 显示  ver=2026-10-01  且  hasAlsoSalesman=true   =^> 已经是新版
echo    login 显示  NEED_REGISTER 之类                          =^> 还是旧代码，要重传 login
echo    tasks 显示  ver=2026-10-01-0100                         =^> 已经是新版
echo ============================================
echo.
pause
