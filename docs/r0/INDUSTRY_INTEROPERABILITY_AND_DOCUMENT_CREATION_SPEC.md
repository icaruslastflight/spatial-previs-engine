# Spatial Previs Engine — Industry Interoperability & Document Creation Specification

> **Status:** Research & Development Architecture Specification (R0–R2)  
> **Target Programs:** Capture, ChamSys MagicQ, Syncronorm Depence R4, Vectorworks Spotlight (VWX), Avolites Titan, CAST wysiwyg, Maxon Cinema 4D (C4D).  
> **Core Interchange Formats:** MVR (DIN SPEC 12801), GDTF (DIN SPEC 15800), glTF 2.0 / USD, CSV / TSV Patch Sheets, Art-Net 4 / sACN E1.31, JSON-RPC 2.0 (MCP).

---

## 1. Executive Summary & Document Creation Philosophy

As a live entertainment previs and spatial computing platform, **Spatial Previs Engine (Festival Visualizer)** must bridge the gap between three distinct documentation domains:
1. **CAD & Venue Modeling (Geometric Truth):** Vectorworks, Cinema 4D, SketchUp.
2. **Console Programming & Show Control (Logical & Telemetric Truth):** ChamSys MagicQ, Avolites Titan, grandMA3, ETC Eos.
3. **Visualizers & Simulation Rigs (Photometric & Physical Truth):** Capture 2026, Syncronorm Depence R4, CAST wysiwyg, Unreal Engine 5.

### How We Ought to Create Documents in Spatial Previs Engine

To avoid vendor lock-in, eliminate manual patch re-entry, and preserve zero-budget ($0) accessibility, documents created by Spatial Previs Engine must adhere to a strict **Three-Tier Document Model**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        THREE-TIER DOCUMENT MODEL                       │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Core Native Document  │ .previs (ZIP container with project.json    │
│    (Deterministic State) │ + assets/ + telemetry/ + GeoAnchor WGS84)   │
├──────────────────────────┼─────────────────────────────────────────────┤
│ 2. Universal Interchange │ • MVR (GeneralSceneDescription.xml + GDTF)  │
│    (Cross-Platform)      │ • GDTF (DIN SPEC 15800 XML + 3D meshes)     │
│                          │ • glTF 2.0 / USD (Visual & LED geometry)    │
│                          │ • CSV / TSV (Console Patch Schedules)       │
├──────────────────────────┼─────────────────────────────────────────────┤
│ 3. Human Paperwork       │ • Fixture Patch & Universe Allocation PDF   │
│    (Crew & Production)   │ • Rigging & Weight Load Distribution Schedule│
│                          │ • Video Raster & Pixel Mapping Sheet        │
│                          │ • Power Phase Balance & Cable Run Log       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Target Programs & Official Documentation Directory

Below is the verified registry of target platforms, official documentation portals, supported file formats, and integration vectors.

