# R5 — Operations

**Milestone theme:** Develop inventory reservations, crew packs and operational handoff.

Status: **Planned** (source: Living Guide v0.3, 17 September 2026)

> Desktop drives the full scope of this milestone. Shared data semantics remain consistent.
> Rental discovery provides information and links; it does not send inquiries or book
> equipment automatically.

---

## Intended user outcomes

When R5 is complete an operator can:

1. **Reserve equipment from inventory** — allocate specific physical items from owned
   or rented stock against scene placements.
2. **Identify shortages** — detect under-stocked item types and surface rental sourcing
   options based on event location.
3. **Generate crew packs** — produce role-specific document sets (rigger pack, lighting
   tech pack, video tech pack) ready for crew call.
4. **Execute operational handoff** — export the complete show package (patch, rigging,
   power, video, audio, laser) to FOH consoles and systems.

---

## Planned feature areas

### OPS-01 — Equipment inventory (INV-01 / INV-02, from PROJECT_CONTEXT.md)

- Persistent section for the production company's owned equipment: quantities,
  condition, locations and allocations.
- AI stage proposals (`AI-03`) use the same inventory to flag shortages.
- Inventory modeled per company → branch/warehouse → stock item, not as a flat pool.
- Stock at different branches cannot be treated as one local pool without explicit
  transfer routing.

### OPS-02 — Location-based rental discovery (RENT-01)

- Surface local production and rental companies based on event location.
- Link to supplier/branch pages with location, catalog snapshot and rental details.
- Make unknown stock, prices and dates explicit — catalog listings are not confirmed
  availability.
- Requires user consent before making any outbound inquiry; does not automate booking.

### OPS-03 — Stock reservation and allocation

- Allocate specific item serial/unit to a scene placement (resolves `Unallocated`
  status from R0).
- Detect double-booking across events or dates.
- Reserve and release blocks; track transfer/delivery logistics between branches.

### OPS-04 — Crew pack generation

- Roles: rigger, lighting tech, video tech, audio tech, laser tech (LSO).
- Per-role pack: relevant drawings, schedules, checklists, radio call sheets.
- Pack generation is a document export; it does not send email or push notifications.

### OPS-05 — Full show package handoff

Consolidates all R0–R4 production paperwork into a single signed export:

- Fixture Patch and Universe Allocation (lighting + video + laser)
- Rigging and Weight Load Distribution (ANSI E1.21)
- Electrical Phase Balance and Cable Run Log (NEC)
- Video Raster and Pixel Mapping Sheet
- Projector Coverage and Throw Report
- Laser MPE Zone Map + Pre-Show Checklist (requires LSO review before use)
- Audio Amp Rack Schedule + Delay Alignment Sheet
- WGS84 Geodetic Site Report

> All outputs carry **PREVIS SIMULATION — NOT AN ENGINEERING CERTIFICATE** disclaimers.

### OPS-06 — Console integration handoff (live production bridge, Phase 4)

- Art-Net 4 / sACN E1.31 ingest daemon (`npm run bridge`).
- MCP tool `previs/triggerDMXCue` for console-linked cue execution.
- ChamSys Remote Protocol (UDP 6553, `CREP` packets) for MagicQ patch sync.
- Titan Web API (HTTP port 4430) for Avolites showfile patch queries.

---

## Key source references (Drive)

- [S12 — Electrical Load and 3D Truss Cable Router](https://drive.google.com/file/d/1nOLIoWPUgrHg_O-koAal4qVD7rnuBW8c/view)
- [S26 — ESTA ANSI E1.21 Rigging and Deflection Math](https://docs.google.com/document/d/18l11ZVMubIermaWHNZd2wCFXk2RcUm013N4AuCF5uLc/edit)
- [S27 — NEC Electrical Load and Phase Balancing Guide](https://docs.google.com/document/d/1OBFoYyd1Fjbu4T0tQq71x_24uQNL1x1Asjy2xrXyNGg/edit)
- `01_PROJECT_CONTEXT.md` backlog items: ENV-01, AI-03, INV-01/02, RENT-01

---

## Platforms affected (R5 integration targets)

| Platform | R5 touchpoint |
| :--- | :--- |
| **MagicQ** | ChamSys Remote Protocol patch sync; universe CSV export |
| **Titan** | Titan Web API showfile patch query and personality import |
| **Vectorworks** | Full MVR round-trip for production paperwork and Braceworks FEA |
| **Capture / Depence** | MVR re-export with updated allocations and positions |
| **wysiwyg** | Instrument schedule, hookup sheets, rigging deflection tables |

---

## Release gates (proposed)

1. **Browser evidence**: Inventory, allocation and crew pack workflows pass Playwright
   scenarios including shortage detection and rental link display.
2. **Native gate**: UE5 R5 build performs full show package handoff over Art-Net / sACN.
3. **Device review**: Android acceptance by owner (Brice Morneau).

---

## Open questions / deferred scope

- **OPS-DQ-01 — Rigging and electrical approval**: All ANSI E1.21 and NEC calculations
  remain `not_evaluated` until reviewed by qualified structural and electrical engineers
  (conflict C10).
- **OPS-DQ-02 — Rental sourcing automation**: External provider APIs unverified; only
  static links until primary-source integration is confirmed (conflict C11).

---

*Source: Living Guide v0.3 (17 Sept 2026), `00_AI_Context/01_PROJECT_CONTEXT.md` backlog.
Planning intent, not committed dates.*
