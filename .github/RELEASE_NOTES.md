Elpis is a terminal environment for coding agents. The agent runs the model loop; Elpis owns everything around it — what goes into each request, what stays on disk, and what carries across sessions.

This is the first stable release. It replaces the two earlier preview builds, which have been withdrawn: they predate the pruning correctness work, Elpis's own state directory, and the updater, and should not be installed.

**Install** (Linux x86_64):

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

Already running Elpis? Use `elpis --update`.

**What it does**

- **Context pruning on three levels** — optional RTK shell-output filtering before the agent sees a command's output, Codex's inherited safety cap for exceptionally large output, then Ace's meaning-aware post-turn pass. Useful results become a compact conclusion plus an evidence pointer; dead ends leave working context. In a controlled same-task comparison, Elpis ended with 93% free context against Codex's 73%.
- **Context Ledger** — `/context` lists exactly which files are in the working set and why, with ctrl+clickable paths. Add files, exclude them, or remove them outright.
- **Durable evidence** — full conversations, terminal events, and artifacts stay exact on disk after they leave working context, and can be retrieved later.
- **Portable session continuity** — older history compacts into goal and checkpoint state, so a session resumes without replaying the transcript.
- **Its own state** — configuration, sessions, history, logs, and hooks live under Elpis's own directory, so Elpis and Codex no longer silently alter each other.
- **Self-update** — `elpis --update` verifies the release checksum and replaces the binary atomically, leaving the existing one untouched on any failure.
- **Bounded local memory** — selective and size-capped, backed by provenance.
- **Provider choice** — OpenAI, Anthropic, Gemini, and OpenRouter, chosen explicitly rather than routed silently.
- **No telemetry by default** — no analytics are uploaded, and every OpenTelemetry exporter is off unless you configure one.

**Not in this release:** macOS, Windows, `/auto` routing, multi-agent control, voice input, LSP integration. Local RAG works only from a source checkout.

Verify the download with the matching `.sha256` asset. Full docs in [the readme](https://github.com/MasihMoafi/Elpis#readme).
