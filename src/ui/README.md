# `src/ui/` — operator HUD and inspectors

Canvas and DOM overlays the operator drives on site. Distinct from
`src/components/`, which holds viewport-embedded controls.

**No longer empty.** The R0 production workspace landed here first, ahead of
the Phase 4/6 HUD panels the table below originally named — those panels
still don't exist yet and remain future work, listed separately so this
table stays honest about what's actually in the directory.

## What's here

| Module | Purpose |
| --- | --- |
| `ProductionWorkspace.ts` | Top-level R0 workspace shell — owns the project/record store, undo, save/reopen, desktop handoff, diagnostic checks, and composes the viewport and cabling inspector into one screen. |
| `ProductionViewport.ts` | Three.js viewport: a read-only projection of committed records (domain state never comes from mesh UUIDs), catalog asset loading, drag/orbit/pinch gesture handling. |
| `ProductionScene.ts` (+ `.test.ts`) | Scene-graph helpers the viewport calls into — lifting glTF-node `extras.sockets` to a wrapper's local frame, preparing a socket-snapped move. |
| `CablingInspector.ts` | Truss cable-routing overlay: drag-to-route handles over `TrussCableRouter`, rendered as its own `THREE.Group` layered on the shared scene. |
| `workspace.css` | Styling for the above. |

## Still pending (not yet landed)

| Module | Phase | Purpose |
| --- | --- | --- |
| `DMXUniverseInspector.ts` | 4 | 32×16 channel grid over one universe, GDTF attribute bands, hover zoom with sparkline history, and a 60 FPS oscilloscope over 5/10/30/60 s windows |
| `AtmosphereController.ts` | 6 | Haze density, wind drift vector, ambient colour temperature (2700–6500 K), laser safety overlay toggle |

## Constraints that already apply

- **Touch first.** Targets are at least ~40 px and every interaction must work
  under touch before it counts as done — `CLAUDE.md` §1.3. A hover-only
  affordance (the inspector's zoom popup) needs a tap equivalent.
- **Read on a HUD cadence, not per frame.** `TypedArrayMemoryPool.stats()`
  allocates its report object; sampling it every frame reintroduces exactly the
  garbage the pool exists to remove.
- **Never retain `FrameTiming`.** The same instance is mutated and handed to
  every tick of every frame. Panels read what they need and copy it.
