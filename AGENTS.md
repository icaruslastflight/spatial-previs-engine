# Spatial Previs development instructions

These rules apply to every agent/chat working in this repository. Read `CLAUDE.md`,
`docs/r0/README.md`, `docs/r0/VERIFICATION.md`, and
`docs/r0/PLATFORM_CAPABILITIES.md` before making project decisions. Inspect current
Git state and preserve other work. Source and executed evidence take precedence over
older prose when determining what is implemented; correct stale prose explicitly.

## Desktop capability

Desktop keeps its full capability. Do not simplify or delay a native feature solely
because it exceeds browser/mobile capability. Shared IDs, units, frames, relationships
and supported operations remain consistent. Unsupported desktop workflows need clear
web/mobile availability and a Continue on desktop route. Do not claim a redirect
transfers project data when it only opens a connection.

## Living development record

The owner requires an ongoing user-facing guide, roadmap and case study with real
screenshots and descriptions. Maintaining it is part of development, not an optional
follow-up requiring a new request.

- Before continuing, recover the latest `Spatial_Previs_Living_Guide.docx` and
  `Spatial_Previs_Guide_Authoring.zip` through the available file connection when
  needed. The PDF is the phone-readable edition. Do not use an older copied guide
  as the authority without checking current project evidence.
- After meaningful behavior, scope, architecture, setup or validation changes,
  update the guide and its PDF, roadmap, case study, captions and dated change log.
  Increment the visible guide version. Replace the existing saved files to preserve
  their identity/version history; do not proliferate similarly named guides.
- Keep `docs/r0/README.md`, `VERIFICATION.md`, `UE5_CONFORMANCE.md`,
  `ACCOUNTS_AND_APIS.md` and `PLATFORM_CAPABILITIES.md` consistent with the work.
  Record new required accounts/APIs, purpose, permissions and verification status.
- Use screenshots of the running implementation. Refresh views affected by UI
  changes, label platform/build, and explain what the user sees and does. Mockups
  are never execution evidence; native/browser/device acceptance remain distinct.
- Distinguish implemented, verified, planned and blocked work. Report actual test
  counts and failures. A generated script or successful login is not a passing build.
- Include practical operator instructions, current limitations, the R0 through R5
  roadmap and a grounded Challenge / Architecture / Execution / Outcome case study.
  Do not invent customers, revenue, live deployments or specialist approval.
- Deliver the PDF/DOCX as download links for phone use. Markdown source links alone
  and sandbox PDF/DOCX links failed in the owner's Android app. Use the normal Drive
  web link as the accessible delivery route, and update its existing file in place:
  https://drive.google.com/file/d/1Dvx5kEi538tHm9_lbEkhS60t0pRAs_d9/view
  Keep the editable source and PDF synchronized. Downloads are snapshots, not
  automatic phone sync.
- The private project folder contains the guide, source snapshot and screenshots:
  https://drive.google.com/drive/folders/1hxxk-5GxRSn13je5movPeL6uR5u8z9i4
  Update the existing editable DOCX (`1YZoGbbMamPzGCk5mS4RxhfFFIhIgiJ3c`),
  authoring ZIP (`14EHMcOO9cKQQzShqz8UDecXESnNm2APx`) and development source ZIP
  (`15yr8O0j8GrDQ4UGVFAEgSHbJXA1VVIvG`) in place when those artifacts change.
  Raw screenshots are in folder `18sxiMAERxrTrwyGsYNr0cuncD1h8t4z3`.

## Continuity and environment

Use the current review branch and remote source checkout; avoid restarting from an
older GitHub default branch. Native source lives under `native/SpatialPrevis` and is
pinned to UE5.8. The known workstation checkout is
`C:\Users\user\Documents\SpatialPrevisEngine`. Inspect it before overwriting files.
Keep source in Git and generated Unreal caches/binaries out of Git.

Administrative setup and development on the remote PC are authorized. Preserve the
streaming/remote-agent processes and active project work; use normal Windows elevation
when required. Never store the NordPass master password in an environment file.
The rental budget remains USD30 total; do not make new paid commitments automatically.

These files establish continuity for project-aware chats. Do not claim that unrelated
chats automatically received instructions they have not loaded.
