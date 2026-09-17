# R0 desktop conformance

Status: native CORE-01 source implemented; Unreal build and runtime conformance pending.
The AirGPU workstation is online. Visual Studio 2026 and its C++ tools are verified.
Epic Games Launcher installed successfully on 17 September 2026; UE5.8.2 files are now
present. The initial build encountered a missing Windows TMP variable in the remote
process environment; preflight now restores it. The owner restarted the PC during
the next attempt. Native build and commandlet results remain unverified.

`native/SpatialPrevis/SpatialPrevis.uproject` is pinned to UE5.8. It contains the
strict project codec, Tools > Spatial Previs R0 record inspector, coordinate adapter,
and conformance commandlet. This milestone accepts bare project-v1 JSON only. It
rejects workspace envelopes rather than silently dropping their history/evidence.
No actors or engineering calculations are created by the inspection panel.

The exact coordinate implementation passes 358 portable C++ assertions under Linux
GCC and remote Windows MSVC. Those are not an Unreal build or render pass.

```powershell
powershell -NoProfile -File scripts/verify-r0-native.ps1 -CoordinatesOnly
powershell -NoProfile -File scripts/verify-r0-native.ps1 -EngineRoot 'C:\Program Files\Epic Games\UE_5.8'
```

The full script builds the editor, executes the commandlet against 292 semantic cases
and 26 malformed JSON cases, then compares exported records to the original values.
Reports must include every case and pass the actual engine coordinate checks.
Results go into a new `test-results/native/<timestamp>/` folder. A script existing
on disk is not evidence of a successful run.

Native CORE-02/03/04 command/history/check/review/persistence behavior and real scene
reconciliation/snapping are still unimplemented. Shared-contract conformance remains
open. Desktop capabilities are not capped by mobile support; see `PLATFORM_CAPABILITIES.md`.

## Shared contract

- `tests/fixtures/r0/production-project.v1.json` is the original project fixture.
- `tests/fixtures/r0/project-conformance.v1.json` is the generated shared corpus.
  Regenerate with `node scripts/generate-r0-conformance.mjs`. The native runner uses
  each case's exact `json` string to avoid numeric precision loss in a staging writer.
- `src/domain/ProductionProject.ts` and `ProjectCodec.ts` define its strict record graph.
- `WorkspaceState.ts` adds the versioned workspace envelope. Bare project v1 files
  migrate explicitly to envelope v1 without changing project IDs or quantities.
- `ProjectStore.test.ts` specifies transactions, cancellation, history, locks,
  exact-input invalidation, reviewer authority and immutable issued JSON bytes.

The native implementation must consume these same cases, including rejection
cases. Do not mark shared-contract conformance complete from a successful import alone. Do not silently
activate this experimental shared format as a production format before that run.

## Required desktop evidence

1. Record repository commit, UE version, compiler, operating system, CPU, GPU, RAM
   and free storage. Keep tokens and account details out of logs.
2. Build the existing desktop project, or establish the native adapter if none
   exists. Inspect its own governing instructions before changes.
3. Preserve every fixture ID, unknown quantity, unit, lock, membership order and
   relationship kind. Mechanical edges must never become power/signal links.
4. Convert the declared right-handed Y-up metre frame at the native boundary.
   Establish the UE axis mapping explicitly; test axis basis, metre/centimetre
   conversion, nonidentity quaternion rotations and round trips. A component-wise
   quaternion copy is not conformance evidence.
5. Test stale revisions, repeated idempotency keys, invalid graph rollback,
   cancel, locked endpoints, deletion, restored allocations, monotonic-revision
   undo/redo and history after reopen.
6. Test un-snapped movement, real socket snaps, unlink, deletion and attached
   hierarchy motion against the renderer and dependent queries.
7. Compare canonical semantic JSON results with the web runner. Include check
   input hashes, newly added relationships, deleted inputs, stale asynchronous
   results and review invalidation. Undo must not restore a stale review badge.
8. Run authenticated review/issue tests with a human principal and a denied
   automation principal. Imported metadata is not proof of reviewer identity.
9. Retain exact issued bytes across scene changes, save/reopen, undo and new drafts.
10. Run actual Android touch workflows. Browser touch emulation is supporting
    evidence only. Visual review requires owner feedback; screenshots cannot
    self-approve the commercial design.

## Venue scope

The product supports arbitrary real or virtual venues. Point State Park is only
the existing sample point-cloud/georeferencing context. Native local scenes must
work without a map account or geographic coordinates. If that sample is used,
its documented anchor-height divergence still requires a verified native fix.

## Windows preflight

From this repository in PowerShell:

```powershell
powershell -NoProfile -File scripts/verify-r0-windows.ps1
```

This verifies the web/domain toolchain and records host evidence. Use
`verify-r0-native.ps1` for the new native project. Only a recorded engine build,
conformance comparison and remaining desktop implementation can close that gate.
