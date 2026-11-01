@echo off
chcp 65001 >nul
title 方块盒子论坛 - 本地服务
cd /d "%~dp0"

if not exist "data" mkdir "data"

echo ============================================
echo  方块盒子论坛 · 本地开发服务
echo  地址: http://127.0.0.1:3210
echo  数据库: %cd%\data\forum.db
echo  关闭这个窗口即可停止服务
echo ============================================
echo.

node --disable-warning=ExperimentalWarning server\index.js

echo.
echo 服务已停止，按任意键关闭窗口…
pause >nul
