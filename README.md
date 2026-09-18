# spatial-previs-engine

Spatial Previs Engine is a venue-independent live-event design and
pre-visualization platform for real venues and entirely virtual environments.
Projects may use a local metre-based scene, an optional geographic reference,
and optional point-cloud or Gaussian-splat context.

**Point State Park is a sample venue**, chosen for a possible real-world
point-cloud demonstration. It is not the product's required location or a
restriction on where a project can be created. The existing legacy viewport
opens that sample; its named coordinates and geodetic tests apply only to it.

This repository holds the **web/mobile client and native UE5 foundation**.
Desktop retains its full capability. Web/mobile support practical on-device
workflows and a desktop handoff for features that need Unreal or stronger hardware.
Project data and supported operations stay compatible across platforms. The web
renderer uses Three.js, CesiumJS and Gaussian splatting with modular-asset snapping.

## Quick start

```bash
npm ci
npm run dev      # http://localhost:5173  (also served on your LAN for phone testing)
```

No API keys are required. The basemap degrades gracefully to a keyless tier.

### R0 production workspace preview

Open **http://localhost:5173/r0.html** for the command-backed local editor.
The root page remains the existing venue sample and socket viewport.
R0 supports equipment search and placement, shared selection across Build / Map /
Connect / Check / Deliver, exact metre coordinates, locks, connection previews,
undo/redo, local saves, JSON import/export, scoped data checks and evidence exports.
Use HTTPS or localhost for the browser's UUID and hashing APIs; an ordinary HTTP
LAN address is not a secure context for R0 checks.

Save project stores the graph and history on this browser/device and reopens the
last successfully saved project. Export project downloads a portable backup.
Concurrent tabs cannot silently overwrite each other's saves. Imported approval
records require fresh authorized review; existing issued bytes remain unchanged.

**R0 is a review build.** Native shared-contract conformance, actual-phone acceptance and commercial
visual approval remain open. R0 movement, socket snaps and unlinking share the command/undo store. Read [R0 status](docs/r0/README.md),
[desktop conformance](docs/r0/UE5_CONFORMANCE.md), and the
[account/API setup checklist](docs/r0/ACCOUNTS_AND_APIS.md) before calling it a release.

Read the [desktop capability decision](docs/r0/PLATFORM_CAPABILITIES.md) and
[native project guide](native/README.md) for the platform boundary and current scope.

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server, exposed on the LAN so you can open it on a phone |
| `npm run build` | `tsc && vite build` â€” must be clean before committing |
| `npm run preview` | Serve the production build locally |
| `npm test` | Vitest: core engine, geodetic, CP-1, socket snapping, asset library |
| `npm run test:r0:browser` | Production browser acceptance; run build and install Playwright Chromium first |
| `npm run verify` | Foundation health check — structure, typecheck, tests, build |
| `npx tsc --noEmit` | Typecheck only |
| `npm run build:assets` | Compile the modular asset library to GLB |

Two Python CLIs round out the toolchain but aren't npm scripts:
[`scripts/memory/`](./scripts/memory/README.md), a per-workstation $0
vector + graph index of this repo, and
[`scripts/ai-tools/`](./scripts/ai-tools/README.md), a project-customized
prompt-drafting tool built on Anthropic's metaprompt technique.

[`dashboard/`](./dashboard/README.md) is a live, keyless dev page
(`npm run dev`, then `/dashboard/`) showing roadmap progress, open PRs,
recent commits and CI status pulled from the real GitHub API, plus a
hand-maintained log of open owner decisions.

## Deploying (free tier only)

```bash
npm run build                          # Vercel / local  â†’ base '/'
DEPLOY_TARGET=gh-pages npm run build   # GitHub Pages    â†’ base '/spatial-previs-engine/'
BASE_PATH=/custom/ npm run build       # explicit override
```

Cesium's runtime asset trees are copied into `dist/cesium/` at build time and
`CESIUM_BASE_URL` is derived from the chosen base path, so subpath deployments
resolve correctly.

The build also emits a PWA manifest and service worker, so the client installs
to a phone home screen as a landscape standalone app and re-opens without an
uplink. Cesium's runtime trees are deliberately left out of the precache â€” they
run to tens of megabytes and are fetched on demand.

## Basemap tiers

The viewport picks the best basemap available and never hard-fails:

| Tier | Requires | Result |
| --- | --- | --- |
| Google Photorealistic 3D Tiles | `VITE_GOOGLE_MAPS_API_KEY` | Full site model, UE5 parity |
| Cesium World Terrain | `VITE_CESIUM_ION_TOKEN` | Shaped ground, no buildings |
| OpenStreetMap imagery | *nothing* | Street context on the ellipsoid |

Copy `.env.example` to `.env.local` to supply keys. Never commit one.

## Using the viewport

- **One finger on an asset** â€” drag it across the ground plane
- **One finger on empty space** â€” orbit the camera
- **Two fingers** â€” pinch-zoom and pan
- Assets snap magnetically within **150 mm**, auto-aligning mating faces and
  quantizing roll to 0&deg; / 90&deg; / 180&deg; / 270&deg;

## Architecture

The client is layered under `src/`:

| Layer | Holds |
| --- | --- |
| `core/` | Frame clock, typed event bus, zero-allocation typed-array pool |
| `geo/`, `geospatial/` | Geographic frame utilities and the Point State Park sample reference |
| `engine/` | Magnetic socket contract, proximity, detents, kinematic linking |
| `assets/` | Procedural primitives and Gaussian splat loading |
| `viewport/` | Touch drag-and-snap gestures, site bounds |
| `domain/` | Versioned project graph, transactions, persistence, scoped checks and diagnostic replay |
| `assistant/` | Read-only scene/evidence tools with no required model provider |
| `ui/` | R0 production workspace, responsive inspector and 3D projection of committed records |
| `render/`, `network/` | Existing phase-specific extension points |

Everything that runs per frame registers on the shared `EngineLoop` in a
priority band â€” telemetry, then physics, then automation, then render â€” rather
than opening a private `requestAnimationFrame`.

## Project guidelines

**Read [`CLAUDE.md`](./CLAUDE.md) before contributing.** It is the binding
specification for the Strict Dual-Platform Parity rule, the $0 budget
constraints, the sample venue coordinate anchors, and the `extras.sockets` schema.