| Software | Publisher | Primary Role | Native / Preferred Formats | Official Documentation URL |
| :--- | :--- | :--- | :--- | :--- |
| **Capture** | Capture Visualisation AB | Real-time Lighting & Laser Previs | `.c26`, `.c24`, `.CaptureSymbol`, `.symdef`, MVR, GDTF, CITP | [https://www.capture.se/Manual/en-UK/](https://www.capture.se/Manual/en-UK/) |
| **MagicQ** | ChamSys Ltd | Lighting Control & MagicVis | `.shw`, MVR (v1.9.7.1+), GDTF, CSV Patch, ChamSys Remote Protocol | [https://chamsyslighting.com/pages/magicq-manual](https://chamsyslighting.com/pages/magicq-manual) |
| **Depence R4** | Syncronorm GmbH | Architectural, Laser, Fountain & Stage Previs | `.dp4`, `.dp3`, MVR, Art-Net, sACN, DMX PBR Materials | [https://help.depence.com/](https://help.depence.com/) |
| **Vectorworks** | Vectorworks, Inc. | Entertainment CAD & Spotlight Rigging | `.vwx`, MVR (DIN SPEC 12801), GDTF (DIN SPEC 15800), IFC, DWG | [https://gdtf-share.com/help/](https://gdtf-share.com/help/) & [https://developer.vectorworks.net/](https://developer.vectorworks.net/) |
| **Titan** | Avolites Ltd | Touring & Festival Console OS | `.titan`, `.d4z`, `.d4`, Titan Web API (port 4430), Synergy, MVR | [https://manual.avolites.com/](https://manual.avolites.com/) & [https://api.avolites.com/](https://api.avolites.com/) |
| **wysiwyg** | CAST Software | Photometric Design & Production Paperwork | `.wyg`, MVR, CSV Patch, AutoPlot, CITP | [https://cast-soft.com/](https://cast-soft.com/) |
| **Cinema 4D** | Maxon Computer GmbH | 3D DCC, Concept Art & Video Mapping Modeling | `.c4d`, glTF 2.0, OpenUSD, FBX, Alembic (`.abc`), Python SDK | [https://developers.maxon.net/](https://developers.maxon.net/) |

---

## 3. Detailed Platform Analysis & Interchange Requirements

### 3.1. Capture (Capture Visualisation AB)
*   **Documentation:** [Capture Reference Manual](https://www.capture.se/Manual/en-UK/) (updated continuously for Capture 2024–2026).
*   **File Formats:**
    *   `.CaptureSymbol`: Modern ZIP archive holding `symbol.xml`, thumbnail PNG, and 3D mesh assets in `geometry/`.
    *   `.symdef`: Legacy plain XML symbol definition with DMX personality and bounding geometry.
    *   `MVR (1.4–1.6)`: Full scene exchange with 3D objects, positions, layers, and fixture types.
    *   `CITP / CAEX`: Live Ethernet protocol linking console programmer selection with visualizer viewports.
*   **Document Creation Rules for Capture:**
    1. Export MVR containing `GeneralSceneDescription.xml` using DIN SPEC 12801 standards.
    2. Ensure fixture identifiers (UUIDs) remain persistent across re-exports to preserve Capture's library mapping cache.
    3. Provide CSV patch export with headers: `Fixture ID, Name, Manufacturer, Model, Mode, Universe, Channel, X, Y, Z, Pan, Tilt, Roll`.

### 3.2. ChamSys MagicQ
*   **Documentation:** [ChamSys MagicQ User Manual](https://chamsyslighting.com/pages/magicq-manual).
*   **Workflow & Integration:**
    *   **MVR Import:** Starting in MagicQ v1.9.7.1+, MagicQ parses MVR files directly, populating patch, head numbers, and 3D coordinates in the Visualiser window.
    *   **Patch Syntax:** `Quantity @ Universe - Channel / Offset * Starting Head Number` (e.g. `12@1-1/16*101` patches 12 fixtures to Universe 1 starting at channel 1, 16 channels each, heads 101–112).
    *   **ChamSys Remote Protocol:** Network control over UDP/TCP port 6553 on local subnet, accepting ASCII commands (e.g., `101 THRU 112 AT 100`, `1 CUE 1 GO`).
*   **Document Creation Rules for MagicQ:**
    1. Generate a **MagicQ Patch CSV** with columns: `Head No, Name, Type, Mode, Universe, Address, X, Y, Z, Rot X, Rot Y, Rot Z`.
    2. In MVR packages, map standard GDTF fixture mode strings to ChamSys head library profiles to minimize manual patching prompt dialogs.

### 3.3. Syncronorm Depence R4
*   **Documentation:** [Depence Help Center](https://help.depence.com/).
*   **Workflow & Integration:**
    *   **MVR Integration:** Reads MVR files containing scene meshes, water effects, laser projectors, and moving heads.
    *   **Laser Safety & MPE:** Depence features built-in Pangolin BEYOND / Lasergraph DSP laser beam simulation.
    *   **Page Collections:** Depence R4 introduces multi-page CAD-style plot paperwork export.
*   **Document Creation Rules for Depence R4:**
    1. Structure stage decks, trusses, and fixtures into named MVR layers (`Truss Rigging`, `Floor Package`, `Video Walls`, `Laser Projectors`).
    2. Export surfaces as separate OBJ/glTF meshes inside the MVR container so Depence can attach DMX-controlled PBR emissive materials.

### 3.4. Vectorworks Spotlight (VWX)
*   **Documentation:** [GDTF-Share Help Portal](https://gdtf-share.com/help/) & [Vectorworks Developer Network](https://developer.vectorworks.net/).
*   **Workflow & Integration:**
    *   **MVR Standard Lead:** Vectorworks is the co-author of the MVR (DIN SPEC 12801) and GDTF (DIN SPEC 15800) specifications.
    *   **Data Structure:** `File > Export > Export MVR` packages:
        *   `GeneralSceneDescription.xml`: Hierarchical XML scene graph (`<Scene>`, `<Layers>`, `<Layer>`, `<ChildList>`, `<Fixture>`, `<FocusPoint>`, `<Structure>`).
        *   Geometry folder with glTF / 3DS meshes.
        *   Embedded `.gdtf` archives for each unique fixture profile.
*   **Document Creation Rules for Vectorworks:**
    1. Strictly follow DIN SPEC 12801 v1.6 schema formatting.
    2. Units: Coordinates must be in **meters**, rotations in **degrees**, matrices in column-major affine 4×4 form.
    3. Rigging trusses must be flagged with `<Structure>` elements with manufacturer and profile metadata to allow Vectorworks Braceworks to perform finite element analysis (FEA).

### 3.5. Avolites Titan
*   **Documentation:** [Avolites Titan Manual](https://manual.avolites.com/) & [Titan Web API Reference](https://api.avolites.com/).
*   **Workflow & Integration:**
    *   **Titan Web API:** Built-in HTTP REST/JSON API operating on port 4430. Allows programmatic showfile querying, preset triggering, and patch inspection without requiring physical console interaction.
    *   **Synergy:** Connects Titan consoles with Avolites Ai and Prism media servers for automatic pixel mapping, surface discovery, and thumbnail streaming over network.
*   **Document Creation Rules for Avolites Titan:**
    1. Produce **Titan Personality XML / CSV** patch schedules.
    2. Connect via Titan Web API (`http://<console_ip>:4430/titan/`) using JSON endpoints to sync universe patch mappings into Titan showfiles.

### 3.6. CAST wysiwyg (WYG)
*   **Documentation:** [CAST Software Knowledge Base](https://cast-soft.com/) & [MVR Reader Portal](https://mvr-reader.com/).
*   **Workflow & Integration:**
    *   WYSIWYG Release 49–52 imports and exports MVR files, mapping fixture positions and 3D truss structures.
    *   Paperwork Engine: wysiwyg is famed for rigorous production paperwork (Instrument Schedules, Pipe Tapes, Hookup Sheets, Rigging Deflection Tables).
*   **Document Creation Rules for wysiwyg:**
    1. Ensure all imported fixtures specify `Unit Number`, `Circuit`, `Channel`, and `Universe`.
    2. Validate exported MVR files using `mvr-reader.com` validator to ensure zero missing XML elements or corrupt ZIP headers.

### 3.7. Maxon Cinema 4D (C4D)
*   **Documentation:** [Maxon Developer Portal](https://developers.maxon.net/) & [Maxon Python API Examples](https://github.com/maxon-computer/cinema-4d-python-api-examples).
*   **Workflow & Integration:**
    *   **DCC Exchange:** Uses `c4d.documents.SaveDocument` / `MergeDocument` with `FORMAT_GLTFEXPORT` and USD / Alembic.
    *   **Video Wall Previs:** Stage designers model custom curved LED video walls in C4D and bake UV projection maps for media servers (disguise, Resolume, Notch).
*   **Document Creation Rules for Cinema 4D:**
    1. Emit scenes as standard **glTF 2.0 (`.gltf` / `.glb`)** and **Universal Scene Description (`.usd` / `.usdc`)**.
    2. Maintain clean UV0 unwraps on all display surfaces (1:1 mapping from 0.0 to 1.0) so video texture engines can apply rasters directly without distortion.

---

## 4. How Spatial Previs Engine Will Generate These Documents

To support all 7 platforms simultaneously, the engine provides modular document generators:

### 4.1. Universal MVR Packager (`MvrBundleBuilder`)
Packages the entire stage scene into a valid `.mvr` archive:
```
show_rig.mvr (ZIP)
├── GeneralSceneDescription.xml   <-- Scene hierarchy, layers, fixtures, coordinates
├── geometries/                    <-- Stage decks, truss meshes, LED screen shells (.gltf)
└── gdtf/                         <-- GDTF archives for all fixture models
    ├── Robe_Robin_MegaPointe.gdtf
    └── Chauvet_COLORado_Solo.gdtf
```

### 4.2. Console Patch Sheet Generator (`PatchScheduleExporter`)
Exports tabular patch spreadsheets formatted with presets for:
- **Standard Industry CSV / TSV**
- **ChamSys MagicQ Patch Import**
- **Avolites Titan Personality Map**
- **grandMA3 / grandMA2 XML Patch**
- **ETC Eos CSV Lightwright Exchange**

### 4.3. Production Paperwork Bundle (`ProductionPaperworkEngine`)
Generates production-grade operational sheets:
- **Rigging & Deflection Schedule:** Hang points, bridle angles, apex load, dead load (ANSI E1.21).
- **Electrical Phase Balancing Sheet:** Phase A / B / C amperage, breaker schedule, voltage drop (NEC).
- **Video & Pixel Mapping Report:** Display surfaces, raster pixel resolution (e.g. 1024×640), cabinet counts, 1GbE data ports, and DMX pixel patch.
- **WGS84 Geodetic Report:** True North rotation, venue elevation, ellipsoidal anchor (184.963m ellipsoidal height for Point State Park test anchor).

---

## 5. Verification & Next Steps

1. **Automated Schema Validation:** Integrate `libMVRgdtf` and XML schema validation tests in `tests/mvr_export.test.ts`.
2. **Cross-Platform Fixture Mapping:** Maintain fixture alias dictionary mapping GDTF names to Capture, MagicQ, and Titan personality keys.
3. **Continuous Knowledge Ingestion:** Ingest this specification into the vector memory store (`scripts/memory/ingest.py`) so AI agents can query interchange rules instantly.
