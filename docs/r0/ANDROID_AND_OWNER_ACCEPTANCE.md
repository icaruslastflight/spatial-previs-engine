# R0 owner acceptance: Android + real-screen browser review

Two of R0's three release gates need a human — the owner. Everything else is
green (see `VERIFICATION.md`). This document is the checklist the owner
follows so those gates can close.

## What is being signed off

Per `docs/r0/README.md`, R0 cannot be called complete until:

- **Gate 1 (partial):** production browser acceptance passes AND its actual
  screens are inspected — the automated Playwright suite already checks
  assertions, but the owner needs to look at the retained screenshots and
  confirm the visual result on their own eyes.
- **Gate 3 (open):** the actual Android device is tested and the owner
  reviews the visual result.

These are visual and interaction judgements. Automation cannot replace them.

## Prerequisites

- The R0 web preview running somewhere the phone can reach it:
  - Same LAN: `npm run build && npm run preview -- --host` on any workstation.
    The preview binds to `0.0.0.0:4173` by default; open
    `http://<workstation-lan-ip>:4173/r0.html` on the phone's browser.
  - Or a temporary tunnel (Cloudflare Tunnel, Tailscale Funnel — both free).
- A real Android phone. Chrome for Android is the reference browser. Any
  Chromium-based browser is acceptable; note the browser + version in the
  sign-off. The phone's actual DPR must be recorded.
- 5-10 minutes for the browser screen inspection, 10-15 minutes for the
  Android touch pass — the checklist below is what to actually do, in order.

## Part 1 — Browser screen inspection (Gate 1)

Look at the nine screenshots the automated suite retained in
`test-results/r0/` (or the CI artifact `r0-browser-evidence`). Each
screenshot corresponds to one committed state of the R0 workspace under a
1440×960 desktop viewport, except `r0-phone*.png` which are Chromium touch
emulation at 390×844.

For each screenshot, confirm:

| Screenshot | What to verify |
| --- | --- |
| `r0-desktop.png` | Two objects placed, one moved to X=6, lock toggled off; the frame guide overlaps the objects, not floating; scene count reads "2 objects"; revision shown top-right. |
| `r0-build.png` | Build workspace layout: catalog on the left, scene in the middle, inspector on the right. A logical connection (video out → video in) has landed and shows as a removable edge. |
| `r0-map.png` | Map workspace: no basemap tiles float above the scene; scene items still selectable; the shared selection remains highlighted (`.scene-item.selected` on the same id as the other workspaces). |
| `r0-connect.png` | Connect workspace: ports panel visible; the one connection created by the suite is in the removable-edges list with a single `[data-remove]` entry. |
| `r0-check.png` | Check workspace: `needs_data` or `stale` badges present after the deliberate invalidation; the recorded-data checks have run once. |
| `r0-deliver.png` | Deliver workspace: local export + evidence + diagnostic download buttons visible; no upload messaging. |
| `r0-phone.png` | Phone 390×844 view: no horizontal overflow; equipment toggle, save button, workspace tabs all above the fold; the 3D scene fills the visible viewport. |
| `r0-phone-inspector.png` | Phone inspector open; numeric X/Y/Z fields fit the viewport; keyboard hasn't clipped the controls. |
| `r0-phone-handoff.png` | Desktop handoff modal open; "Native UE5 import of this complete workspace is still in development" text visible; no horizontal overflow. |

**How to sign off:** open each PNG, tick each row, then write one line
underneath the table naming the browser + version + viewport size. If
anything looks wrong, write it down — do not tick the row.

## Part 2 — Android touch pass (Gate 3)

Point the phone's browser at the preview URL and drive each row in order.
Every row names an interaction and an expected result. Take a screenshot
whenever a row says "capture". Save all screenshots to
`test-results/r0/android-<yyyyMMdd-HHmm>/` on the workstation (adb pull, or
just AirDrop-equivalent + drop into that folder).

