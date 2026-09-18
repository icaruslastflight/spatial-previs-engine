# Festival Visualizer — Project Guidelines

Venue-independent spatial twin and live-event pre-visualization client for
real and virtual environments. **Point State Park, Pittsburgh, PA is a sample
venue for optional point-cloud context, not the product's scope.** This repository
contains the web/mobile client and the native UE5 foundation. Desktop retains its
full capability; browser/device limits must not reduce the desktop product.

---

## 1. Governing rules

Read `AGENTS.md` for the owner's standing documentation/continuity requirements.
Every meaningful development change includes updating the living illustrated guide,
roadmap, case study, account checklist and executed verification records. Keep their
saved identities and version history; provide PDF/DOCX downloads for phone access.

### 1.1 Shared contracts and full desktop capability

Owner decision on 17 September 2026: **do not limit desktop capability to what
web/mobile can run.** This supersedes the earlier identical-feature-set requirement.

- Desktop may ship advanced geometry, simulation, device integration and rendering
  that browsers or phones cannot support. Give those workflows their full native
  capability and mark availability explicitly in the web/mobile product.
- Keep shared project identities, units, coordinate transforms, relationship
  meanings and supported operations consistent. A contract change needs a versioned
  compatibility/migration path and conformance evidence; do not silently reinterpret
  or delete unsupported desktop data when a project passes through a browser.
- Web/mobile must offer **Continue on desktop** for unavailable workflows, through
  a configured desktop connection or clear handoff. A redirect is not automatic
  project synchronization; explain export/import requirements where applicable.
- Shared snapping/parser behavior must agree where both implementations support
  it. Desktop-only features do not require a reduced browser implementation first.
- Document actual capability differences. The Cesium basemap and Three.js show
  layer do not share a depth buffer (`src/geo/CesiumGlobe.ts`), so show geometry
  is not occluded by basemap buildings. Occlusion checks remain desktop-authoritative.
- Shared numeric constants live in exactly one place per platform and are
  mirrored verbatim. On the web those are `POINT_STATE_PARK` in
  `src/geo/GeoAnchor.ts` and `SNAP_THRESHOLD_METERS` / `DETENT_STEP_RADIANS` in
  `src/engine/SocketSnappingEngine.ts`.

> **OPEN PARITY DIVERGENCE — site anchor height.** The web anchor's ellipsoidal
> height was corrected from 186.6 m to **184.963 m** (§2): the geoid separation
> was wrong by 0.42 m and the NAD83 → WGS84 frame offset was missing entirely.
> The UE5 georeferencing actor has **not** taken the same change, so the two
> platforms are currently **1.637 m apart vertically**. This is a correction,
> not a capability gap — the desktop is not authoritative here. Port the same
> number to UE5 and delete this note.

### 1.2 $0 financial budget

This line is developed on a phone with no spend. That is a hard constraint, not
a preference.

- **Libraries:** open source only — Three.js, CesiumJS, Vite,
  `@mkkellogg/gaussian-splats-3d`.
- **Hosting:** free-tier static only — Vercel or GitHub Pages. See §5.
- **No paid API keys are assumed.** Anything needing a key must degrade
  gracefully to a keyless path. The basemap does this across three tiers (§4).
- **No cross-origin isolation.** Static free hosts cannot set COOP/COEP headers,
  so `sharedMemoryForWorkers` stays `false` in the splat loader. Do not turn it
  on without a host that can serve those headers.
- **No large binaries in git.** Scans go in release assets or an external bucket
  and are fetched at runtime. Git LFS bandwidth is not free.

### 1.3 Mobile touch is the primary browser target

The browser viewport is developed and operated on a phone. Its supported
interactions must work under touch before they are considered done. Desktop-only
workflows remain available through the desktop handoff instead of constraining UE5.

- One finger on an asset drags it; one finger on empty space orbits; two fingers
  pinch-zoom and pan. A second finger landing mid-drag **aborts** the drag and
  hands the gesture to the camera.
- Touch targets are at least ~40 px. `touch-action: none` on the 3D canvas.
- Device pixel ratio is capped at 2 — previz is fill-rate bound and phones ship
  3x panels.

---

## 2. Site anchor — Point State Park

These constants describe the existing sample venue only. Do not use them as
mandatory defaults for new projects. Local unreferenced scenes must remain
usable without maps, geographic coordinates, scans, accounts or API keys.
Other venues require their own geographic reference and source evidence.

```
Latitude    40.4417° N        →  +40.4417
Longitude    80.0075° W       →  -80.0075   (stored SIGNED)
Height      184.963 m         →  WGS84 ellipsoidal
```

Defined once as `POINT_STATE_PARK` in `src/geo/GeoAnchor.ts`. **Never re-declare
these numbers anywhere else** — import the constant.

- Longitude is always stored **signed**. Pittsburgh is negative. A positive
  80.0075 puts the site in Central Asia.
- Height is **ellipsoidal**, not orthometric, and reaching it takes **two**
  corrections. Applying only the first is the easy mistake:

