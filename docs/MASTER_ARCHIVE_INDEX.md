# Spatial Previs Engine — Master Archive Index

> **Location:** `G:\My Drive\Spatial Previs Engine - Master Archive`
> **Inventoried:** 17 September 2026
>
> This is the original V3 project archive. Files here are **historical task prompts
> and knowledge base references**, not executed implementations. Treat as
> planning intent + research; verify against current code at the repository commit.

---

## Root files

| File | Type | Role |
| :--- | :--- | :--- |
| `master_prompt_infrastructure_v3_hyper_detailed.md` | Markdown | Master composite of all 7 phase prompts. **Historical task input, not proof of execution.** |
| `v3_01_repository_foundation_architecture.md` | Markdown | Phase 1: TS config, Vite/WebGPU, EventBus, MemoryPool, EngineLoop |
| `v3_02_cicd_github_actions_pwa_playtest.md` | Markdown | Phase 2: CI/CD, GitHub Actions, PWA, playtest automation |
| `v3_03_gdtf_share_api_fixture_resolver.md` | Markdown | Phase 3: GDTF Share API, XML parser, glTF asset resolver |
| `v3_04_network_telemetry_512ch_merge_engine.md` | Markdown | Phase 4: Art-Net 4 / sACN bridge, HTP/LTP merge, DMX oscilloscope UI |
| `v3_05_electrical_load_3d_truss_cable_router.md` | Markdown | Phase 5A: NEC electrical load, A* cable routing, spline editing |
| `v3_06_webgpu_volumetric_beam_laser_safety.md` | Markdown | Phase 5B: WGSL volumetric beam shader, Pangolin OSC laser, MPE safety |
| `v3_07_mcp_gemini_connected_app_gateway.md` | Markdown | Phase 5C: MCP JSON-RPC 2.0 gateway, Gemini tool methods |

## 01_Planning_and_Architecture

| File | Role |
| :--- | :--- |
| `Scene_Mode_and_Environment_Architecture_v2` | Real-world vs virtual scene modes, CesiumJS vs Gaussian Splat, splat cleanup pipeline |
| `Scene_Mode_and_Environment_Architecture.gdoc` | Google Doc stub (links to live Doc) |
| `Event_Asset_Library_and_Modular_Snapping_Specification.gdoc` | Socket snapping specification (S03) |
| `Core_AI_Integration_Architecture_and_Engine_Specification.gdoc` | AI/MCP integration spec (S04) |
| `Mobile_Phone_Development_Line_Specification.gdoc` | Mobile divergence and capability limits (S05) |
| `Festival_Visualizer_MVP_Architecture_and_Execution_Plan.gdoc` | Original MVP plan |
| `Zero_Budget_Development_Line_and_Divergence_Checkpoints_Specification.gdoc` | $0 budget constraints (S07) |

## Knowledge Base

### 01_Standards_and_Protocols
- `GDTF_MVR_DIN_SPEC_Technical_Manual.md.gdoc` — DIN SPEC 15800/15801 reference
- `ArtNet4_sACN_OSC_Network_Specification.md.gdoc` — Protocol wire format
- `FOH_Protocol_Bridge_WebTransport_Gateway_Spec.md.gdoc` — WebTransport bridge design
- `Agentic_AI_World_Models_and_MCP_Integration_Spec.md.gdoc` — MCP/AI spec
- `Class4_Laser_Safety_and_MPE_Compliance_Manual.md.gdoc` — IEC 60825-1 laser safety

### 02_Geospatial_and_Rendering
- `3DGS_Compression_and_SPZ_Format_Guide.md.gdoc` — Gaussian splat SPZ format
- `Point_State_Park_WGS84_Spatial_Anchor_Spec.md.gdoc` — Test venue anchor spec

### 03_Electrical_and_Rigging
- `ESTA_ANSI_E121_Rigging_and_Deflection_Math.md.gdoc` — Rigging physics (S26)
- `NEC_Electrical_Load_and_Phase_Balancing_Guide.md.gdoc` — Electrical safety (S27)

### 04_Hardware_and_Photometrics
- `Audio_Line_Array_Dispersion_and_Acoustic_Prediction_Spec.md.gdoc` — Audio coverage (S28)
- `Megapixel_VR_HELIOS_Processor_Integration.md.gdoc` — HELIOS LED processor (S29, unverified)

### 05_Competitive_Intelligence
- `Commercial_Visualizer_Feature_Matrix_2026.md.gdoc` — Feature comparison (S30)

## 05_AI_Prompts_and_Code

Content not yet listed — contains model-neutral task template plus archive of V3 prompts.

---

## Reading rules for this archive

1. **Historical task prompts ≠ executed implementations.** Verify in the repository at a
   known commit before claiming a feature exists.
2. **`.gdoc` stubs** (178 bytes) are Google Docs shortcut files and cannot be read
   offline without Drive/browser access.
3. **Knowledge Base documents** are internal explanations, not standards issued by
   the named organizations. Verify against primary publisher sources.
4. See the curated navigation guide at `G:\My Drive\spatial-previs-engine\00_AI_Context\02_RETRIEVAL_MAP.md`
   for canonical source IDs (S01–S31) and conflict cross-references.

---

*Inventoried 17 September 2026. Paths and Drive mounting via Windows `G:\` drive.*
