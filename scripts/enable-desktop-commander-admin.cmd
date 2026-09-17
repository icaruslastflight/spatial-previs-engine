@echo off
setlocal
set "SPATIAL_PREVIS_SETUP=%~dp0apply-remote-workstation-admin.ps1"
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; try { $arguments='-NoProfile -File '+[char]34+$env:SPATIAL_PREVIS_SETUP+[char]34; $process=Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru; exit $process.ExitCode } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 pause
