# Native UE5 R0 foundation

Open `SpatialPrevis/SpatialPrevis.uproject` with UE5.8 after installing the engine
and its supported C++ toolchain. This is the native CORE-01 milestone, not the full
R0 desktop product. No paid API or map account is needed.

## Current workflow

1. Build `SpatialPrevisEditor` using `../scripts/verify-r0-native.ps1` from PowerShell.
2. In Unreal Editor, choose **Tools > Spatial Previs R0**.
3. Import `../tests/fixtures/r0/production-project.v1.json` using the file dialog.
4. Inspect IDs, kinds, labels, locks, unknown quantities, revision and relationships.
   Selecting a row displays its complete record JSON.
5. Export a separate project JSON file. The source file stays intact; failed imports
   preserve the active project. Existing export destinations require confirmation.

The inspector does not yet import the web workspace envelope or create scene actors.
Use the bare shared fixture for native inspection. Web workspace backups include
history and evidence that this milestone deliberately refuses to discard.

## Coordinate boundary

| Value | Shared project | UE boundary |
| --- | --- | --- |
| Axes | X east, Y up, Z negative north | X north, Y east, Z up |
| Position | metres `(x,y,z)` | centimetres `(-100z,100x,100y)` |
| Quaternion | XYZW `(x,y,z,w)` | XYZW `(z,-x,-y,w)` |

Unchanged project JSON is exported directly through the codec. It is not normalized
through renderer transforms. The portable coordinate header is used by the real
FTransform adapter, with engine-specific rotation checks in the commandlet.

## Verification

```powershell
powershell -NoProfile -File scripts/verify-r0-native.ps1 -CoordinatesOnly
powershell -NoProfile -File scripts/verify-r0-native.ps1 -EngineRoot 'C:\Program Files\Epic Games\UE_5.8'
```

Run these from the repository root. The full command compiles the editor, runs the
shared corpus and compares semantic output. Native evidence preserves exact JSON
in strings to avoid report-writer rounding. The comparator has its own corruption
tests, run with `node scripts/test-r0-native-comparator.mjs`; synthetic test reports
are never native evidence.

No generated Unreal binaries, caches, project solutions or saved evidence belong in
Git. Keep the source and fixture versions together. See `docs/r0/UE5_CONFORMANCE.md`
for the command, persistence, scene, evidence and Android work still needed for R0.
