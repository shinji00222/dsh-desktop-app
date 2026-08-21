@echo off
setlocal
chcp 65001 >nul
title 打包 DeepSeek Harness 桌面应用

cd /d "%~dp0.."

echo ============================================
echo   打包 DeepSeek Harness 桌面应用（portable）
echo ============================================
echo.

rem 将下载缓存放在项目内，便于管理
set "npm_config_cache=%~dp0..\.npm-cache"
set "ELECTRON_CACHE=%~dp0..\.electron-cache"
set "ELECTRON_BUILDER_CACHE=%~dp0..\.electron-builder-cache"

echo [1/3] 安装依赖（含 electron / electron-builder）...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [错误] 依赖安装失败
  pause
  exit /b 1
)

echo.
echo [2/3] 打包 portable exe ...
call npx electron-builder --win portable
if errorlevel 1 (
  echo [错误] 打包失败，请查看上方日志
  pause
  exit /b 1
)

echo.
echo [3/3] 完成！
echo 产物：dist\DeepSeek-Harness-*-portable.exe
echo 更新桌面快捷方式指向新 exe 即可。
pause