```
h_WGS84 = H_orthometric + N_geoid  + d_frame
184.963 = 220.0         + (−33.82) + (−1.217)
```

| Term | Value | Why |
| --- | --- | --- |
| `H_orthometric` | 220.0 m | Metres above mean sea level (NAVD88) — the survey-drawing number. NGS marks around the Point read 219.5–222.3 m. |
| `N_geoid` | −33.82 m | GEOID18 separation at the anchor. Gets from a geoid-referenced height to an ellipsoid-referenced one. Omit it and the site floats 33.8 m up. |
| `d_frame` | −1.217 m | NAD83(2011) → ITRF2014. NAVD88 and GEOID18 are published against NAD83; Cesium and Google 3D Tiles use WGS84. Omit it and the site sits 1.2 m high — invisible to an eyeball check, 8× the snapping tolerance. |

Sourced to **NGS PID KY3596 ("P 44")**, ~380 m west of the anchor, the nearest
mark publishing both heights: `NAVD 88 ORTHO HEIGHT 219.5 m (720 ft)`,
`NAD 83 ELLIP HT 185.678 m`, `GEOID HEIGHT −33.821 m (GEOID18)`. The frame
offset is from PROJ 9.5.1, `EPSG:6319 → EPSG:7912`, evaluated at the anchor.

Both corrections are **per-site**. The geoid ranges roughly −105 m to +85 m
worldwide and the frame offset is position-dependent — re-derive both per venue,
never copy these numbers forward.

### Coordinate frames

The scene is a **local ENU tangent plane in meters** anchored at the site.
Geodesy is Z-up; Three.js is Y-up. The bridge, defined once in `GeoAnchor.ts`:

```
three.x = +East          east  = +three.x
three.y = +Up            north = -three.z
three.z = -North         up    = +three.y
```

All conversions go through `SITE_FRAME` (`EnuFrame`). Do not hand-roll geodetic
math elsewhere.

---

## 3. `extras.sockets` schema

Modular assets carry socket metadata under **`extras.sockets`**, matching the
glTF `extras` convention so web and UE5 read the same asset file. The shape
below is *Event Asset Library and Modular Snapping Specification*, section 3.1.

```jsonc
{
  "extras": {
    "sockets": [
      {
        "socket_id": "end_a_top_near",       // unique within the asset
        "socket_type": "TRUSS_CONICAL_F34",  // must be in SOCKET_TYPES
        "gender": "MALE",                    // MALE | FEMALE | NEUTRAL | UNIVERSAL
        "transform": {
          "translation": [1.0, 0.145, 0.145],  // LOCAL space, metres
          "normal":      [1.0, 0.0, 0.0],      // LOCAL, points OUTWARD
          "up":          [0.0, 1.0, 1.0]       // LOCAL, roll reference
        },
        "tolerances": {
          "snap_radius": 0.15,                 // metres
          "snap_angle": 15,                    // DEGREES of angular tolerance
          "detents_deg": [0, 90, 180, 270]     // roll locks onto these
        },
        "kinematic_rules": {
          "can_parent": true,
          "can_child": true,
          "load_bearing": true,
          "max_load_kg": 750
        },
        "tags": ["end_a", "top_near"]
      }
    ]
  }
}
```

### `snap_angle` is a TOLERANCE, not the detent step

This is the single easiest thing in the schema to misread, so it is worth
stating twice: **15 degrees is the angular capture window** — how far the two
mating axes may deviate from anti-parallel and still snap. **The detents are
0 / 90 / 180 / 270.** The joint captures within 15 degrees, then locks onto the
nearest cardinal detent. They are separate numbers doing separate jobs.

### Field rules

- **`normal`** points *outward* from the mating face. Two sockets mate when
  their normals are **anti-parallel**.
- **`up`** resolves the remaining roll degree of freedom. It need not be exactly
  perpendicular to `normal` (it is Gram-Schmidt orthogonalized on registration)
  but it must not be *parallel* to it, or the socket is rejected.
- **`up` must encode angular position for radially-arrayed sockets.** On the
  F34 truss the four chord sockets point their `up` vectors **radially outward
  toward their own chord**. Giving all four a shared `up` of `(0,1,0)` is a bug:
  it aligns the mated pair and leaves the other three chords crossed by up to
  17 mm. Covered by a regression check.
- **`gender`:** `MALE` mates only `FEMALE`; `NEUTRAL` mates only `NEUTRAL`
  (coffin locks are hermaphroditic); `UNIVERSAL` mates anything of its own type.
- **`socket_type`** must appear in `SOCKET_TYPES`. Unknown types are rejected at
  registration with a warning, never silently ignored.
- **`kinematic_rules`** gate reparenting: a socket with `can_child: false`
  (a hoist top hook, a fixture clamp) never becomes a child.

### Legacy shape

The pre-migration flat form — `position`/`normal`/`up` as siblings of
`socket_id`, lowercase types and genders — is still parsed by
`normalizeSocket()` and aliased onto the spec vocabulary, so older assets keep
loading. Everything authored in this codebase emits the spec shape.

### glTF round-trip caveat

