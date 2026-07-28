# Internal Read-Only Workspace RAG

`/rag` gives Elpis read-only semantic search over a workspace: ask a question in plain
language, get back relevant excerpts with their source paths, without loading whole files
into the context window.

> **Elpis does not ship a retrieval engine.**
>
> Retrieval means embedding models, a vector store, and — depending on the reranker you
> pick — gigabytes of weights. None of that belongs in a terminal binary, and none of it
> should be downloaded on a user's behalf. Elpis owns the `/rag` surface; you own the
> engine, the models, and the cost.

---

## 1. Architecture

Elpis is the client. The engine is any MCP server you register.

```text
[Elpis TUI / agent]
        |
        |  MCP (stdio JSON-RPC)
        v
[ your retrieval server ]  -- exposes: query_knowledge_base(query, doc_path?)
        |
        v
[ your embeddings + vector store ]  -- local models, Ollama, or a hosted API
```

Elpis contributes the command, the argument parsing, the path picker, and the instruction
that the answer must cite its source paths. Everything below the MCP boundary is yours.

---

## 2. Registering a server

`/rag` looks for a registered and enabled MCP server named `elpis-rag`, `rag-mcp`, or
`rag`, in that order. Add one to `~/.codex/config.toml`:

```toml
[mcp_servers.rag]
command = "/absolute/path/to/your/.venv/bin/python"
args = ["/absolute/path/to/server.py"]
```

Restart Elpis, then confirm with `/mcp`. Until a server is registered, `/rag` refuses and
tells you so — it will not ask the model to answer from retrieval that did not happen.

The server must expose a `query_knowledge_base` tool taking `query` and an optional
`doc_path`. [rag-mcp](https://github.com/MasihMoafi/rag-mcp) is a ready-made local
implementation: hybrid BM25 + vector search with reranking, everything on-device, no API
keys. Any MCP server meeting the same contract works equally well, including one backed by
a hosted embedding API.

---

## 3. Usage

- `/rag <query>` — search the current workspace.
- `/rag <path> -- <query>` — restrict the search to a folder or file.
- `/rag -- <query>` — opens a path picker prefilled with the working directory.

Agents may also call `query_knowledge_base` directly when they need broad discovery before
editing. The tool is read-only; it has no write or edit capability. Exact current-file
evidence is still required before changing a file.

---

## 4. Interaction with the rest of Elpis

- **Context pruning:** returned excerpts enter context as turn-level evidence pointers and
  are pruned after the turn (see [context.md](context.md)).
- **Memory:** durable memory may record a useful query or search strategy, never the
  retrieved document bodies (see [memory.md](memory.md)).
- **Startup:** the retrieval server is a separate process. Its import cost, model loading,
  and memory footprint never enter the TUI's launch path.
