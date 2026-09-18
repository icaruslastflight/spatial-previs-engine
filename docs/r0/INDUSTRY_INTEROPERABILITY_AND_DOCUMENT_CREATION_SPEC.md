---
document_id: SPE-INTEROP-001
project: spatial-previs-engine
updated: 2026-09-17
status: research_and_planning
scope: Industry interoperability, document creation, platform integration
sources:
  - "G:/My Drive/Spatial Previs Engine - Master Archive/master_prompt_infrastructure_v3_hyper_detailed.md"
  - "G:/My Drive/Spatial Previs Engine - Master Archive/v3_03_gdtf_share_api_fixture_resolver.md"
  - "G:/My Drive/Spatial Previs Engine - Master Archive/v3_04_network_telemetry_512ch_merge_engine.md"
  - "G:/My Drive/Spatial Previs Engine - Master Archive/v3_05_electrical_load_3d_truss_cable_router.md"
  - "G:/My Drive/Spatial Previs Engine - Master Archive/v3_06_webgpu_volumetric_beam_laser_safety.md"
  - "G:/My Drive/Spatial Previs Engine - Master Archive/v3_07_mcp_gemini_connected_app_gateway.md"
  - "G:/My Drive/Spatial Previs Engine - Master Archive/01_Planning_and_Architecture/Scene_Mode_and_Environment_Architecture_v2"
  - Living Guide v0.3 (17 Sept 2026)
authority: planning_intent
---

# Industry Interoperability and Document Creation Specification

> **Scope:** How Spatial Previs Engine exchanges data with the 7 major live production
> platforms and what production documents it produces at each milestone.
>
> **Authority label:** All integration targets and document schemas are **planned intent**
> unless marked **repository-documented** or **test-verified**. Safety-critical
> calculations (structural, electrical, optical, acoustic, laser) are **not_evaluated**
> until reviewed by a qualified domain specialist.

---

## Executive philosophy

Spatial Previs Engine is built on **open, royalty-free protocols**. No commercial SDK,
plugin license or paid API access is required to exchange data with the platforms below.
The integration strategy mirrors how these platforms already talk to each other — via
**MVR / GDTF** for geometry and fixtures, **Art-Net 4 / sACN** for live DMX telemetry,
**OSC** for cue events, and **glTF 2.0** for 3D scene exchange.

Desktop drives the full engineering scope. Web surfaces the reliable subset of each
workflow and provides a **Continue on desktop** handoff route to UE5 for advanced
operations that exceed browser capability.

---

## Core interchange formats

| Format | Standard | Role in Spatial Previs Engine |
| :--- | :--- | :--- |
| **GDTF 1.2** | DIN SPEC 15800 | Fixture geometry, DMX personality, photometric data |
| **MVR** | DIN SPEC 15801 | Full scene export: fixtures, trusses, layers, connections |
| **glTF 2.0** | Khronos | Asset geometry, `extras.sockets` snap metadata, UV maps |
| **Art-Net 4** | UDP port 6454 | Live DMX telemetry; 512-channel per-universe |
| **sACN / ANSI E1.31** | UDP port 5568 | Live DMX telemetry with per-channel priority (0xDD) |
| **OSC** | UDP | Cue trigger events, laser control, MCP gateway commands |
| **JSON-RPC 2.0** | HTTP port 3000 | MCP gateway: scene graph, asset snap, DMX cue, electrical |

### GDTF parsing pipeline (v3_03 specification)

```
GDTF Share REST API → fetch_gdtf_library.js
  → /public/assets/fixtures/cache/<fixture>.gdtf (ZIP)
  → GDTFParser.ts:
      FixtureType { Name, Manufacturer, UUID }
      DMXModes / DMXChannels { Break, Offset, PhysicalFrom/To, Default }
      GLB geometry → extras.sockets injection
      KHR_lights_punctual spot/point photometric embed
  → GDTFAssetResolver.ts: in-memory UUID index → Three.js/WebGPU mesh
```

### DMX merge engine (v3_04 specification)