| # | Action | Expected result | Capture |
| --- | --- | --- | --- |
| 1 | Cold-load `<preview-url>/r0.html` | Ready in ≤ 3 s on 4G / 1 s on Wi-Fi; no horizontal scroll; equipment button visible in top-left | `01-cold-load.png` |
| 2 | Tap **Equipment**, tap `500 mm panel` | One panel appears; scene count → "1 objects" | — |
| 3 | Tap **Equipment**, tap `F34 truss` | Two objects; render status clears | `02-two-placed.png` |
| 4 | Tap the truss in the scene | Inspector opens; the selected item highlights across Build/Map/Connect/Check/Deliver tabs | `03-inspector.png` |
| 5 | Type `2.5` in the X field, tap **Update** | Revision increments; truss visibly moves | — |
| 6 | With one finger: drag the truss across the scene | Truss follows the finger; snap indicator appears when it nears the panel | — |
| 7 | Mid-drag, land a **second finger** on the empty scene | Drag aborts; camera pinch-zoom takes over; no partial move committed | `04-second-finger-abort.png` |
| 8 | Pinch to zoom out, then pinch to zoom in | Camera smooths; no rubber-banding; scene never "jumps" | — |
| 9 | Tap **Save**; wait for "Saved on this device" | Save indicator turns green within 1 s | — |
| 10 | Kill the tab, re-open the URL | Scene reopens with the same two objects at their saved positions; revision matches | `05-reopen.png` |
| 11 | Turn off Wi-Fi + mobile data (airplane mode ON) | Refresh: page still loads from the service worker cache; scene still opens | `06-offline-reopen.png` |
| 12 | Turn Wi-Fi back on | No error banner; save still works | — |
| 13 | Try to import a broken JSON — tap **Import**, pick any random binary file | Error banner appears; scene unchanged; revision unchanged | `07-malformed-import.png` |
| 14 | Import the export from step 9 | Scene reopens with correct objects; project ID matches; revision continues | — |
| 15 | Tap **Continue on desktop** | Modal opens with "Native UE5 import…" copy; URL field editable | `08-handoff-modal.png` |
| 16 | Enter `javascript:alert(1)` and tap Save | Rejected with error state; no URL stored; **Open** disabled | — |
| 17 | Enter `https://desktop.example.test/portal` and tap Save | Accepted; **Open** enabled; URL persists across reload | `09-handoff-valid.png` |
| 18 | Rotate to landscape | Layout reflows; no horizontal overflow; no controls off-screen | `10-landscape.png` |
| 19 | Rotate back to portrait | Layout reflows back cleanly | — |
| 20 | Toggle to Check workspace, tap **Run check** | Checks show `needs_data` / `stale` where the recorded-data is missing; nothing claims a real pass | `11-checks.png` |
| 21 | Toggle to Deliver workspace | Export / evidence / diagnostic buttons work; downloads land in the phone's Downloads folder | `12-deliver.png` |

**Touch-target sizes to eyeball** (do this once, on any screen): every
button ≥ 40 px on both axes. Fail if any tab, save button or equipment
toggle is smaller.

**Performance to eyeball**: frame time should not stutter above ~50 ms on
routine camera pans on a phone ≥ 2 years newer. Any long freeze (>500 ms
without user input) is a finding.

## Part 3 — Sign-off block

Copy this block to the bottom of `docs/r0/VERIFICATION.md` (or paste as a
comment on the R0 PR) once both parts pass:

```
R0 owner acceptance — <date>

Browser screen inspection (Gate 1)
- Owner:                <name>
- Reviewed screens:     test-results/r0/r0-*.png (nine files)
- Verdict:              [PASS | FAIL: <reason>]
- Browser + version:    <e.g. Chrome 134 on macOS 15 desktop>

Android touch pass (Gate 3)
- Owner:                <name>
- Device:               <phone model + Android version>
- Browser:              <Chrome for Android version>
- Preview URL:          <lan url or tunnel url>
- Evidence folder:      test-results/r0/android-<yyyyMMdd-HHmm>/
- Verdict:              [PASS | FAIL: <reason per checklist row>]
- Notes:                <anything not covered by a row>
```

Both parts passing is what closes the two remaining R0 gates. Nothing else
in the repo can promote itself to "passed"; automation records that the
scenarios ran, not that the owner accepted them.

## What is explicitly out of scope for R0 acceptance

The following live under later scope and do not affect this sign-off:

- LED mapping and specialist optical/electrical/acoustic/laser calculations
  return `not_evaluated` today and remain out of R0.
- Native UE5 import of the workspace envelope. R0 native inspects bare
  project-v1 JSON and refuses envelopes on purpose; that is preservation,
  not a bug.
- Full stock reservation, crew-pack generation and issued-artifact review
  workflows. R0 preserves the shape and the immutable-issued-bytes rule
  but does not run the workflow.
