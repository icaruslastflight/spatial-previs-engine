---
name: memory-system
description: How to use this repo's persistent AI memory (session tracking + vector/graph search via scripts/memory/mcp_memory_server.py). Load this before starting a nontrivial task, when deciding what to save after a decision/bugfix, or when asked "what did we do before" / "why is this implemented like this".
---

# Memory system usage

The canonical instructions for this repo's memory-system workflow live in
`.agents/rules/memory.md` and `.agents/skills/{elite-agent-memory-system,
rag-implementation, spatial-previs-memory}/SKILL.md` — owner decision, 18
September 2026 (see `AGENTS.md`). This file is a thin pointer into that
tree, not a duplicate, for the same reason `phased-plan` and
`domain-correctness-review` point into `scripts/ai-tools/metaprompt.py`
rather than re-deriving its wording: two copies of the same instructions
drift, one copy with a pointer doesn't.

Read those files before:
- Starting a new task with a clear scope (`memory_start_session` +
  `memory_get_context`).
- Making an architecture decision, establishing a pattern, or resolving a
  non-trivial bug (`memory_save_note`).
- Answering "what did we do before" / "why is this implemented like this"
  (`memory_list_sessions`, `vector_memory_search`).

The MCP server backing these tools (`scripts/memory/mcp_memory_server.py`)
is registered as `spatial-previs-memory` in the repo's root `.mcp.json` —
see CLAUDE.md §14 for what it does and does not persist (session state to
`.agents/memory/sessions.json`, vector/graph data to `.memory/`, both
git-ignored, both $0/local).
