Elpis is a terminal shell for coding agents. The agent runs the model loop; Elpis owns everything around it — what goes into each request, what stays on disk, and what carries across sessions.

**Install** (Linux x86_64):

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install-elpis.sh | bash
elpis
```

**Main features, in priority order**

- **Managed context** — Ace prunes completed tool exploration after the active agent finishes using it, while Codex's inherited safety cap bounds exceptionally large output. In a controlled same-task comparison, Elpis ended with 93% free context against Codex's 73%.
- **Context Ledger** — a live, ctrl+clickable list of exactly which files are in the working set.
- **Durable evidence** — full conversations, terminal events, and artifacts stay exact on disk after they leave working context, and can be retrieved later.
- **Portable session continuity** — older history compacts into goal and checkpoint state, so a session resumes without replaying the transcript.
- **Bounded local memory** — selective and size-capped, backed by provenance.
- **Provider choice** — OpenAI, Anthropic, Gemini, and OpenRouter, chosen explicitly rather than routed silently.
- **Local read-only RAG** — query a local knowledge base from inside the session.

**Not in this release:** macOS, Windows, `/auto` routing, multi-agent control, voice input, LSP integration.

Verify the download with the matching `.sha256` asset. Full docs in [the readme](https://github.com/MasihMoafi/Elpis#readme).
