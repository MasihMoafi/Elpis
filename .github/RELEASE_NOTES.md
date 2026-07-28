Elpis is a terminal environment for coding agents. The agent runs the model loop; Elpis owns everything around it — what goes into each request, what stays on disk, and what carries across sessions.

**Install** (Linux x86_64):

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

**Install** (macOS, Apple Silicon):

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

The macOS build is CI-proven — it's tested headlessly in the release pipeline on real Apple Silicon runners — but not yet verified on a developer's own machine. Report anything unexpected.

Already running Elpis? Use `elpis --update`.

**What's new since 0.1.0**

- **macOS (Apple Silicon)** — first release with a native `arm64` build. Intel Macs are not supported; the installer will tell you to use Rosetta if you try.
- **RAG removed** — the bundled retrieval engine (a Python/PyTorch sidecar) and the `/rag` command are gone. Retrieval is now a capability you register like any other tool, via MCP; ask in plain language and the agent calls it and cites sources.
- **Durable memory on by default** — was off by default in 0.1.0.
- **Dev-rule files now load on any machine** — previously the Context Ledger only found a project's dev-rule files (`skills/dev/*.md`) if they happened to sit in a folder next to the project. Fixed: it now also checks a fixed location under Elpis's home directory, so the rules travel with the machine, not the project's disk layout.
- **Context Ledger: durable memory row is toggleable** — the keyboard toggle silently excluded the memory row from selection; fixed.
- Startup cost measured and reduced; debug builds now flag themselves instead of pretending to be a release build.

**What it does**

- **Context pruning on three levels** — optional RTK shell-output filtering before the agent sees a command's output, Codex's inherited safety cap for exceptionally large output, then Ace's meaning-aware post-turn pass. Useful results become a compact conclusion plus an evidence pointer; dead ends leave working context. In a controlled same-task comparison, Elpis ended with 93% free context against Codex's 73%.
- **Context Ledger** — `/context` lists exactly which files are in the working set and why, with ctrl+clickable paths. Add files, exclude them, or remove them outright.
- **Durable evidence** — full conversations, terminal events, and artifacts stay exact on disk after they leave working context, and can be retrieved later.
- **Portable session continuity** — older history compacts into goal and checkpoint state, so a session resumes without replaying the transcript.
- **Its own state** — configuration, sessions, history, logs, and hooks live under Elpis's own directory, so Elpis and Codex no longer silently alter each other.
- **Self-update** — `elpis --update` verifies the release checksum and replaces the binary atomically, leaving the existing one untouched on any failure.
- **Bounded local memory** — selective and size-capped, backed by provenance, and now on by default.
- **Provider choice** — OpenAI, Anthropic, Gemini, and OpenRouter, chosen explicitly rather than routed silently.
- **No telemetry by default** — no analytics are uploaded, and every OpenTelemetry exporter is off unless you configure one.

**Not in this release:** Windows, `/auto` routing, multi-agent control, voice input, LSP integration.

Verify the download with the matching `.sha256` asset. Full docs in [the readme](https://github.com/MasihMoafi/Elpis#readme).
