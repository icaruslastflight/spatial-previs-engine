"""Local $0 vector + graph memory over this repo and Drive knowledge base.

Walks source directories and Google Drive context folders, chunks each file,
inserts chunks into an embedded ChromaDB collection with rich metadata, and
mirrors the file->file import graph into a NetworkX DiGraph that persists to
a pickle beside the vector store.

Everything runs on the workstation with no server processes. The ChromaDB
collection persists to `.memory/chroma/`; the graph pickle to
`.memory/graph.pickle`. Both live outside the tracked tree per CLAUDE.md sec. 11.

Usage:
    python scripts/memory/ingest.py                    # incremental upsert
    python scripts/memory/ingest.py --rebuild          # wipe and reindex
    python scripts/memory/ingest.py --root <path>      # override repo root
    python scripts/memory/ingest.py --drive-path <p>   # override Drive context path
"""

from __future__ import annotations

import argparse
import hashlib
import pickle
import re
import sys
from pathlib import Path
from typing import Iterable, Tuple

import chromadb
import networkx as nx

INDEXED_REPO_DIRS = ("src", "native", "docs", "scripts", "tests", "showcase", ".agents")
INDEXED_ROOT_FILES = (
    "CLAUDE.md", "README.md", "AGENTS.md", "package.json", "index.html",
    "PRODUCTION_WORKSPACE_SPEC.md", "UE5_CONFORMANCE.md"
)

DEFAULT_DRIVE_ROOTS = (
    Path(r"G:\My Drive\spatial-previs-engine"),
    Path(r"G:\My Drive\Spatial Previs Engine - Master Archive"),
)

TEXT_SUFFIXES = frozenset({
    ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonc",
    ".cpp", ".c", ".cc", ".h", ".hpp", ".cs",
    ".py", ".sh", ".ps1", ".cmd", ".bat",
    ".md", ".mdx", ".rst", ".txt", ".html", ".css", ".xml", ".ini", ".yaml", ".yml",
    ".uproject", ".build.cs", ".target.cs",
})

EXCLUDED_DIRS = frozenset({
    "node_modules", ".git", "dist", "build", "test-results",
    "Intermediate", "Saved", "Binaries", ".memory", "__pycache__", ".vscode",
    ".tempmediaStorage",
})

MAX_FILE_BYTES = 1_000_000      # 1MB limit per text file
CHUNK_LINES = 80               # ~80-line windows keep embeddings coherent
CHUNK_OVERLAP = 15             # continuity between adjacent chunks

# JS/TS/Python/C++ import extraction
IMPORT_PATTERNS = (
    re.compile(r"""(?m)^\s*import[^'"`]*['"`]([^'"`\n]+)['"`]"""),
    re.compile(r"""(?m)^\s*(?:import|from)\s+([\w.]+)"""),
    re.compile(r"""(?m)^\s*#include\s+["<]([^">]+)[">]"""),
    re.compile(r"""(?m)require\(['"`]([^'"`\n]+)['"`]\)"""),
)


def is_text_file(path: Path) -> bool:
    # Skip virtual Google Docs files that are reparse points (.gdoc)
    if path.suffix.lower() == ".gdoc":
        return False
    if path.suffix.lower() in TEXT_SUFFIXES:
        return True
    if path.name in INDEXED_ROOT_FILES:
        return True
    return False


def determine_platform(path_str: str) -> str:
    """Which platform a file belongs to -- web (src/vitest side), native
    (UE5.8/C++), tooling (dev-time scripts, not shipped to either platform),
    docs, or external (Drive-sourced, belongs to neither platform's source
    tree). Coarse and directory-based on purpose: this is a retrieval hint,
    not a build-system classification."""
    lower = path_str.lower().replace("\\", "/")
    top = lower.split("/", 1)[0]
    if top == "native":
        return "native"
    if top == ".agents" or top == "docs":
        return "docs"
    if top in ("src", "tests", "showcase"):
        return "web"
    if top == "scripts":
        return "tooling"
    if path_str in ("package.json", "index.html"):
        return "web"
    if path_str in ("CLAUDE.md", "README.md", "AGENTS.md",
                    "PRODUCTION_WORKSPACE_SPEC.md", "UE5_CONFORMANCE.md"):
        return "docs"
    return "docs"


