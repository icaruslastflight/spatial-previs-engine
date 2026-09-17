@echo off
setlocal
title Desktop Commander Remote
set "PATH=C:\Program Files\nodejs;%PATH%"
rem Reuse the signed-in user's device pairing and avoid starting a second agent.
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; try { $agents=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '@wonderwhy-er[\\/]desktop-commander[\\/]' -and $_.CommandLine -match '\sremote(?:\s|$)' }); if($agents.Count -gt 0){Write-Output 'Desktop Commander is already running.'; exit 10}; exit 0 } catch {Write-Output $_.Exception.Message; exit 20}"
if errorlevel 20 exit /b 20
if errorlevel 10 exit /b 0
call "C:\Program Files\nodejs\npx.cmd" -y @wonderwhy-er/desktop-commander@latest remote
exit /b %errorlevel%
