"""Model Context Protocol (MCP) stdio server for Vector Memory & Agent Context.

Implements JSON-RPC 2.0 over stdio conforming to the MCP specification:
- Tools:
  - vector_memory_search(query, k, category)
  - vector_memory_graph(path, depth)
  - memory_start_session(projectPath, userPrompt)
  - memory_get_context(projectPath, currentPrompt)
  - memory_observe(sessionId, action, details)
  - memory_save_note(sessionId, userPrompt, aiResponse, annotation)
  - memory_end_session(sessionId)
  - memory_list_sessions(projectPath, limit)

Zero external API dependencies. Persists vector search in `.memory/chroma/`,
graph in `.memory/graph.pickle`, and agent session state in `.agents/memory/sessions.json`.
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path

# Add script directory to sys.path to import query_memory
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

from query import query_memory

AGENTS_MEMORY_DIR = REPO_ROOT / ".agents" / "memory"
AGENTS_MEMORY_DIR.mkdir(parents=True, exist_ok=True)
SESSIONS_FILE = AGENTS_MEMORY_DIR / "sessions.json"


def load_sessions() -> dict:
    if SESSIONS_FILE.exists():
        try:
            with SESSIONS_FILE.open("r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {"sessions": {}}
    return {"sessions": {}}


def save_sessions(data: dict) -> None:
    with SESSIONS_FILE.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# Tool implementations
def tool_vector_memory_search(params: dict) -> dict:
    query = params.get("query", "")
    k = int(params.get("k", 5))
    category = params.get("category", None)
    res = query_memory(query, REPO_ROOT, k=k, category=category, with_neighbors=True)
    return res


def tool_vector_memory_graph(params: dict) -> dict:
    path = params.get("path", "")
    graph_path = REPO_ROOT / ".memory" / "graph.pickle"
    if not graph_path.exists():
        return {"error": "Graph pickle does not exist. Run scripts/memory/ingest.py first."}
    import pickle
    with graph_path.open("rb") as f:
        g = pickle.load(f)
    if path not in g:
        # Try matching substring
        matches = [n for n in g.nodes if path.lower() in n.lower()]
        if not matches:
            return {"path": path, "found": False, "neighbors": []}
        path = matches[0]
    
    successors = list(g.successors(path))
    predecessors = list(g.predecessors(path))
    return {
        "path": path,
        "found": True,
        "imports": successors,
        "imported_by": predecessors,
        "total_nodes": g.number_of_nodes(),
        "total_edges": g.number_of_edges()
    }


def tool_memory_start_session(params: dict) -> dict:
    project_path = params.get("projectPath", str(REPO_ROOT))
    user_prompt = params.get("userPrompt", "")
    session_id = f"session_{int(time.time())}_{uuid.uuid4().hex[:6]}"
    
    data = load_sessions()
    data["sessions"][session_id] = {
        "sessionId": session_id,
        "projectPath": project_path,
        "userPrompt": user_prompt,
        "startTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "endTime": None,
        "status": "active",
        "observations": [],
        "notes": []
    }
    save_sessions(data)
    return {"sessionId": session_id, "status": "started", "projectPath": project_path}


def tool_memory_get_context(params: dict) -> dict:
    project_path = params.get("projectPath", str(REPO_ROOT))
    current_prompt = params.get("currentPrompt", "")
    
    data = load_sessions()
    sessions = list(data["sessions"].values())
    recent_sessions = sorted(sessions, key=lambda s: s.get("startTime", ""), reverse=True)[:5]
    
    # Also perform vector search on currentPrompt if provided
    vector_context = []
    if current_prompt:
        try:
            v_res = query_memory(current_prompt, REPO_ROOT, k=3)
            if "hits" in v_res:
                vector_context = [{
                    "path": h["path"],
                    "lines": f"{h['start_line']}-{h['end_line']}",
                    "category": h["category"],
                    "body": h["body"][:250] + "..."
                } for h in v_res["hits"]]
        except Exception:
            pass

    return {
        "projectPath": project_path,
        "recentSessions": [{
            "sessionId": s["sessionId"],
            "prompt": s["userPrompt"],
            "startTime": s["startTime"],
            "notesCount": len(s.get("notes", [])),
            "observationsCount": len(s.get("observations", []))
        } for s in recent_sessions],
        "vectorContext": vector_context
    }


def tool_memory_observe(params: dict) -> dict:
    session_id = params.get("sessionId", "")
    action = params.get("action", "")
    details = params.get("details", "")
    
    data = load_sessions()
    session = data["sessions"].get(session_id)
    if not session:
        # Create ad-hoc session if not started
        session = {
            "sessionId": session_id,
            "startTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "status": "active",
            "observations": [],
            "notes": []
        }
        data["sessions"][session_id] = session
        
    session["observations"].append({
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "action": action,
        "details": details
    })
    save_sessions(data)
    return {"status": "observed", "sessionId": session_id, "action": action}


def tool_memory_save_note(params: dict) -> dict:
    session_id = params.get("sessionId", "")
    user_prompt = params.get("userPrompt", "")
    ai_response = params.get("aiResponse", "")
    annotation = params.get("annotation", "")
    
    data = load_sessions()
    session = data["sessions"].get(session_id)
    if not session:
        session = {
            "sessionId": session_id,
            "startTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "status": "active",
            "observations": [],
            "notes": []
        }
        data["sessions"][session_id] = session
        
    note_id = f"note_{int(time.time())}_{uuid.uuid4().hex[:4]}"
    session["notes"].append({
        "noteId": note_id,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "userPrompt": user_prompt,
        "aiResponse": ai_response,
        "annotation": annotation
    })
    save_sessions(data)
    return {"status": "saved", "sessionId": session_id, "noteId": note_id}


def tool_memory_end_session(params: dict) -> dict:
    session_id = params.get("sessionId", "")
    data = load_sessions()
    session = data["sessions"].get(session_id)
    if not session:
        return {"error": f"Session '{session_id}' not found"}
    
    session["endTime"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    session["status"] = "completed"
    save_sessions(data)
    return {
        "sessionId": session_id,
        "status": "completed",
        "observationsCount": len(session.get("observations", [])),
        "notesCount": len(session.get("notes", []))
    }


def tool_memory_list_sessions(params: dict) -> dict:
    limit = int(params.get("limit", 10))
    data = load_sessions()
    sessions = list(data["sessions"].values())
    sorted_sessions = sorted(sessions, key=lambda s: s.get("startTime", ""), reverse=True)[:limit]
    return {
        "total": len(sessions),
        "sessions": sorted_sessions
    }


TOOLS = {
    "vector_memory_search": {
        "description": "Query the local ChromaDB vector index over the repo codebase and Drive knowledge base.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language query or code symbol"},
                "k": {"type": "integer", "description": "Number of matches (default 5)"},
                "category": {"type": "string", "description": "Optional category filter: code, docs, context, standards, safety_manual, planning"}
            },
            "required": ["query"]
        },
        "handler": tool_vector_memory_search
    },
    "vector_memory_graph": {
        "description": "Walk the file-level import/dependency graph starting from a file path.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative file path or file name"},
                "depth": {"type": "integer", "description": "Graph traversal depth (default 1)"}
            },
            "required": ["path"]
        },
        "handler": tool_vector_memory_graph
    },
    "memory_start_session": {
        "description": "Start a new persistent agent tracking session for the current workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "projectPath": {"type": "string", "description": "Path to workspace"},
                "userPrompt": {"type": "string", "description": "User request prompt"}
            },
            "required": ["projectPath", "userPrompt"]
        },
        "handler": tool_memory_start_session
    },
    "memory_get_context": {
        "description": "Load historical sessions, past architecture decisions, and vector context.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "projectPath": {"type": "string", "description": "Path to workspace"},
                "currentPrompt": {"type": "string", "description": "Current task topic or prompt"}
            },
            "required": ["projectPath"]
        },
        "handler": tool_memory_get_context
    },
    "memory_observe": {
        "description": "Record an important implementation action during the session.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string", "description": "Active session ID"},
                "action": {"type": "string", "description": "Action performed (e.g. Created file, Refactored function)"},
                "details": {"type": "string", "description": "Specific details, files, and diffs"}
            },
            "required": ["sessionId", "action", "details"]
        },
        "handler": tool_memory_observe
    },
    "memory_save_note": {
        "description": "Save an architecture decision (ADR), gotcha, convention, or debugging lesson.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string", "description": "Active session ID"},
                "userPrompt": {"type": "string", "description": "The user request or problem"},
                "aiResponse": {"type": "string", "description": "What was implemented"},
                "annotation": {"type": "string", "description": "Decision, trade-offs, gotchas, and affected files"}
            },
            "required": ["sessionId", "userPrompt", "aiResponse", "annotation"]
        },
        "handler": tool_memory_save_note
    },
    "memory_end_session": {
        "description": "Close an active session and persist summary to long-term memory.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string", "description": "Active session ID"}
            },
            "required": ["sessionId"]
        },
        "handler": tool_memory_end_session
    },
    "memory_list_sessions": {
        "description": "List previous sessions and historical notes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "projectPath": {"type": "string", "description": "Workspace path"},
                "limit": {"type": "integer", "description": "Max sessions to return"}
            }
        },
        "handler": tool_memory_list_sessions
    }
}


def handle_request(req: dict) -> dict | None:
    msg_id = req.get("id")
    method = req.get("method", "")
    params = req.get("params", {})

    if method == "tools/list":
        tool_list = []
        for name, meta in TOOLS.items():
            tool_list.append({
                "name": name,
                "description": meta["description"],
                "inputSchema": meta["inputSchema"]
            })
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": tool_list}}

    if method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})
        if tool_name not in TOOLS:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Tool '{tool_name}' not found"}
            }
        try:
            handler = TOOLS[tool_name]["handler"]
            res = handler(arguments)
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(res, indent=2)}]
                }
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32000, "message": str(e)}
            }

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "spatial-previs-memory-server",
                    "version": "1.0.0"
                }
            }
        }

    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method '{method}' not found"}
    }


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            res = handle_request(req)
            if res:
                sys.stdout.write(json.dumps(res) + "\n")
                sys.stdout.flush()
        except Exception as e:
            err = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(e)}}
            sys.stdout.write(json.dumps(err) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
