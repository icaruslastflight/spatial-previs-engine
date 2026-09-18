# R1 — LED

**Milestone theme:** Describe LED layouts, map content and prepare output packing.

Status: **Planned** (source: Living Guide v0.3, 17 September 2026)

> Desktop drives the full scope of this milestone. Web and mobile expose reliable subsets,
> label feature availability and provide a **Continue on desktop** handoff.
> Shared data semantics remain consistent while desktop features can advance independently.

> **The goal of R1 is not to produce a render of an LED wall.
> It is to make the LED rig's universe map, pixel patch, processor assignment and
> content canvas a byproduct of the planning decision — so the media server operator
> imports the file and the patch is already done.**

---

## The problem this solves

Current LED production planning:

1. The LD places LED surface symbols in a lighting CAD file.
2. The video director independently creates the same surface in the media server.
3. Universe and Art-Net addresses are manually re-entered from a printout.
4. Pixel order (RGB/GRB), serpentine wiring and panel seam offsets are discovered
   and corrected during load-in.
5. The media server operator, LD and TD work from three separate documents that
   describe the same physical object.

**R1 replaces this with a single shared surface record** — one geometry, one pixel
count, one universe allocation. When the cabinet count changes, the universe map
re-generates. When the panel pitch changes, the power estimate updates. The media
server handoff file reflects the current state of the project, not a snapshot from
two weeks ago.

---

## Intended user outcomes

When R1 is complete an operator can:

1. **Describe LED layouts** — define display surfaces (curved, flat, cylindrical), assign
   cabinet dimensions, pixel pitch, native raster resolution and panel manufacturer data
   sourced from GDTF records.
2. **Map content** — assign video source routing (media server, NDI stream, Syphon/Spout,
   test pattern) to each surface in a movable pixel-mapping viewport. Record the mapping
   in the project graph as a first-class connection.
3. **Prepare output packing** — produce per-surface pixel maps, LED processor channel
   allocations and Art-Net / sACN universe assignments for handoff to all supported media
   servers and processors.
4. **Export handoff files** — deliver the correctly-formatted output data each platform
   expects (slice CSV, fixture XML, universe JSON, MVR layer, Art-Net patch) so that no
   manual re-entry is needed on the media server side.

---

## Scope inherited from R0

All R0 capabilities — records, relationships, check, save/restore, diagnostics, desktop
handoff — remain unchanged through R1. R1 adds to R0 without replacing it.

---

## Planned feature areas

### LED-01 — Surface catalog entries

- New `video` asset category in the modular asset library with accurate panel dimensions
  and `extras.sockets` mounting points.
- GDTF-sourced display surface nodes: pixel pitch (mm), native resolution (W×H px),
  physical tile size (m), power draw (W/m²).
- Curved and cylindrical surface geometry generated from radius + arc parameters.
- Panel manufacturers catalogued: ROE Visual, ABSEN, Unilumin, Leyard, Aoto, Brompton
  panel profiles where GDTF data exists.

### LED-02 — Content mapping workspace (Map context extension)

The Map workspace (currently a movable 3D viewport) gains a dedicated
**Video / Pixel Mapping** editor mode:

- Select a display surface to open its raster inspector (W×H pixels, bit depth, Hz).
- Assign a source:
  - Media server port (Resolume, disguise, PIXERA, MadMapper, TouchDesigner, Notch)
  - NDI stream (receive by source name / IP)
  - Syphon server name (macOS) or Spout sender name (Windows)
  - Test pattern: SMPTE 75% bars, pixel grid, RGB sweep, colour ramp, white field
- Preview the mapping in the viewport with real-time UV overlay.
- Drag and drop slices onto the surface raster to position content.
- Record the mapping as a `video` domain connection in the project graph.

### LED-03 — Output packing and universe allocation

- Declare LED processor type (Brompton Tessera, Megapixel VR HELIOS, Nova Star,
  Avolites Ai, disguise VFC) and port count.
