---
name: rag-implementation
description: Build and query Retrieval-Augmented Generation (RAG) systems for LLM applications with vector databases and semantic search. Use when implementing knowledge-grounded AI, indexing technical documents, or integrating LLMs with external knowledge bases.
---

# RAG Implementation & Vector Retrieval

Master Retrieval-Augmented Generation (RAG) to build applications that provide accurate, grounded responses using external knowledge sources and local vector databases.

## Spatial Previs Engine RAG Topology

This repository implements a zero-cost ($0), offline-first RAG topology:
1. **Local Persistent Vector Store**: ChromaDB (`.memory/chroma/`) running locally via ONNX `all-MiniLM-L6-v2` embeddings.
2. **Structural Import Graph**: NetworkX `DiGraph` (`.memory/graph.pickle`) capturing file imports and references.
3. **In-Engine Memory Store**: TypeScript `VectorMemoryStore` in `src/memory/` for browser/Node execution without Python prerequisites.
4. **Drive AI Context Ingestion**: Automated ingestion of `00_AI_Context/` (`01_PROJECT_CONTEXT.md`, `02_RETRIEVAL_MAP.md`, `03_CONFLICT_REGISTER.md`, `04_SOURCE_REGISTER.json`), `Knowledge Base/`, and specs.

## Querying Vector Memory

```bash
# Basic natural-language query
python scripts/memory/query.py "where is DETENT_STEP_RADIANS defined"

# Query with 1-hop graph neighbors -- also prints cross-platform parity
# edges (see below) distinctly from ordinary import edges, each with its
# manual-verification caveat attached
python scripts/memory/query.py -k 8 --with-neighbors "GDTF pan tilt drive"

# Query with chunk body preview
python scripts/memory/query.py --body "WGS84 ellipsoidal height"

# Query with category filtering
python scripts/memory/query.py --category context "spatial anchor Point State Park"

# Direct lookup of a shared-constant entity (unit + per-platform value +
# parity_status) -- skips vector search entirely for known named constants
python scripts/memory/query.py --entity POINT_STATE_PARK_HEIGHT
python scripts/memory/query.py --entity SNAP_THRESHOLD_METERS --json
```

## Ingestion Architecture

- Window size: 80 lines per chunk
- Overlap: 15 lines
- Chunk Key: `<path>#<start_line>-<end_line>#<content_sha1>`
- Categories:
  - `code`: `src/`, `native/`, `scripts/`
  - `docs`: `docs/`, `README.md`, `CLAUDE.md`, `AGENTS.md`
  - `context`: `00_AI_Context/` from Google Drive
  - `standards`: `Knowledge Base/` (GDTF, MVR, Art-Net, sACN, Laser safety, Rigging)
- **Platform tag** (every chunk, orthogonal to category): `web` | `native` |
  `tooling` | `docs` | `external` (Drive-sourced), derived from top-level
  directory in `determine_platform()`.
- **Shared-constant entity nodes** (`entity::<NAME>` in the graph, not
  chunks): a small, hand-maintained list in `ingest.py`'s
  `SHARED_CONSTANT_ENTITIES` for CLAUDE.md's own numeric constants —
  `POINT_STATE_PARK_HEIGHT/LATITUDE/LONGITUDE`, `SNAP_THRESHOLD_METERS`,
  `SNAP_ANGLE_RADIANS`, `DETENT_STEP_RADIANS`. Each carries a unit and a
  `parity_status`: `documented-mirrored` (CLAUDE.md §3 says UE5 mirrors it,
  not independently verified), `assumed-shared` (governed by §1.1's rule,
  not separately tracked), or `open` — currently only the site-anchor
  height, where the native value is *inferred* from §1.1's own wording, not
  confirmed against any `native/` file. Never treat an `open` entity's
  native value as verified.
- **Cross-platform parity edges** (`kind: "parity"` graph edges, bidirectional):
  connect a web file to a native file implementing the *same documented
  contract*, sourced only from CLAUDE.md §16's coordinate-boundary table —
  currently `src/domain/ProjectTransforms.ts` ↔
  `native/.../SpatialPrevisCore/Public/{SpatialPrevisCoordinates.h,
  SpatialPrevisUnrealTransform.h}`. A parity edge means "same contract per
  CLAUDE.md," never "checked equal" — native conformance stays manual-only
  per `docs/r0/UE5_CONFORMANCE.md` regardless of what the graph can
  discover; `query.py` always prints the caveat alongside a parity hit.
