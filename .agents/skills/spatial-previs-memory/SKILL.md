---
name: spatial-previs-memory
description: Domain knowledge retrieval and conflict resolution for Spatial Previs Engine. Covers GDTF/MVR fixture math, WGS84 geodesy, Art-Net/sACN universes, laser safety MPE, and rigging physics.
---

# Spatial Previs Domain Memory & Specifications

Guidelines for retrieving domain-specific knowledge from the local vector memory and Google Drive context.

## Critical Authority & Conflict Rules (SPE-CTX-003)

Always check `03_CONFLICT_REGISTER.md` before finalizing calculations or implementations:

- **C01 (Coordinates & Mode)**: Real-world mode uses WGS84 coordinates and geographic anchor; Virtual mode uses local origin (0,0,0) without mandatory basemap.
- **C02 (Point State Park Anchor)**: The verified test anchor elevation is **184.963 m ellipsoidal height** (Point State Park, Pittsburgh: 40.4418° N, 80.0076° W). Do NOT use uncorrected 220m or 186.6m values without distinguishing ellipsoidal vs orthometric height.
- **C03 (Strict Parity)**: Native desktop and browser maintain consistent IDs, units, frames, and socket snapping math.
- **C07 (GDTF / MVR Schemas)**: Use DIN SPEC 15800 GDTF and MVR specifications; geometry units are meters; rotation in degrees.
- **C08 (Model-Neutral MCP Gateway)**: Use JSON-RPC 2.0 endpoint at `POST /mcp` with methods: `previs/getSceneGraph`, `previs/snapAsset`, `previs/triggerDMXCue`, `previs/getElectricalStatus`, `previs/memorySearch`.
- **C09 (DMX Wire Contracts)**: Telemetry engine operates 512 channels per universe with HTP/LTP merging over 44-byte Art-Net / 638-byte sACN frames.
- **C10 (Safety Disclaimers)**: Previs simulations of rigging deflection (ESTA ANSI E1.21), electrical load balance (NEC), and laser MPE (ANSI Z136.1 Class 4) are for visualization and hazard avoidance; they do not replace licensed engineering certificates.

## Quick Retrieval Routes

```bash
# Query GDTF / MVR specifications
python scripts/memory/query.py "GDTF DIN SPEC fixture geometries channels"

# Query Geodetic coordinates and Point State Park anchor
python scripts/memory/query.py "Point State Park WGS84 spatial anchor"

# Query Laser safety MPE calculations
python scripts/memory/query.py "Class 4 laser safety MPE exposure distance"

# Query Rigging and deflection math
python scripts/memory/query.py "ESTA ANSI E1.21 truss deflection load"
```
