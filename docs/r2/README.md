# R2 — Projection

**Milestone theme:** Develop projector and surface planning workflows.

Status: **Planned** (source: Living Guide v0.3, 17 September 2026)

> Desktop drives the full scope of this milestone. Web and mobile expose reliable subsets
> and provide a **Continue on desktop** handoff. Shared data semantics remain consistent.

---

## Intended user outcomes

When R2 is complete an operator can:

1. **Place and configure projectors** — add projectors to the scene from GDTF library,
   set lens type (throw ratio / focal length), assign DMX personality and universe.
2. **Define projection surfaces** — create flat, curved or irregular surfaces as
   display targets; import from Cinema 4D glTF or model directly.
3. **Calculate coverage and blending** — inspect throw distance, coverage footprint,
   keystoning correction angle, and multi-projector blend zones.
4. **Generate surface mapping documents** — produce per-projector output specs for
   media servers (disguise, Resolume, etc.).

---

## Planned feature areas

### PROJ-01 — Projector catalog entries

- GDTF-sourced projector records with throw ratio range, lens shift range, native
  resolution, lumen output and power draw.
- DMX personality for brightness, color temperature, shutter and lens servo.

### PROJ-02 — Throw calculation engine

- Compute covered area given throw distance and lens throw ratio.
- Flag when the projector falls outside its rated throw range.
- Detect surface hotspots (overlapping at >100% relative brightness).
- Export throw report as Production Paperwork PDF.

### PROJ-03 — Projection surface geometry

- Accept glTF surfaces from Cinema 4D imports (UV0 required, 0–1 normalized).
- In-engine plane, cylinder and dome primitives as projection targets.

### PROJ-04 — Multi-projector blend map

- Define blend overlap zones (edge feathering width in pixels).
- Allocate separate Art-Net universes per projector head.
- Export blend map as JSON consumable by disguise and Notch.

### PROJ-05 — Production paperwork

Extends `ProductionPaperworkEngine` to emit:

- **Projector Position Sheet**: name, model, position (m), pan/tilt, throw distance,
  screen coverage (m²), universe, DMX address.
- **Lens / Coverage Report**: throw ratio, recommended distance range, actual coverage,
  keystoning correction required.

> All generated sheets carry a **PREVIS SIMULATION — NOT AN ENGINEERING CERTIFICATE**
> disclaimer (conflict C10).

---

## Platforms affected (R2 integration targets)

| Platform | R2 touchpoint |
| :--- | :--- |
| **Capture 2026** | MVR `<Projector>` element with frustum geometry |
| **Depence R4** | Projector PBR emissive surface; DMX brightness drive |
| **wysiwyg** | Instrument schedule includes projector positions and throws |
| **Cinema 4D** | glTF surface import; C4D Python SDK texture bake export |
| **Vectorworks** | Spotlight instrument record updated with projection surface link |

---

## Release gates (proposed)

1. **Browser evidence**: Projection surface inspector passes automated Playwright scenarios.
2. **Native gate**: UE5 R2 build renders correct projector throw volumes with live DMX.
3. **Device review**: Android acceptance by owner (Brice Morneau).

---

## Open questions / deferred scope

- **PROJ-DQ-01**: Photometric overlap calculations remain `not_evaluated` until optical
  specialist review (conflict C10).
- **PROJ-DQ-02**: Keystoning correction values are planning aids; physical alignment
  authority remains with the on-site projectionist.

---

*Source: Living Guide v0.3 (17 Sept 2026). Planning intent, not committed dates.*
