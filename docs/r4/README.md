# R4 — Laser

**Milestone theme:** Develop laser planning and specialist review workflows.

Status: **Planned** (source: Living Guide v0.3, 17 September 2026)

> Desktop drives the full scope of this milestone. Laser safety calculations carry
> additional gating: they remain **not_evaluated** until reviewed by a qualified
> laser safety officer per IEC 60825-1 / EN 60825-1. No simulation output authorizes
> physical laser operation.

---

## Intended user outcomes

When R4 is complete an operator can:

1. **Place laser projectors** — add classified laser fixtures (Class 3B, 4) from a
   GDTF library with wavelength, beam divergence, aperture and peak power data.
2. **Compute MPE zones** — calculate Nominal Ocular Hazard Distance (NOHD) and
   Maximum Permissible Exposure (MPE) for each beam.
3. **Document audience scan zones** — record scan safety zones (EN 60825-1 Annex B)
   and exclusion radii.
4. **Prepare laser show documentation** — generate a pre-show safety checklist and
   variance application data for submission to a Laser Safety Officer (LSO).

---

## Planned feature areas

### LASER-01 — Laser fixture catalog

- IEC 60825-1 class, wavelength (nm), beam divergence (mrad), aperture (mm),
  peak power (W), pulse duration, repetition rate.
- GDTF DMX personality for XY scanner, color, zoom, shutter/interlock.
- Pangolin BEYOND / Lasergraph DSP protocol markers (via Depence R4 integration).

### LASER-02 — MPE / NOHD calculation engine (simulation, not approval)

Implements EN 60825-1 §4 formulas:

```
NOHD = sqrt(Φ / (π × MPE)) / θ_divergence
```

- Per-beam NOHD, MPE irradiance threshold, protected zone radius.
- Audience scan zone flagging (beam within 3 m of grade during scan).
- All values marked as `simulation` / `not_evaluated` pending LSO sign-off.

### LASER-03 — Interlock and show control records

- Record interlock chain: E-stop → laser controller → projector.
- DMX cue integration: flag cues that activate audience-scanning beams.
- Export interlock diagram as a pre-show safety checklist.

### LASER-04 — Production paperwork

Extends `ProductionPaperworkEngine` to emit:

- **Laser Projector Schedule**: name, class, wavelength, power, position, NOHD (simulated).
- **MPE Zone Map**: per-fixture hazard radii overlay (SVG export for crew briefing).
- **Pre-Show Safety Checklist**: interlock test steps, LSO sign-off fields.

> All laser calculations carry: **SIMULATION ONLY — REQUIRES IEC 60825-1 LSO REVIEW
> BEFORE ANY PHYSICAL OPERATION** (conflict C10).

---

## Key source references (Drive)

- [S13 — WebGPU Volumetric Beam and Laser Safety Spec](https://drive.google.com/file/d/1AZv5V0fQYemuoivoZLWZyGB82Fr78Aa5/view)
- [S21 — Class 4 Laser Safety and MPE Compliance Manual](https://docs.google.com/document/d/1RXFU7jP5WDjqScQ_P4TyKbiRT3g8CxiZD0PilHDPXys/edit)

---

## Platforms affected (R4 integration targets)

| Platform | R4 touchpoint |
| :--- | :--- |
| **Depence R4** | Laser beam simulation with Pangolin BEYOND / Lasergraph DSP drive |
| **Capture 2026** | CITP laser beam preview; MVR `<Laser>` element |
| **wysiwyg** | Laser fixture instrument record in production paperwork |
| **MagicQ** | DMX laser cue integration via ChamSys Remote Protocol |

---

## Release gates (proposed)

1. **Browser evidence**: Laser placement and MPE display pass Playwright scenarios.
2. **Native gate**: UE5 R4 build renders EN 60825-1 beam volumes with live sACN drive.
3. **Device review + LSO disclaimer confirmation**: Android acceptance by owner (Brice Morneau)
   with mandatory disclaimer acknowledgment before any NOHD figures are displayed.

---

*Source: Living Guide v0.3 (17 Sept 2026). Planning intent, not committed dates.
Laser safety is a regulated engineering domain; no software simulation is a substitute
for qualified review under applicable national regulations.*
