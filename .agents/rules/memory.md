# Memory System — Automatic Knowledge Management & Context Continuity

> **Priority:** High  
> **Tools:** `memory_start_session`, `memory_get_context`, `memory_observe`, `memory_save_note`, `memory_end_session`, `memory_list_sessions`  
> **Vector Tools:** `vector_memory_search`, `vector_memory_graph`

---

## When to READ Memory (`memory_get_context` / `vector_memory_search`)

Before every implementation or investigation, check if relevant knowledge exists:

```
• Plan new feature       -> `memory_get_context` + `vector_memory_search`
• Debug issue            -> Check `memory_get_context` or old histories via `memory_list_sessions`
• Architecture question  -> Query vector store (`scripts/memory/query.py` or MCP tool)
• Standards / Math check -> Search Drive context (`00_AI_Context`, `03_CONFLICT_REGISTER.md`)
```

### Rule: Session Start
At the start of a new session with a clear scope:
1. `memory_start_session(projectPath, userPrompt)` to begin recording.
2. Perform `memory_get_context(projectPath, currentPrompt)` with the main topic of the request.
3. Incorporate the historical context into planning and code execution.
4. Notify the user when relevant knowledge from past sessions has been loaded.

---

## When to WRITE Memory (`memory_save_note` / `memory_observe`)

Save knowledge automatically after key events:

### Always Save (`decision`, `pattern`, `debug`, `context`)
| Event | Memory Type | Example Key |
|---|---|---|
| Architecture Decision (ADR) | `decision` | `adr-video-mapping-movable-viewport` |
| Tech Stack / Dependency Change | `decision` | `memory-tier-chromadb-onnx-persistent` |
| New Code Pattern established | `pattern` | `pattern-typedarray-memory-pool-dmx` |
| Bug resolved (non-trivial) | `debug` | `debug-continue-on-desktop-modal-fix` |
| Project Convention defined | `context` | `convention-wgs84-ellipsoidal-184m` |

### Often Save (`learning`, `architecture`)
| Event | Memory Type | Example Key |
|---|---|---|
| Lesson learned / Gotcha | `learning` | `gotcha-win32-gdoc-virtual-reparse-points` |
| Architecture Overview | `architecture` | `architecture-express-mcp-gateway-v3` |
| API Design Decision | `decision` | `api-jsonrpc-previs-methods` |
| Performance Optimization | `pattern` | `perf-zero-allocation-512ch-buffer` |

---

## Format for Memories

Every memory note must be rich in context:

```typescript
memory_save_note({
  sessionId: "<current-session-id>",
  userPrompt: "What the user requested",
  aiResponse: "What was implemented (files, functions, interfaces)",
  annotation: "Decision: X, Why: Y, Trade-offs: Z, Relevant files: A, B, C"
})
```

### Key Conventions
- Kebab-case: `video-screen-raster-mapping`
- Prefix by domain: `render-`, `dmx-`, `network-`, `geo-`, `memory-`, `mcp-`
- Versioning when iterative: `mcp-gateway-v1`, `vector-store-v2`

### Tag Conventions
- Max 5 tags per memory
- Always tag affected domain: `viewport`, `dmx`, `rigging`, `electrical`, `memory`, `mcp`
- Always tag technology: `threejs`, `chromadb`, `express`, `typescript`, `python`

---

## Anti-Patterns

- **Saving trivialities**: Only save knowledge useful in a future session or for team continuity.
- **Duplicate memories**: Check existing notes before saving a duplicate; update existing knowledge when appropriate.
- **Context dumping**: Keep notes focused (< 500 words per note). Refer to source files for complete code.
- **Forgetting to End Session**: Always call `memory_end_session` at the completion of a milestone to commit session observations to persistent storage.
