# `src/render/` — WebGPU render layer

Beam, laser and atmospheric rendering that sits above the Three.js show layer.

**Currently empty by design.** The Phase 1 foundation establishes the frame
clock that this layer submits from (`EngineLoop`, priority band
`TICK_PRIORITY.RENDER = 3`), but the renderers themselves land with the
volumetric work.

## What lands here

| Module | Phase | Purpose |
| --- | --- | --- |
| `VolumetricBeamShader.ts` | 6 | Three.js material wrapper around `src/shaders/volumetric_beam.wgsl` — depth linearization, soft surface attenuation, Beer-Lambert scattering, GDTF gobo projection |
| `LaserFanRenderer.ts` | 6 | Pangolin OSC-driven laser fans, plus the ANSI Z136.1 / FDA CDRH MPE safety intersector against audience zones below 2.5 m |

## Constraints that already apply

- **Submission happens in `TICK_PRIORITY.RENDER`**, never in a private
  `requestAnimationFrame`. Telemetry, physics and automation must all have
  settled for the frame before anything draws — see the header of
  `src/core/EngineLoop.ts`.
- **Occlusion is desktop-authoritative.** The Cesium basemap and the Three.js
  show layer do not share a depth buffer (documented at the point of divergence
  in `src/geo/CesiumGlobe.ts`), so show geometry is never occluded by basemap
  buildings on the web. Beam/surface intersection tests that depend on basemap
  depth cannot reach parity here and must say so.
- **No cross-origin isolation.** Free static hosts cannot set COOP/COEP, so
  nothing here may depend on `SharedArrayBuffer`.
