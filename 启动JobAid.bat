@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================
echo   JobAid / Interview Copilot
echo ================================
echo.
echo 正在启动…（关闭本窗口即退出程序）
echo.
node launch.js
pause
