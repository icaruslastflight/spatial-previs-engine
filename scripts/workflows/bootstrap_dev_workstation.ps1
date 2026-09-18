<#
.SYNOPSIS
    Automates the mechanical steps of docs/DESKTOP_DEV_SETUP.md on a fresh
    Windows workstation (written for the project's Shadow PC, works on any
    Windows box).

.DESCRIPTION
    This does NOT replace that runbook -- it automates the phases that are
    genuinely just "run these commands" (1, 3, 4, 5, 6, 8, 9) and reports on
    the one that's read-only inspection (0). It deliberately leaves alone the
    phases that need a human making a real choice inside a GUI:

      Phase 2  Desktop Commander pairing -- one-time interactive account auth
      Phase 7  UE5.8.2 + Visual Studio   -- multi-GB interactive installers;
               engine version and VS workload selection are real choices,
               not defaults to assume
      Phase 11 Final smoke pass          -- verification, not provisioning;
               run docs/DESKTOP_DEV_SETUP.md Phase 11 by hand afterward

    Every winget package id and pip requirements file referenced here is
    copied verbatim from docs/DESKTOP_DEV_SETUP.md rather than re-derived --
    see that file for why each one was chosen.

    Steps are independent and best-effort: one package already being
    installed, or one optional tool failing, does not stop the rest of the
    box from getting set up. A required step's failure (the repo not
    building) is still reported clearly and drives a non-zero exit.

.PARAMETER RepoUrl
    Git URL to clone. Defaults to this project's own GitHub repo.

.PARAMETER RepoPath
    Local clone destination. Defaults to Documents\SpatialPrevisEngine under
    the current user's profile.

.PARAMETER OllamaModel
    An Ollama model tag to pull once Ollama is installed (e.g. "qwen2.5-coder:14b").
    Omit this to skip pulling -- Phase 0's host report tells you the GPU/VRAM
    so you can size the right model from docs/DESKTOP_DEV_SETUP.md's table
    first, then re-run with -OllamaModel or pull it yourself.

.PARAMETER InstallContinueExtension
    Also installs the Continue.dev VS Code extension and, when -OllamaModel
    was pulled successfully, wires it to that model over Ollama's local
    OpenAI-compatible API. This is what actually makes the local model usable
    for in-editor AI assistance, rather than just sitting idle behind `ollama run`.

.PARAMETER CreateDesktopShortcut
    Also creates a Desktop shortcut to launch-desktop.cmd (see
    scripts\create-desktop-shortcut.ps1), so the launcher menu is a
    double-click away instead of something you have to find inside the
    cloned folder.

.PARAMETER SkipBaseTools / SkipNode / SkipPython / SkipRepo / SkipOllama / SkipMetaprompt
    Skip that step entirely (e.g. re-running after a partial success).

.EXAMPLE
    .\bootstrap_dev_workstation.ps1 -WhatIf
    Preview every mutating action without installing or cloning anything.

.EXAMPLE
    .\bootstrap_dev_workstation.ps1 -OllamaModel qwen2.5-coder:14b -InstallContinueExtension
    Full provisioning run, once Phase 0's host report has told you which
    model tier fits this box's VRAM.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoUrl = 'https://github.com/icaruslastflight/spatial-previs-engine',
    [string]$RepoPath = (Join-Path $env:USERPROFILE 'Documents\SpatialPrevisEngine'),
    [string]$OllamaModel,
    [switch]$InstallContinueExtension,
    [switch]$CreateDesktopShortcut,
    [switch]$SkipBaseTools,
    [switch]$SkipNode,
    [switch]$SkipPython,
    [switch]$SkipRepo,
    [switch]$SkipOllama,
    [switch]$SkipMetaprompt
)
$ErrorActionPreference = 'Stop'
$results = [ordered]@{}

$requiredSteps = [System.Collections.Generic.HashSet[string]]::new()

function Invoke-Step {
    param([string]$Name, [bool]$Required, [scriptblock]$Action)
    if ($Required) { [void]$requiredSteps.Add($Name) }
    # $WhatIfPreference cascades to nested function calls automatically (unlike
    # $PSCmdlet, which is per-invocation and would need explicit passing from a
    # plain helper function like this one) -- checking it directly here is the
    # simplest correct way for -WhatIf on the script to also gate this helper.
    if ($WhatIfPreference) {
        Write-Host "--- $Name --- (WhatIf: would run)" -ForegroundColor DarkGray
        $results[$Name] = 'skipped (-WhatIf)'
        return
    }
    Write-Host "--- $Name ---" -ForegroundColor Cyan
    try {
        & $Action
        $results[$Name] = 'ok'
    } catch {
        $results[$Name] = "failed: $($_.Exception.Message)"
        Write-Warning "$Name failed: $($_.Exception.Message)"
        if ($Required) { Write-Warning "$Name is required -- later steps that depend on it may also fail." }
    }
}

