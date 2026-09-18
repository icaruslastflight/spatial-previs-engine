"""Query the repo's local $0 memory and Drive knowledge base.

Sends a natural-language query through the embedded ChromaDB collection
built by `scripts/memory/ingest.py` and prints the top-k matching chunks
with `path:line` citations. Optionally filters by category and walks
the NetworkX graph 1 hop.

Usage:
    python scripts/memory/query.py "where is DETENT_STEP_RADIANS defined"
    python scripts/memory/query.py -k 5 --category context "spatial anchor Point State Park"
    python scripts/memory/query.py --json "laser MPE safety limit"
"""

from __future__ import annotations

import argparse
import json
import pickle
import sys
from pathlib import Path

import chromadb
import networkx as nx


def query_entity(name: str, repo_root: Path) -> dict:
    """Look up a shared-constant entity node (unit, per-platform value,
    parity_status) added by ingest.py's SHARED_CONSTANT_ENTITIES list --
    a direct lookup instead of a vector-similarity guess for values that
    are known, named constants rather than free text."""
    graph_path = repo_root / ".memory" / "graph.pickle"
    if not graph_path.exists():
        return {"error": f"No graph at {graph_path}. Run scripts/memory/ingest.py first."}
    with graph_path.open("rb") as handle:
        graph = pickle.load(handle)

    node_id = f"entity::{name}"
    if node_id not in graph:
        matches = [
            n for n, data in graph.nodes(data=True)
            if data.get("kind") == "entity" and name.lower() in n.lower()
        ]
        if not matches:
            entities = [n for n, d in graph.nodes(data=True) if d.get("kind") == "entity"]
            return {"error": f"No entity named '{name}'. Known entities: {entities}"}
        node_id = matches[0]

    data = dict(graph.nodes[node_id])
    data.pop("kind", None)
    return {"entity": data}


def query_memory(
    query_text: str,
    repo_root: Path,
    k: int = 5,
    category: str | None = None,
    with_neighbors: bool = False,
) -> dict:
    memory_dir = repo_root / ".memory"
    chroma_dir = memory_dir / "chroma"
    graph_path = memory_dir / "graph.pickle"

    if not chroma_dir.is_dir():
        return {"error": f"No vector store at {chroma_dir}. Run scripts/memory/ingest.py first."}

    client = chromadb.PersistentClient(path=str(chroma_dir))
    collection = client.get_or_create_collection("spatial-previs-engine")

    where_clause = {"category": category} if category else None
    result = collection.query(
        query_texts=[query_text],
        n_results=k,
        where=where_clause
    )

    docs = result.get("documents", [[]])[0]
    metas = result.get("metadatas", [[]])[0]
    distances = result.get("distances", [[]])[0]
    ids = result.get("ids", [[]])[0]

    graph: nx.DiGraph | None = None
    if with_neighbors and graph_path.exists():
        try:
            with graph_path.open("rb") as handle:
                graph = pickle.load(handle)
        except Exception:
            graph = None

    hits = []
    for doc, meta, distance, chunk_id in zip(docs, metas, distances, ids):
        path = meta.get("path", "?")
        start = meta.get("start_line", 1)
        end = meta.get("end_line", 1)
        cat = meta.get("category", "general")
        origin = meta.get("origin", "repo")
        platform = meta.get("platform", "docs")

        neighbors = []
        if graph is not None and path in graph:
            neighbors = list(graph.successors(path))[:10]

        hits.append({
            "id": chunk_id,
            "path": path,
            "start_line": start,
            "end_line": end,
            "distance": round(distance, 4),
            "category": cat,
            "platform": platform,
            "origin": origin,
            "body": doc,
            "neighbors": neighbors,
        })

    return {
        "query": query_text,
        "category": category,
        "count": len(hits),
        "hits": hits
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", nargs="*", help="Free-form query text.")
    parser.add_argument("--root", type=Path, default=None,
                        help="Repo root (default: parent of scripts/ directory).")
    parser.add_argument("-k", type=int, default=5, help="Top-k chunks (default 5).")
    parser.add_argument("--category", type=str, default=None,
                        help="Filter by category (code, docs, context, standards, safety_manual, planning).")
    parser.add_argument("--entity", type=str, default=None,
                        help="Direct lookup of a shared-constant entity node by name "
                             "(e.g. POINT_STATE_PARK_HEIGHT, SNAP_THRESHOLD_METERS) "
                             "instead of a vector-similarity search.")
    parser.add_argument("--with-neighbors", action="store_true",
                        help="Also print files reached by one graph hop.")
    parser.add_argument("--body", action="store_true",
                        help="Print the matched chunk body, not just the citation.")
    parser.add_argument("--json", action="store_true",
                        help="Output results in JSON format.")
    args = parser.parse_args()

    here = Path(__file__).resolve()
    repo_root = args.root or here.parents[2]

    if args.entity:
        res = query_entity(args.entity, repo_root)
        if "error" in res:
            print(res["error"], file=sys.stderr)
            return 2
        if args.json:
            print(json.dumps(res, indent=2))
            return 0
        entity = res["entity"]
        print(f"{entity['name']}  [{entity['unit']}]  parity_status={entity['parity_status']}")
        print(f"  web:    {entity['web_value']}")
        print(f"  native: {entity['native_value']}  ({entity['native_value_confidence']})")
        print(f"  source: {entity['source']}")
        return 0

    if not args.query:
        parser.error("query text is required unless --entity is given")
    query_str = " ".join(args.query)

    res = query_memory(
        query_text=query_str,
        repo_root=repo_root,
        k=args.k,
        category=args.category,
        with_neighbors=args.with_neighbors,
    )

    if "error" in res:
        print(res["error"], file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(res, indent=2))
        return 0

    hits = res["hits"]
    if not hits:
        print(f"No matches found for query: '{query_str}'")
        return 0

    cat_label = f" [Category: {args.category}]" if args.category else ""
    print(f"Top {len(hits)} matches for: '{query_str}'{cat_label}\n")

    for i, hit in enumerate(hits, start=1):
        print(f"[{i}] {hit['path']}:{hit['start_line']}-{hit['end_line']}  (distance: {hit['distance']}) [{hit['category']}/{hit['platform']}]")
        if args.body:
            snippet = "\n    ".join(hit["body"].splitlines()[:15])
            print(f"    {snippet}")
            if len(hit["body"].splitlines()) > 15:
                print("    ...")
        if hit["neighbors"]:
            print(f"    graph -> {', '.join(hit['neighbors'][:6])}")
        print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
