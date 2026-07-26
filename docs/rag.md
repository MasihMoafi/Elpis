# Internal Read-Only Workspace RAG

Elpis can run a **read-only workspace RAG** (Retrieval-Augmented Generation) service for semantic discovery over project documentation, codebase files, and external reference materials, without cluttering the agent's active context window.

!!! warning "Requires a source checkout"

    This service is **not reachable from a binary install**. The `.deb` package and the `curl` installer ship the Rust binary only; the RAG service is a separate Python sidecar that lives in the repository.

    To use it you need a source checkout, [`uv`](https://docs.astral.sh/uv/), and a run of `scripts/setup-rag.sh`, which creates the virtualenv in place and writes an absolute-path `mcp_servers.elpis-rag` block into your `config.toml`. Re-run it after moving the checkout. Reaching binary installs is [tracked work](https://github.com/MasihMoafi/Elpis/blob/main/TASKS.md).

---

## 1. Systemic Architecture

The RAG pipeline operates as an isolated Python MCP (Model Context Protocol) microservice that communicates directly with the Rust TUI:

```text
[Elpis TUI / Agent Core]
          |
          |  (Stdio MCP JSON-RPC handshake)
          v
+---------+-------------------------------------------------------+
|              PYTHON RAG MCP SERVICE (`elpis-rag`)               |
|  Exposes tool: `query_knowledge_base(query, path)`              |
+---------+-------------------------------------------------------+
          |
          v  (Lazy loads PyTorch + Embeddings on first query)
+---------+-------------------------------------------------------+
|                    QDRANT VECTOR ENGINE                         |
|  - Local Mode: Persistent disk index under workspace            |
|  - Cloud Mode: Remote Qdrant cluster endpoint                   |
+-----------------------------------------------------------------+
```

---

## 2. Fast Startup & Lazy Loading

Importing the machine-learning stack is slow enough to be felt at startup, so Elpis isolates the RAG service from the launch path:

- **Standard-library handshake:** `src/agent/host.py` imports nothing beyond the Python standard library at module scope, so the MCP protocol handshake is answered without loading any machine-learning stack.
- **Lazy Dependency Loading (`rag.fetch`):** Heavier dependencies (PyTorch, SentenceTransformers, Qdrant client) load only when `query_knowledge_base` runs, via `importlib.import_module("rag.fetch")` inside the tool handler itself.
- **Out-of-process:** The service is a separate MCP process, so its memory footprint and import cost never enter the TUI's address space.

---

## 3. Command Usage & Tool Invocation

Users and agents can invoke semantic search across the workspace using the `/rag` command or MCP tool:

### User Slash Commands
- `/rag <query>`: Executes a workspace-wide semantic vector search and returns relevant markdown excerpts with file pointers.
- `/rag <path> -- <query>`: Restricts semantic search to a specific subdirectory or file target.

### Autonomous Agent Tool
- **`query_knowledge_base`:** Agents can call this tool autonomously when needing broad context or searching for concepts across unfamiliar files before modifying code.
- **Read-Only Safety Guarantee:** The RAG tool is strictly read-only. It has no filesystem write or edit capabilities.

---

## 4. Systemic Inter-Dependencies

- **Integration with Context Pruning:** Excerpts returned by `/rag` are injected into context as temporary `turn`-level evidence pointers, which are automatically pruned post-turn by Ace (see `docs/context.md`).
- **Integration with Memory:** Durable memory (`MEMORY.md`) can store successful `/rag` query keys and search strategies without duplicating full document content (see `docs/memory.md`).