```
UDP 6454 (Art-Net 4)    ┐
UDP 5568 (sACN E1.31)   ┼→ foh_bridge_daemon.js → ws://127.0.0.1:3000/telemetry
OSC (configurable port) ┘         │
                                  ↓
                         DMXUniverseMatrix.ts
                           Uint8Array(512) level data
                           Uint8Array(512) sACN 0xDD priority
                         Merge: HTP | LTP | 0xDD per-channel priority
                         Failsafe: HOLD_LAST_FRAME → BLACKOUT @ 4.0s loss
                                  │
                                  ↓
                         DMXUniverseInspector.ts (UI)
                           32×16 channel grid  60 FPS sparkline oscilloscope
```

---

## Platform integration specifications

### 1. Capture 2026 (Capture Sweden AB)

**Category:** Visualization and pre-production
**Protocols:** MVR export/import, CITP (art-net layer, media server thumbnails),
Art-Net 4 patch synchronization

#### What SPE sends to Capture

| Data | Format | R milestone |
| :--- | :--- | :--- |
| Full fixture patch with positions | MVR (DIN SPEC 15801) | R0 |
| Display surfaces (LED panels) | MVR `<VideoScreen>` geometry | R1 |
| Projector frustums | MVR `<Projector>` with throw geometry | R2 |
| Speaker positions | MVR instrument record | R3 |
| Laser fixtures | MVR `<Laser>` element + CITP beam preview | R4 |
| Final production patch | MVR + Art-Net universe allocation | R5 |

#### What SPE receives from Capture

- Capture can export MVR back with updated fixture positions after previsualization
  — SPE accepts this as a project update via `Open file` → MVR import.

#### Known API surface

- **GDTF Share API:** `GET https://gdtf-share.com/apis/public/getList.php` — fixture catalog
- **GDTF download:** `GET https://gdtf-share.com/apis/public/downloadFile.php?rid={rid}`
- **Capture MVR import/export:** File menu → Import/Export → My Virtual Rig (MVR)
- **CITP:** Port 4809 (TCP/UDP); MSEX layer for media server thumbnails

#### Unverified claims (conflict C11)

All Capture-specific API endpoints and CITP server port numbers must be confirmed
against the current Capture 2026 release notes before implementation.

---

### 2. ChamSys MagicQ

**Category:** Lighting console and pixel mapping engine
**Protocols:** Art-Net 4, sACN E1.31, ChamSys Remote Ethernet Protocol (CREP UDP 6553),
MagicQ Patch Import (CSV)

#### What SPE sends to MagicQ

| Data | Format | R milestone |
| :--- | :--- | :--- |
| Universe and DMX address allocation | Art-Net 4 universe headers | R0 |
| Pixel patch (LED surfaces) | MagicQ Patch Import CSV | R1 |
| Cue triggers | OSC `/magicq/execute` | R0 |

#### What SPE receives from MagicQ

- Live 512-channel DMX levels via Art-Net 4 (UDP 6454) or sACN (UDP 5568)
- Parsed by `foh_bridge_daemon.js` → `DMXUniverseMatrix.ts` → 60 FPS viewport update

#### ChamSys Remote Ethernet Protocol (CREP)

```
UDP socket → MagicQ IP : 6553
Packet format: "CREP" (4 bytes) + command string + null terminator
Commands (planned, unverified):
  CREP,0001,0001,0001,0001,0,EXEC <macro>  // execute macro
  CREP,0001,0001,0001,0001,0,PATC          // sync patch
```

> **Unverified (C11):** CREP command format and port confirmed from ChamSys
> documentation excerpt. Verify against current MagicQ PC v1.9 release notes.

---

### 3. Syncronorm Depence R4

**Category:** Media server visualization (video, lasers, haze, tracking)
**Protocols:** MVR import, Art-Net 4, sACN, Pangolin OSC (lasers), GDTF

#### What SPE sends to Depence R4

| Data | Format | R milestone |
| :--- | :--- | :--- |
| Fixture positions + DMX patch | MVR export | R0 |
| LED surfaces (emissive PBR) | MVR OBJ/glTF with emissive material | R1 |
| Projector positions + throw | MVR `<Projector>` | R2 |
| Laser fixtures + scan angles | MVR + Pangolin OSC (`/laser/pattern`, `/laser/color`) | R4 |

#### Depence R4 specifics

- Depence R4 natively imports MVR for scene population.
- Laser beams are driven via Pangolin BEYOND or Lasergraph DSP over OSC.
  Planned OSC addresses: `/laser/pattern`, `/laser/color`, `/laser/enable`.
