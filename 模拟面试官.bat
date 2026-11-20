@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================
echo   模拟面试官（会念题，JobAid 能听到）
echo ================================
echo.
echo 先启动「JobAid」并点开始监听，再用本工具念题。
echo 空格 = 朗读当前题，左右方向键 = 切题，Esc = 退出
echo.
set ELECTRON_RUN_AS_NODE=
"node_modules\electron\dist\electron.exe" scripts\interviewer.js
