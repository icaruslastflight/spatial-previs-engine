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

# Query with 1-hop graph neighbors
python scripts/memory/query.py -k 8 --with-neighbors "GDTF pan tilt drive"

# Query with chunk body preview
python scripts/memory/query.py --body "WGS84 ellipsoidal height"

# Query with category filtering
python scripts/memory/query.py --category context "spatial anchor Point State Park"
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
