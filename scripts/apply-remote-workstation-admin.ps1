$ErrorActionPreference='Stop'
$base=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SpatialPrevis\Workstation'
New-Item -ItemType Directory -Path $base -Force | Out-Null
try {
    Start-Transcript -Path (Join-Path $base 'administrator-setup-log.txt') -Force | Out-Null
    & (Join-Path $PSScriptRoot 'configure-remote-workstation.ps1') -Mode User
    & (Join-Path $PSScriptRoot 'configure-remote-workstation.ps1') -Mode Machine
    & (Join-Path $PSScriptRoot 'configure-desktop-commander-admin.ps1')
    [pscustomobject]@{Success=$true;Completed=(Get-Date).ToString('o')} | ConvertTo-Json |
        Set-Content (Join-Path $base 'administrator-setup-result.json') -Encoding UTF8
} catch {
    [pscustomobject]@{Success=$false;Error=$_.Exception.Message;Completed=(Get-Date).ToString('o')} | ConvertTo-Json |
        Set-Content (Join-Path $base 'administrator-setup-result.json') -Encoding UTF8
    throw
} finally { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null }
