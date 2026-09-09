@echo off
setlocal
chcp 65001 >nul
title DeepSeek Harness rollback

set "DSH_VERSION=%~1"
set "DSH_BIN=%LOCALAPPDATA%\pnpm\bin\dsh.cmd"
if "%DSH_VERSION%"=="" set /p "DSH_VERSION=Enter the DSH version to restore: "
if "%DSH_VERSION%"=="" exit /b 1

where pnpm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pnpm.cmd was not found in PATH.
  pause
  exit /b 1
)

call pnpm.cmd add -g @deepseek-ai/dsh@%DSH_VERSION%
if errorlevel 1 (
  echo [ERROR] Rollback failed.
  pause
  exit /b 1
)

if not exist "%DSH_BIN%" (
  echo [ERROR] Rollback finished but dsh.cmd was not created at:
  echo %DSH_BIN%
  pause
  exit /b 1
)

echo Installed version:
"%DSH_BIN%" --version

echo Restored DSH %DSH_VERSION%. Close and reopen the desktop app.
pause
