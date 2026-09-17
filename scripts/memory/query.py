"""Query the repo's local $0 memory.

Sends a natural-language query through the embedded ChromaDB collection
built by `scripts/memory/ingest.py` and prints the top-k matching chunks
with `path:line` citations. Optionally walks the NetworkX import graph
one hop from each hit to surface related files.

Usage:
    python scripts/memory/query.py "where is the socket-snapping detent step defined?"
    python scripts/memory/query.py -k 5 --with-neighbors "GDTF pan/tilt"
"""

from __future__ import annotations

import argparse
import pickle
import sys
from pathlib import Path

import chromadb
import networkx as nx


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", nargs="+", help="Free-form query text.")
    parser.add_argument("--root", type=Path, default=None,
                        help="Repo root (default: parent of scripts/ directory).")
    parser.add_argument("-k", type=int, default=5, help="Top-k chunks (default 5).")
    parser.add_argument("--with-neighbors", action="store_true",
                        help="Also print files reached by one graph hop.")
    parser.add_argument("--body", action="store_true",
                        help="Print the matched chunk body, not just the citation.")
    args = parser.parse_args()

    here = Path(__file__).resolve()
    repo_root = args.root or here.parents[2]
    memory_dir = repo_root / ".memory"
    chroma_dir = memory_dir / "chroma"
    graph_path = memory_dir / "graph.pickle"

    if not chroma_dir.is_dir():
        print(f"No vector store at {chroma_dir}. Run scripts/memory/ingest.py first.",
              file=sys.stderr)
        return 2

    client = chromadb.PersistentClient(path=str(chroma_dir))
    collection = client.get_or_create_collection("spatial-previs-engine")
    result = collection.query(query_texts=[" ".join(args.query)], n_results=args.k)

    docs = result.get("documents", [[]])[0]
    metas = result.get("metadatas", [[]])[0]
    distances = result.get("distances", [[]])[0]

    if not docs:
        print("(no matches)")
        return 0

    graph: nx.DiGraph | None = None
    if args.with_neighbors and graph_path.exists():
        with graph_path.open("rb") as handle:
            graph = pickle.load(handle)

    print(f"Top {len(docs)} for: {' '.join(args.query)}\n")
    for i, (doc, meta, distance) in enumerate(zip(docs, metas, distances), start=1):
        path = meta.get("path", "?")
        start = meta.get("start_line", "?")
        end = meta.get("end_line", "?")
        # Smaller distance is a closer match in Chroma's default cosine space.
        print(f"[{i}] {path}:{start}-{end}  (score {distance:.3f})")
        if args.body:
            print("    " + "\n    ".join(doc.splitlines()[:12]))
            if len(doc.splitlines()) > 12:
                print("    ...")
        if graph is not None and path in graph:
            neighbors = sorted(graph.successors(path))
            if neighbors:
                print(f"    imports -> {', '.join(neighbors[:6])}"
                      + (" ..." if len(neighbors) > 6 else ""))
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