Three's `GLTFLoader` flattens a node's `extras` straight onto `userData` via
`Object.assign`, so `extras.sockets` in the file arrives as `userData.sockets`,
not `userData.extras.sockets`. `readSockets()` accepts **both** shapes.

### Snapping tolerances — mirrored in UE5

| Constant | Value | Meaning |
| --- | --- | --- |
| `SNAP_THRESHOLD_METERS` | **0.15 m** | Magnetic capture radius between socket origins |
| `SNAP_ANGLE_RADIANS` | **15°** | Angular capture window (mating-axis deviation) |
| `DETENT_STEP_RADIANS` | **π/2 (90°)** | Roll quantizes to 0° / 90° / 180° / 270° |

**Detent semantics (easy to get backwards):** rotate by the *small correction*
`rawAngle − round(rawAngle / 90°) × 90°`, which drives the joint **onto** the
nearest detent. Rotating *by* the quantized angle instead leaves up to 45° of
residual error. There is a regression check for this.

## 4. Basemap tiers

The basemap degrades gracefully; none of these tiers is required for the app to
run.

| Tier | Requires | Result |
| --- | --- | --- |
| Google Photorealistic 3D Tiles | `VITE_GOOGLE_MAPS_API_KEY` | Full site model, UE5 parity |
| Cesium World Terrain | `VITE_CESIUM_ION_TOKEN` | Shaped ground, no buildings |
| OpenStreetMap imagery | *nothing* | Street context on the ellipsoid |

Put keys in `.env.local` (git-ignored). **Never commit a key.** Tile
attribution is a licensing requirement — the credit container must stay visible.

---

## 5. Commands

```bash
npm run dev         # dev server, exposed on the LAN for phone testing
npm run build       # tsc && vite build  — MUST be clean before committing
npm run preview     # serve the production build locally
npx tsc --noEmit    # typecheck only (also: npm run typecheck)
npm test            # vitest: core engine, geodetic, CP-1, snapping, asset library
npm run verify      # full foundation health check — structure + all three gates
npm run build:assets # compile the modular asset library to GLB
npm run bridge      # FOH Art-Net/sACN → WebSocket daemon (lands in Phase 4)
npm run fetch:gdtf  # sync GDTF fixture profiles into the local cache
npm run render:wall-loop # regenerate public/assets/video/edm_wall_loop.mp4 (needs ffmpeg + a dev server)
npm run test:r0:browser # Playwright acceptance against the R0 production build (§7.1) — build + `npx playwright install chromium` first
npm run bundle       # scripts/build-installation-bundle.mjs — packages a desktop/installer bundle
npm run showcase     # opens r0.html?showcase=true against a running dev server; dev:showcase does both in one step
```

`npm test` runs Vitest over every `src/**/*.test.ts`. Configuration lives in
`vitest.config.ts`, kept separate from `vite.config.ts` so the suite loads
neither the Cesium asset middleware nor the PWA service-worker generator.

### Deployment

```bash
npm run build                          # Vercel / local  → base '/'
DEPLOY_TARGET=gh-pages npm run build   # GitHub Pages    → base '/spatial-previs-engine/'
BASE_PATH=/custom/ npm run build       # explicit override
```

`CESIUM_BASE_URL` is derived from the chosen base path, so Cesium's runtime
assets resolve correctly under a subpath. Cesium's `Workers/`, `Assets/`,
`Widgets/` and `ThirdParty/` trees are copied into `dist/cesium/` at build time
— they are fetched at runtime and **cannot** be bundled.

---

## 6. Code conventions

- **TypeScript is strict.** `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noImplicitOverride` are all on. Kinematics code must not silently widen to
  `any`.
- **`erasableSyntaxOnly` is on** — no `enum`, no parameter properties, no
  namespaces. Use `as const` arrays plus `(typeof X)[number]` union types.
- **`verbatimModuleSyntax` is on** — type-only imports must use `import type`.
- Relative imports carry the `.ts` extension (`allowImportingTsExtensions`).
- Prefer scratch objects over per-frame allocation in the render loop.
- Comments explain *why*, especially where the math is subtle or a constraint is
  non-obvious. Do not annotate the obvious.

## 7. Layout

