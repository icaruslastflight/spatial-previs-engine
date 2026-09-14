# Festival Visualizer — Project Guidelines

Browser-native spatial twin and live-event pre-visualization client for
**Point State Park, Pittsburgh, PA**. This is the *Parallel High-Capability Web
Application* line: it targets maximum browser feature parity with the Unreal
Engine 5 desktop architecture.

---

## 1. Governing rules

### 1.1 Strict Dual-Platform Parity

Every 3D feature, snapping kinematic, and protocol parser must behave
**identically** on the web client and the UE5 desktop build.

- A change to snapping tolerances, socket semantics, the site anchor, or a
  protocol parser is a **cross-platform change**. Land it on both sides or land
  it on neither.
- Where the web genuinely cannot match the desktop, say so at the point of
  divergence in a code comment and treat the desktop as authoritative. There is
  one such divergence today, documented in `src/geo/CesiumGlobe.ts`: the Cesium
  basemap and the Three.js show layer do not share a depth buffer, so show
  geometry is never occluded by basemap buildings. **Occlusion checks are
  desktop-authoritative.**
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

> **OPEN PARITY DIVERGENCE — `FIXTURE_YOKE_AXIS` socket type.** Phase 3 added
> `FIXTURE_YOKE_AXIS` to `SOCKET_TYPES` (§3, `src/engine/SocketSnappingEngine.ts`)
> so a GDTF fixture's pan/tilt articulation points ride on the same
> `extras.sockets` query mechanism as every other socket. It is a genuinely new
> capability, not a correction, and it has **not** been mirrored into the UE5
> socket vocabulary. It is deliberately inert for snapping purposes --
> `can_parent`/`can_child` are always false wherever it is emitted -- so this
> divergence cannot cause a web/desktop snapping mismatch; it can only make a
> fixture's articulation point undiscoverable to UE5 tooling that queries
> sockets. Add the type to the UE5 socket enum and delete this note.

### 1.2 $0 financial budget

This line is developed on a phone with no spend. That is a hard constraint, not
a preference.

- **Libraries:** open source only — Three.js, CesiumJS, Vite,
  `@mkkellogg/gaussian-splats-3d`.
- **Hosting:** free-tier static only — Vercel or GitHub Pages. See §5.
- **No paid API keys are assumed.** Anything needing a key must degrade
  gracefully to a keyless path. The basemap does this across three tiers (§4).
- **GDTF Share needs a free account, not a paid key** — but it still degrades
  gracefully. `getList.php`/`downloadFile.php` require a login session, not an
  anonymous GET; `scripts/fetch_gdtf_library.js` reads credentials from the
  environment and, when they are absent, prints how to register a free account
  and exits `0` rather than failing. See §11.
- **No cross-origin isolation.** Static free hosts cannot set COOP/COEP headers,
  so `sharedMemoryForWorkers` stays `false` in the splat loader. Do not turn it
  on without a host that can serve those headers.
- **No large binaries in git.** Scans go in release assets or an external bucket
  and are fetched at runtime. Git LFS bandwidth is not free.

### 1.3 Mobile touch is the primary target

The viewport is developed and operated on a phone. Every interaction must work
under touch before it is considered done.

- One finger on an asset drags it; one finger on empty space orbits; two fingers
  pinch-zoom and pan. A second finger landing mid-drag **aborts** the drag and
  hands the gesture to the camera.
- Touch targets are at least ~40 px. `touch-action: none` on the 3D canvas.
- Device pixel ratio is capped at 2 — previz is fill-rate bound and phones ship
  3x panels.

---

## 2. Site anchor — Point State Park

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
npm run fetch:gdtf  # fetch cataloged fixtures from GDTF Share (needs a free account, §11)
npm run bridge      # FOH Art-Net/sACN → WebSocket daemon (lands in Phase 4)
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
             GDTFParser.ts             GDTF (DIN SPEC 15800) XML/archive parsing + socket injection
             GDTFAssetResolver.ts      runtime index; Object3D/SpotLight fixture instantiation
  assets/    ModularPrimitives.ts      procedural F34 truss + 4x8 deck
             SplatSceneLoader.ts       manifest-driven Gaussian splat loading
             SampleGdtfProfile.ts      synthetic fixture profile, until a real one is fetched
  geo/       GeoAnchor.ts              site anchor, WGS84/ECEF/ENU, axis bridge
             CesiumGlobe.ts            basemap tiers + camera sync
             cesiumBaseUrl.ts          publishes CESIUM_BASE_URL before Cesium loads
  geospatial/PointStateParkAnchor.ts   CP-1 venue origin + landmark registration
  viewport/  DragSnapController.ts     touch drag-and-snap gesture contract
             SiteBounds.ts             GeoJSON site envelope → scene
  components/PlaytestController.ts     WASD/RMB desktop playtest rig + diagnostics HUD
             SplatViewport.ts          Gaussian splat viewer composition
  render/    (Phase 6)                 WebGPU volumetric beams, laser MPE safety
  network/   (Phase 4)                 Art-Net 4 / sACN telemetry ingest
  ui/        (Phase 2, 4, 6)           operator HUD, DMX inspector, atmosphere
  main.ts                              composition root