# Shared-constant entity nodes: a small, hand-maintained list rather than a
# generalized symbol parser (see README's "Extending" section for why this
# stays manual for now). Each carries its unit explicitly -- the whole point
# is that a query should never hand back a bare, unit-less number for a
# value CLAUDE.md defines in metres/degrees. `parity_status` distinguishes
# CLAUDE.md's own documented-mirrored constants (sec. 3's snapping tolerances)
# from the one open, unresolved divergence (sec. 1.1/sec. 2's site-anchor height) --
# collapsing that distinction would be exactly the mistake sec. 1.1 warns against.
SHARED_CONSTANT_ENTITIES = (
    {
        "name": "POINT_STATE_PARK_HEIGHT",
        "unit": "metres, WGS84 ellipsoidal",
        "web_value": 184.963,
        "native_value": 186.6,
        "native_value_confidence": "inferred from CLAUDE.md sec. 1.1 wording "
            "('corrected from 186.6 m'); not directly confirmed in any "
            "native/ source file as of this ingest",
        "parity_status": "open",
        "source": "CLAUDE.md sec. 1.1, sec. 2; src/geo/GeoAnchor.ts (POINT_STATE_PARK)",
    },
    {
        "name": "POINT_STATE_PARK_LATITUDE",
        "unit": "degrees, signed (north positive)",
        "web_value": 40.4417,
        "native_value": None,
        "native_value_confidence": "not separately tracked; assumed shared "
            "per CLAUDE.md sec. 1.1's shared-numeric-constants rule",
        "parity_status": "assumed-shared",
        "source": "CLAUDE.md sec. 2; src/geo/GeoAnchor.ts (POINT_STATE_PARK)",
    },
    {
        "name": "POINT_STATE_PARK_LONGITUDE",
        "unit": "degrees, signed (west negative)",
        "web_value": -80.0075,
        "native_value": None,
        "native_value_confidence": "not separately tracked; assumed shared "
            "per CLAUDE.md sec. 1.1's shared-numeric-constants rule",
        "parity_status": "assumed-shared",
        "source": "CLAUDE.md sec. 2; src/geo/GeoAnchor.ts (POINT_STATE_PARK)",
    },
    {
        "name": "SNAP_THRESHOLD_METERS",
        "unit": "metres",
        "web_value": 0.15,
        "native_value": 0.15,
        "native_value_confidence": "documented as mirrored in CLAUDE.md sec. 3's "
            "table; not independently verified against native/ source",
        "parity_status": "documented-mirrored",
        "source": "CLAUDE.md sec. 3; src/engine/SocketSnappingEngine.ts",
    },
    {
        "name": "SNAP_ANGLE_RADIANS",
        "unit": "degrees (angular CAPTURE WINDOW -- not the detent step)",
        "web_value": 15,
        "native_value": 15,
        "native_value_confidence": "documented as mirrored in CLAUDE.md sec. 3's "
            "table; not independently verified against native/ source",
        "parity_status": "documented-mirrored",
        "source": "CLAUDE.md sec. 3",
    },
    {
        "name": "DETENT_STEP_RADIANS",
        "unit": "degrees (roll DETENT STEP -- not the capture window)",
        "web_value": 90,
        "native_value": 90,
        "native_value_confidence": "documented as mirrored in CLAUDE.md sec. 3's "
            "table; not independently verified against native/ source",
        "parity_status": "documented-mirrored",
        "source": "CLAUDE.md sec. 3",
    },
)


def add_entity_nodes(graph: nx.DiGraph) -> None:
    for entity in SHARED_CONSTANT_ENTITIES:
        graph.add_node(
            f"entity::{entity['name']}",
            kind="entity",
            **entity,
        )


# Cross-platform parity edges: web file <-> native file pairs that implement
# the SAME documented contract (CLAUDE.md sec. 16's coordinate-boundary table),
# sourced only from that table -- never inferred from filename similarity.
# `query.py --with-neighbors` labels these distinctly from ordinary `imports`
# edges and always prints the manual-verification caveat, because a graph
# edge here means "these two files implement the same documented contract",
# never "this has been checked equal" -- native conformance stays manual per
# docs/r0/UE5_CONFORMANCE.md regardless of what the graph can discover.
MANUAL_VERIFICATION_CAVEAT = (
    "parity edge: same documented contract (CLAUDE.md sec. 16), NOT independently "
    "verified equal -- native conformance is manual-only per docs/r0/UE5_CONFORMANCE.md"
)