```
src/
  core/      EventBus.ts               typed pub/sub; allocation-free dispatch
             MemoryPool.ts             recycled Uint8Array(512) / Float32Array(512)
             EngineLoop.ts             one 60 FPS clock, four priority bands
  engine/    SocketSnappingEngine.ts   socket contract, proximity, detents, linking
             GDTFParser.ts             .gdtf unpack + description.xml (DIN SPEC 15800)
             GDTFAssetResolver.ts      GDTF -> Three kinematic chain + photometric light
  assets/    ModularPrimitives.ts      procedural F34 truss + 4x8 deck
             SplatSceneLoader.ts       manifest-driven Gaussian splat loading
  geo/       GeoAnchor.ts              site anchor, WGS84/ECEF/ENU, axis bridge
             CesiumGlobe.ts            basemap tiers + camera sync
             cesiumBaseUrl.ts          publishes CESIUM_BASE_URL before Cesium loads
  geospatial/PointStateParkAnchor.ts   CP-1 venue origin + landmark registration
  viewport/  DragSnapController.ts     touch drag-and-snap gesture contract
             SiteBounds.ts             GeoJSON site envelope → scene
  domain/    ProductionProject.ts      versioned project graph (records, typed relationships, units)
             ProjectStore.ts           atomic commands, stale-revision/duplicate-key rejection, undo/redo
             ProjectCodec.ts           project-v1 JSON (de)serialization + migration
             ProjectChecks.ts          named scoped checks, SHA-256 input hashing, dependency invalidation
             WorkspaceRepository.ts    IndexedDB compare-and-swap saves, active-project pointer
             WorkspaceState.ts         R0 workspace app state
             DiagnosticBundle.ts       redacted diagnostic/evidence export
             ProjectTransforms.ts      coordinate-boundary codec shared with native (see native/README.md)
  assistant/ SceneTools.ts             read-only `scene.summary` / `scene.inspect` tools, no model provider required
  mcp/       server.ts                 Express JSON-RPC 2.0 gateway exposing scene/DMX/electrical + memory tools
  memory/    VectorMemoryStore.ts      in-engine ($0) vector store — distinct from the per-workstation `.memory/` index (§14)
             SessionMemoryStore.ts     in-engine session lifecycle memory
  io/        MVRExporter.ts            My Virtual Rig (MVR) interop export
  components/PlaytestController.ts     WASD/RMB desktop playtest rig + diagnostics HUD
             SplatViewport.ts          Gaussian splat viewer composition
  render/    (Phase 6)                 WebGPU volumetric beams, laser MPE safety
  network/   (Phase 4)                 Art-Net 4 / sACN telemetry ingest
  ui/        ProductionWorkspace.ts    R0 workspace shell: Build / Map / Connect / Check / Operations / Deliver
             ProductionScene.ts        3D projection of the committed project graph
             ProductionViewport.ts     R0's viewport composition (camera presets, screen mapping, LED/DMX patch)
             CablingInspector.ts       power/signal connection editor
  main.ts                              composition root for the legacy sample viewport (index.html)
public/assets/scans/                   scan registry + placeholder site bounds
```

Tests sit beside the module they cover as `<Module>.test.ts`. Each of
`render/`, `network/` and `ui/` carries a `README.md` naming the phase that
fills it and the constraints that already bind it.

### 7.1 Two entry points — legacy sample vs. R0 production workspace

`index.html` (→ `main.ts`) is the original Point State Park sample viewport
and socket-snapping demo. **`r0.html` is the active production workspace** —
the command/undo-backed editor described by `docs/r0/README.md`, built from
`domain/` + `ui/ProductionWorkspace.ts`. Recent feature work (DMX patch,
aiming solver, gobos, the EDM wall loop) lands there, not in `main.ts`. When
asked to add or change operator-facing functionality, check `docs/r0/README.md`
first to see whether it belongs in the R0 workspace rather than the legacy page.

R0's domain layer (CORE-01–04 in `docs/r0/README.md`) is a strict
command/undo store, not direct object mutation: every edit is an atomic
command against `ProjectStore`, validated, revisioned, and undoable. Read
`domain/ProjectStore.ts` before adding a new mutation rather than reaching
into `ProductionProject` records directly.

`src/memory/` (in-engine `VectorMemoryStore`/`SessionMemoryStore`, used by
`mcp/server.ts` and the R0 assistant tools) is a **different system** from the
per-workstation `.memory/` ChromaDB+NetworkX index described in §14 — same
$0-budget philosophy, different layer (runtime app memory vs. a dev-time repo
index). Don't conflate the two when asked to touch "memory."

### Core engine invariants

- **One frame clock.** Anything per-frame registers on `EngineLoop` at a
  priority band — telemetry (0), physics (1), automation (2), render (3) —
  rather than opening its own `requestAnimationFrame`. Independent rAF
  callbacks make execution order an accident of import order.
- **`FrameTiming` is reused.** The same object is mutated and handed to every
  tick of every frame. Read it, never retain it.
- **Pooled buffers are borrowed.** `DmxUpdatePayload.data` is on loan from
  `TypedArrayMemoryPool` and is recycled when dispatch returns. Copy to retain.
- **The event vocabulary is mirrored in UE5.** Adding an event to
  `EngineEventMap` without adding it to the desktop dispatcher breaks parity.

---

## 8. Geospatial splat pipeline (reusable, any venue)

`scripts/workflows/run_geospatial_splat_pipeline.sh` is the standardized venue
deployment workflow: ingest a capture, strip transients, georeference, register
for the runtime, verify the build.

