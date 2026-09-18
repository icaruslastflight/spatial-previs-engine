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

Indexes `src/`, `native/`, `docs/`, `scripts/`, `tests/`, `showcase/`, `.agents/`
plus a few named root files (`CLAUDE.md`, `README.md`, `AGENTS.md`,
`package.json`, `index.html`, `PRODUCTION_WORKSPACE_SPEC.md`,
`UE5_CONFORMANCE.md`). Skips `node_modules/`, `dist/`, `test-results/`, Unreal's
`Intermediate/`, `Saved/`, `Binaries/`, `.memory/`. Files larger than 1 MB and
any non-text suffix are skipped.

Chunks are 80-line windows with 15-line overlap, keyed by
`<path>#<start>-<end>#<sha1[:16]>` so re-runs upsert cleanly. Every chunk's
metadata carries `category` (code/docs/context/standards/safety_manual/
planning/general) and `platform` (`web` | `native` | `tooling` | `docs` |
`external`, derived from the top-level directory — see `determine_platform()`
in `ingest.py`).

### Drive knowledge base (in-scope, per-workstation)

`ingest.py` also walks two hardcoded Google-Drive-synced roots if present on
the workstation — `G:\My Drive\spatial-previs-engine` and
`G:\My Drive\Spatial Previs Engine - Master Archive` — tagging their chunks
`origin: drive`, `platform: external`, and `.gdoc` reparse points are skipped
(they're not real file content). This is owner-confirmed in-scope for the
memory stack, but it is genuinely per-workstation: a fresh checkout without
that Drive folder mounted simply indexes fewer chunks, silently and without
error (`walk_drive_sources` returns early if the root isn't a directory).
Override the roots with `--drive-path <path>`.

### Shared-constant entity nodes

Alongside file nodes, the graph carries a small, hand-maintained set of
`entity::<NAME>` nodes for CLAUDE.md's own shared numeric constants — each
one carries an explicit unit, a `web_value`, a `native_value` (or `None`
where none is separately tracked), and a `parity_status`:

- `documented-mirrored` — CLAUDE.md states the value is mirrored in UE5
  (the §3 snapping-tolerance table), but this hasn't been independently
  verified against `native/` source.
- `assumed-shared` — governed by CLAUDE.md §1.1's "shared numeric constants
  live in exactly one place" rule but not separately tracked per platform.
- `open` — an actual, acknowledged divergence. Currently only
  `POINT_STATE_PARK_HEIGHT`: web is 184.963 m (CLAUDE.md §2, confirmed in
  `src/geo/GeoAnchor.ts`); native is recorded as 186.6 m, but that number is
  *inferred* from CLAUDE.md §1.1's "corrected from 186.6 m" wording, not
  confirmed against any file under `native/` — `native_value_confidence`
  says so explicitly. Delete this entity's divergence fields once §1.1's
  own note is deleted (i.e. once UE5 takes the fix).

The full current list lives in `SHARED_CONSTANT_ENTITIES` in `ingest.py` —
extend it there; it is deliberately not a generalized symbol parser (see
"Extending" below).

### Cross-platform parity edges

The graph also carries `kind: "parity"` edges (bidirectional) between web
files and their native counterparts that implement the *same documented
contract* — currently just the CLAUDE.md §16 coordinate boundary:
`src/domain/ProjectTransforms.ts` ↔
`native/.../SpatialPrevisCore/Public/SpatialPrevisCoordinates.h` and
`SpatialPrevisUnrealTransform.h`. Sourced only from §16's own table, never
inferred from filename similarity. A parity edge means "these implement the
same contract per CLAUDE.md," **never** "this has been checked equal" —
`query.py --with-neighbors` always prints the manual-verification caveat
alongside it, since native conformance stays manual-only per
`docs/r0/UE5_CONFORMANCE.md` regardless of what the graph can discover. The
event-vocabulary mirroring CLAUDE.md §7.1 also mentions (`EngineEventMap` ↔
"the desktop dispatcher") has no native-side edge yet — there is no
dispatcher file under `native/` to point to (native is still CORE-01;
CORE-02+ event/command dispatch is unimplemented per
`docs/r0/UE5_CONFORMANCE.md`) — add the edge once that file exists rather
than pointing it at nothing.

## Query

```bash
python scripts/memory/query.py "where is DETENT_STEP_RADIANS defined"
python scripts/memory/query.py -k 8 --with-neighbors "GDTF pan tilt drive"
python scripts/memory/query.py --body "case-sensitive TMap"
python scripts/memory/query.py --entity POINT_STATE_PARK_HEIGHT
python scripts/memory/query.py --entity SNAP_THRESHOLD_METERS --json
```

Output is one `path:line` citation per hit with a cosine distance score
(lower = closer) and a `[category/platform]` tag. `--with-neighbors` prints
one graph hop from each hit. `--body` includes the first 12 lines of the
matched chunk. `--entity <NAME>` skips vector search entirely and returns a
shared-constant entity node directly (unit, value per platform, parity
status, source) — substring-matches if the exact name isn't found, and lists
all known entity names if nothing matches.

## MCP server

`mcp_memory_server.py` in this same directory is a stdio JSON-RPC 2.0 server
exposing `vector_memory_search`, `vector_memory_graph`, and a session-tracking
suite (`memory_start_session` / `memory_get_context` / `memory_observe` /
`memory_save_note` / `memory_end_session` / `memory_list_sessions`) that
persists to `.agents/memory/sessions.json`. It calls into this module's own
`query_memory()` rather than reimplementing retrieval, so the CLI stays the
source of truth. Registered as `spatial-previs-memory` in the repo's root
`.mcp.json`, launched with `python scripts/memory/mcp_memory_server.py`.
For the memory-note conventions (what to save, tagging, session lifecycle),
see `.agents/rules/memory.md` and `.agents/skills/elite-agent-memory-system/`
— canonical per `AGENTS.md`'s 18 September 2026 decision.

## What NOT to expect

- **This is retrieval, not reasoning.** It surfaces relevant chunks; a model
  still has to read them and think.
- **The graph is file-level.** Import edges are captured; symbol/reference
  edges are not (yet). Good enough for "what does this touch," not for
  call-graph analysis.
- **Entity nodes are hand-maintained, not derived.** If `GeoAnchor.ts` or
  `SocketSnappingEngine.ts` change without a matching edit to
  `SHARED_CONSTANT_ENTITIES`, the entity node goes stale silently — there is
  no automated check that the two agree (yet; see CI gap below).
- **No CI coverage yet.** `.github/workflows/ci.yml`'s Python step only
  byte-compiles top-level `scripts/*.py` and `scripts/splatlib/*.py` — this
  directory isn't included. Treat local `py_compile` + a manual
  `ingest.py --rebuild` / `query.py` round-trip as the verification step
  until that's added.

## Extending

- **Better import edges:** the current regex catches ES/CommonJS/Python/C++
  imports. Add TS path aliases by piping through `tsc --traceResolution` or
  parsing `tsconfig.json`.
- **Symbol nodes:** run a lightweight symbol pass (Tree-sitter or
  `esprima`/`libclang`) and add `defines`/`references` edges.
- **Cross-workstation sync:** `.memory/` is per-machine. If you want a shared
  index, replace `PersistentClient` with a ChromaDB server and put the graph
  behind a small HTTP wrapper — still $0 self-hosted.
