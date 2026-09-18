# R2 — Projection

**Milestone theme:** Develop projector and surface planning workflows.

Status: **Planned** (source: Living Guide v0.3, 17 September 2026)

> Desktop drives the full scope of this milestone.
> **The goal of R2 is not to produce a pretty render of a projection rig.
> It is to eliminate the gap between the planning conversation and the show file —
> so that every decision made in pre-production is automatically available to the
> video director, media server operator, and lighting designer without re-entry.**

---

## The problem this solves

In current production practice the projection workflow typically looks like this:

1. LD places a projector symbol in a lighting CAD file.
2. Video director independently models the surface in their media server.
3. The throw distance is calculated separately in a browser tool.
4. The media server operator re-enters positions and throw data from printouts on site.
5. Keystoning and blend zones are discovered and corrected during load-in.
6. The LD and video director discover conflicts (a light hits the projection surface,
   a performer enters the beam path) only during rehearsal.

**R2 collapses this into a single shared planning record.** When the projector moves,
the throw recalculates. When a blend zone widens, the power budget updates. When the
surface is confirmed, the media server handoff file is already done.

---

## Intended user outcomes

When R2 is complete an operator can:

1. **Spec and place projectors** — select from a GDTF library with real manufacturer
   data, position in the shared 3D scene and immediately see throw, coverage and keystone
   correction angle without leaving the app.
2. **Detect real problems early** — automated checks flag: projector out of rated throw
   range, surface receiving less than target lumens, adjacent light fixtures washing out
   the projection surface, blend zones insufficient for the gap between heads.
3. **Define content canvases** — map a 2D content coordinate space onto 3D surfaces so
   the video director knows exactly what pixel dimensions to work in and what the aspect
   ratio is across a multi-projector blend.
4. **Hand off to any media server with zero re-entry** — export the exact file format
   each platform expects; the operator imports it and their geometry is already done.
5. **Rehearse the show before load-in** — drive the projection rig live from the SPE
   MCP gateway during a virtual production walkthrough before the truck arrives.

---

## Planned feature areas

### PROJ-01 — Projector catalog (GDTF-sourced)

- Manufacturer, model, throw ratio range (min/max), zoom range, lens shift range (H/V).
- Native resolution (W×H px), aspect ratio, max lumens, ANSI contrast.
- Power draw (W), power factor, weight (kg), DMX personality (brightness, zoom, shutter,
  color wheel, lens servo if motorised).
- Supported configurations: single-chip DLP, 3-chip DLP, LCD, LCoS, laser phosphor.
- Manufacturers catalogued: Christie, Barco, Panasonic, Sony, NEC, Epson, Digital
  Projection, Optoma.

### PROJ-02 — Automated throw calculation engine

Every projector placed in the scene continuously computes:

```
throw_distance (m) = lens_throw_ratio × screen_width (m)
coverage_width  (m) = throw_distance / throw_ratio_min
coverage_height (m) = coverage_width / aspect_ratio
horizontal_angle (°) = 2 × arctan(screen_width  / (2 × throw_distance))
vertical_angle   (°) = 2 × arctan(screen_height / (2 × throw_distance))
keystone_correction (°) = arcsin(vertical_offset / throw_distance)
lux_at_surface (lx)  = lumens / (coverage_width × coverage_height)
```

**Automated flags (surfaced as project-level check results):**
- `THROW_OUT_OF_RANGE` — projector is closer or further than its rated lens range.
- `KEYSTONE_EXCEEDS_LIMIT` — correction angle exceeds the projector's rated max
  (typically 15° V / 10° H); flag recommends lens shift or physical repositioning.
- `BELOW_TARGET_LUMENS` — computed lux at surface is below the operator-set target
  (default 800 lx for a dark venue; 2000 lx for a bright/daylight show).
- `SURFACE_LIGHT_SPILL` — a lighting fixture in the shared scene has a beam cone that
  intersects the projection surface; flags which fixture and the intensity at surface.
  This is the cross-discipline check that no visualizer currently does.

### PROJ-03 — Surface geometry and content canvas

**Surface types:**
- Flat plane (width × height, m) — with or without perforation (acoustically transparent)
- Cylinder (radius × height, arc angle)
- Dome (radius, azimuth/elevation range)
- Irregular mesh — imported from Cinema 4D or TouchDesigner as glTF 2.0 (UV0 required)