```bash
# Point State Park, from a real capture
scripts/workflows/run_geospatial_splat_pipeline.sh \
    --venue-name "Point State Park" \
    --lat 40.4417 --long -80.0075 --elevation 220 \
    --input-scan captures/psp_raw.ply \
    --output-splat public/assets/scans/point_state_park_clean.splat

# Any future venue
scripts/workflows/run_geospatial_splat_pipeline.sh \
    --venue-name "Hart Plaza" --lat 42.3286 --long -83.0456 --elevation 180 \
    --input-scan captures/hart_plaza.ply

# No capture yet: exercise the whole path on a labelled synthetic scene
scripts/workflows/run_geospatial_splat_pipeline.sh \
    --venue-name "Point State Park" \
    --lat 40.4417 --long -80.0075 --elevation 220 --synthesize
```

| Flag | Meaning |
| --- | --- |
| `--venue-name` | Human-readable name; also produces the slug used for paths |
| `--lat` | Latitude, signed decimal degrees (north positive) |
| `--long` | Longitude, signed decimal degrees — **west is NEGATIVE** |
| `--elevation` | Site elevation in metres above **mean sea level** (orthometric) |
| `--input-scan` | Capture to ingest (`.ply` or `.splat`) |
| `--output-splat` | Cleaned binary output |
| `--geoid-separation` | Geoid height above the ellipsoid (default −33.82, Point State Park) |
| `--frame-offset` | National-datum → WGS84/ITRF frame offset (default 0.0; −1.217 for Point State Park) |
| `--detector` | `auto` \| `geometric` \| `sam2` |
| `--synthesize` | Generate a labelled synthetic capture instead of ingesting |
| `--skip-clean` / `--skip-build` | Partial runs |

### ELEVATION IS ORTHOMETRIC — the pipeline converts it

`--elevation` takes the number off the survey drawing (metres above sea level).
WGS84, Cesium and Google 3D Tiles all consume **ellipsoidal** height. The script
converts with the site's geoid separation and frame offset:

```
h_ellipsoidal = H_orthometric + N_geoid    + d_frame
184.963 m     = 220.0 m       + (−33.82 m) + (−1.217 m)   # Point State Park
```

Passing a raw MSL figure straight into a WGS84 pipeline floats the venue tens of
metres above the basemap. **Both corrections must be looked up per site.**
`--geoid-separation` ranges roughly −105 m to +85 m worldwide; the −33.82 m
default is Point State Park. `--frame-offset` defaults to **0.0** — pass it
whenever the elevation came from a national vertical datum (NAVD88 in the US is
published against NAD83, which differs from WGS84 by 1–2 m in CONUS).

### Splat clean-up on its own

```bash
python3 scripts/cleanup_splat.py --self-test           # synthetic verification
python3 scripts/cleanup_splat.py --synthesize out.splat
python3 scripts/cleanup_splat.py -i raw.ply -o clean.splat --detector auto
```

Two detectors, combined by union:

- **`geometric`** — always available, deterministic, no weights or GPU. Voxel
  connected-components classified by real-world dimensions (person / vehicle /
  barricade / floater). Carries the result today.
- **`sam2`** — Segment Anything 2 instance masks over rendered views,
  back-projected with multi-view voting. Needs `pip install sam2` and a
  checkpoint at `models/sam2/`. Contributes clean instance *boundaries* where
  geometry welds a person to the wall behind them.

Classification uses **width and length separately**, not a single footprint
number — a barricade run is thin in cross-section and arbitrarily long, so a
combined footprint cap rejects the whole line.

## 9. Modular asset library

```bash
npm run build:assets                              # build all 37 assets
node scripts/build-asset-library.js --only video  # one category
node scripts/build-asset-library.js --verify      # validate without writing
```

Generates `public/assets/models/<category>/<id>.glb` plus
`public/assets/manifest.json`. Every asset embeds `extras.sockets`, ships an
in-GLB low-poly collision hull, and is validated against the 15,000-triangle
LOD0 budget. Categories: `trussing`, `staging`, `video`, `lighting`, `audio`,
`sfx`, `site`.

These are **dimensionally accurate, visually placeholder**. Real dimensions and
socket positions are the contract (Checkpoint CP-3); triangle counts sit far
below the budget ceiling because procedural stock has no welds or grilles to
model. Manufacturer CAD hot-swaps in without re-plotting **as long as socket
ids and positions match exactly**.

## 10. GDTF fixture profiles

Real lighting fixtures come from **GDTF** (General Device Type Format,
DIN SPEC 15800:2022-02) rather than being modelled by hand. A `.gdtf` file is a
ZIP holding `description.xml` — the fixture's kinematic tree, photometric
emitter and every DMX mode a console can patch it in — plus GLB meshes under
`models/gltf/` and wheel rasters under `wheels/`.

```bash
npm run fetch:gdtf                       # sync profiles into the cache
node scripts/fetch_gdtf_library.js --verify   # check the cache, never touch the network
node scripts/fetch_gdtf_library.js --force    # re-download even if cached
```

### GDTF Share needs an account

Despite the `/apis/public/` path, `getList.php` answers **401 Unauthorized** to
an anonymous request. The fetcher logs in first, with credentials from the
environment:

```bash
GDTF_SHARE_USER=you@example.com GDTF_SHARE_PASSWORD=... npm run fetch:gdtf
```

