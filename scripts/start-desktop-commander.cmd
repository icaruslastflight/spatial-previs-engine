@echo off
setlocal
title Desktop Commander Remote
rem Prefer an nvm-windows managed Node (docs/DESKTOP_DEV_SETUP.md Phase 3) over
rem the system-wide installer path; fall back to the latter when nvm is absent.
set "NODE_DIR=C:\Program Files\nodejs"
if exist "C:\nvm4w\nodejs\npx.cmd" set "NODE_DIR=C:\nvm4w\nodejs"
if not exist "%NODE_DIR%\npx.cmd" (
    echo Node.js was not found at "%NODE_DIR%". Install Node 22 via nvm-windows first.
    exit /b 30
)
set "PATH=%NODE_DIR%;%PATH%"
rem Reuse the signed-in user's device pairing and avoid starting a second agent.
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; try { $agents=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '@wonderwhy-er[\\/]desktop-commander[\\/]' -and $_.CommandLine -match '\sremote(?:\s|$)' }); if($agents.Count -gt 0){Write-Output 'Desktop Commander is already running.'; exit 10}; exit 0 } catch {Write-Output $_.Exception.Message; exit 20}"
if errorlevel 20 exit /b 20
if errorlevel 10 exit /b 0
call "%NODE_DIR%\npx.cmd" -y @wonderwhy-er/desktop-commander@latest remote
exit /b %errorlevel%
