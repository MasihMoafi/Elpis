<div align="center">

<img src="docs/assets/elpis.webp" alt="Elpis" width="450">

<br>

**Terminal environment for coding agents that keeps the working context small.**

[![Linux verification](https://img.shields.io/github/actions/workflow/status/MasihMoafi/Elpis/embedded-elpis-linux.yml?branch=main&label=verification&style=flat-square)](https://github.com/MasihMoafi/Elpis/actions/workflows/embedded-elpis-linux.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](LICENSE)
[![Telemetry](https://img.shields.io/badge/telemetry-off%20by%20default-brightgreen?style=flat-square)](#privacy-and-ownership)

[Install](#quickstart) • [Features](#core-features) • [Docs](#documentation)

</div>

![Elpis demo](docs/assets/demo.gif)

## Quickstart

Linux x86_64 and macOS on Apple Silicon:

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

The installer picks the right binary for your machine and also installs
[RTK](https://github.com/rtk-ai/rtk), which powers shell-output filtering. On first launch,
choose a provider and sign in or enter its API key.

## What is Elpis

> *You run an agent inside Elpis, and it becomes Elpis.*

The agent runs the model loop. Elpis owns everything around it: context, memory, continuity, retrieval, permissions, and provider choice.

Swap the agent and it inherits the same environment. Nothing about your project has to be explained twice.

<img src="docs/assets/elpises.webp" alt="One Elpis environment, many paths of work running through it" width="720">

Different paths. Same roots. One shared project.

## Why Elpis

Long sessions fill up with transcripts, file reads, searches, and dead ends. What matters gets buried in the story of how the agent got there, and every request pays for it.

Elpis keeps the two apart. The next request gets a small working set you can inspect. The full record stays on disk and is fetched only when it is needed.

**One controlled comparison** — same task, same prompt:

| | Free context at end |
| --- | --- |
| **Elpis** | **93%** |
| Codex | 73% |

<details>
<summary>Screenshots</summary>

Start:

![Starting Elpis](docs/demo/starting-elpis.webp)
![Starting Codex with the same prompt](docs/demo/starting-codex.webp)

End — Elpis, 93% free:

![Elpis end state](docs/demo/elpis-end-state.webp)

End — Codex, 73% free:

![Codex end state](docs/demo/codex-end-state.webp)

This is one recorded workflow, not a claim that every task reduces the same amount.

</details>

## Core Features

### Context pruning on three levels

| Level | What it does | When |
| --- | --- | --- |
| **1. Shell-output filtering** | Supported commands are rewritten through RTK's `PreToolUse` hook, before their output ever reaches the model. In one real investigation it removed 72–97% of three broad `rg` outputs. The installer installs [RTK](https://github.com/rtk-ai/rtk) and Elpis registers the hook on first launch, where you trust it like any other hook. | Before the agent sees it |
| **2. Safety cap** | Deterministic truncation bounds exceptionally large tool output. Inherited from Codex, unchanged. | Before the agent sees it |
| **3. Ace post-turn pass** | Meaning-aware. Useful results become a compact conclusion plus an evidence pointer; dead ends leave the working context entirely. A failed pass changes nothing. | After the work is done |

All three levels ship with Elpis. Inspect the result with `/prune`.

```text
[tool output]
     |
     v
[1. RTK filter]         compact output, exact output on demand
     |
     v
[2. safety cap]         deterministic; only exceptionally large output
     |
     v
[3. active agent turn]  result stays available while the agent works
     |
     v
[4. Ace post-turn pass] meaning-aware; runs after the work is complete
     |
     +-- useful -----> compact conclusion + rollout evidence pointer
     +-- dead end ---> removed from the next working context
     +-- failure ----> original history unchanged
```

### Context Ledger

`Tab` — or `Alt+C` while a turn is running — opens a side panel listing every source admitted into the working set, each with its size and whether it is included. Toggling a row changes what the next turn actually receives, so context selection becomes an intentional operation instead of a side effect.

<img src="docs/assets/context-ledger.webp" alt="The Context Ledger listing admitted instruction files with their token counts and included state" width="400">

### Where the window went

`/context` answers a different question: not what is admitted, but what filled the window. It shows usage as a grid broken down by category — user messages, agent responses, tool calls, system prompt, skills, free space — alongside the backtrack checkpoints you can jump to.

<img src="docs/assets/elpis-context-slash.webp" alt="/context showing token usage as a grid, broken down by category, with available backtrack checkpoints" width="720">

<details>
<summary>Full uncut session — context pruning, ledger, and /context in one recorded run</summary>

![Elpis evidence — full context-management session](docs/assets/evidence.gif)

</details>

### Session continuity

Goal and checkpoint state survive compaction, model switches, and restarts, so work resumes without replaying the transcript. Exact conversations, terminal events, and artifacts remain on disk as durable evidence.

### Memory with provenance

Reusable memory is selective, size-capped, and attributable — every entry records where it came from, and entries are promoted or archived rather than accumulating forever. It is on by default; `/memories` turns recall and writing off independently, and the agent you talk to has no memory-write tool of its own.

### MCP integrations you plug in

Elpis ships no retrieval or speech engine and downloads no models. MCP servers keep optional capabilities in their own processes, with their own dependencies and disk costs; `/mcp` confirms the servers you register are connected.

- **Workspace retrieval:** [rag-mcp](https://github.com/MasihMoafi/rag-mcp) provides local semantic search over your own documents. Its embeddings, vector store, reranker, and any API key remain yours. See [docs/rag.md](docs/rag.md).
- **Voice transcription:** [Voice Commander](https://github.com/MasihMoafi/Voice-commander) records speech, transcribes it locally, and pastes at the active cursor. It remains an external companion; it can expose transcription as an MCP tool rather than adding Whisper, CUDA, Python, or model downloads to Elpis.

### Privacy and ownership

No analytics are uploaded, and every OpenTelemetry exporter defaults to off — telemetry is sent only if you configure an exporter yourself. Bring your own keys: use OpenAI, Anthropic, Gemini, or OpenRouter without one provider being silently routed through another. Durable state is plain files you can inspect, edit, export, or delete.

## Future development

- Windows support.
- Structured clarification and acceptance checks before difficult work.
- Multi-agent controls and visible task coordination.
- `/auto` model routing after it proves a real cost benefit.
- Voice input and LSP-backed code intelligence.


## Documentation

- [Context and pruning](docs/context.md) — the three pruning layers and the Context Ledger
- [Sessions and continuity](docs/sessions.md) — exact resume, lean continuation, `GOAL.md` / `ES.md`
- [Memory](docs/memory.md) — the two-stage pipeline, the archive, and what you control
- [Providers](docs/providers.md) — every supported route, including local inference
- [Workspace retrieval](docs/rag.md) — how to plug in semantic search over your own documents
- [Technical guide](docs/GUIDE.md) — product vision and architecture

## License

Apache-2.0.

The execution foundation — terminal UI, patches, permissions, sandboxing, sessions — derives from OpenAI's Apache-2.0 Codex CLI. Elpis adds the context, continuity, memory, retrieval, and provider-control layer around it. Codex-derived source retains its upstream notices under `codex-rs/`.
