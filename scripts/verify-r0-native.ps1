[CmdletBinding()]
param(
    [string]$EngineRoot = $env:SPATIAL_PREVIS_UE_ROOT,
    [switch]$CoordinatesOnly,
    [ValidateRange(1, 64)][int]$MaxParallelActions = 2
)
$ErrorActionPreference = 'Stop'
# Remote process hosts can omit optional Windows environment entries. Build.bat
# places its lock under TMP; an absent TMP otherwise looks like a competing build.
$windowsTemp = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'
if (!$env:TMP) { $env:TMP = $windowsTemp }
if (!$env:TEMP) { $env:TEMP = $windowsTemp }
if (!(Test-Path -LiteralPath $env:TMP)) { New-Item -ItemType Directory -Path $env:TMP -Force | Out-Null }
$repoRoot = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$evidenceDir = Join-Path $repoRoot "test-results\native\$stamp"
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
if (!$programFilesX86) { $programFilesX86 = Join-Path $env:SystemDrive 'Program Files (x86)' }
if (!${env:ProgramFiles(x86)}) { [Environment]::SetEnvironmentVariable('ProgramFiles(x86)', $programFilesX86, 'Process') }
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path $vswhere)) { throw 'Visual Studio C++ tools were not found.' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$visualStudio) { throw 'Install the C++ build tools in Visual Studio.' }
$vcvars = Join-Path $visualStudio 'VC\Auxiliary\Build\vcvars64.bat'
$include = Join-Path $repoRoot 'native\SpatialPrevis\Source\SpatialPrevisCore\Public'
$source = Join-Path $repoRoot 'native\tests\coordinates.cpp'
$executable = Join-Path $evidenceDir 'coordinates.exe'
$compileCmd = Join-Path $evidenceDir 'compile-coordinates.cmd'
@"
@echo off
call "$vcvars" >nul
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /W4 /WX /EHsc /I"$include" "$source" /Fe:"$executable" /Fo:"$evidenceDir\coordinates.obj"
if errorlevel 1 exit /b 1
"$executable"
"@ | Set-Content -LiteralPath $compileCmd -Encoding Ascii
& cmd.exe /d /c $compileCmd 2>&1 | Tee-Object -FilePath (Join-Path $evidenceDir 'coordinates.log')
if ($LASTEXITCODE -ne 0) { throw 'Native coordinate compilation or assertions failed.' }
if ($CoordinatesOnly) { Write-Host "Coordinate evidence: $evidenceDir"; exit 0 }

if (!$EngineRoot) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Epic Games\UE_5.8'),
        (Get-ItemProperty 'HKLM:\SOFTWARE\EpicGames\Unreal Engine\5.8' -ErrorAction SilentlyContinue).InstalledDirectory
    )
    $EngineRoot = $candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ 'Engine\Build\Build.version')) } | Select-Object -First 1
}
if (!$EngineRoot) { throw 'UE5.8 is not installed. Finish its Epic Launcher installation, then set SPATIAL_PREVIS_UE_ROOT or pass -EngineRoot.' }
$version = Get-Content (Join-Path $EngineRoot 'Engine\Build\Build.version') -Raw | ConvertFrom-Json
if ($version.MajorVersion -ne 5 -or $version.MinorVersion -ne 8) { throw 'This project is pinned to UE5.8; refusing another engine version.' }
$project = Join-Path $repoRoot 'native\SpatialPrevis\SpatialPrevis.uproject'
$build = Join-Path $EngineRoot 'Engine\Build\BatchFiles\Build.bat'
$editor = Join-Path $EngineRoot 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
$corpus = Join-Path $repoRoot 'tests\fixtures\r0\project-conformance.v1.json'
$report = Join-Path $evidenceDir 'conformance.json'
[ordered]@{
    scope='Native project/workspace contracts, repository and read-only scene tools'; engine=$version; compilerInstallation=$visualStudio
    commit=(& git -C $repoRoot rev-parse HEAD); dirty=@(& git -C $repoRoot status --porcelain)
    os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version)
    cpu=(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfLogicalProcessors)
    ram=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion)
    disk=@(Get-PSDrive -PSProvider FileSystem | Select-Object Name,Free)
} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidenceDir 'host.json') -Encoding UTF8
& $build SpatialPrevisEditor Win64 Development "-Project=$project" "-MaxParallelActions=$MaxParallelActions" -WaitMutex -NoHotReloadFromIDE 2>&1 | Tee-Object (Join-Path $evidenceDir 'build.log')
if ($LASTEXITCODE -ne 0) { throw "UE build failed; inspect $evidenceDir\build.log" }
& $editor $project -run=SpatialPrevisConformance "-Corpus=$corpus" "-Report=$report" -unattended -NullRHI -nosplash -nop4 2>&1 | Tee-Object (Join-Path $evidenceDir 'commandlet.log')
if ($LASTEXITCODE -ne 0) { throw "Native conformance failed; inspect $evidenceDir" }
& node (Join-Path $PSScriptRoot 'compare-r0-native.mjs') $report 2>&1 | Tee-Object (Join-Path $evidenceDir 'comparison.log')
if ($LASTEXITCODE -ne 0) { throw 'Native semantic comparison failed.' }
$workspaceCorpus = Join-Path $repoRoot 'tests\fixtures\r0\workspace-conformance.v1.json'
$workspaceReport = Join-Path $evidenceDir 'workspace-conformance.json'
& $editor $project -run=SpatialPrevisWorkspaceConformance "-Corpus=$workspaceCorpus" "-Report=$workspaceReport" -unattended -NullRHI -nosplash -nop4 2>&1 | Tee-Object (Join-Path $evidenceDir 'workspace-commandlet.log')
if ($LASTEXITCODE -ne 0) { throw "Native workspace conformance failed; inspect $evidenceDir" }
& node (Join-Path $PSScriptRoot 'compare-r0-native-workspace.mjs') $workspaceReport 2>&1 | Tee-Object (Join-Path $evidenceDir 'workspace-comparison.log')
if ($LASTEXITCODE -ne 0) { throw 'Native workspace semantic comparison failed.' }
Write-Host "Native conformance evidence: $evidenceDir"
Write-Host 'Contract conformance does not close rendering, actual Android, or owner acceptance gates.'