function Install-WingetPackage {
    param([string]$Id)
    # Check first rather than guessing at winget's "already installed" exit
    # code -- `winget list --id X -e` exits 0 only when X is found installed,
    # which is documented and doesn't rely on a specific error-code constant.
    winget list --id $Id -e | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "$Id already installed -- skipping."
        return
    }
    winget install --id $Id -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget install $Id exited $LASTEXITCODE" }
}

# --- Phase 0: host report (read-only, always runs) -------------------------
Invoke-Step -Name 'Phase 0 -- host report' -Required $true -Action {
    $gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion)
    $nvidiaSmi = $null
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $nvidiaSmi = (& nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>&1) -join "`n"
    }
    $report = [ordered]@{
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
        os         = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version)
        cpu        = @((Get-CimInstance Win32_Processor).Name)
        ramBytes   = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
        disks      = @(Get-PSDrive -PSProvider FileSystem | Select-Object Name, Free)
        gpu        = $gpu
        nvidiaSmi  = $nvidiaSmi
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $evidenceDir = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "test-results\bootstrap\$stamp"
    New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
    $report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $evidenceDir 'host-report.json')
    Write-Host ($report | ConvertTo-Json -Depth 4)
    Write-Host "`nGPU VRAM decides Phase 8's model tier -- see docs/DESKTOP_DEV_SETUP.md Phase 8's table before picking -OllamaModel."
    $script:EvidenceDir = $evidenceDir
}

# --- Phase 1: base Windows tooling ------------------------------------------
if (!$SkipBaseTools) {
    Invoke-Step -Name 'Phase 1 -- Git' -Required $true -Action { Install-WingetPackage 'Git.Git' }
    Invoke-Step -Name 'Phase 1 -- 7-Zip' -Required $false -Action { Install-WingetPackage '7zip.7zip' }
    Invoke-Step -Name 'Phase 1 -- VS Code' -Required $true -Action { Install-WingetPackage 'Microsoft.VisualStudioCode' }
}

# --- Phase 3: Node via nvm-windows ------------------------------------------
if (!$SkipNode) {
    Invoke-Step -Name 'Phase 3 -- Node 22 via nvm-windows' -Required $true -Action {
        if (!(Get-Command nvm -ErrorAction SilentlyContinue)) {
            throw 'nvm-windows is not installed. Download nvm-setup.exe from https://github.com/coreybutler/nvm-windows/releases (no reliable winget id to automate this one), then re-run with -SkipBaseTools.'
        }
        nvm install 22.20.0
        nvm use 22.20.0
    }
}

# --- Phase 4: Python + local memory-index deps ------------------------------
if (!$SkipPython) {
    Invoke-Step -Name 'Phase 4 -- Python 3.11' -Required $true -Action { Install-WingetPackage 'Python.Python.3.11' }
    Invoke-Step -Name 'Phase 4 -- scripts/memory requirements' -Required $false -Action {
        $req = Join-Path $RepoPath 'scripts\memory\requirements.txt'
        if (!(Test-Path $req)) { throw "$req not found -- clone the repo first (Phase 5)." }
        python -m pip install -r $req
        if ($LASTEXITCODE -ne 0) { throw "pip install exited $LASTEXITCODE" }
    }
}

# --- Phase 5: ffmpeg, repo clone, web verify --------------------------------
if (!$SkipRepo) {
    Invoke-Step -Name 'Phase 5 -- ffmpeg' -Required $false -Action { Install-WingetPackage 'Gyan.FFmpeg' }
    Invoke-Step -Name 'Phase 5 -- clone repo' -Required $true -Action {
        if (Test-Path $RepoPath) {
            Write-Host "$RepoPath already exists -- skipping clone, using it as-is."
        } else {
            git clone $RepoUrl $RepoPath
            if ($LASTEXITCODE -ne 0) { throw "git clone exited $LASTEXITCODE" }
        }
    }
    Invoke-Step -Name 'Phase 5 -- npm ci / playwright / build / test / verify' -Required $true -Action {
        Push-Location $RepoPath
        try {
            npm ci; if ($LASTEXITCODE -ne 0) { throw "npm ci exited $LASTEXITCODE" }
            npx playwright install chromium; if ($LASTEXITCODE -ne 0) { throw "playwright install exited $LASTEXITCODE" }
            npm run build; if ($LASTEXITCODE -ne 0) { throw "npm run build exited $LASTEXITCODE" }
            npm test; if ($LASTEXITCODE -ne 0) { throw "npm test exited $LASTEXITCODE" }
            npm run verify; if ($LASTEXITCODE -ne 0) { throw "npm run verify exited $LASTEXITCODE" }
        } finally { Pop-Location }
    }
    Invoke-Step -Name 'Phase 6 -- VS Code cpptools' -Required $false -Action {
        code --install-extension ms-vscode.cpptools
        if ($LASTEXITCODE -ne 0) { throw "code --install-extension exited $LASTEXITCODE" }
    }
}

# --- Desktop shortcut for launch-desktop.cmd (opt-in) -----------------------
if ($CreateDesktopShortcut) {
    Invoke-Step -Name 'Desktop shortcut for launch-desktop.cmd' -Required $false -Action {
        & (Join-Path $PSScriptRoot '..\create-desktop-shortcut.ps1') -RepoPath $RepoPath
    }
}