- Atmospheric effects (haze density, wind drift) exposed via `AtmosphereController.ts`
  HUD → sACN universe channel mapping.

#### WebGPU volumetric shader technical basis (v3_06)

```wgsl
// Beer-Lambert light absorption (WGSL)
let A_beer = 1.0 - exp(-beta * max(0.0, delta_z));

// Soft depth fading
let z_scene = 2.0 * near * far / (far + near - (2.0 * z_raw - 1.0) * (far - near));
let delta_z_soft = z_scene - z_frag;
let A_soft = clamp(delta_z_soft / delta, 0.0, 1.0);
```

> **Note:** WebGPU WGSL shaders are planned for UE5/desktop-tier rendering.
> Browser-tier uses Three.js ShaderMaterial as a fallback.

---

### 4. Vectorworks Spotlight (Nemetschek)

**Category:** CAD-first production planning, Braceworks structural FEA, Schein rendering
**Protocols:** MVR round-trip, GDTF fixture catalog, Braceworks dead-load/deflection API

#### What SPE sends to Vectorworks

| Data | Format | R milestone |
| :--- | :--- | :--- |
| Fixture positions + patch | MVR + GDTF UUIDs | R0 |
| Complete production paperwork | MVR with instrument schedule, hook-up, dim chart | R5 |
| Rigging and truss geometry | MVR truss elements + estimated dead loads | R5 |

#### What SPE receives from Vectorworks

- Refined MVR with Braceworks FEA dead-load annotations
  (structural values are **not_evaluated** by SPE — Vectorworks Braceworks holds
  engineering authority per conflict C10).
- GDTF profiles exported from Vectorworks spotlight can be re-imported into SPE.

#### Braceworks / ANSI E1.21 note (v3_05 source)

SPE's electrical / truss cable routing engine uses:

```
A* topological graph of extras.sockets on truss models
→ Catmull-Rom spline TubeGeometry (cable bundles)
  Cable types: Socapex 19-pin, PowerCON, DMX 5-pin, Cat6
→ Breaker Load Board UI + Cable Schedule CSV export
```

