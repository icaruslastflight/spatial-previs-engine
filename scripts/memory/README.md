# Local $0 AI memory over this repo

A per-workstation vector + graph index of the repo's source. No servers, no
paid APIs, no committed binaries. Runs on Python 3.10+.

- **Vector store:** ChromaDB in `PersistentClient` mode. Uses its built-in
  ONNX embedder (`all-MiniLM-L6-v2`, ~80 MB, auto-downloaded on first ingest
  into `%USERPROFILE%\.cache\chroma\` on Windows or `~/.cache/chroma/`).
- **Graph:** NetworkX `DiGraph` of file-level import edges, persisted to a
  pickle. Cheap to load, cheap to walk.
- **Persistence:** `.memory/chroma/` and `.memory/graph.pickle` at repo root.
  Git-ignored per `CLAUDE.md` §11.

## Install

```bash
pip install -r scripts/memory/requirements.txt
```

## Ingest

```bash
python scripts/memory/ingest.py                 # incremental upsert
python scripts/memory/ingest.py --rebuild       # wipe and reindex
```

Indexes `src/`, `native/`, `docs/`, `scripts/`, `tests/`, `showcase/` plus a
few named root files (`CLAUDE.md`, `README.md`, `AGENTS.md`, `package.json`,
`index.html`). Skips `node_modules/`, `dist/`, `test-results/`, Unreal's
`Intermediate/`, `Saved/`, `Binaries/`. Files larger than 500 KB and any
non-text suffix are skipped.

Chunks are 80-line windows with 15-line overlap, keyed by
`<path>#<start>-<end>#<sha1[:16]>` so re-runs upsert cleanly.

## Query

```bash
python scripts/memory/query.py "where is DETENT_STEP_RADIANS defined"
python scripts/memory/query.py -k 8 --with-neighbors "GDTF pan tilt drive"
python scripts/memory/query.py --body "case-sensitive TMap"
```

Output is one `path:line` citation per hit with a cosine distance score
(lower = closer). `--with-neighbors` prints one graph hop from each hit.
`--body` includes the first 12 lines of the matched chunk.

## What NOT to expect

- **This is retrieval, not reasoning.** It surfaces relevant chunks; a model
  still has to read them and think.
- **The graph is file-level.** Import edges are captured; symbol/reference
  edges are not (yet). Good enough for "what does this touch," not for
  call-graph analysis.
- **No MCP wiring here.** Both scripts are CLIs. Exposing them to agent
  sessions as an MCP server is a separate step — write a small MCP wrapper
  that calls into the same `chromadb.PersistentClient` and `nx.DiGraph`
  loaded from `.memory/`.

## Extending

- **Better import edges:** the current regex catches ES/CommonJS/Python/C++
  imports. Add TS path aliases by piping through `tsc --traceResolution` or
  parsing `tsconfig.json`.
- **Symbol nodes:** run a lightweight symbol pass (Tree-sitter or
  `esprima`/`libclang`) and add `defines`/`references` edges.
- **Cross-workstation sync:** `.memory/` is per-machine. If you want a shared
  index, replace `PersistentClient` with a ChromaDB server and put the graph
  behind a small HTTP wrapper — still $0 self-hosted.
