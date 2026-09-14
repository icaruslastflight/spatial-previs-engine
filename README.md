# spatial-previs-engine

High-performance spatial twin and live-event pre-visualization platform anchored
at **Point State Park, Pittsburgh, PA** (40.4417&deg;N, 80.0075&deg;W).

This repository holds the **web client** — the Parallel High-Capability Web
Application line, built for maximum browser-native parity with the Unreal
Engine 5 desktop architecture. Three.js + CesiumJS + Gaussian splatting, with
modular-asset magnetic snapping.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173  (also served on your LAN for phone testing)
```

No API keys are required. The basemap degrades gracefully to a keyless tier.

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server, exposed on the LAN so you can open it on a phone |
| `npm run build` | `tsc && vite build` — must be clean before committing |
| `npm run preview` | Serve the production build locally |
| `npm test` | Geodetic + socket-snapping regression checks |
| `npx tsc --noEmit` | Typecheck only |

## Deploying (free tier only)

```bash
npm run build                          # Vercel / local  → base '/'
DEPLOY_TARGET=gh-pages npm run build   # GitHub Pages    → base '/spatial-previs-engine/'
BASE_PATH=/custom/ npm run build       # explicit override
```

Cesium's runtime asset trees are copied into `dist/cesium/` at build time and
`CESIUM_BASE_URL` is derived from the chosen base path, so subpath deployments
resolve correctly.

## Basemap tiers

The viewport picks the best basemap available and never hard-fails:

| Tier | Requires | Result |
| --- | --- | --- |
| Google Photorealistic 3D Tiles | `VITE_GOOGLE_MAPS_API_KEY` | Full site model, UE5 parity |
| Cesium World Terrain | `VITE_CESIUM_ION_TOKEN` | Shaped ground, no buildings |
| OpenStreetMap imagery | *nothing* | Street context on the ellipsoid |

Copy `.env.example` to `.env.local` to supply keys. Never commit one.

## Using the viewport

- **One finger on an asset** — drag it across the ground plane
- **One finger on empty space** — orbit the camera
- **Two fingers** — pinch-zoom and pan
- Assets snap magnetically within **150 mm**, auto-aligning mating faces and
  quantizing roll to 0&deg; / 90&deg; / 180&deg; / 270&deg;

## Project guidelines

**Read [`CLAUDE.md`](./CLAUDE.md) before contributing.** It is the binding
specification for the Strict Dual-Platform Parity rule, the $0 budget
constraints, the site coordinate anchors, and the `extras.sockets` schema.
