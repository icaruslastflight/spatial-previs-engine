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
Height      186.0 m           →  WGS84 ellipsoidal
```

Defined once as `POINT_STATE_PARK` in `src/geo/GeoAnchor.ts`. **Never re-declare
these numbers anywhere else** — import the constant.

- Longitude is always stored **signed**. Pittsburgh is negative. A positive
  80.0075 puts the site in Central Asia.
- Height is **ellipsoidal**, not orthometric. The Point sits at roughly 216 m
  MSL; the EGM96 geoid separation for western Pennsylvania is about −33 m, hence
  ~186 m ellipsoidal.

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
glTF `extras` convention so web and UE5 read the same asset file.

```jsonc
{
  "extras": {
    "sockets": [
      {
        "socket_id": "end_a_top_near",   // unique within the asset
        "socket_type": "truss_f34_chord", // must be in the shared catalogue
        "gender": "male",                 // "male" | "female" | "neutral"
        "position": [1.0, 0.145, 0.145],  // LOCAL space, meters
        "normal":   [1.0, 0.0, 0.0],      // LOCAL, points OUTWARD from the face
        "up":       [0.0, 1.0, 1.0],      // LOCAL, roll reference
        "tags": ["end_a", "top_near"],    // optional
        "load_rating_kg": 750             // optional, advisory
      }
    ]
  }
}
```

### Field rules

- **`normal`** points *outward* from the mating face. Two sockets mate when
  their normals are **anti-parallel**.
- **`up`** resolves the remaining roll degree of freedom. It need not be exactly
  perpendicular to `normal` — it is Gram-Schmidt orthogonalized on registration
  — but it must not be *parallel* to it, or the socket is rejected.
- **`up` must encode angular position for radially-arrayed sockets.** On the
  F34 truss the four chord sockets point their `up` vectors **radially outward
  toward their own chord**. Giving all four a shared `up` of `(0,1,0)` is a bug:
  it aligns the mated pair and leaves the other three chords crossed by up to
  17 mm. Covered by a regression check in the test suite.
- **`gender`:** `male` mates only with `female`. `neutral` mates only with
  `neutral` — coffin locks are hermaphroditic, so they are `neutral`.
- **`socket_type`** must appear in `SOCKET_TYPES`. Unknown types are rejected at
  registration with a warning, never silently ignored.

### glTF round-trip caveat

Three's `GLTFLoader` flattens a node's `extras` straight onto `userData` via
`Object.assign`, so `extras.sockets` in the file arrives as `userData.sockets`,
not `userData.extras.sockets`. `readSockets()` accepts **both** shapes. Assets
authored in this codebase write the literal spec shape.

### Snapping tolerances — mirrored in UE5

| Constant | Value | Meaning |
| --- | --- | --- |
| `SNAP_THRESHOLD_METERS` | **0.15 m** | Magnetic capture radius between socket origins |
| `DETENT_STEP_RADIANS` | **π/2 (90°)** | Roll quantizes to 0° / 90° / 180° / 270° |

**Detent semantics (easy to get backwards):** rotate by the *small correction*
`rawAngle − round(rawAngle / 90°) × 90°`, which drives the joint **onto** the
nearest detent. Rotating *by* the quantized angle instead leaves up to 45° of
residual error. There is a regression check for this.

---

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
npm test            # geodetic + socket snapping regression checks
```

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
  engine/    SocketSnappingEngine.ts   socket contract, proximity, detents, linking
             SocketSnappingEngine.test.ts
  assets/    ModularPrimitives.ts      procedural F34 truss + 4x8 deck
             SplatSceneLoader.ts       manifest-driven Gaussian splat loading
  geo/       GeoAnchor.ts              site anchor, WGS84/ECEF/ENU, axis bridge
             CesiumGlobe.ts            basemap tiers + camera sync
             cesiumBaseUrl.ts          publishes CESIUM_BASE_URL before Cesium loads
  viewport/  DragSnapController.ts     touch drag-and-snap gesture contract
             SiteBounds.ts             GeoJSON site envelope → scene
  main.ts                              composition root
public/assets/scans/                   scan registry + placeholder site bounds
```
