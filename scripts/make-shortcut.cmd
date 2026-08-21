@echo off
setlocal
chcp 65001 >nul
title 更新桌面快捷方式

rem 找到 dist 下最新的 portable exe
set "EXE="
for /f "delims=" %%f in ('dir /b /o-d "%~dp0..\dist\DeepSeek-Harness-*-portable.exe" 2^>nul') do (
  if not defined EXE set "EXE=%%f"
)
if not defined EXE (
  echo [错误] 未在 dist\ 目录找到打包产物，请先运行 scripts\build-app.cmd
  pause
  exit /b 1
)

set "TARGET=%~dp0..\dist\%EXE%"
set "ICON=%~dp0..\assets\app.ico"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$sh=New-Object -ComObject WScript.Shell;" ^
  "$lnk=$sh.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\DeepSeek Harness.lnk');" ^
  "$lnk.TargetPath='%TARGET%';" ^
  "$lnk.WorkingDirectory='%~dp0..';" ^
  "$lnk.IconLocation='%ICON%,0';" ^
  "$lnk.Description='DeepSeek Harness 桌面应用（独立窗口）';" ^
  "$lnk.Save()"

if errorlevel 1 (
  echo [错误] 快捷方式创建失败
  pause
  exit /b 1
)

echo 桌面快捷方式已更新 -^> %EXE%
pause
