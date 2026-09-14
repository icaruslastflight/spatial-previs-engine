# `src/ui/` — operator HUD and inspectors

Canvas and DOM overlays the operator drives on site. Distinct from
`src/components/`, which holds viewport-embedded controls.

**Currently empty by design.** Phase 1 establishes the event vocabulary these
panels subscribe to (`src/core/EventBus.ts`) and the frame clock they refresh
against (`src/core/EngineLoop.ts`); the panels land with their own phases.

## What lands here

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