- Pack surface rasters into processor output channels respecting port width limits
  (e.g. Brompton SX40: 4× SDI 12G outputs, each ≤ 1920×1200 px).
- Allocate Art-Net / sACN universes (512 channels each) and generate a universe map.
- Calculate minimum data port count (1 GbE per ≈ 7 universes at 30 Hz).
- Detect and flag over-allocation (pixel count exceeds available DMX channels at
  chosen bit depth: 8 bpp RGB = 3 ch/pixel).

### LED-04 — Production paperwork — Video Raster Sheet

Extends `ProductionPaperworkEngine` to emit:

- **Video Raster Sheet**: surface name, manufacturer, pitch, native resolution,
  physical area (m²), cabinet count, total pixel count, required Art-Net universes,
  data port count (1 GbE), DMX pixel patch.
- **LED Processor Assignment Table**: processor name/model, source inputs, output
  channels, universe base.
- **Slice Layout CSV**: compatible with Resolume Advanced Output, MadMapper LED/DMX
  import, and PIXERA CSV warp import.

> All generated sheets carry: **PREVIS SIMULATION — NOT AN ENGINEERING CERTIFICATE**
> (conflict register rule C10).

---

## Media server integration — mapping expectations by platform

### Resolume Arena (FFGL / Advanced Output / Stageflow)

**Integration role:** Primary VJ/live media server for LED pixel mapping in club,
festival and touring environments.

**Mapping expectations:**
- Resolume Arena (not Avenue) exposes the **Advanced Output** pixel mapper.
- Each LED surface becomes a **Lumiverse** (virtual DMX universe) in the Fixtures Editor.
- SPE exports a **Slice Layout CSV** that maps pixel coordinates to Lumiverse addresses.
- **Auto Span** distributes data across universes when pixel count exceeds 512 channels.
- Protocol output: Art-Net (broadcast or unicast) or sACN (multicast) to hardware
  pixel controllers (Advatek PixLite, Enttec ODE, Brompton via Tessera DVI/SDI).

**What SPE provides:**
```
Resolume Advanced Output import package:
  slices.csv           — x, y, w, h, universe, start_channel, pixel_order
  fixture_profiles/    — custom .xml fixture profiles for non-standard panels
  patch_summary.json   — universe base, pixel count, colour order per surface
```

**Stageflow by Hybrid Constructs (key plugin):**
- Stageflow integrates with Resolume Arena's Advanced Output to provide a **drag-and-drop
  stage slice layout** — operators arrange surface slices visually like puzzle pieces.
- SPE's Video Raster Sheet feeds directly into Stageflow's slice import, eliminating
  manual re-entry of pixel geometry.
- Companion plugins from Hybrid Constructs:
  - **Chaser** — pixel-perfect screen bump and chase pattern sequencer; SPE can trigger
    Chaser presets via Art-Net from the FOH bridge.
  - **Vexml** — converts vector SVG layouts (SPE can export SVG from its map viewport)
    into Stageflow-ready stage presets. SPE's pixel map SVG export is designed to be
    Vexml-compatible.
  - **HeadsUp** — timecode and cue monitoring; ingests OSC from the SPE MCP gateway
    (`/show/timecode`, `/show/cue`).

**FFGL plugins (Resolume FreeFrame GL):**
- Third-party FFGL sources and effects load as video sources in Resolume.
- SPE can be configured as an NDI or Syphon/Spout texture source feeding into FFGL
  compositor layers, allowing the 3D preview to appear as a real-time Resolume source.

---

### MadMapper (GarageCube / 1024 Architecture)

**Integration role:** Projection mapping and LED pixel mapping; widely used for
architectural, retail and festival installs.

**Mapping expectations:**
- MadMapper's **LED/DMX section** manages fixtures as pixel arrays.
- Each LED surface in SPE maps to a MadMapper **LED matrix fixture**.
- Content sources supported: internal media, NDI (network), Syphon (macOS), Spout (Windows).
- SPE provides the fixture geometry; operators drag NDI/Syphon/Spout sources onto
  fixtures in the MadMapper LED editor.