> **Not_evaluated (C10):** ANSI E1.21 structural deflection results require a
> qualified structural engineer. SPE produces planning aids, not engineering certificates.
> See [S26 ESTA ANSI E121 Rigging and Deflection Math](https://docs.google.com/document/d/18l11ZVMubIermaWHNZd2wCFXk2RcUm013N4AuCF5uLc/edit).

---

### 5. Avolites Titan

**Category:** Lighting console (Diamond series, Tiger Touch, Arena, Sapphire Touch)
**Protocols:** Art-Net 4, sACN, Titan Web API (HTTP port 4430), Synergy pixel mapping

#### What SPE sends to Titan

| Data | Format | R milestone |
| :--- | :--- | :--- |
| Universe allocations | Art-Net 4 / sACN headers | R0 |
| Pixel-map surface UUIDs | Synergy pixel-map discovery (Titan Web API) | R1 |
| Full showfile patch query | Titan Web API JSON (HTTP 4430) | R5 |

#### Titan Web API (planned, unverified)

```http
GET http://{titan-ip}:4430/titan/get?path=/Patch/Fixtures
→ JSON array of fixture records: fixtureId, dmxAddress, universe, position
```

> **Unverified (C11):** Titan Web API endpoint paths and port confirmed from
> Avolites SDK documentation excerpt. Verify against current Titan v16+ release.

#### Synergy integration (R1)

Avolites Synergy links a Titan console to a Resolume or disguise media server.
SPE's R1 LED pixel mapping assigns surface UUIDs via the Synergy pixel-map
discovery broadcast — surfaces are then paintable from the console fader wing.

---

### 6. CAST Software wysiwyg (WYG)

**Category:** Visualization, pre-production, console connectivity
**Protocols:** MVR import/export, wysiwyg Console Link (Art-Net / sACN passthrough),
instrument schedule export (CSV / PDF)

#### What SPE sends to wysiwyg

| Data | Format | R milestone |
| :--- | :--- | :--- |
| Fixture positions + patch | MVR including `Video Walls` layer | R0 / R1 |
| Projector throws | MVR instrument schedule | R2 |
| Laser fixtures | MVR instrument record | R4 |
| Production paperwork | Hook-up sheets, dim charts (via wysiwyg PDF export) | R5 |

#### wysiwyg Instrument Schedule fields SPE populates

```
Instrument Type | Wattage | Circuit | Dimmer | Channel | Color | Beam Angle
Position | Unit Number | Focus | Template | Universe | Address
```

All values sourced from GDTF fixture records in the SPE project graph.
Empty GDTF fields surface as **Unknown** per the R0 recorded-data model.

#### Validation route (R1)

MVR files can be validated against wysiwyg compatibility via the community tool
[mvr-reader.com](https://mvr-reader.com) before importing into wysiwyg.

---

### 7. Maxon Cinema 4D (C4D)

**Category:** 3D modeling and motion graphics
**Protocols:** glTF 2.0 import/export, Python SDK, C4D-to-SPE asset pipeline

#### What C4D sends to SPE

| Data | Format | Role |
| :--- | :--- | :--- |
| Custom stage geometry | glTF 2.0 with UV0 (0→1 normalized) | Display surfaces (R2), custom trusses |
| LED tile meshes | glTF 2.0 with emissive material | LED wall surfaces (R1) |

#### What SPE sends to C4D

| Data | Format | Role |
| :--- | :--- | :--- |
| Scene with placed fixtures | glTF 2.0 export | Motion graphics context |
| LED surface UV maps | glTF with UV0 unwrap | Texture bake reference (R1) |

#### glTF 2.0 surface requirements from SPE

```json
// extras.sockets metadata required on all trusses/surfaces
"extras": {
  "sockets": [
    { "id": "clamp_a", "type": "fixture_clamp", "transform": [...] },
    { "id": "yoke_b", "type": "yoke_axis",      "transform": [...] }
  ]
}
```

UV0 channel must be present and normalized (0.0 to 1.0) on all display surfaces
imported from C4D for the R1 / R2 content mapping editor.

#### C4D Python SDK pipeline (planned)

```python
# C4D Python SDK — texture bake export to SPE
import c4d
doc = c4d.documents.GetActiveDocument()
obj = doc.GetActiveObject()
# Bake UV0 diffuse + emissive channels to EXR
# Export as glTF via built-in exporter (File → Export → glTF 2.0)
```

---

## Document creation: Production paperwork model

Spatial Previs Engine generates structured production paperwork from the project graph.
No export requires a third-party application — all documents are local browser downloads.

### Document types by milestone

| Milestone | Document | Contents |
| :--- | :--- | :--- |
| **R0** | Fixture Schedule | Name, type, position (m), universe, address, GDTF UUID |
| **R0** | Scene Evidence | Read-only JSON snapshot at named revision |
| **R0** | Diagnostic Export | Aliased replay for debugging, no live data |
| **R1** | Video Raster Sheet | Surface, pitch, resolution, area, Art-Net universes, port count |
| **R1** | LED Processor Assignment | Processor model, inputs, outputs, universe base |
| **R2** | Projector Position Sheet | Model, position, pan/tilt, throw, coverage, universe |
| **R2** | Lens / Coverage Report | Throw ratio, recommended distance range, actual coverage |
| **R3** | Speaker Position Sheet | Model, position, splay, aim, rigging load |
| **R3** | Amp Rack Schedule | Rack, channels, per-channel load, power draw, circuit |
| **R3** | Delay Alignment Sheet | Speaker group, distance to FOH (m), delay (ms) |
| **R4** | Laser Projector Schedule | Class, wavelength, power, position, NOHD (simulation) |
| **R4** | MPE Zone Map | SVG hazard radii overlay, LSO sign-off fields |
| **R4** | Pre-Show Safety Checklist | Interlock test steps — requires LSO review |
| **R5** | Full Show Package | All above documents consolidated + signed export |
| **R5** | Crew Packs | Role-specific: rigger, lighting, video, audio, laser (LSO) |
| **R5** | Cable Schedule | A* routed cable runs, types, lengths, circuit assignment |
| **R5** | Electrical Load Report | NEC phase-balance, voltage drop, neutral unbalance |

### Mandatory disclaimer template

> **PREVIS SIMULATION — NOT AN ENGINEERING CERTIFICATE.**
> This document is produced by Spatial Previs Engine for pre-production planning.
> Structural, electrical, optical, acoustic and laser safety figures are
> **not_evaluated** and require review by qualified domain specialists before
> physical installation or operation. See conflict register entries C10, C11.

---

## MCP JSON-RPC 2.0 gateway (v3_07 specification)

The FOH bridge daemon exposes a **Model Context Protocol** (MCP) JSON-RPC 2.0
server at `http://127.0.0.1:3000/mcp`, enabling AI tools (Gemini, Claude Desktop)
to query and command the live session.

```json
// JSON-RPC 2.0 method registry (planned)
{
  "previs/getSceneGraph":    "WGS84 coords, stage deck layouts, fixture manifests",
  "previs/snapAsset":        "Execute magnetic socket snap for a glTF model ID",
  "previs/triggerDMXCue":    "Fire static snapshot or sequence cue in DMX engine",
  "previs/getElectricalStatus": "Circuit breaker loads and voltage drop warnings"
}
```

The gateway routes to core engine singletons:
`SocketSnappingEngine`, `FullDMXControlEngine`, `ElectricalCablingEngine`.

> **Conflict C08:** Competing MCP method namespaces (`previs/*` vs `tools/list` /
> `tools/call`). Select and document the intended interface before coding.

---

## Scene modes (two-tier environment model)

From `Scene_Mode_and_Environment_Architecture_v2`:

### Real-world mode

```json
{
  "mode": "real_world",
  "anchor": { "latitude": 40.4417, "longitude": -80.0075,
               "height_ellipsoidal_m": 186.6, "label": "Point State Park" },
  "environment": { "type": "cesium", "tileset": "google_photorealistic_3d" }
}
```

### Virtual / dramatic mode

```json
{
  "mode": "virtual",
  "anchor": null,
  "environment": { "type": "splat",
                   "url": "assets/environments/rainforest_clean.splat",
                   "transform": { "matrix": [ ... ] } }
}
```

Both modes share the same DragSnapController, SocketSnappingEngine,
asset library and project graph. Only the environment layer differs.

---

## Network wiring diagram (FOH bridge)

```
┌──────────────────────────────────────────┐
│  Lighting Console (MagicQ / Titan)       │
│  or Media Server (disguise / Resolume)   │
└───────┬───────────────────┬──────────────┘
        │ UDP 6454           │ UDP 5568
        │ Art-Net 4          │ sACN E1.31
        ▼                    ▼
┌──────────────────────────────────────────┐
│  foh_bridge_daemon.js (Node.js)          │
│  Parses binary headers, merges sources   │
│  WebSocket broadcast: ws://127.0.0.1:3000/telemetry │
└───────────────────────┬──────────────────┘
                        │ WS
                        ▼
┌──────────────────────────────────────────┐
│  DMXUniverseMatrix.ts                    │
│  HTP / LTP / 0xDD merge                 │
│  Failsafe: HOLD → BLACKOUT @ 4.0s       │
└───────────────────────┬──────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────┐
│  60 FPS Engine Loop (EngineLoop.ts)      │
│  Priority 0: Telemetry buffer swap       │
│  Priority 1: Socket snap physics         │
│  Priority 2: Automation / LFO            │
│  Priority 3: WebGPU render               │
└──────────────────────────────────────────┘
```

---

## Conflict register notes

| Conflict | Relevance to interop |
| :--- | :--- |
| **C09** | Competing bridge endpoints (`:3000/telemetry` vs WebTransport `:4433`). Use `:3000/telemetry` WebSocket as the single tested contract. |
| **C10** | Safety calculations — electrical, laser, structural — are `not_evaluated`. All outputs must carry the disclaimer. |
| **C11** | Vendor API claims (Megapixel VR HELIOS, Titan Web API, CREP commands) require primary-source verification before implementation. |
| **C08** | MCP method namespace conflict — resolve before coding the gateway. |

---

*Document created 17 September 2026. Sources: Master Archive (G:\My Drive\Spatial
Previs Engine - Master Archive) v3 task prompts, Scene_Mode_and_Environment_Architecture_v2,
and Living Guide v0.3. Authority: planning intent. Primary-source verification required
before implementing any vendor API calls.*
