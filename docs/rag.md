# Workspace Retrieval

Semantic search over your own files — ask a question in plain language, get back relevant
excerpts with their source paths, instead of reading files one at a time or loading a whole
tree into the context window.

> **Elpis does not provide this. It lets you plug it in.**
>
> Retrieval means embedding models, a vector store, and — depending on the reranker — many
> gigabytes of weights. A Qwen reranker alone is around 8GB. None of that fits in a terminal
> binary, and none of it should be downloaded on a user's behalf. Elpis has no retrieval
> engine and no `/rag` command; it has MCP, which is the general mechanism for exactly this.

## How to add it

Register any MCP server that exposes a retrieval tool. `~/.codex/config.toml`:

```toml
[mcp_servers.rag]
command = "/absolute/path/to/.venv/bin/python"
args = ["/absolute/path/to/server.py"]
```

Restart Elpis and run `/mcp` to confirm it connected. From then on the agent calls it the
way it calls any other tool — ask for what you want in plain language and name a folder if
you want the search scoped.

[rag-mcp](https://github.com/MasihMoafi/rag-mcp) is a ready-made local implementation:
hybrid BM25 plus vector search with reranking, everything on-device, no API keys. Its
readme carries the current setup steps. Any MCP server meeting the same contract works
equally well, including one backed by a hosted embedding API — that choice, and its cost,
is yours.

## Why it is not built in

The engine used to live in this repository. It pinned PyTorch, which is roughly 2.5GB, and
that single fact made retrieval unreachable from every binary install: you cannot ship it
in a release artifact, and you cannot ask someone who ran a one-line installer to wait for
a multi-gigabyte download. Moving the engine out did not reduce what Elpis can do — it moved
the cost to the person who decides to pay it.

The rule that follows: never add a machine-learning dependency to this repository. See
`docs/SHIPPING_RULES.md`.

## What Elpis still owns

- **Context pruning** — excerpts a retrieval tool returns are tool output like any other,
  so they are pruned after the turn rather than accumulating (see [context.md](context.md)).
- **Memory** — durable memory may record a useful query or search strategy, never the
  retrieved document bodies (see [memory.md](memory.md)).
- **Startup** — an MCP server runs in its own process. Its imports, model loading, and
  indexing cost cannot reach the TUI's launch path no matter how heavy the engine is.
