# R1 — LED

**Milestone theme:** Describe LED layouts, map content and prepare output packing.

Status: **Planned** (source: Living Guide v0.3, 17 September 2026)

> Desktop drives the full scope of this milestone. Web and mobile expose reliable subsets,
> label feature availability and provide a **Continue on desktop** handoff.
> Shared data semantics remain consistent while desktop features can advance independently.

---

## Intended user outcomes

When R1 is complete an operator can:

1. **Describe LED layouts** — define display surfaces (curved, flat, cylindrical), assign
   cabinet dimensions, pixel pitch, native raster resolution and panel manufacturer data
   sourced from GDTF records.
2. **Map content** — assign video source routing (media server, streaming input, test
   pattern) to each surface. Record the mapping in the project graph as a first-class
   connection, not a free-text annotation.
3. **Prepare output packing** — produce per-surface pixel maps, LED processor channel
   allocations and DMX / Art-Net / sACN universe assignments for handoff to disguise,
   Resolume, Notch or Megapixel VR HELIOS.

---

## Scope inherited from R0

All R0 capabilities remain unchanged through R1. R1 adds to R0 without replacing it.

---

## Planned feature areas

### LED-01 — Surface catalog entries

- New `video` asset category with accurate panel dimensions and `extras.sockets` mounting points.
- GDTF-sourced display surface nodes: pixel pitch (mm), native resolution (W×H px),
  physical tile size (m), power draw (W/m²).
- Curved and cylindrical surface geometry generated from radius + arc parameters.

### LED-02 — Content mapping workspace (Map context, R1 extension)

The Map workspace gains a dedicated **Video / Pixel Mapping** editor mode:

- Select a display surface to open its raster inspector.
- Assign a source: media server port, test pattern (SMPTE bars, pixel grid, RGB sweep,
  EDM loop), or live Art-Net / sACN pixel feed.
- Preview the mapping in the viewport with real-time UV overlay.
- Record the mapping as a `video` domain connection in the project graph.

### LED-03 — Output packing and universe allocation

- Declare LED processor type (disguise, Megapixel VR, Brompton) and port count.
- Pack surface rasters into processor output channels respecting port width limits.
- Allocate Art-Net / sACN universes (512 channels each) and generate a universe map.
- Detect and flag over-allocation.

### LED-04 — Production paperwork — Video Raster Sheet

Extends `ProductionPaperworkEngine` to emit:

- **Video Raster Sheet**: surface name, manufacturer, pitch, native resolution,
  physical area (m²), cabinet count, total pixel count, required Art-Net universes,
  data port count (1 GbE), DMX pixel patch.
- **LED Processor Assignment Table**: processor name/model, source inputs, output channels, universe base.

> All generated sheets carry a **PREVIS SIMULATION — NOT AN ENGINEERING CERTIFICATE**
> disclaimer per conflict register rule C10.

---

## Platforms affected (R1 integration targets)

| Platform | R1 touchpoint |
| :--- | :--- |
| **Capture 2026** | MVR export includes `<VideoScreen>` geometry layer; CITP media thumbnail |
| **Depence R4** | MVR surfaces exported as OBJ/glTF with emissive PBR material slot |
| **Avolites Titan** | Synergy pixel-map discovery; surface UUIDs via Titan Web API |
| **MagicQ** | DMX pixel patch CSV appended to MagicQ Patch Import export |
| **wysiwyg** | MVR layer `Video Walls` included; validated via `mvr-reader.com` |
| **Cinema 4D** | glTF 2.0 export with UV0 unwrap 0→1 on all display surfaces |

---

## Release gates (proposed)

1. **Browser evidence**: Map workspace Video / Pixel Mapping mode passes automated Playwright scenarios.
2. **Native gate**: UE5 R1 build displays LED surfaces with live Art-Net pixel feed.
3. **Device and visual review**: Android acceptance by owner (Brice Morneau).

---

## Open questions / deferred scope

- **LED-DQ-01**: Electrical load calculations remain `not_evaluated` until specialist review.
- **LED-DQ-02**: Megapixel VR HELIOS endpoints unverified (conflict C11).
- **ENV-01**: Pre-made environment templates deferred, no release assigned.
- **INV-01 / INV-02**: Equipment inventory and owned gear tracking deferred to R5+.

---

*Source: Living Guide v0.3 (17 Sept 2026), `G:\My Drive\spatial-previs-engine\Spatial_Previs_Living_Guide.docx`.
Implementation scope and gate definitions are proposed planning intent, not committed dates.*