**Content canvas (the video director's view):**
- Each surface has a **native canvas resolution** (W×H px) defined by total projected
  pixel area at target lux.
- Multi-projector surfaces define a **unified canvas** that spans all heads:
  total canvas W = sum of non-overlapping coverage widths (minus blend zone overlap).
- The canvas is exported as a reference PNG (background-free, grid overlay) at the
  correct aspect ratio — the video director opens this in their compositing tool and
  works at pixel-perfect scale.
- Blend zone width (px) is calculated and shown as a guide overlay on the canvas.

**Why this matters:** The video director currently has to guess aspect ratios or measure
on site. SPE gives them the exact canvas before anyone travels.

### PROJ-04 — Multi-projector blend planning

- Define overlap between adjacent projectors (edge feather width in pixels and metres).
- Detect when the overlap zone is smaller than the minimum required for a soft blend
  (typically ≥ 10% of frame width).
- Generate **blend mask SVGs** (soft-edge alpha ramp per projector) exportable to:
  - Resolume Arena slice mask
  - MadMapper surface mask
  - WATCHOUT edge blend warp
  - 7thSense Delta MPCDI alpha maps
  - Hippotizer SHAPE blend mask

### PROJ-05 — Cross-discipline conflict checks

These are the checks that take SPE beyond a visualizer:

| Check | What it detects | Disciplines involved |
| :--- | :--- | :--- |
| **Light-on-surface spill** | A lighting fixture's beam cone intersects the projection surface at > threshold lux | LD + VD |
| **Performer path intersection** | A performer tracking zone passes through a projection beam (blocking or occlusion) | VD + Director |
| **Rigging conflict** | A truss or I-beam sits within the projector frustum, causing a shadow | TD + LD |
| **Cable run conflict** | A proposed cable route crosses a projection throw path at floor level | TD |
| **Power phase overload** | Adding the projector load pushes a circuit above the NEC 80% threshold | TD + Electrician |

Each check produces a **named, revisionable result** in the project graph — the same
evidence model as R0's `Check recorded data`. Passing a check at revision 4 is not
evidence that it passed at revision 12.

### PROJ-06 — Production paperwork

Extends `ProductionPaperworkEngine` to emit:

- **Projector Position Sheet**: name, model, position (m), pan/tilt/roll, throw distance,
  screen coverage (m²), computed lux, keystone correction, universe, DMX address.
- **Lens Selection Report**: throw ratio required, recommended lens (from manufacturer
  database), distance range (rated min/max at that lens), rated vs computed lux.
- **Blend Zone Map**: per-projector edge feather widths (px and m), SVG diagram.
- **Content Canvas Reference**: per-surface total canvas resolution, aspect ratio,
  blend zone px guides, reference PNG.
- **Multi-Projector Power Summary**: projector count, total kW, phase assignment,
  circuit recommendations.

> All sheets carry: **PREVIS SIMULATION — NOT AN ENGINEERING CERTIFICATE.**
> Photometric, structural and electrical values require specialist review (C10).

---

## Media server integration — mapping expectations by platform

### Resolume Arena

**What operators currently do:** Place projectors on stage, guess throw in a browser
calculator, manually enter coverage dimensions into Resolume slices, discover keystoning
on site.

**What SPE changes:** Exports a Resolume **Output slice file** with pre-computed
coverage, resolution and aspect ratio. The operator imports it and the slice geometry
matches the physical throw. Blend zone widths are embedded as edge-feather percentages.

**Unique Resolume integration — surface-driven FFGL:**
- SPE exports the content canvas as a Resolume **composition template** at the correct
  output resolution, so the operator opens it and the composition aspect ratio is already
  set. No more "guess the canvas size" during pre-production.
- FFGL sources (Notch Blocks, TouchDesigner Syphon/Spout) load as layers inside this
  pre-sized composition.

```
resolume_projection_package/
  output_slices.rpp          — Resolume projection slice file
  composition_template.avc   — Pre-sized composition at canvas resolution
  blend_masks/               — Per-projector SVG edge blend guides
  canvas_reference.png       — For VD content creation reference
```

---

### MadMapper

**Unique MadMapper strength:** Mesh warping and surface geometry editing directly on
import — operators can refine SPE's geometry on site without re-patching.

**What SPE exports:**
- **Surface mesh** as an OBJ file for import as a MadMapper 3D surface.
- **Projector position** as a MadMapper **projector object** (camera frustum).
- **Pixel UV map** baked into the OBJ so content applies correctly without additional
  warping steps for flat surfaces.
- **Blend mask** as a PNG alpha map applied per-projector in MadMapper's Output section.

**Advanced — MadMapper AI Surface Detection (2024+):**
MadMapper's AI-assisted surface detection can refine the SPE-provided mesh using a
live camera feed during load-in. SPE provides the starting geometry; MadMapper corrects
it. The operator then exports the corrected mesh back to SPE as a glTF update for
documentation.

```
madmapper_projection_package/
  surfaces.obj               — Surface geometry with UV0
  projectors.mmproj          — MadMapper projector setup file
  blend_masks/               — Per-projector PNG alpha blend maps
  canvas_reference.png
```

---

### TouchDesigner

**Unique TouchDesigner strength:** Generative and interactive content; SPE provides the
physical geometry that makes generative content spatially accurate.

**What SPE exports:**
- `throw_geometry.json` — per-projector frustum matrix (4×4 transform) that TD uses
  to set up Camera COMP nodes matching the physical projectors.
- `surface_mesh.glb` — the projection surface as a glTF for import into TD's `SOP`
  network via the `FBX SOP` or `GLTF SOP`.
- **Live position stream** — SPE MCP gateway (`previs/getSceneGraph`) provides projector
  positions at 30 Hz via a TD `Web Client DAT`, so generative content responds in
  real time when the operator adjusts throw in SPE.

**Unique cross-tool capability — interactive pre-production rehearsal:**
The video director opens TouchDesigner with the SPE-sourced frustum matrices and can
run a full content rehearsal against the accurate projection geometry — before the
projectors are physically hung. Content decisions are grounded in real geometry, not
guesses.

---

### Notch (via host server)

**Integration pattern:** Notch Block renders generative content; host server (disguise,
PIXERA) applies SPE's geometry to map it.

**SPE's role:**
- Provides `projection_surfaces.mvr` with accurate surface dimensions and projector
  positions.
- Exposes Notch-controllable parameters via the MCP gateway as OSC addresses:
  `/notch/{block_id}/param/{name}` — the LD or video director can map these to DMX
  faders from the lighting console for a unified control surface.

**Why this matters:** The projection surface and the Notch content are designed in the
same coordinate space. SPE is the shared truth that keeps them aligned.

---

### Dataton WATCHOUT

**Integration role:** Multi-display show control with timeline-based cue management;
widely used for corporate, theatre and broadcast.

**What WATCHOUT needs:** A virtual stage (canvas) with display outputs placed on it.
SPE exports this as a WATCHOUT **Stage XML** file.

**Unique WATCHOUT integration:**
- WATCHOUT's "one giant canvas" architecture maps perfectly to SPE's content canvas
  model — one canvas per projection surface, with projector outputs defined as display
  nodes.
- SPE exports the physical distance between projector display nodes, which WATCHOUT uses
  for frame-accurate synchronisation between heads.
- MPCDI blend warp data exported from SPE feeds directly into WATCHOUT via Scalable
  Display Technologies integration.
- WATCHOUT accepts Art-Net and OSC for cue triggering — SPE's MCP gateway
  (`previs/triggerDMXCue`) can fire WATCHOUT timeline cues during a virtual walkthrough.

```
watchout_projection_package/
  stage.xml                  — WATCHOUT stage layout (projector display nodes)
  mpcdi_blend/               — MPCDI v2 .xml + GeometryWarpFile + AlphaMap per output
  canvas_reference.png
  artnet_cue_map.json        — DMX universe/channel to WATCHOUT cue mapping
```

---

### Green Hippo Hippotizer (SHAPE)

**Integration role:** Mid-tier media server with SHAPE 3D toolset for projection mapping;
common in touring and theatre.

**What SPE provides to Hippotizer SHAPE:**
- Projection surface as a UV-mapped 3D mesh (OBJ + MTL) for import into SHAPE.
- Projector positions as SHAPE `Camera` objects (frustum + throw).
- SHAPE can then simulate brightness and coverage from multiple viewer perspectives —
  using SPE's geometry as the ground truth.
- Blend mask PNGs per projector for SHAPE's edge blend layer.

**Art-Net / DMX integration:**
SPE's universe allocation feeds directly into Hippotizer's DMX Component configuration
(Net, Sub-Net, Universe per projector). The Auto Patch utility in Hippotizer reads the
universe map directly from SPE's patch export.

```
hippotizer_projection_package/
  shape_surfaces.obj          — SHAPE-compatible mesh
  shape_cameras.json          — Projector frustum positions for SHAPE camera setup
  dmx_autopatch.csv           — Net, subnet, universe, start_channel per projector
  blend_masks/
```

---

### disguise (Mapping Matter + Designer)

**Unique disguise strength:** Tier-1 large-scale touring; Mapping Matter provides
photometric 3D simulation that mirrors SPE's throw engine.

**Workflow:**
1. SPE exports MVR with `<Projector>` elements and surface geometry.
2. **Mapping Matter** imports the MVR for brightness simulation and clash checking
   — this is now the standard pre-production tool for disguise-based projection design.
3. Confirmed geometry flows into disguise Designer as **Feed Maps** (video texture
   to screen) using the VFC output configuration.
4. SPE's cross-discipline conflict checks (light-on-surface, cable conflict) complement
   Mapping Matter's purely photometric model.

**What SPE provides:**
```
disguise_projection_package/
  scene.mvr                  — MVR with Projector + VideoScreen layers
  mapping_matter_import.json — Mapping Matter-compatible projection spec
  feed_map_config.json       — d3 Feed Map assignments per surface
  blend_masks/
```

---

### 7thSense Delta (MPCDI)

**Integration role:** High-specification media server for large-scale fixed installs,
planetariums, simulation, and prestige touring.

**What 7thSense Delta needs:** MPCDI v2 files (geometry warp + alpha blend) and a
stage layout.

**SPE exports:**
- MPCDI v2 package: `GeometryWarpFile~g-1...g-N` and `AlphaMap~g-1...g-N` per
  projector output channel, named to 7thSense's expected convention
  (`C:\AutoAlignment\MPCDI` on the Delta server).
- DeltaGUI channel assignment sheet (PDF): lists which MPCDI region matches which
  Delta output channel — the operator maps these in DeltaGUI without guesswork.

```
7thsense_projection_package/
  mpcdi_v2/
    GeometryWarpFile~g-1.pfm
    GeometryWarpFile~g-2.pfm
    AlphaMap~g-1.png
    AlphaMap~g-2.png
    projection.mpcdi
  delta_channel_assignment.pdf
```

---

## Content canvas system — the video director's tool

The content canvas is the most unique usability feature in R2. It replaces the
"figure it out on site" approach with a pre-production deliverable.

### What it produces

For every projection surface in the scene, SPE generates:

```
canvas_reference/
  surface_{id}_canvas_reference.png    — Exact canvas at correct px resolution,
                                         with blend zone guides and projector labels
  surface_{id}_content_brief.pdf       — One-pager: canvas resolution, aspect ratio,
                                         blend zone widths (px), lux at surface,
                                         projector model, distance, key checks (pass/fail)
```

### Why this is important

The content brief is what SPE gives the **video director and content creator**. It is not
a technical document — it is a creative brief grounded in physics. The content creator
knows exactly:
- What canvas size to work in (not a guess)
- Where the blend zones are (not discovered on site)
- Whether the show is inside / outside / mixed (lux target)
- Which projectors are stacked vs. blended (layout)

This replaces hours of production meetings and back-and-forth email with a single file
exported from the same tool that generated the throw calculation.

---

## Release gates (proposed)

1. **Browser evidence**: Projector placement, throw calculation, surface conflict check
   and canvas reference export pass automated Playwright scenarios.
2. **Native gate**: UE5 R2 build renders correct projector frustum volumes and
   cross-discipline spill detection with live DMX-driven brightness.
3. **Device review**: Android acceptance by owner (Brice Morneau).

---

## Open questions / deferred scope

| ID | Item |
| :--- | :--- |
| **PROJ-DQ-01** | Photometric lux calculations are planning aids — not engineering certificates. Physical calibration authority remains with Christie Mystique, Scalable Atlas or the on-site projectionist (C10). |
| **PROJ-DQ-02** | Keystoning correction values are planning input only. Actual geometric correction is performed in the media server or projector lens shift, not by SPE. |
| **PROJ-DQ-03** | Mapping Matter integration — API for programmatic import of projection specs is not publicly documented; MVR export is the tested path (C11). |
| **PROJ-DQ-04** | MadMapper AI surface detection reverse-export (corrected mesh back to SPE) is an aspirational workflow; the import path from MadMapper to SPE is not yet specified. |
| **PROJ-DQ-05** | Performer path intersection requires a tracking data source (e.g., Blacktrax, d&b Soundscape). The tracking input protocol is deferred to R5 operations. |

---

*Sources: Living Guide v0.3 (17 Sept 2026); web research on Resolume Arena, MadMapper,
TouchDesigner, Notch, Dataton WATCHOUT v7, Green Hippo Hippotizer SHAPE, disguise
Mapping Matter, 7thSense Delta MPCDI workflow, Christie Mystique, Scalable Display
Technologies, Pixelwix (September 2026). Planning intent, not committed dates.*