PARITY_EDGES = (
    (
        "src/domain/ProjectTransforms.ts",
        "native/SpatialPrevis/Source/SpatialPrevisCore/Public/SpatialPrevisCoordinates.h",
        "coordinate-boundary codec: position/direction/quaternion conversion "
        "(CLAUDE.md sec. 16's axes/units/quaternion table)",
    ),
    (
        "src/domain/ProjectTransforms.ts",
        "native/SpatialPrevis/Source/SpatialPrevisCore/Public/SpatialPrevisUnrealTransform.h",
        "coordinate-boundary codec: FTransform construction wrapping "
        "SpatialPrevisCoordinates' conversion functions",
    ),
)


def add_parity_edges(graph: nx.DiGraph) -> None:
    for web_path, native_path, note in PARITY_EDGES:
        if web_path not in graph or native_path not in graph:
            # One or both files are missing from this ingest (e.g. native/
            # wasn't checked out, or the file moved) -- skip rather than add
            # a dangling edge to a node that was never indexed.
            continue
        graph.add_edge(web_path, native_path, kind="parity", note=note,
                       caveat=MANUAL_VERIFICATION_CAVEAT)
        graph.add_edge(native_path, web_path, kind="parity", note=note,
                       caveat=MANUAL_VERIFICATION_CAVEAT)


def determine_category(path_str: str) -> str:
    lower = path_str.lower().replace("\\", "/")
    if "00_ai_context" in lower:
        return "context"
    if "conflict_register" in lower:
        return "conflict_register"
    if "knowledge base" in lower or "standards" in lower:
        return "standards"
    if "laser" in lower or "safety" in lower:
        return "safety_manual"
    if "planning" in lower or "architecture" in lower:
        return "planning"
    if "src/" in lower or "native/" in lower or "scripts/" in lower:
        return "code"
    if "docs/" in lower or ".agents/" in lower or lower.endswith(".md"):
        return "docs"
    return "general"


def walk_repo(root: Path) -> Iterable[Tuple[Path, str]]:
    for name in INDEXED_ROOT_FILES:
        candidate = root / name
        if candidate.is_file():
            yield candidate, "repo"
    for top in INDEXED_REPO_DIRS:
        base = root / top
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            if any(part in EXCLUDED_DIRS for part in path.parts):
                continue
            if not is_text_file(path):
                continue
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            yield path, "repo"


def walk_drive_sources(drive_root: Path) -> Iterable[Tuple[Path, str]]:
    if not drive_root.is_dir():
        return
    for path in drive_root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in EXCLUDED_DIRS for part in path.parts):
            continue
        if not is_text_file(path):
            continue
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        yield path, "drive"


def chunk_lines(text: str) -> list[tuple[int, int, str]]:
    """Return (start_line, end_line, body) triples over ~CHUNK_LINES windows."""
    lines = text.splitlines()
    if not lines:
        return []
    chunks: list[tuple[int, int, str]] = []
    step = max(1, CHUNK_LINES - CHUNK_OVERLAP)
    for start in range(0, len(lines), step):
        end = min(len(lines), start + CHUNK_LINES)
        body = "\n".join(lines[start:end])
        if body.strip():
            chunks.append((start + 1, end, body))
        if end == len(lines):
            break
    return chunks


def content_hash(body: str) -> str:
    return hashlib.sha1(body.encode("utf-8", errors="replace")).hexdigest()[:16]