public/assets/scans/                   scan registry + placeholder site bounds
```

Tests sit beside the module they cover as `<Module>.test.ts`. Each of
`render/`, `network/` and `ui/` carries a `README.md` naming the phase that
fills it and the constraints that already bind it.

### Core engine invariants

- **One frame clock.** Anything per-frame registers on `EngineLoop` at a
  priority band — telemetry (0), physics (1), automation (2), render (3) —
  rather than opening its own `requestAnimationFrame`. Independent rAF
  callbacks make execution order an accident of import order.
- **`FrameTiming` is reused.** The same object is mutated and handed to every
  tick of every frame. Read it, never retain it.
- **Pooled buffers are borrowed.** `DmxUpdatePayload.channels` is on loan from
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

## 10. Binaries are not committed

`.splat`, `.ply` and SAM-2 checkpoints are git-ignored. Captures are large and
regenerable; real surveys belong in release assets or an external bucket. The
synthetic stand-in regenerates with `--synthesize`.

## 11. GDTF fixture library

`.gdtf` files (DIN SPEC 15800) describe real moving lights: DMX channel maps,
3D geometry, and photometrics, in one manufacturer-published archive.

### GDTF Share needs a free account

`scripts/fetch_gdtf_library.js` fetches cataloged profiles (Robe MegaPointe,
Martin MAC Aura, Claypaky Sharpy, GLP JDC1) from `gdtf-share.com`. Its
`getList.php`/`downloadFile.php` endpoints living under an `apis/public/` path
read as anonymous GETs at a glance, but both require a logged-in session:
`login.php` exchanges a username/password for a session cookie first. The
account is **free to register, not a paid key**, but it is still a credential
this repo cannot assume is present, so the script degrades the same way the
basemap's keyed tiers do (§1.2, §4):

```bash
GDTF_SHARE_USER=you GDTF_SHARE_PASSWORD=... npm run fetch:gdtf
node --env-file=.env.local scripts/fetch_gdtf_library.js   # Node 20.6+
```

Without credentials it prints registration instructions and exits `0` —
never fails a build over a missing free account. Fetched archives land in
`public/assets/fixtures/cache/`, git-ignored like every other binary (§10).

### File format and parsing scope

A `.gdtf` file is a ZIP: `description.xml` at its root plus 3D models under
`models/gltf/` (GLB, preferred) or `models/3ds/`. `src/engine/GDTFParser.ts`
only reads the glTF path — every Phase 3 target fixture ships one, and this
project has no 3DS importer.

`GdtfGeometryKind` gives first-class handling to `Geometry`, `Axis` and `Beam`
only — this project's target fixtures are conventional moving-head washes and
spots. Media server, laser and display geometry types still parse structurally
(the tree walks through them) but fall back to a generic `'Other'` kind rather
than guessed-at dedicated fields.

`DMXValue` attributes (`Default`, `Highlight`, `ChannelFunction.Default`) are
extracted as their raw DIN SPEC 15800 byte-mirroring strings (e.g. `"255/1"`),
not decoded to a resolved numeric level — decoding needs the channel's byte
resolution, a DMX-engine concern that lands with Phase 4, not a parsing one.

### Coordinate bridge

GDTF's `Position` matrices are right-handed, Z-up, with +Y away from the
viewer — DIN SPEC 15800's own convention, unrelated to WGS84/ENU.
`GDTFParser.gdtfSpaceToThreeSpace()` bridges this into Three's Y-up frame as a
change of basis (`P · M · P⁻¹`), so a node's rotation transforms correctly,
not just its translation. The resulting axis relationship is numerically
identical in form to `SITE_FRAME`'s ENU bridge (`GeoAnchor.ts`) — both happen
to be right-handed Z-up frames — but the two are kept as separate helpers:
this is fixture-local geometry, not geodesy, so it does not borrow
`EnuFrame`'s geodesy-specific types just because the formula matches.

### Socket injection

`GDTFParser.injectFixtureSockets()` derives a fixture's `extras.sockets`:

- One **`PIPE_CLAMP_2IN`** socket at the fixture's own local origin — the
  clamp that grips whatever truss the fixture hangs from. It reuses the
  existing pipe-clamp type rather than inventing a fixture-specific one.
- One **`FIXTURE_YOKE_AXIS`** socket per `Axis` geometry node (pan/tilt
  articulation points), positioned by composing parent transforms down the
  tree. This type never mates with anything (`can_parent`/`can_child` are
  always `false`) — see the open parity divergence note in §1.1, since it is
  a new type the UE5 socket vocabulary has not yet mirrored.

### Runtime resolver and photometrics

`src/engine/GDTFAssetResolver.ts` indexes parsed profiles by `FixtureTypeID`
and instantiates each one as a `THREE.Group` hierarchy mirroring its
`Geometries` tree exactly — pan/tilt is real scene-graph nesting, not a
flattened mesh. Without a fetched archive, every node gets a dimensionally-
scaled placeholder box: the same "dimensionally accurate, visually
placeholder" contract the procedural modular assets use (§9).

Each `Beam` node gets a `THREE.SpotLight` parameterized from the profile's
photometric attributes — the runtime equivalent of embedding
`KHR_lights_punctual` (constraint 3), since these fixtures are built
procedurally rather than round-tripped through an authored glTF:

- **Lumens → candela**: `LuminousFlux` (total output) divided by the beam
  cone's solid angle (`2π(1 − cos(halfAngle))`), since Three's physically
  correct lighting consumes candela (lm/sr), not total lumens.
- **Kelvin → RGB**: Tanner Helland's curve-fit approximation of Mitchell
  Charity's blackbody data — not a rigorous CIE calculation, which is more
  precision than a previz beam tint needs.

No fixture light casts a shadow: a build can carry a dozen-plus fixtures, and
per-light shadow maps are not affordable on the phone fill-rate budget (§1.3).

### Sample fixture

Until a real archive is cached, the **"+ Wash Fixture"** palette button
instantiates `src/assets/SampleGdtfProfile.ts` — a hand-authored two-axis
(Yoke → Head → Beam) profile run through the real `parseDescriptionXml()`
path, exactly as a fetched archive's `description.xml` would be. Same
synthetic-stand-in contract as `cleanup_splat.py --synthesize` (§8) and the
procedural modular assets (§9): exercise the real pipeline end to end rather
than shortcut around the missing real asset.
