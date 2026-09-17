# R0 shared production foundation

Status: **web implementation prepared for review; release acceptance remains open**.
Base: `37b1f3b74ccb8b16c97c69521ed0190edffa4f95`. The earlier CORE-01
contract at `13647b0` is extended without changing project schema v1.

## Run and verify

```bash
npm ci
npm run dev
# Open http://localhost:5173/r0.html
npm run verify
npx playwright install chromium
npm run test:r0:browser
```

The browser command starts a production preview on port 4175 and writes
`test-results/r0/results.json` and screenshots. `R0_TEST_URL` can select an
already running production preview. Offline tests require the production service
worker, which is disabled in Vite dev. Windows preflight is available at
`scripts/verify-r0-windows.ps1`.

## Implemented behavior

| Area | Behavior |
| --- | --- |
| CORE-01 | Stable records, typed relationships, strict whole-graph validation; unknown quantities retain units. |
| CORE-02 | Atomic commands, stale revision and duplicate-key rejection, permissions and endpoint locks, detached previews, cancel, monotonic undo/redo. |
| CORE-03 | IndexedDB compare-and-swap saves and atomic active-project pointer; explicit project-v1 migration; persistent history, renderer reconciliation and immutable issued bytes. |
| CORE-04 | Named check model/version, exact-input SHA-256 hashes, five result states, dependency invalidation and human authorization boundary. |
| UI-01 | Linked Build / Map / Connect / Check / Deliver contexts; catalog search, selection, numeric editing, drag/snaps, unlink, locks, removal previews and JSON recovery. |
| AI-01 | Strict read-only `scene.summary` and `scene.inspect` tools; detached evidence with revision, sources, unknown values and freshly checked input hashes. No model account required. |
| QA-01 | Domain/scene regressions, redacted diagnostic replay, browser acceptance script, Windows preflight and native evidence checklist. |

Only recorded-data presence is calculated. Populated data does not establish
engineering performance. Structural, electrical, optical, acoustic and laser-safety
calculations return `not_evaluated` through scene tools. Local editing does not
allow specialist review/issuance; a host must supply that authenticated authority.

## Operator walkthrough

1. Search the catalog and place two objects. Select and edit exact X/Y/Z metres.
2. Drag equipment to move/snap. Two fingers operate the camera; a second contact,
   pointer cancellation or Escape cancels a move. Numeric fields provide a non-drag alternative.
3. Use Preview nearby socket snap or Preview unlink, then cancel/apply and undo.
4. Lock equipment and verify edits are blocked. Preview removal, cancel, then apply
   and undo; relationships and allocations return with the geometry.
5. In Connect, add an output port to one object and an input to another. Preview
   and apply a logical connection. Mechanical edges never imply power or signal.
6. Run Check recorded data. Missing values remain `needs_data`; changing their
   inputs makes checks stale. Inspect evidence identifies the recorded data and revision.
7. Save, reload and check records/history. Export a portable JSON backup. Saving
   an imported project makes that project the next startup project.
8. Deliver exports scene evidence and redacted diagnostics locally. Nothing is
   uploaded automatically. Diagnostics retain geometry/numbers; inspect before sharing.

## Integrity and recovery

- Canceled/rejected proposals leave records, relationships, allocations and history intact.
- Invalid imports and changes made while import loads preserve the current project.
- Failed saves keep the previous stored project. Export current edits before reopening.
- Concurrent tabs get a save conflict instead of silently overwriting each other.
- Imported histories must connect to the current graph, not just contain valid snapshots.
- Loaded/imported reviews require reauthorization; files cannot prove reviewer identity.
  Historical issued artifacts retain their exact bytes.
- Renderer asset loads replace the scene atomically. Failed loads retain the prior scene
  with an explicit error and suspend geometry interaction until recovery.
- Drag proposals resolve on cloned geometry using the existing socket engine. Committed
  transforms/edges use the same command boundary as numeric edits. Imported attachment
  sockets that are missing block dragging with an explicit error; unlink remains available.
- Moving a parent carries descendants; moving an attached child unlinks it. Origin-based
  queries are not collision tests. Snaps are geometric, not structural approval.
- Diagnostics alias names, sources, identifiers and review metadata. Redacted issued
  content is a diagnostic copy; the original stored artifact is never modified.

## Verification and release gates

`VERIFICATION.md` records executed checks and environment limits. CI runs the production
browser suite and retains results/screenshots. A configured workflow is not proof it ran.

R0 cannot be called complete until all of these are evidenced:

1. Production browser acceptance passes and its actual screens are inspected, including
   interrupted gestures, offline reopen, malformed imports, concurrent saves and narrow controls.
2. The actual UE5 implementation passes shared fixtures and rejection cases. The native
   CORE-01 project now lives under `native/SpatialPrevis`; its engine build and remaining
   workspace implementation are still open. See `UE5_CONFORMANCE.md`.
3. The actual Android device is tested and the owner/operator reviews the visual result.

The root sample viewport remains intact; `/r0.html` is the experimental shared-state
workspace. No snap constants, parser semantics or sample anchor values were changed.
Do not merge it as a conforming cross-platform release before those gates close.

Point State Park is only an optional sample venue. Local R0 projects require no geographic
anchor, map, point cloud, service account or paid API. LED mapping, specialist calculations,
stock reservations and crew-pack generation remain R1+ scope.