- Protocol output: Art-Net / sACN to hardware controllers.

**What SPE provides:**
```
MadMapper LED import package:
  fixtures.mmfl        — MadMapper fixture library file (XML-based LED fixture definitions)
  patch.csv            — universe, start_address, pixel_count, pixel_order per surface
  ndi_source_name      — SPE's NDI broadcast name for live 3D preview texture feed
```

**Internal Loopback:** MadMapper can consume its own rendered output as an LED source.
SPE documents this path: SPE 3D preview → Syphon/Spout out → MadMapper input → LED output.

**Key plugin / integration tools:**
- **MadMapper Mini** (hardware) — standalone mapper device; SPE's export targets its
  fixture format for install scenarios.
- **GrandMA3 MadMapper link** — MadMapper surfaces can be driven by a grandMA3 console
  via ArtNet; SPE universe allocation aligns with this constraint.

---

### TouchDesigner (Derivative)

**Integration role:** Generative content engine; custom LED mapping pipelines; real-time
interactive installations; AI/ML-driven content.

**Mapping expectations:**
- TouchDesigner uses the **TOP → CHOP → DMX Out** pipeline (classic method) or
  the newer **DMX Fixture POP / DMX Out POP** system (TD 2025+).
- SPE provides pixel layout data that informs the TouchDesigner `Shuffle` and
  `Lookup` CHOP order required to handle serpentine wiring and custom panel ordering.
- SPE can receive NDI from TouchDesigner as a content source, or send its 3D scene
  geometry to TD via OSC or the MCP gateway for reactive/generative triggering.

**What SPE provides:**
```
TouchDesigner handoff package:
  pixel_map.json       — {surface_id, width, height, universe_base, serpentine: bool,
                          pixel_order: "RGB"|"GRB"|"RGBW", panels: [{x,y,w,h}]}
  td_artnet_config.txt — DMX Out CHOP settings: network, universe range, start channel
  ndi_source_name      — SPE NDI broadcast name for live texture feed
```

**Modern POP workflow (TD 2025+):**
- `DMX Fixture POP` nodes replace manual CHOP channel management.
- SPE's `pixel_map.json` maps directly to the Fixture POP `Layout` parameter.
- `DMX Map DAT` (TD built-in) validates against SPE's universe allocation.

**Unique TouchDesigner capability — live geometry sync:**
- SPE MCP gateway exposes `previs/getSceneGraph` via JSON-RPC 2.0.
- A TouchDesigner `Web Client DAT` can poll this endpoint at 30 Hz to receive
  live fixture positions, enabling TD generative content to react to equipment
  placement changes in real time.

---

### Notch (Notch VX / Notch Builder)

**Integration role:** Real-time generative content blocks embedded in media servers;
used with disguise, PIXERA, LightAct, TouchDesigner as a Notch Block host.

**Mapping expectations:**
- Notch does not do pixel mapping independently — it outputs content as a real-time
  GPU texture (`.dfx` Notch Block) that the host media server maps onto surfaces.
- SPE's role: provide the host media server with the mapping data (MVR, slice CSV,
  universe allocation), while the Notch Block provides the rendered texture.
- Exposed Notch parameters (color, intensity, geometry deform) are mappable to
  Art-Net / DMX / OSC values from the lighting console or SPE MCP gateway.

**What SPE provides to Notch → host server pipeline:**
```
MVR export (with VideoScreen layer):
  → disguise loads MVR, maps Notch Block texture to VideoScreen surface
  → PIXERA loads MVR, Panel Array Tool reads surface dimensions
  → universe and Art-Net patch copied from SPE Video Raster Sheet

Notch parameter mapping (via OSC from SPE MCP gateway):
  /notch/{block_id}/param/{name}   float 0.0–1.0
  e.g. /notch/rainforest/param/intensity   0.75
```

