@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DeepSeek Harness update

set "DSH_VERSION=0.1.5-alpha.2"
set "DSH_BIN=%LOCALAPPDATA%\pnpm\bin\dsh.cmd"
set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMdd-HHmmss')"`) do set "STAMP=%%I"
set "BACKUP_DIR=%PROJECT_DIR%backups\%STAMP%"

echo ============================================
echo   DeepSeek Harness update
echo   fixed version: %DSH_VERSION%
echo ============================================
echo.

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
echo [1/4] Backing up local DSH data...
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%backup-dsh-data.ps1" -Source "%USERPROFILE%\.dsh" -Destination "%BACKUP_DIR%\dsh"
if errorlevel 1 (
  echo [ERROR] Backup failed. Update was not started.
  pause
  exit /b 1
)

where pnpm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pnpm.cmd was not found in PATH.
  pause
  exit /b 1
)

echo [2/4] Recording current DSH version...
if exist "%DSH_BIN%" "%DSH_BIN%" --version > "%BACKUP_DIR%\version-before.txt" 2>nul

echo [3/4] Installing DSH %DSH_VERSION%...
call pnpm.cmd add -g @deepseek-ai/dsh@%DSH_VERSION%
if errorlevel 1 (
  echo [ERROR] DSH installation failed. The backup is at:
  echo %BACKUP_DIR%
  pause
  exit /b 1
)

if not exist "%DSH_BIN%" (
  echo [ERROR] Installation finished but dsh.cmd was not created at:
  echo %DSH_BIN%
  pause
  exit /b 1
)
"%DSH_BIN%" --version > "%BACKUP_DIR%\version-after.txt" 2>nul

echo [4/4] Done.
echo DSH %DSH_VERSION% is installed. Close and reopen the desktop app.
echo Backup: %BACKUP_DIR%
pause
