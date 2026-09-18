<#
.SYNOPSIS
    Creates a Windows Desktop shortcut for launch-desktop.cmd.

.DESCRIPTION
    A one-time convenience so the launcher menu (Production Workspace,
    Development Dashboard, UE5 Editor, ...) is a double-click from the
    Desktop rather than something you have to find inside the repo folder
    or open a terminal for. Idempotent: re-running replaces an existing
    shortcut at the same path (WScript.Shell's normal CreateShortcut/Save
    behaviour) rather than erroring or duplicating it.

    Uses the WScript.Shell COM object -- there is no first-class PowerShell
    cmdlet for creating a .lnk file. Same mechanism
    scripts\configure-desktop-commander-admin.ps1 already uses for its own
    Startup shortcut, kept consistent rather than reaching for a different
    approach (e.g. a raw .lnk binary writer) for the same job.

.PARAMETER RepoPath
    Path to the cloned repo (the directory containing launch-desktop.cmd).
    Defaults to the parent of this script's own location, so running it
    from inside a clone needs no argument.

.PARAMETER ShortcutName
    File name for the shortcut, without extension.

.EXAMPLE
    .\scripts\create-desktop-shortcut.ps1
    Creates the shortcut using this checkout's own path.

.EXAMPLE
    .\scripts\create-desktop-shortcut.ps1 -RepoPath 'C:\Users\user\Documents\SpatialPrevisEngine' -WhatIf
    Preview without writing anything -- useful when calling this from
    another machine's clone path, or from bootstrap_dev_workstation.ps1.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
    [string]$ShortcutName = 'Spatial Previs Desktop Launcher'
)
$ErrorActionPreference = 'Stop'

$launcher = Join-Path $RepoPath 'launch-desktop.cmd'
if (!(Test-Path $launcher)) {
    throw "$launcher not found -- pass -RepoPath pointing at the cloned repo (the folder containing launch-desktop.cmd)."
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "$ShortcutName.lnk"

if ($PSCmdlet.ShouldProcess($shortcutPath, "Create Desktop shortcut -> $launcher")) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcher
    $shortcut.WorkingDirectory = $RepoPath
    $shortcut.Description = 'Spatial Previs Engine -- Production Workspace, Development Dashboard, UE5 Editor'
    # cmd.exe's own embedded icon -- avoids shipping or guessing at a
    # project .ico this repo doesn't have (CLAUDE.md s11: no binaries that
    # aren't already justified as committed).
    $shortcut.IconLocation = "$env:SystemRoot\System32\cmd.exe,0"
    $shortcut.Save()
    Write-Host "Created $shortcutPath -> $launcher"
    [pscustomobject]@{ ShortcutPath = $shortcutPath; Target = $launcher }
}
