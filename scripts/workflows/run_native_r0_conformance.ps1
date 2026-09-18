<#
.SYNOPSIS
    Runs the R0 native-conformance path end to end: corpus freshness, web
    preflight, then the Windows-only UE5 build + conformance commandlets.

.DESCRIPTION
    scripts/verify-r0-native.ps1 already chains the coordinate compile, the
    UE5 editor build, both conformance commandlets and both semantic
    comparators internally -- this wrapper does not reimplement any of that.
    It closes the two gaps that sit outside every documented chain:

      1. scripts/generate-r0-conformance.mjs --check, which nothing else
         calls, so corpus drift against tests/fixtures/r0/production-project.v1.json
         can silently ship undetected.
      2. scripts/verify-r0-windows.ps1, whose own output says "Native UE5
         conformance is NOT RUN" -- it is a separate web-only preflight, never
         sequenced with the native gate anywhere in the repo's docs or CI.

    Both scripts above are invoked, not reimplemented; -EngineRoot,
    -CoordinatesOnly and -MaxParallelActions pass straight through to
    verify-r0-native.ps1 unchanged.

.NOTES
    Windows-only, like both scripts it wraps -- CI here is Linux-only and
    does not run this path. See docs/DESKTOP_DEV_SETUP.md Phase 11.
#>
[CmdletBinding()]
param(
    [string]$EngineRoot = $env:SPATIAL_PREVIS_UE_ROOT,
    [switch]$CoordinatesOnly,
    [ValidateRange(1, 64)][int]$MaxParallelActions = 2,
    [switch]$SkipCorpusCheck,
    [switch]$SkipWebPreflight
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $repoRoot
try {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $runDir = Join-Path $repoRoot "test-results\r0-conformance\$stamp"
    New-Item -ItemType Directory -Path $runDir -Force | Out-Null

    if (!$SkipCorpusCheck) {
        Write-Host '--- Step 1/3: R0 conformance corpus freshness ---'
        & node (Join-Path $repoRoot 'scripts\generate-r0-conformance.mjs') --check
        if ($LASTEXITCODE -ne 0) {
            throw 'R0 conformance corpus is stale; run "node scripts/generate-r0-conformance.mjs" and commit the regenerated fixture before continuing.'
        }
    } else {
        Write-Host '--- Step 1/3: corpus freshness check skipped (-SkipCorpusCheck) ---'
    }

    $webEvidenceDir = Join-Path $runDir 'web-preflight'
    if (!$SkipWebPreflight) {
        Write-Host '--- Step 2/3: web preflight (typecheck, test, build) ---'
        try {
            & (Join-Path $repoRoot 'scripts\verify-r0-windows.ps1') -EvidenceDirectory $webEvidenceDir
        } catch {
            throw "Web preflight failed; see $webEvidenceDir for logs. Original error: $_"
        }
    } else {
        Write-Host '--- Step 2/3: web preflight skipped (-SkipWebPreflight) ---'
    }

    Write-Host '--- Step 3/3: native UE5 build + conformance ---'
    $nativeCmdArgs = @('-MaxParallelActions', $MaxParallelActions)
    if ($EngineRoot) { $nativeCmdArgs += @('-EngineRoot', $EngineRoot) }
    if ($CoordinatesOnly) { $nativeCmdArgs += '-CoordinatesOnly' }
    $nativeLog = Join-Path $runDir 'native-conformance.log'
    $nativeEvidencePath = '(not reported -- see native-conformance.log)'
    try {
        $nativeOutput = & (Join-Path $repoRoot 'scripts\verify-r0-native.ps1') @nativeCmdArgs 2>&1 | Tee-Object -FilePath $nativeLog
        $nativeEvidenceLine = $nativeOutput | Where-Object { $_ -match 'Native conformance evidence:\s*(.+)$' } | Select-Object -Last 1
        if ($nativeEvidenceLine -and $nativeEvidenceLine -match 'Native conformance evidence:\s*(.+)$') {
            $nativeEvidencePath = $Matches[1].Trim()
        }
    } catch {
        throw "Native build/conformance failed; see $nativeLog. Original error: $_"
    }

    Write-Host ''
    Write-Host '=== R0 conformance summary ==='
    Write-Host "Wrapper run directory:       $runDir"
    Write-Host "Web preflight evidence:      $(if ($SkipWebPreflight) { '(skipped)' } else { $webEvidenceDir })"
    Write-Host "Native conformance evidence: $nativeEvidencePath"
    Write-Host 'Contract conformance does not close rendering, actual Android, or owner acceptance gates.'
} finally {
    Pop-Location
}
