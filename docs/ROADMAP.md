# Spatial Previs Engine — Milestone Roadmap

> Source of truth: **Living Guide v0.3**, 17 September 2026.
> `G:\My Drive\spatial-previs-engine\Spatial_Previs_Living_Guide.docx`
>
> Desktop drives the full scope of each milestone. Web and mobile expose reliable
> subsets, label feature availability and provide a **Continue on desktop** handoff.
> Shared data semantics (IDs, units, coordinates, relationships) remain consistent
> across platforms. No committed delivery dates.

---

## Milestone table

| Release | Name | Intended user outcome | Status | Docs |
| :--- | :--- | :--- | :--- | :--- |
| **R0** | Foundation | Place and relate equipment, preserve edits, inspect data and exchange project evidence. | ✅ **Complete** (17 Sept 2026) | [`docs/r0/`](r0/README.md) |
| **R1** | LED | Describe LED layouts, map content and prepare output packing. | 🔵 **Planned** | [`docs/r1/`](r1/README.md) |
| **R2** | Projection | Develop projector and surface planning workflows. | 🔵 **Planned** | [`docs/r2/`](r2/README.md) |
| **R3** | Audio | Develop audio system planning and specialist evaluation workflows. | 🔵 **Planned** | [`docs/r3/`](r3/README.md) |
| **R4** | Laser | Develop laser planning and specialist review workflows. | 🔵 **Planned** | [`docs/r4/`](r4/README.md) |
| **R5** | Operations | Develop inventory reservations, crew packs and operational handoff. | 🔵 **Planned** | [`docs/r5/`](r5/README.md) |

---

## R0 — Foundation (complete)

**R0 acceptance gates (all closed 17 September 2026):**
1. ✅ Production browser acceptance — 23 scenarios, Chromium 153 headless + phone emulation.
2. ✅ UE5 native conformance — 292 CORE-01 + 26 syntax + 62 workspace parse + 10 scenario steps on UE 5.8.2 / Windows 11.
3. ✅ Android device + owner sign-off by Brice Morneau.

Full details: [`docs/r0/VERIFICATION.md`](r0/VERIFICATION.md)

---

## R1 — LED (planned next)

**Theme:** Describe LED layouts, map content, and prepare output packing.

Key deliverables:
- LED surface catalog (GDTF-sourced pitch, resolution, power)
- Map workspace Video / Pixel Mapping editor mode
- Art-Net / sACN universe allocation
- Video Raster Sheet production paperwork
- MVR export with `<VideoScreen>` layers for Capture, Depence, wysiwyg

See [`docs/r1/README.md`](r1/README.md) for full feature and gate definitions.

---

## R2 — Projection (planned)

**Theme:** Projector placement, throw calculation, coverage mapping.

Key deliverables:
- GDTF projector catalog (throw ratio, lens shift, lumens)
- Throw distance and coverage footprint engine
- Multi-projector blend map export (disguise, Notch)
- Projector Position Sheet production paperwork

See [`docs/r2/README.md`](r2/README.md).

---

## R3 — Audio (planned)

**Theme:** Line array and fill speaker placement, coverage model, signal routing.

Key deliverables:
- Speaker catalog (dispersion, SPL, rigging config)
- Per-frequency SPL heatmap (simulation, not engineering approval)
- Amp rack schedule and wiring diagram
- Delay alignment sheet

See [`docs/r3/README.md`](r3/README.md).

---

## R4 — Laser (planned)

**Theme:** Laser planning and LSO (Laser Safety Officer) review workflows.

Key deliverables:
- IEC 60825-1 laser fixture catalog
- NOHD / MPE calculation engine (simulation only — requires LSO review)
- Interlock chain records and pre-show safety checklist
- MPE Zone Map export (SVG)

> ⚠️ All laser outputs carry a mandatory disclaimer: **SIMULATION ONLY — REQUIRES
> IEC 60825-1 LSO REVIEW BEFORE ANY PHYSICAL OPERATION.**

See [`docs/r4/README.md`](r4/README.md).

---

## R5 — Operations (planned)

**Theme:** Inventory, reservations, crew packs and full show package handoff.

Key deliverables:
- Owned equipment inventory with branch/warehouse stock tracking (INV-01/02)
- Location-based rental discovery with supplier links (RENT-01, information only)
- Crew pack generation (rigger, lighting, video, audio, laser)
- Full show package export: all R0–R4 paperwork consolidated
- Live console integration bridge: Art-Net/sACN, ChamSys Remote Protocol, Titan Web API

See [`docs/r5/README.md`](r5/README.md).

---

## Deferred backlog (no release assigned)

| ID | Feature | Source |
| :--- | :--- | :--- |
| ENV-01 | Pre-made venue environment templates (small, arena, theatre, festival, wooded) | `01_PROJECT_CONTEXT.md` |
| AI-03 | Reference-based stage generation from sketches / drawings | `01_PROJECT_CONTEXT.md` |
| INV-01/02 | Owned equipment tracking (moved to R5 scope) | `01_PROJECT_CONTEXT.md` |
| RENT-01 | Rental sourcing (moved to R5 scope) | `01_PROJECT_CONTEXT.md` |

---

## Cross-platform interoperability

The full industry interoperability and document creation specification is at:

[`docs/r0/INDUSTRY_INTEROPERABILITY_AND_DOCUMENT_CREATION_SPEC.md`](r0/INDUSTRY_INTEROPERABILITY_AND_DOCUMENT_CREATION_SPEC.md)

Covers: Capture, ChamSys MagicQ, Syncronorm Depence R4, Vectorworks Spotlight,
Avolites Titan, CAST wysiwyg, and Maxon Cinema 4D.

---

*Roadmap sourced from Living Guide v0.3 (17 September 2026). All milestones beyond R0
are planned scope with no committed delivery dates. Safety-critical calculations
(structural, electrical, optical, acoustic, laser) remain `not_evaluated` in all
milestones until reviewed by qualified domain specialists.*
