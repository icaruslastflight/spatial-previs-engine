$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Approve normal Windows elevation for this setup.'}
$base=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SpatialPrevis\Workstation'
New-Item -ItemType Directory -Path $base -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'start-desktop-commander.cmd') (Join-Path $base 'Start-DesktopCommander.cmd') -Force
$runner=Join-Path $base 'Start-DesktopCommander-Admin.ps1'
Copy-Item (Join-Path $PSScriptRoot 'start-desktop-commander-admin.ps1') $runner -Force
$name='SpatialPrevis-DesktopCommander'
$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if($null -ne $existing -and @($existing.Actions | Where-Object {$_.Arguments -like '*SpatialPrevis\Workstation\Start-DesktopCommander-Admin.ps1*'}).Count -eq 0){throw 'Preserve the unrelated task with this name.'}
$action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument ('-NoProfile -WindowStyle Minimized -File "'+$runner+'"') -WorkingDirectory $base
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$taskPrincipal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description 'Owner-authorized administrator Desktop Commander at Windows sign-in. Disable this task to stop automatic startup.' -Force | Out-Null
$verified=Get-ScheduledTask -TaskName $name
if($verified.Principal.RunLevel -ne 'Highest' -or $verified.Principal.LogonType -ne 'Interactive'){throw 'Administrator task readback failed.'}
$shortcut=Join-Path ([Environment]::GetFolderPath('Startup')) 'Desktop Commander Remote.lnk'
if(Test-Path $shortcut){
    $link=(New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
    if($link.Arguments -like '*SpatialPrevis\Workstation\Start-DesktopCommander.cmd*'){Remove-Item $shortcut}
}
$agents=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -match '@wonderwhy-er[\\/]desktop-commander[\\/]'})
$processes=@($agents | ForEach-Object {[pscustomobject]@{Id=$_.ProcessId;CreationTicks=[string]$_.CreationDate.ToUniversalTime().Ticks}})
[pscustomobject]@{ExpiresUtc=(Get-Date).ToUniversalTime().AddMinutes(2).ToString('o');Processes=$processes} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $base 'replace-agent-once.json') -Encoding UTF8
[pscustomobject]@{Task=$name;RunLevel=[string]$verified.Principal.RunLevel;LogonType=[string]$verified.Principal.LogonType;User=$verified.Principal.UserId} | ConvertTo-Json | Set-Content (Join-Path $base 'administrator-task-configuration.json') -Encoding UTF8
Write-Output 'Verified administrator startup task. Reconnecting the paired device agent.'
Start-ScheduledTask -TaskName $name