A GDTF Share account is free, so this stays inside the $0 budget. **Without
credentials the script verifies the cache and exits 0** — a build machine has no
reason to hold vendor credentials, and an empty cache is a legitimate first-run
state. It fails only when the cache *contradicts itself* (a manifest entry whose
file is missing or whose bytes changed), because a corrupt archive fails much
further downstream, inside the parser.

The cache is **git-ignored** (§11): archives run to tens of megabytes and are
redistributable only under GDTF Share's terms.

### Coordinate systems differ — the parser converts once

GDTF is right-handed **Z-up** in metres; Three.js is **Y-up**. Every position
and matrix `GDTFParser` emits has already been converted by `gdtfToThree`
(`x, y, z → x, z, −y`). **Never re-apply the conversion downstream.**

### Rotation axes come from the tree, not from names

A GDTF `<Axis>` rotates about its **own local X** (DIN SPEC 15800 §6.4); the
node's `Position` matrix orients that axis. So the resolver rotates about X and
nothing else. Matching on geometry names (`Yoke`, `Head`) instead would break on
any fixture whose manufacturer named its parts differently.

### Flux is not intensity

GDTF publishes total luminous flux in **lumens**; a Three.js `SpotLight` wants
**candela**. `fluxToCandela` spreads the flux over the cone's solid angle:

```
omega = 2π(1 − cos(field_angle / 2))      steradians
I     = flux / omega                      candela
```

Handing the lumen figure to `intensity` directly makes a narrow-beam fixture
read as dim as a wash of the same wattage — backwards, and the single easiest
photometric mistake to make here.

### Sockets vs. kinematic references

The resolver injects **one** `extras.sockets` entry — `fixture_clamp`
(`PIPE_CLAMP_2IN`), the truss-mounting interface — in the §3 spec shape. It
carries `can_child: true`, which is what makes a fixture attachable: the engine
gates reparenting on the *moving* socket's `can_child`, and a fixture dragged
onto truss is the moving side.

The pan pivot, tilt pivot and lens emitter go under **`extras.kinematics`**, not
`extras.sockets`. Sockets are a mating vocabulary — every `socket_type` must
appear in `SOCKET_TYPES` and the engine will try to mate anything it finds
there. An internal rotation axis is not a place another asset connects, so
putting it in the socket list would invite nonsense joints.

## 11. Binaries are not committed

`.splat`, `.ply`, `.gdtf` and SAM-2 checkpoints are git-ignored. Captures are
large and regenerable; real surveys belong in release assets or an external
bucket. The synthetic splat stand-in regenerates with `--synthesize`; the GDTF
cache repopulates with `npm run fetch:gdtf`.

Neither pipeline depends on a committed binary to be verifiable. The splat
self-test builds a labelled synthetic capture, and the GDTF suite builds real
`.gdtf` archives in memory (`tests/helpers/gdtfFixture.ts`) — genuine ZIPs
holding genuine DIN SPEC 15800 XML, so the ZIP traversal, attribute names,
matrix grammar and `value/resolution` DMX grammar are all under test even
though CI cannot reach GDTF Share.

**Owner-approved exception: `public/assets/video/edm_wall_loop.mp4`.** The
rule above targets captures and archives that run to tens or hundreds of MB
and cannot reasonably live in git history; it was never a ban on every binary.
This file is ~250 KB — smaller than several committed GLBs in
`public/assets/models/` — and is itself regenerable: `npm run render:wall-loop`
rebuilds it by capturing `src/assets/VideoWallContent.ts`'s own
`createEdmLoop` renderer through one seamless loop and encoding it with
`ffmpeg`, so the committed file and the in-app procedural fallback are
provably the same art rather than two designs drifting apart. It is the
default upstage LED wall content; `VideoWallContent.ts` still falls back to
the live procedural loop if the file is stripped or 404s, so no path depends
on the binary being present.

## 12. Showcase renders

`showcase/` holds standalone, real-pipeline demo pages — no mocked data, no
stand-ins. `showcase/gdtf-fixture.html` runs the actual archive builder, the
actual `parseGDTF`, and the actual `GDTFAssetResolver` in a browser tab and
renders the result; it is not a hand-authored scene that merely looks similar.

```bash
npm run dev                                                    # serve the app
npm run showcase:capture -- --page showcase/gdtf-fixture.html  # screenshot it
```

Each showcase page sets `document.body.dataset.ready = 'true'` once its scene
has finished building (`'error'` if it threw) — `capture_showcase.mjs` waits on
that flag rather than a fixed delay, so a slow parse or a silent failure shows
up as a timeout, not a screenshot of a half-built scene.

A render surfacing a real bug is the point, not a failure of the showcase: the
straight-down beam sanity check in `tests/gdtf.test.ts` exists because this
exact page first rendered with every beam pointing sideways, which is what
found the fixed-vs-composed-quaternion bug in `GDTFAssetResolver`'s pan/tilt
drive.

## 13. AI planning and model selection