**Notch Block `.dfx` licensing note (conflict C11):**
- Playback requires a Codemeter USB dongle with Notch Playback license on the host
  server. SPE cannot enable, verify or manage this licensing. Document requirement
  in the operator's crew pack (R5).

---

### disguise (d3 / gx / rx / vx series)

**Integration role:** Tier-1 large-scale touring and broadcast media server.

**Mapping expectations:**
- disguise uses **Feed Maps** (video texture to screen) and **PixelMap layers**
  for DMX/LED pixel output.
- The workflow bridge from SPE to disguise involves:
  1. SPE exports MVR with `<VideoScreen>` layers.
  2. Third-party tool **Pixmap Pro** (or manual workflow) converts MVR fixture
     data into disguise `Fixturetyps` and Feed Map configurations.
  3. disguise **Mapping Matter** (pre-production planning tool) accepts the 3D
     screen geometry from the MVR for clash checking and throw simulation.
- VFC (Video Format Conversion) card outputs on the disguise server carry the
  final video signal to Brompton Tessera or other processors.

**Brompton Tessera integration (LED processor layer):**
- Brompton Tessera SX40/SX40R: 4× 12G-SDI outputs, each ≤ 1920×1200 px,
  management via Ethernet (IP control).
- Art-Net from disguise or console controls Tessera parameters (brightness, preset
  recall) via **Live Control** mode.
- Brompton universes start at index 0 (not 1) — SPE's universe allocator accounts
  for this offset in Brompton-targeted exports.
- **ChromaTune / 3D LUT**: colour calibration lives on the Tessera, not in SPE.
  SPE documents LUT slot and preset numbers in the LED Processor Assignment Table.

**What SPE provides:**
```
disguise handoff package:
  scene.mvr               — MVR with VideoScreen geometry + universe data
  feed_map_config.json    — Feed Map assignments per surface (compatible with d3 JSON API)
  brompton_presets.json   — Tessera preset names, LUT slot references, Art-Net addresses
```

---

### PIXERA (AV Stumpfl)

**Integration role:** Flexible multi-screen media server for corporate, broadcast
and live events; strong native LED support.

**Mapping expectations:**
- PIXERA's **Panel Array Tool** (Screens tab) auto-generates LED wall structure
  from pixel pitch and resolution data — SPE exports exactly these values.
- **Selective Target Rendering → "Texture per Screen"** mode handles complex
  multi-surface pixel mapping as a single feed.
- `.csv` / `.pfm` warp files import directly for custom pixel coordinate remapping.
- Art-Net / sACN / KiNET output drivers are native.

**What SPE provides:**
```
PIXERA handoff package:
  panel_array.csv         — pitch_mm, resolution_w, resolution_h, tile_w_m, tile_h_m
  pixel_warp.csv          — source_x, source_y, dest_universe, dest_channel
  artnet_config.json      — universe, ip, subnet, protocol per surface
```

---

### Content transport layer (NDI / Syphon / Spout)

All platforms above accept live content via one or more of:

| Protocol | Platform | Direction | Notes |
| :--- | :--- | :--- | :--- |
| **NDI** | All (cross-platform, cross-machine) | SPE ↔ media server | Requires Gigabit wired Ethernet; mDNS discovery |
| **Syphon** | MadMapper, Resolume (macOS) | SPE → media server | Zero-copy GPU texture sharing; macOS only |
| **Spout** | Resolume, TouchDesigner, MadMapper (Win) | SPE → media server | GPU texture sharing; Windows only |
| **Internal Loopback** | MadMapper | SPE preview → MadMapper LED input | Same-machine texture passback |

SPE broadcasts its 3D scene preview as:
- **NDI** output (always on, cross-platform): source name `Spatial Previs Preview`
- **Spout** sender (Windows only): sender name `SpatialPrevis`
- **Syphon** server (macOS only, UE5 native build): server name `SpatialPrevis`

These become selectable content sources in all platforms without requiring file export.

---

## Platform integration table (R1 summary)

