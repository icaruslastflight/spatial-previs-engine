"""Local $0 vector + graph memory over this repo.

Walks a fixed set of source directories, chunks each file, inserts the
chunks into an embedded ChromaDB collection with file/symbol metadata,
and mirrors the file->file import graph into a NetworkX DiGraph that
persists to a pickle beside the vector store.

Everything runs on the workstation with no server processes. The
ChromaDB collection persists to `.memory/chroma/`; the graph pickle to
`.memory/graph.pickle`. Both live outside the tracked tree per
CLAUDE.md §11 (no large binaries in git).

Usage:
    python scripts/memory/ingest.py                    # incremental
    python scripts/memory/ingest.py --rebuild          # wipe and reindex
    python scripts/memory/ingest.py --root <path>      # override repo root
"""

from __future__ import annotations

import argparse
import hashlib
import pickle
import re
import sys
from pathlib import Path
from typing import Iterable

import chromadb
import networkx as nx

INDEXED_DIRS = ("src", "native", "docs", "scripts", "tests", "showcase")
INDEXED_ROOT_FILES = ("CLAUDE.md", "README.md", "AGENTS.md", "package.json", "index.html")

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
})

MAX_FILE_BYTES = 500_000       # skip anything much larger than a source file
CHUNK_LINES = 80               # ~80-line windows keep embeddings coherent
CHUNK_OVERLAP = 15             # continuity between adjacent chunks

# JS/TS/Python import extraction. Each pattern captures the module string.
IMPORT_PATTERNS = (
    re.compile(r"""(?m)^\s*import[^'"`]*['"`]([^'"`\n]+)['"`]"""),
    re.compile(r"""(?m)^\s*(?:import|from)\s+([\w.]+)"""),
    re.compile(r"""(?m)^\s*#include\s+["<]([^">]+)[">]"""),
    re.compile(r"""(?m)require\(['"`]([^'"`\n]+)['"`]\)"""),
)


def is_text_file(path: Path) -> bool:
    if path.suffix.lower() in TEXT_SUFFIXES:
        return True
    if path.name in INDEXED_ROOT_FILES:
        return True
    return False


def walk_indexed(root: Path) -> Iterable[Path]:
    for name in INDEXED_ROOT_FILES:
        candidate = root / name
        if candidate.is_file():
            yield candidate
    for top in INDEXED_DIRS:
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
            yield path


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
    parser.add_argument("--rebuild", action="store_true",
                        help="Wipe .memory/ and reindex from scratch.")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    here = Path(__file__).resolve()
    repo_root = args.root or here.parents[2]
    memory_dir = repo_root / ".memory"
    chroma_dir = memory_dir / "chroma"
    graph_path = memory_dir / "graph.pickle"

    if args.rebuild and memory_dir.exists():
        import shutil
        shutil.rmtree(memory_dir)
    memory_dir.mkdir(parents=True, exist_ok=True)
    chroma_dir.mkdir(parents=True, exist_ok=True)

    client = chromadb.PersistentClient(path=str(chroma_dir))
    collection = client.get_or_create_collection("spatial-previs-engine")

    # Load or start the file-level import graph.
    if graph_path.exists() and not args.rebuild:
        with graph_path.open("rb") as handle:
            graph = pickle.load(handle)
    else:
        graph = nx.DiGraph()

    # Batch inserts — Chroma's HTTP-optional PersistentClient still benefits.
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
    for path in walk_indexed(repo_root):
        rel = path.relative_to(repo_root).as_posix()
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        file_count += 1
        graph.add_node(rel, kind="file", suffix=path.suffix.lower())
        for target in imports_from(text):
            # File-level import edges; targets stay raw and resolve later.
            graph.add_edge(rel, target, kind="imports")
        for start, end, body in chunk_lines(text):
            chunk_id = f"{rel}#{start}-{end}#{content_hash(body)}"
            batch_ids.append(chunk_id)
            batch_docs.append(body)
            batch_meta.append({
                "path": rel,
                "start_line": start,
                "end_line": end,
                "suffix": path.suffix.lower(),
                "size": len(body),
            })
            chunk_count += 1
            if len(batch_ids) >= 128:
                flush()
        if not args.quiet and file_count % 25 == 0:
            print(f"  indexed {file_count} files / {chunk_count} chunks", file=sys.stderr)
    flush()

    with graph_path.open("wb") as handle:
        pickle.dump(graph, handle)

    if not args.quiet:
        print(
            f"Indexed {file_count} files / {chunk_count} chunks; "
            f"graph has {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges."
        )
        print(f"Vector store: {chroma_dir}")
        print(f"Graph pickle: {graph_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
