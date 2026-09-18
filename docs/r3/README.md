# R3 — Audio

**Milestone theme:** Develop audio system planning and specialist evaluation workflows.

Status: **Planned** (source: Living Guide v0.3, 17 September 2026)

> Desktop drives the full scope of this milestone. Shared data semantics remain consistent.

---

## Intended user outcomes

When R3 is complete an operator can:

1. **Place line arrays and fills** — select speaker systems from a catalog with
   accurate enclosure dimensions and coverage data (horizontal × vertical dispersion
   by frequency).
2. **Inspect coverage** — view per-frequency SPL overlays across the audience plane.
3. **Record signal routing** — document amp rack assignments, drive rack channels
   and power sequencing.
4. **Generate audio production paperwork** — produce system diagrams, delay alignment
   sheets and amp rack schedules.

---

## Planned feature areas

### AUDIO-01 — Speaker catalog entries

- Manufacturer and model with enclosure dimensions (W × H × D, m), rigging points,
  weight (kg), rated SPL, dispersion pattern.
- Supported rigging configurations (J-array splay angles, sub cardioid arrangements).

### AUDIO-02 — Acoustic coverage model (simulation, not engineering approval)

- Per-frequency SPL heatmap over a defined audience plane.
- Coverage gap and hot-spot detection.
- Delay time calculation by speaker-to-listener distance (ms, not a calibrated measurement).

> Acoustic calculations are **not_evaluated** until reviewed by a qualified audio
> engineer. These are planning aids, not venue acoustic certifications.

### AUDIO-03 — Signal routing records

- Add audio domain ports to amp racks, drive racks and crossovers.
- Record connections: console output → drive rack channel → amp channel → speaker.
- Export as system diagram JSON and as a wiring schedule CSV.

### AUDIO-04 — Production paperwork

- **Speaker Position Sheet**: name, model, position, splay, aim, rigging load, universe.
- **Amp Rack Schedule**: rack name, channel count, per-channel load, power draw, circuit.
- **Delay Alignment Sheet**: speaker group, distance to FOH mix position (m), delay (ms).

> All sheets carry **PREVIS SIMULATION — NOT AN ENGINEERING CERTIFICATE** (conflict C10).

---

## Key source references (Drive)

- [S28 — Audio Line Array Dispersion and Acoustic Prediction Spec](https://docs.google.com/document/d/1hLrQy3meUrtKr0tIPOK0mNL5SEcb53eukovg5hQIS0M/edit)

---

## Release gates (proposed)

1. **Browser evidence**: Audio placement and port-connection workflows pass Playwright scenarios.
2. **Native gate**: UE5 R3 build displays speaker rigs with splay and delay data.
3. **Device review**: Android acceptance by owner (Brice Morneau).

---

*Source: Living Guide v0.3 (17 Sept 2026). Planning intent, not committed dates.*