| Platform | R1 export | Key mapping tool | Unique feature |
| :--- | :--- | :--- | :--- |
| **Resolume Arena** | Slice CSV + fixture XML | Advanced Output | Stageflow/Vexml drag-and-drop layout |
| **MadMapper** | `.mmfl` fixture library + CSV patch | LED/DMX section | Internal Loopback; NDI/Syphon/Spout |
| **TouchDesigner** | `pixel_map.json` + Art-Net config | DMX Fixture POP (TD2025+) | Live geometry sync via MCP `previs/getSceneGraph` |
| **Notch** | MVR `<VideoScreen>` via host server | Host server Feed Map | Exposed parameters via OSC from SPE MCP |
| **disguise** | MVR + feed map JSON | Mapping Matter + Pixmap Pro | Brompton Tessera Live Control via Art-Net |
| **PIXERA** | Panel array CSV + warp CSV | Panel Array Tool | `.pfm` warp import; Mapping Multi-View |
| **Capture 2026** | MVR `<VideoScreen>` | MVR import | CITP media thumbnail |
| **Depence R4** | MVR + glTF emissive surface | MVR import | Pangolin OSC for LED-driven atmospheric effects |
| **wysiwyg** | MVR `Video Walls` layer | Instrument schedule | Validated via mvr-reader.com |
| **Cinema 4D** | glTF 2.0 UV0 unwrap | C4D glTF exporter | Texture bake reference for content creation |
| **Avolites Titan** | Art-Net universe + Synergy UUID | Synergy pixel-map | Console fader wing pixel control |

---

## LED processor integration (hardware layer)

| Processor | Output method | SPE handoff format | Notes |
| :--- | :--- | :--- | :--- |
| **Brompton Tessera SX40/SX40R** | 4× 12G-SDI per processor | `brompton_presets.json` | Universe offset at 0; ChromaTune/LUT via Tessera |
| **Megapixel VR HELIOS** | Ethernet pixel output | `helios_patch.json` | API endpoints unverified — conflict C11 |
| **Nova Star VX series** | Art-Net / sACN | Standard universe CSV | Common on budget productions |
| **Avolites Ai** | Synergy pixel output | Synergy UUID + Art-Net | Integrated with Titan console |
| **disguise VFC card** | DisplayPort / SDI to processor | MVR + d3 feed map | Requires Pixmap Pro bridge |

---

## Release gates (proposed)

1. **Browser evidence**: Map workspace Video / Pixel Mapping mode passes automated
   Playwright scenarios including: surface selection, NDI source assignment, universe
   allocation, and Slice CSV export.
2. **Native gate**: UE5 R1 build displays LED surfaces with live Art-Net pixel feed
   received from Resolume Arena in Lumiverse mode.
3. **Device and visual review**: Android acceptance by owner (Brice Morneau).

---

## Open questions / deferred scope

| ID | Item |
| :--- | :--- |
| **LED-DQ-01** | Electrical load from LED power draw remains `not_evaluated` — specialist sign-off required (C10). |
| **LED-DQ-02** | Megapixel VR HELIOS API endpoints unverified (C11) — integrate only after primary-source confirmation. |
| **LED-DQ-03** | Notch Playback licensing (Codemeter dongle) must be documented in R5 operator crew pack; not automatable. |
| **LED-DQ-04** | Pixmap Pro (disguise MVR bridge) is a third-party paid tool — operator must own license; SPE exports MVR; bridge is the operator's responsibility. |
| **ENV-01** | Pre-made venue environment templates deferred, no specific release assigned. |

---

*Sources: Living Guide v0.3 (17 Sept 2026); Master Archive V3 task prompts v3_04;
Web research: Resolume Advanced Output, MadMapper LED/DMX, TouchDesigner DMX Fixture POP,
Notch Block hosting, disguise Mapping Matter, PIXERA Panel Array Tool, Stageflow/Chaser/Vexml
by Hybrid Constructs, Brompton Tessera SX40 integration (September 2026).
Implementation scope and gate definitions are proposed planning intent, not committed dates.*