Every non-trivial AI-driven change (three or more distinct steps, or any work
that spans multiple modules) starts with a written plan. The plan is the
artifact you carry into the PR body or commit message so a reviewer can see
what was thought before it was typed. Trial-and-error tool loops burn far more
API cost than the one round of thinking that would have avoided them.

This section is deliberately **provider-agnostic**. It classifies work by the
kind of thinking a phase needs, not by any vendor's product name. Whoever
is executing — a human, or any AI coding assistant, agent CLI or
open-weight model — reads these rules the same way.

### 13.1 What every plan states

1. **Phases and steps in order.** Break the work into a small number of phases;
   list the steps in each. A step names its file(s) and the change type
   (read / edit / add / delete / verify).
2. **Tier choice per phase, with a reason.** Say which tier of model
   (§13.2) is right for that phase and why. "Default tier" is a valid
   line; the point is that a deep-reasoning choice is deliberate, not
   silent.
3. **Verification per phase.** What proves the phase is done — a test name,
   a build target, a specific tool run, an inspected artifact. A phase
   without a verification line is not planned, it is speculated.

The plan lives inline in the PR or commit body (or, for
autonomous/agent-mode work, in a task list the agent maintains). Keep it
tight: bullets, not prose. If a phase changes shape mid-work, rewrite the
plan and note why — do not silently drift.

### 13.2 Choosing the model tier per phase

Two tiers, defined by the work each is meant to do. Any provider's product
maps onto them; do not hard-code a vendor name into the plan.

- **Default tier — the fast, capable workhorse.** Whichever model in the
  current toolbelt is the fastest one that still handles routine work
  reliably. Use it for anything routine: mechanical refactors, doc edits,
  following a written plan step by step, single-file bug fixes with clear
  symptoms, adding a test that mirrors an existing one, chores, most
  glue-code and file-plumbing work.
- **Deep-reasoning tier — the slow, careful specialist.** Whichever model
  in the current toolbelt has the deepest reasoning available (typically
  the highest-cost, highest-latency option). Reserve it for phases whose
  success actually depends on that depth:
  - **Root-cause hunts where the symptom does not point at the cause.**
    (The `TMap<FString>` case-collision bug on this repo — `mass`/`Mass`/`MASS`
    all collapse silently because the underlying map's default key funcs
    hash and compare their string keys case-insensitively — was exactly
    this class.)
  - Architecture calls where two viable shapes need real trade-off analysis.
  - Cross-file refactors that require holding the whole call graph in mind.
  - Algorithms you are deriving rather than adapting from a known reference.
  - Hard-to-reverse or safety-critical code where "close enough" is not enough.

If neither list clearly fits, pick the default tier and note in the plan
why the deep-reasoning tier might be warranted if it stalls. Do not switch
mid-phase without amending the plan.

Product names (whatever this year's headline model is called for each
vendor) belong in the plan's "reason" clause at most, not in these tier
labels. When a vendor renames or reshuffles tiers, this rule stays valid;
only the mapping to concrete product names moves.

### 13.3 Cost discipline

The purpose of §13 is fewer tokens per shipped change, not more ceremony.
Two heuristics:

- **A short plan beats a long trial-and-error loop.** If you are on your
  third speculative tool call trying to figure out what a file contains,
  stop and write the plan.
- **Do not pay deep-reasoning rates for default-tier work.** Reading a
  file, running a known command, applying a named edit — none of these
  need the deeper reasoning tier. Reserve it for the reasoning-heavy
  phase and drop back down for the mechanical follow-through.

Trivial one-file, one-symptom changes are exempt — write the fix, not the
plan.

## 14. Local $0 AI memory

A per-workstation vector + graph index of this repo lives at
`.memory/`. The scripts under `scripts/memory/` build it and query it — no
servers, no paid embeddings, no committed binaries. See
`scripts/memory/README.md` for the full contract; the short version:

- **Vector store:** ChromaDB `PersistentClient` under `.memory/chroma/`,
  using its built-in ONNX embedder (`all-MiniLM-L6-v2`, ~80 MB, auto-
  downloaded on first ingest into the user's `~/.cache/chroma/`). No
  `sentence-transformers`, no `torch`.
- **Graph:** NetworkX `DiGraph` of file→file import edges, persisted as
  `.memory/graph.pickle`.
- **Storage location:** the entire `.memory/` tree is git-ignored per §11.
  Both artifacts regenerate deterministically from source. Do not commit
  either.
- **Beyond the repo tree:** `ingest.py` also walks two hardcoded, per-
  workstation Google-Drive-synced roots (`G:\My Drive\spatial-previs-engine`,
  `G:\My Drive\Spatial Previs Engine - Master Archive`) when present, tagging
  their chunks `origin: drive`. This is workstation-specific and not
  reproducible from a fresh checkout — see `scripts/memory/README.md` before
  relying on Drive-sourced results.
- **MCP server, registered.** `scripts/memory/mcp_memory_server.py` is a
  stdio JSON-RPC 2.0 server (session start/observe/note/end plus
  `vector_memory_search`/`vector_memory_graph`), persisting agent session
  state to `.agents/memory/sessions.json` (also git-ignored). Registered as
  `spatial-previs-memory` in the repo's `.mcp.json`, so any MCP-aware agent
  session opened against this repo can launch it directly.

```bash
pip install -r scripts/memory/requirements.txt
python scripts/memory/ingest.py                          # ~30 s on this repo
python scripts/memory/query.py "detent step radians"
python scripts/memory/query.py --with-neighbors "GDTF pan tilt"
```

The ingest chunks 80-line windows with 15-line overlap and upserts by a
content-hashed id so incremental re-runs stay cheap. The query prints
`path:line` citations with a cosine-distance score; `--with-neighbors` walks
one graph hop.

**What this is not:** it is retrieval, not reasoning. It surfaces relevant
chunks and lets any model or human read them. `ingest.py`/`query.py` remain
the CLI source of truth; `mcp_memory_server.py` (above) is additive MCP
wiring beside them, not a replacement — it shells into the same `query_memory()`
rather than reimplementing retrieval. Do not swap either for a paid vector
API; that would cross the §1.2 hard budget.

## 15. Local prompt-drafting tool

A project-customized fork of Anthropic's `metaprompt.ipynb` cookbook notebook
lives at `scripts/ai-tools/metaprompt.py` — no servers, no notebook, $0 beyond
a per-call Anthropic API token. See `scripts/ai-tools/README.md` for the full
contract; the short version:

- **What it does:** given a task description, drafts a full prompt template
  for it (`<Inputs>` / `<Instructions Structure>` / `<Instructions>`), then can
  test-drive the result against supplied variable values. Only the drafting
  call is provider-specific; the templates are plain text usable from any
  agent or model API.
- **Project customization:** every `draft` call prepends this file
  (`CLAUDE.md`) as fixed context by default, so a drafted template already
  respects this codebase's rules without the caller restating them. It also
  shells out to `scripts/memory/query.py --with-neighbors` (§14) for grounding
  citations, respecting that module's own CLI-not-library boundary rather than
  reaching into its internals.
- **Domain examples:** three of its five few-shot examples are swapped for
  this project's own review patterns — a GDTF flux→candela photometric check
  (§10) and an `extras.sockets` schema review (§3) both double as this
  project's canonical checklist wording; the `domain-correctness-review`
  skill (`.claude/skills/`) reuses the same checklist text rather than
  re-deriving it, so the two must not drift apart.

```bash
pip install -r scripts/ai-tools/requirements.txt
python scripts/ai-tools/metaprompt.py draft --task "review a new extras.sockets entry"
python scripts/ai-tools/metaprompt.py full --task "..." --values NAME=value
```

**What this is not:** a general-purpose chat tool — it writes reusable prompt
*templates*, not one-off answers. The `ANTHROPIC_API_KEY` it needs is never a
project file: set it once at the workstation level (`setx` on Windows) and
store the value in a password manager, matching this project's existing
`GDTF_SHARE_USER`/`PASSWORD` convention (§10). Generated drafts land in
`scripts/ai-tools/prompts/`, git-ignored per §11, the same per-workstation
pattern as `.memory/`.

## 16. Native UE5 foundation (`native/`)

`native/SpatialPrevis` is the UE5.8 project implementing the desktop side of
§1.1's parity contract — currently the **CORE-01 milestone** (import/inspect
the shared project JSON), not the full native R0 product. See
`native/README.md` and `docs/r0/UE5_CONFORMANCE.md` for exact scope.

```powershell
powershell -NoProfile -File scripts/verify-r0-native.ps1 -CoordinatesOnly
powershell -NoProfile -File scripts/verify-r0-native.ps1 -EngineRoot 'C:\Program Files\Epic Games\UE_5.8'
node scripts/test-r0-native-comparator.mjs   # comparator's own corruption tests — not native evidence
```

Requires UE5.8 and its C++ toolchain locally; these are not npm scripts.
Never commit generated Unreal binaries, caches, `.sln`/project files, or saved
evidence — source and the fixture version travel together in Git, everything
Unreal generates does not.

### The native coordinate boundary is a *different* conversion from `SITE_FRAME`

§2's ENU tangent-plane bridge (`three.x/y/z ↔ east/north/up`) governs the web
scene only. The wire boundary between the shared project JSON and UE5's
`FTransform` is a separate, already-fixed codec (`ProjectTransforms.ts` on the
web side, the C++ adapter + commandlet on the native side) — do not reuse or
hand-derive the ENU bridge for it:

| Value | Shared project JSON | UE boundary |
| --- | --- | --- |
| Axes | X east, Y up, Z south (negative north) | X north, Y east, Z up |
| Position | metres `(x, y, z)` | centimetres `(-100z, 100x, 100y)` |
| Quaternion | XYZW `(x, y, z, w)` | XYZW `(z, -x, -y, w)` |

Unchanged project JSON round-trips through this codec unnormalized — it is
not passed through Three.js renderer transforms first. `domain/R0Boundaries.test.ts`
and `domain/NativeConformance.test.ts` are the regression checks; extend those,
don't hand-verify a new conversion path.
