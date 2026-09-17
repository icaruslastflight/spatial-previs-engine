# Remote workstation controls

Checkpoint: 17 September 2026, after the owner's restart.

## Verified changes

Windows file/terminal access reconnected successfully. The active Desktop Commander
process is still a standard user process at this checkpoint.

| Setting | Verified result |
| --- | --- |
| Desktop Commander at Windows sign-in | `Desktop Commander Remote.lnk` installed in the current user's Startup folder, minimized. Its CMD runner detected the existing agent and returned 0 without launching another. No reboot or full new-session launch was tested. |
| Steam, Epic launcher and Edge auto-launch | The three identified current-user Run entries were backed up and removed. Applications remain installed; Epic's active verification/helper was retained. |
| Edge background execution | `StartupBoostEnabled=0` and `BackgroundModeEnabled=0` machine policies read back. The existing Google sign-in window was retained. |
| Windows Widgets | `AllowNewsAndInterests=0` policy read back. Eight Widgets-related processes were closed: Widgets, WidgetService and six descendant WebView processes. Later enumeration found no Widgets/WidgetService process. |
| Suggestions | `DisableThirdPartySuggestions=1` and `DisableTailoredExperiencesWithDiagnosticData=1` current-user policies read back. These are not a claim that every Windows suggestion or network request is eliminated. |
| Delivery Optimization | `DODownloadMode=0`: peer sharing disabled, ordinary update downloads preserved. The service remains available. |

Original registry values are preserved in
`C:\Users\user\AppData\Local\SpatialPrevis\Workstation\User-original-settings.json`
and `Machine-original-settings.json`. Reapplying the configuration retains the first
captured values. The setup scripts are under that directory's `Setup` folder and
are versioned in this repository's `scripts` directory.

Windows Security, updates, AirGPU controller, Sunshine, GPU/display services, active
ChatGPT, NordPass, the sign-in browser and Epic installation were preserved. No
Windows components were uninstalled. No network measurement establishes that these
changes resolved the phone's bitrate warning.

## Administrator startup: prepared, approval still required

The owner explicitly requested administrator access and automatic routine commands.
`Enable Desktop Commander Admin.lnk` is on the Windows desktop. It opens the
reviewable `enable-desktop-commander-admin.cmd` and
`apply-remote-workstation-admin.ps1` setup. Windows must approve this elevation;
the current standard user agent cannot grant itself administrator privileges.

After approval, the prepared installer creates `SpatialPrevis-DesktopCommander` in
Task Scheduler, with a user-logon trigger, Interactive logon and Highest run level.
It reuses the existing Windows profile/device pairing and stores no Windows or
NordPass master password. It replaces the normal Startup shortcut only after task
configuration is read back. A short-lived marker identifies the old agent processes
by PID and creation time for a one-time reconnection; unrelated processes are excluded.

At this checkpoint the administrator task and elevated reconnection are **not yet
verified**. Once enabled, task-launched commands inherit that administrator token;
this is not blanket approval for applications launched outside that agent. Windows
sign-in is still required; this is not a pre-login Windows service.

Disable today's normal startup in Settings > Apps > Startup. If the administrator
task is enabled later, disable `SpatialPrevis-DesktopCommander` in Task Scheduler.
Run `configure-remote-workstation.ps1 -Mode RestoreUser` and `-Mode RestoreMachine`
from an elevated PowerShell to restore the backed-up registry settings. Disable the
administrator task separately; restoring registry values does not stop running apps.

Manual reconnection, in PowerShell on the remote PC:

```powershell
npx.cmd -y @wonderwhy-er/desktop-commander@latest remote
```

## Screen access and power

Sunshine is the PC's screen/audio/input host for Moonlight on the phone. Desktop
Commander provides file/terminal control; it does not replace that screen stream.
Preserve Sunshine and AirGPU services during cleanup.

Remote Windows shutdown can be requested while the agent is connected. The owner's
request to establish this capability is not an instruction to shut down during an
active installation or build. Save work and avoid forced application closure.

AirGPU documents Start and Stop through its [machines dashboard](https://app.airgpu.com/machines).
Wait for Running before reconnecting Moonlight. No supported Wake-on-LAN method or
public power-control API was verified. A disconnected or shut-down Windows session
does not by itself establish the provider's stopped/billing state; inspect the dashboard.
The owner can use these provider controls; authenticated assistant control has not
been established. No paid commitments or power actions were made during this setup.

## Engine checkpoint

The owner's later screenshot shows UE5.8.2 verification at 88% and an Epic connection
warning. Leave the active installer running and verify completion before invoking
the native build. Engine compilation, commandlet conformance and native UI acceptance
remain unverified.

## References

- [AirGPU connection and power workflow](https://help.airgpu.com/getting-started/connect-to-your-machine)
- [Edge startup boost policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/StartupBoostEnabled)
- [Edge background mode policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/BackgroundModeEnabled)
- [Widgets policies](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-newsandinterests)
- [Delivery Optimization modes](https://learn.microsoft.com/en-us/windows/deployment/do/waas-delivery-optimization-reference)
- [Windows experience policy applicability](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-experience)
