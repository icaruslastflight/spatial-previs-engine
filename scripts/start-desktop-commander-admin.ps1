$ErrorActionPreference='Stop'
$base=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SpatialPrevis\Workstation'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'The startup task must run with highest privileges.'}
$marker=Join-Path $base 'replace-agent-once.json'
if(Test-Path $marker){
    $replacement=Get-Content $marker -Raw | ConvertFrom-Json
    Remove-Item $marker
    if([datetimeoffset]::UtcNow -lt [datetimeoffset]$replacement.ExpiresUtc){
        Start-Sleep -Seconds 5
        foreach($entry in $replacement.Processes){
            $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$entry.Id)
            if($null -ne $process -and $process.Name -eq 'node.exe' -and
               $process.CommandLine -match '@wonderwhy-er[\\/]desktop-commander[\\/]' -and
               [string]$process.CreationDate.ToUniversalTime().Ticks -eq [string]$entry.CreationTicks){
                Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
                Wait-Process -Id $process.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
                $remaining=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$entry.Id)
                if($null -ne $remaining -and [string]$remaining.CreationDate.ToUniversalTime().Ticks -eq [string]$entry.CreationTicks){throw 'The old agent has not exited; retry startup after it closes.'}
            }
        }
    }
}
[pscustomobject]@{StartedUtc=(Get-Date).ToUniversalTime().ToString('o');User=$identity.Name;Administrator=$true} |
    ConvertTo-Json | Set-Content (Join-Path $base 'last-administrator-start.json') -Encoding UTF8
& (Join-Path $base 'Start-DesktopCommander.cmd')
exit $LASTEXITCODE
