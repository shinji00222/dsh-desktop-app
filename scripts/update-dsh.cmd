@echo off
setlocal
chcp 65001 >nul
title DeepSeek Harness 更新

set "HARNESS_DIR=C:\Users\lwz12\source\repos\deepseek-harness"
set "NODE=C:\Users\lwz12\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v26.7.0-win-x64\node.exe"
set "PNPM_CMD=%~dp0..\node_modules\.bin\pnpm.cmd"

echo ============================================
echo   DeepSeek Harness 更新（DSH 本体）
echo ============================================
echo.
if not exist "%HARNESS_DIR%\.git" (
  echo [错误] 未找到 DSH 仓库: %HARNESS_DIR%
  echo 请检查 scripts\update-dsh.cmd 中的 HARNESS_DIR 配置。
  pause
  exit /b 1
)

echo [1/4] git pull（拉取最新代码）...
cd /d "%HARNESS_DIR%"
git pull --ff-only
if errorlevel 1 (
  echo.
  echo [错误] git pull 失败。请检查网络，或本地是否有未提交的改动。
  pause
  exit /b 1
)

echo.
echo [2/4] 安装依赖（pnpm install）...
if not exist "%PNPM_CMD%" (
  echo [错误] 项目内未找到 pnpm，请先在应用项目目录运行 npm install。
  pause
  exit /b 1
)
call "%PNPM_CMD%" install
if errorlevel 1 (
  echo.
  echo [错误] 依赖安装失败。
  pause
  exit /b 1
)

echo.
echo [3/4] 构建 DSH（npm run build）...
call npm run build
if errorlevel 1 (
  echo.
  echo [错误] 构建失败。请将上方报错信息截图反馈。
  pause
  exit /b 1
)

echo.
echo [4/4] 完成！
echo.
echo DSH 已更新到最新版。请关闭并重新打开桌面应用。
echo （应用本体无需重新安装，打开即是新版本）
pause
