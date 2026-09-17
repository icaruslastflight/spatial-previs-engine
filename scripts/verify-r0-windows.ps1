[CmdletBinding()]
param([string]$EvidenceDirectory = "$env:TEMP\spatial-previs-r0-evidence")
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
    New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
    $summary = [ordered]@{
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
        machine = $env:COMPUTERNAME
        repository = $repoRoot
        commit = (& git rev-parse HEAD)
        workingTree = (& git status --short)
        operatingSystem = (Get-CimInstance Win32_OperatingSystem).Caption
        cpu = @((Get-CimInstance Win32_Processor).Name)
        gpu = @((Get-CimInstance Win32_VideoController).Name)
        memoryBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
        disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, Size, FreeSpace)
        node = (& node --version)
        ue58EditorExists = (Test-Path 'C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe')
        desktopConformance = 'not_run'
        webChecks = @()
    }
    foreach ($taskName in @('typecheck', 'test', 'build')) {
        & npm.cmd run $taskName 2>&1 | Tee-Object -FilePath (Join-Path $EvidenceDirectory "$taskName.log")
        $taskExitCode = $LASTEXITCODE
        $summary.webChecks += @{ task = $taskName; exitCode = $taskExitCode }
        if ($taskExitCode -ne 0) { throw "$taskName failed with exit code $taskExitCode" }
    }
    $summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'preflight.json')
    Write-Output "Web checks passed. Evidence: $EvidenceDirectory. Native UE5 conformance is NOT RUN."
} finally {
    if ($null -ne $summary) {
        $summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'preflight.json')
    }
    Pop-Location
}
