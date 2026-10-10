@echo off
chcp 65001 >nul
cd /d "%~dp0.."

echo.
echo ==========================================================
echo  按「订单表」回填客户的「最近下单」（lastOrderAt）
echo ==========================================================
echo.
echo  背景：商城表带进来的「最后下单」是商城系统的快照，会滞后于
echo        我们自己的销售订单，导致 手机端/后台 两处显示不一致。
echo        2026-10-07 起口径统一：**一律以订单表为准**。
echo        每次导入/更新订单之后，跑一次这个脚本即可。
echo.

echo [1/2] 先预览：看看有多少家不一致（这一步不写库）...
node tools\run_adminapi.js backfillLastOrder
echo.

echo [2/2] 上面那批确认无误后，按任意键开始写入；不想写就关掉这个窗口。
pause >nul

node tools\run_adminapi.js backfillLastOrder {"apply":true}

echo.
echo 完成。手机端/后台刷新一下即可看到新日期。
pause
