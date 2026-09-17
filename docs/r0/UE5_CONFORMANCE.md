# R0 desktop conformance

Status: not executed. The AirGPU device is registered but offline to this session.
UE 5.8 and Visual Studio 2026 were reported ready by the owner. No native UE5
project exists in this web repository. A passing web suite does not close this gate.

## Shared contract

- `tests/fixtures/r0/production-project.v1.json` is the original project fixture.
- `src/domain/ProductionProject.ts` and `ProjectCodec.ts` define its strict record graph.
- `WorkspaceState.ts` adds the versioned workspace envelope. Bare project v1 files
  migrate explicitly to envelope v1 without changing project IDs or quantities.
- `ProjectStore.test.ts` specifies transactions, cancellation, history, locks,
  exact-input invalidation, reviewer authority and immutable issued JSON bytes.

The native implementation must consume these same cases, including rejection
cases. Do not mark parity complete from a successful import alone. Do not silently
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

This verifies the web/domain toolchain and records host evidence. It does not
compile a missing UE5 project or manufacture a desktop conformance pass. Supply
the real native project and its automation suite before recording the desktop
gate as passed.
