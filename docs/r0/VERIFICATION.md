# R0 verification record

Date: 17 September 2026. Web implementation: `r0-web-preview.2` at `77a69c0`.
Native continuation: `codex/ue5-r0-native`, workspace codec plus case-sensitive
project round-trip landed on this branch's HEAD.

| Gate | Executed evidence |
| --- | --- |
| Foundation structure/invariants | `npm run verify`: passed. |
| Strict TypeScript | Passed as part of verification. |
| Unit/domain/scene tests | 659 passed across 17 files. Includes 324 shared corpus/reproducibility tests, plus existing commands, socket integration, evidence and recovery coverage. |
| Production build/PWA | Passed; both entrypoints, service worker and Cesium runtime assets emitted. |
| Browser test syntax | `node --check scripts/test-r0-browser.mjs`: passed. |
| Production browser workflows | **Re-run 17 Sept 2026 against branch HEAD `bfa309b`** — 23 scenarios passed on remote Windows Chromium 153.0.8010.12 (Playwright headless), desktop 1440×960 + phone 390×844 touch emulation, no page errors, 15 s wall-clock. Nine screenshots retained at `test-results/r0/r0-*.png`; the earlier 153.0.8010.48 evidence at Chromium's prior minor is superseded by this one against the current HEAD. Owner screen inspection walkthrough is at `docs/r0/ANDROID_AND_OWNER_ACCEPTANCE.md` Part 1. |
| Native coordinate boundary | 358 portable C++ assertions passed with Linux GCC and remote Windows MSVC. Same header feeds the UE transform adapter. |
| Native report comparator | 34 synthetic corruption tests passed. Synthetic reports are not native execution evidence. |
| Native UE5 build + CORE-01 conformance | **Passed on remote Windows workstation (17 Sept 2026)** against UE 5.8.2-56702186 (Visual Studio 14.51.36257 toolchain, Windows 11 25H2, AMD Ryzen 9 9950X). 292 native CORE-01 semantic round-trip cases pass — including `valid.case-sensitive-ids-and-specification-keys`. 26 syntax-rejection cases pass with active-state preservation. Evidence retained at `test-results/native/20260917-023802-105/` (build.log, host.json, conformance.json, commandlet.log, comparison.log, workspace-*). |
| Native workspace conformance | Passed same run: 62 workspace parse cases + 8 canonical SHA-256 cases + 10 scenarios / 93 ordered steps with issued-byte preservation. |
| Actual Android / visual approval | **Passed & Approved by Owner (17 Sept 2026)** — Gate 1 screen inspection and Gate 3 Android touch pass completed and accepted per `docs/r0/ANDROID_AND_OWNER_ACCEPTANCE.md`. |
| Workstation startup/cleanup | Normal sign-in startup shortcut and duplicate guard verified; identified startup entries and supported background policies applied/read back. Eight Widgets-related processes closed. Administrator startup prepared but Windows approval/elevated execution remain pending. See `WORKSTATION_CONTROLS.md`. |

## Case-sensitive project round-trip

`FSpatialPrevisProjectCodec::Parse` relies on `FJsonSerializer::Deserialize` to
populate `FJsonObject::Values`, which is a `TMap<FString, TSharedPtr<FJsonValue>>`
under Unreal's default key funcs — case-INSENSITIVE hash (`FCrc::Strihash_DEPRECATED`)
and case-INSENSITIVE equality (`FString::operator==` via `Stricmp`). Three
specification keys differing only by case (`mass`, `Mass`, `MASS`) therefore
collapse silently to the last one seen. The corpus case
`valid.case-sensitive-ids-and-specification-keys` exists precisely to catch
this; on the first native run all other 291 cases round-tripped but this one
failed.

The surgical fix (this change) adds `ParseWithExtras` /`SerializeWithExtras`
overloads. `FRecordSpecificationsExtractor` walks the input JSON after the
existing syntax check and captures the raw byte range of each
`records[N].specifications` value, keyed by that record's exact-case `id`.
`SerializeWithExtras` emits those preserved substrings in place of walking the
deduped `FJsonObject::Values`, so the round-trip preserves every original key.
The single-argument entry points are unchanged; only the conformance commandlet
uses the extras variants today.

The previous web milestone had 335 passing tests. The shared corpus adds 324 tests
for 292 semantic cases, 26 malformed JSON strings and corpus integrity/reproducibility.
The 292 semantic cases contain 25 valid projects and 267 rejection cases.

The Windows coordinate check ran at
`test-results/native/20260917-001258-985/coordinates.log` on the remote checkout.
The test compiles C++ without Unreal headers; it does not close the engine gate.
Web browser output is retained at `docs/r0/evidence/web-browser-results.json`.

Browser results belong in `test-results/r0/` or the CI artifact named
`r0-browser-evidence`; an authored test script is not a recorded pass.
The unit tests exercise Three.js socket transforms without a GPU, so they are not
visual quality or real-device interaction evidence.

## Part 3 — Owner Acceptance Sign-off

R0 owner acceptance — 17 September 2026

Browser screen inspection (Gate 1)
- Owner:                icaruslastflight
- Reviewed screens:     test-results/r0/r0-*.png (nine files)
- Verdict:              PASS
- Browser + version:    Windows Chrome / Chromium 153 desktop (1440×960) & touch emulation (390×844)

Android touch pass (Gate 3)
- Owner:                icaruslastflight
- Device:               Android Phone (Chrome for Android)
- Checklist:            All 21 touch-pass items verified (gestures, 2-finger abort, pinch zoom, offline reload, error handling, handoff modal, rotation)
- Touch targets:        ≥ 40 px verified across all interactive controls
- Frame pacing:         Smooth pans, no stutters or input freezes
- Verdict:              PASS
- Notes:                Visual result reviewed and approved by owner. Release acceptance gates closed.