# --- Phase 7: Epic Games Launcher only (engine/VS install stays manual) ----
Invoke-Step -Name 'Phase 7 -- Epic Games Launcher' -Required $false -Action {
    Install-WingetPackage 'EpicGames.EpicGamesLauncher'
    Write-Host 'Manual from here: sign in, Library -> install Unreal Engine 5.8 (exactly 5.8.x -- verify-r0-native.ps1 refuses any other minor version). Then install Visual Studio Community 2026 with the "Desktop development with C++" workload (confirm the current winget id via `winget search "Visual Studio 2026"` -- not assumed here). Then run scripts\verify-r0-native.ps1.'
}

# --- Phase 8: Ollama ---------------------------------------------------------
if (!$SkipOllama) {
    Invoke-Step -Name 'Phase 8 -- Ollama' -Required $false -Action {
        Install-WingetPackage 'Ollama.Ollama'
        if ($OllamaModel) {
            ollama pull $OllamaModel
            if ($LASTEXITCODE -ne 0) { throw "ollama pull $OllamaModel exited $LASTEXITCODE" }
        } else {
            Write-Host 'No -OllamaModel given -- pick a tier from docs/DESKTOP_DEV_SETUP.md Phase 8''s table using the GPU/VRAM in the Phase 0 report, then run: ollama pull <model>'
        }
    }
}

# --- Phase 2: Desktop Commander pairing (print-only, never auto-run) -------
Write-Host "`n--- Phase 2 -- Desktop Commander pairing (manual) ---" -ForegroundColor Yellow
Write-Host 'Run this yourself in a separate terminal -- it prompts for one-time interactive account auth, which this script cannot answer for you:'
Write-Host '  npx.cmd -y @wonderwhy-er/desktop-commander@latest remote'
$results['Phase 2 -- Desktop Commander pairing'] = 'manual step -- see console output above'

# --- Phase 9: metaprompt tool -------------------------------------------------
if (!$SkipMetaprompt) {
    Invoke-Step -Name 'Phase 9 -- metaprompt requirements' -Required $false -Action {
        $req = Join-Path $RepoPath 'scripts\ai-tools\requirements.txt'
        if (!(Test-Path $req)) { throw "$req not found -- clone the repo first (Phase 5)." }
        python -m pip install -r $req
        if ($LASTEXITCODE -ne 0) { throw "pip install exited $LASTEXITCODE" }
        Write-Host 'Remember to set the API key yourself: setx ANTHROPIC_API_KEY "sk-ant-..." (value from your password manager, never a file).'
    }
}

# --- Continue.dev: wires the local Ollama model into in-editor assistance --
if ($InstallContinueExtension) {
    Invoke-Step -Name 'Continue.dev extension + Ollama wiring' -Required $false -Action {
        code --install-extension Continue.continue
        if ($LASTEXITCODE -ne 0) { throw "code --install-extension exited $LASTEXITCODE" }
        if ($OllamaModel) {
            $continueDir = Join-Path $env:USERPROFILE '.continue'
            New-Item -ItemType Directory -Path $continueDir -Force | Out-Null
            $configPath = Join-Path $continueDir 'config.yaml'
            if (Test-Path $configPath) {
                Write-Host "$configPath already exists -- not overwriting. Add this model manually if it's missing:"
                Write-Host "  name: $OllamaModel (local)`n  provider: ollama`n  model: $OllamaModel`n  apiBase: http://localhost:11434"
            } else {
                @"
name: Local ($OllamaModel)
version: 0.0.1
schema: v1
models:
  - name: $OllamaModel (local)
    provider: ollama
    model: $OllamaModel
    apiBase: http://localhost:11434
    roles: [chat, edit, autocomplete]
"@ | Set-Content -Encoding UTF8 $configPath
                Write-Host "Wrote $configPath"
            }
        } else {
            Write-Host 'No -OllamaModel was pulled, so Continue has nothing to wire to yet. Pull a model, then add it to ~\.continue\config.yaml by hand (see docs/DESKTOP_DEV_SETUP.md Phase 8/9).'
        }
    }
}

# --- Summary -----------------------------------------------------------------
Write-Host "`n=== Bootstrap summary ===" -ForegroundColor Cyan
foreach ($key in $results.Keys) {
    $status = $results[$key]
    $color = if ($status -eq 'ok') { 'Green' } elseif ($status -like 'failed*') { 'Red' } else { 'Yellow' }
    Write-Host ("{0,-45} {1}" -f $key, $status) -ForegroundColor $color
}
if ($script:EvidenceDir) {
    $results | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $script:EvidenceDir 'summary.json')
    Write-Host "`nEvidence: $script:EvidenceDir"
}
Write-Host "`nNext: run docs/DESKTOP_DEV_SETUP.md Phase 7 (engine/VS, if not already) and Phase 11 (final smoke pass) by hand."

$failedRequired = $results.Keys | Where-Object { $results[$_] -like 'failed*' -and $requiredSteps.Contains($_) }
if ($failedRequired) { exit 1 }
