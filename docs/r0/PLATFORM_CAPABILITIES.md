# Desktop capability and mobile handoff

Decision: 17 September 2026, explicitly directed by the owner.

The desktop product keeps the fullest available implementation. Web/mobile limits
must not reduce Unreal's rendering, simulation, geometry, control or future production
workflows. A feature may be desktop-only without delaying or simplifying it to fit
a phone. Platform feature sets do not have to be identical.

Shared data remains trustworthy across platforms. IDs, units, transforms, quantities,
relationship kinds and the meaning of supported commands must agree. Unsupported
data must be preserved through a supported interchange format or the import must be
refused with a clear explanation. Do not erase advanced data to make a file load.

## User experience

- Identify which workflows run locally and which need desktop.
- Offer **Continue on desktop** from web/mobile. Use a verified connection URL
  configured by the user, or guide the user to their remote desktop client.
- Preserve unsaved work through the existing portable project backup before handoff.
- Explain whether data is synchronized automatically or must be transferred manually.
  The current R0 backup is manual; opening a desktop connection does not upload it.
- Require a secure URL for a browser handoff. Do not embed passwords, fabricate app
  deep links or expose a workstation's local services publicly to make a button work.

## Current state

Web R0 supports its command, save, undo, connection and data-check workflows. Native
CORE-01 source provides strict bare-project JSON inspection and export. Native
workspace-envelope import, editing/history, evidence and scene rendering still require
implementation and engine validation. The current native inspector refuses web
workspace envelopes, so exporting a workspace is a recovery/handoff preparation step,
not proof that the native inspector can open it yet.

The R0 release gate is conformance of shared contracts and claimed behavior, plus
separate platform acceptance. It is not identical graphical fidelity or an identical
feature list. Existing sample coordinate corrections remain correctness work; they
are not optional capability differences.

## Desktop showcase launch options

The authored festival stage showcase (`src/assets/FestivalStage.ts` and
`showcase/concert-stage-demo.html`) demonstrates high-fidelity stage design,
Claypaky Sharpy GDTF moving heads, sACN/Art-Net DMX addressing, EDM video wall,
volumetric dual-layer light cones, and live EN 60825-1 laser MPE evaluation.
On desktop, operators can launch directly into the showcase via:
- `npm run showcase` or `npm run dev:showcase`
- The Windows launcher `launch-desktop.cmd --showcase` (or interactive menu)
- Viewport HUD & Playtest diagnostics buttons in the web client (`?showcase=true`)
- "Stage showcase" button in the Production Workspace command bar and desktop handoff dialog
- "Launch Stage Showcase" button in the native Unreal Editor module and `Tools -> Spatial Previs` menu