def imports_from(body: str) -> list[str]:
    seen: list[str] = []
    for pattern in IMPORT_PATTERNS:
        for match in pattern.findall(body):
            if match not in seen:
                seen.append(match)
    return seen


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=None,
                        help="Repo root (default: parent of scripts/ directory).")
    parser.add_argument("--drive-path", type=Path, default=None,
                        help="Drive context root.")
    parser.add_argument("--rebuild", action="store_true",
                        help="Wipe .memory/ and reindex from scratch.")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    here = Path(__file__).resolve()
    repo_root = args.root or here.parents[2]
    memory_dir = repo_root / ".memory"
    chroma_dir = memory_dir / "chroma"
    graph_path = memory_dir / "graph.pickle"

    memory_dir.mkdir(parents=True, exist_ok=True)
    chroma_dir.mkdir(parents=True, exist_ok=True)

    client = chromadb.PersistentClient(path=str(chroma_dir))
    if args.rebuild:
        try:
            client.delete_collection("spatial-previs-engine")
        except Exception:
            pass
        if graph_path.exists():
            try:
                graph_path.unlink()
            except Exception:
                pass

    collection = client.get_or_create_collection(
        name="spatial-previs-engine",
        metadata={"description": "Spatial Previs Engine codebase and Drive knowledge base"}
    )

    # Load or start the graph
    if graph_path.exists() and not args.rebuild:
        with graph_path.open("rb") as handle:
            graph = pickle.load(handle)
    else:
        graph = nx.DiGraph()

    batch_ids: list[str] = []
    batch_docs: list[str] = []
    batch_meta: list[dict] = []

    def flush() -> None:
        if not batch_ids:
            return
        collection.upsert(ids=batch_ids, documents=batch_docs, metadatas=batch_meta)
        batch_ids.clear()
        batch_docs.clear()
        batch_meta.clear()

    file_count = 0
    chunk_count = 0

    # 1. Index Repo files
    for path, origin in walk_repo(repo_root):
        rel = path.relative_to(repo_root).as_posix()
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        file_count += 1
        category = determine_category(rel)
        platform = determine_platform(rel)
        graph.add_node(rel, kind="file", origin=origin, category=category,
                       platform=platform, suffix=path.suffix.lower())
        for target in imports_from(text):
            graph.add_edge(rel, target, kind="imports")
        for start, end, body in chunk_lines(text):
            chunk_id = f"repo::{rel}#{start}-{end}#{content_hash(body)}"
            batch_ids.append(chunk_id)
            batch_docs.append(body)
            batch_meta.append({
                "path": rel,
                "origin": origin,
                "category": category,
                "platform": platform,
                "start_line": start,
                "end_line": end,
                "suffix": path.suffix.lower(),
                "size": len(body),
            })
            chunk_count += 1
            if len(batch_ids) >= 128:
                flush()
        if not args.quiet and file_count % 30 == 0:
            print(f"  indexed {file_count} files / {chunk_count} chunks", file=sys.stderr)

    # 2. Index Drive files
    drive_roots = [args.drive_path] if args.drive_path else [d for d in DEFAULT_DRIVE_ROOTS if d.is_dir()]
    drive_file_count = 0
    for drive_root in drive_roots:
        if not args.quiet:
            print(f"Scanning Drive knowledge base at: {drive_root}", file=sys.stderr)
        for path, origin in walk_drive_sources(drive_root):
            try:
                rel = path.relative_to(drive_root).as_posix()
                display_path = f"drive://{drive_root.name}/{rel}"
            except ValueError:
                display_path = str(path)
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            file_count += 1
            drive_file_count += 1
            category = determine_category(display_path)
            graph.add_node(display_path, kind="drive_doc", origin="drive", category=category,
                           platform="external", suffix=path.suffix.lower())
            for start, end, body in chunk_lines(text):
                chunk_id = f"drive::{display_path}#{start}-{end}#{content_hash(body)}"
                batch_ids.append(chunk_id)
                batch_docs.append(body)
                batch_meta.append({
                    "path": display_path,
                    "origin": origin,
                    "category": category,
                    "platform": "external",
                    "start_line": start,
                    "end_line": end,
                    "suffix": path.suffix.lower(),
                    "size": len(body),
                })
                chunk_count += 1
                if len(batch_ids) >= 128:
                    flush()

    flush()

    add_entity_nodes(graph)
    add_parity_edges(graph)

    with graph_path.open("wb") as handle:
        pickle.dump(graph, handle)

    if not args.quiet:
        print(
            f"Successfully indexed {file_count} total files ({drive_file_count} from Drive) / {chunk_count} chunks."
        )
        print(f"Graph nodes: {graph.number_of_nodes()}, edges: {graph.number_of_edges()}")
        print(f"ChromaDB store: {chroma_dir}")
        print(f"Graph pickle: {graph_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
