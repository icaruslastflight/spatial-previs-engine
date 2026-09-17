param([ValidateSet('User','Machine','RestoreUser','RestoreMachine')][string]$Mode='User')
$ErrorActionPreference='Stop'
$base=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SpatialPrevis\Workstation'
New-Item -ItemType Directory -Path $base -Force | Out-Null
$machine=$Mode -match 'Machine$'
if($machine){
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=New-Object Security.Principal.WindowsPrincipal($identity)
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
        throw 'Machine settings require normal Windows administrator elevation.'
    }
}
$scope=if($machine){'Machine'}else{'User'}
$backupPath=Join-Path $base ($scope+'-original-settings.json')
$backups=New-Object System.Collections.ArrayList
if(Test-Path $backupPath){
    foreach($entry in @(Get-Content $backupPath -Raw | ConvertFrom-Json)){[void]$backups.Add($entry)}
}
function Save-Original([string]$Path,[string]$Name){
    if(@($backups | Where-Object {$_.Path -eq $Path -and $_.Name -eq $Name}).Count){return}
    $key=Get-Item $Path -ErrorAction SilentlyContinue
    $exists=$null -ne $key -and $key.GetValueNames() -contains $Name
    $value=$null; $kind=$null
    if($exists){$value=$key.GetValue($Name,$null,'DoNotExpandEnvironmentNames');$kind=[string]$key.GetValueKind($Name)}
    [void]$backups.Add([pscustomobject]@{Path=$Path;Name=$Name;Existed=$exists;Kind=$kind;Value=$value})
    ConvertTo-Json -InputObject @($backups.ToArray()) -Depth 8 | Set-Content $backupPath -Encoding UTF8
}
function Set-Setting([string]$Path,[string]$Name,[int]$Value){
    Save-Original $Path $Name
    New-Item $Path -Force | Out-Null
    New-ItemProperty $Path -Name $Name -Value $Value -PropertyType DWord -Force | Out-Null
    if((Get-ItemPropertyValue $Path -Name $Name) -ne $Value){throw "Readback failed: $Name"}
    Write-Output "Verified $Name=$Value"
}
function Disable-Startup([string]$Name){
    $path='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $key=Get-Item $path -ErrorAction SilentlyContinue
    if($null -ne $key -and $key.GetValueNames() -contains $Name){
        Save-Original $path $Name
        Remove-ItemProperty $path -Name $Name
        if((Get-Item $path).GetValueNames() -contains $Name){throw "Startup disable failed: $Name"}
        Write-Output "Disabled startup: $Name"
    }
}
if($Mode -match '^Restore'){
    if(-not (Test-Path $backupPath)){throw 'No original-settings backup exists.'}
    foreach($entry in $backups){
        if($entry.Existed){
            New-Item $entry.Path -Force | Out-Null
            New-ItemProperty $entry.Path -Name $entry.Name -Value $entry.Value -PropertyType $entry.Kind -Force | Out-Null
        }else{Remove-ItemProperty $entry.Path -Name $entry.Name -ErrorAction SilentlyContinue}
    }
    if(-not $machine){
        $shortcut=Join-Path ([Environment]::GetFolderPath('Startup')) 'Desktop Commander Remote.lnk'
        if(Test-Path $shortcut){
            $link=(New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
            if($link.Arguments -like '*SpatialPrevis\Workstation\Start-DesktopCommander.cmd*'){Remove-Item $shortcut}
        }
    }
    Write-Output "Restored $scope original settings. Existing running applications are unchanged."
    exit 0
}
if($machine){
    Set-Setting 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' 'StartupBoostEnabled' 0
    Set-Setting 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' 'BackgroundModeEnabled' 0
    Set-Setting 'HKLM:\SOFTWARE\Policies\Microsoft\Dsh' 'AllowNewsAndInterests' 0
    Set-Setting 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization' 'DODownloadMode' 0
}else{
    Disable-Startup 'Steam'
    Disable-Startup 'EpicGamesLauncher'
    $run=Get-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    foreach($name in @($run.GetValueNames() | Where-Object {$_ -like 'MicrosoftEdgeAutoLaunch_*'})){Disable-Startup $name}
    Set-Setting 'HKCU:\Software\Policies\Microsoft\Windows\CloudContent' 'DisableThirdPartySuggestions' 1
    Set-Setting 'HKCU:\Software\Policies\Microsoft\Windows\CloudContent' 'DisableTailoredExperiencesWithDiagnosticData' 1
    $launcher=Join-Path $base 'Start-DesktopCommander.cmd'
    Copy-Item (Join-Path $PSScriptRoot 'start-desktop-commander.cmd') $launcher -Force
    $shortcut=Join-Path ([Environment]::GetFolderPath('Startup')) 'Desktop Commander Remote.lnk'
    $shell=New-Object -ComObject WScript.Shell
    $link=$shell.CreateShortcut($shortcut)
    if((Test-Path $shortcut) -and $link.Arguments -notlike '*SpatialPrevis\Workstation\Start-DesktopCommander.cmd*'){
        throw 'A different Desktop Commander Remote startup shortcut already exists; preserve it.'
    }
    $link.TargetPath='C:\Windows\System32\cmd.exe'
    $link.Arguments='/d /c ""'+$launcher+'""'
    $link.WorkingDirectory=$base
    $link.WindowStyle=7
    $link.Description='Start the paired Desktop Commander remote agent at Windows sign-in.'
    $link.IconLocation='C:\Windows\System32\cmd.exe,0'
    $link.Save()
    $verified=$shell.CreateShortcut($shortcut)
    if($verified.TargetPath -ne 'C:\Windows\System32\cmd.exe' -or $verified.Arguments -ne $link.Arguments -or $verified.WindowStyle -ne 7){throw 'Shortcut readback failed.'}
    Write-Output 'Verified minimized Desktop Commander Remote startup shortcut.'
}
Write-Output "Original settings saved: $backupPath"
