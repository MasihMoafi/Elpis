# Elpis

## Quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install-elpis.sh | bash && ~/.local/bin/elpis
```

## Demo

![Elpis demo](docs/assets/demo-linkedin.gif)

<details>
<summary>Full evidence session</summary>

![Elpis evidence — full context-management session](docs/assets/evidence.gif)

</details>

## What is Elpis

Elpis is a shared working environment for coding agents. Whichever agent you choose
receives the same context, memory, permissions, evidence, and continuity.

### Elpises

An Elpis is an agent working inside that environment. Different Elpises can research,
build, test, or review along different paths while staying rooted in the same project.

<img src="docs/assets/elpises.png" alt="Elpises working on different paths of one shared Elpis environment" width="720">

Different paths. Same roots. One shared project.

## Why Elpis

Long agent sessions accumulate transcripts, file reads, searches, command output, and dead ends. The useful state gets buried in the history of how the agent reached it, while every request pays for more context.

Elpis separates working context from durable evidence. The next request receives a small, inspectable working set; the exact record stays on disk and is retrieved only when needed.

**One controlled comparison** — same task, same prompt:

| | Free context at end |
| --- | --- |
| **Elpis** | **93%** |
| Codex | 73% |

<details>
<summary>Screenshots</summary>

Start:

![Starting Elpis](docs/demo/starting-elpis.png)
![Starting Codex with the same prompt](docs/demo/starting-codex.png)

End — Elpis, 93% free:

![Elpis end state](docs/demo/elpis-end-state.png)

End — Codex, 73% free:

![Codex end state](docs/demo/codex-end-state.png)

This is one recorded workflow, not a claim that every task reduces the same amount.

</details>

## Core Features

- **Managed context** — Ace performs meaning-aware post-turn pruning while Codex's inherited safety cap bounds exceptionally large tool output. Inspect pruning with `/prune`.
- **Portable continuity** — goal and checkpoint state survive compaction and restarts, so work resumes without replaying the full transcript.
- **Visible context** — the Context Ledger shows exactly which files are in the working set, with ctrl+clickable paths for inspection.
- **Durable evidence and bounded memory** — exact conversations, terminal events, and artifacts remain on disk; reusable memory stays selective, size-capped, and attributable.
- **Explicit provider choice** — use OpenAI, Anthropic, Gemini, or OpenRouter without silently routing one provider through another.
- **Visible safety controls** — Read Only, Default, and Full Access modes keep file changes, commands, approvals, and results inspectable.
- **No analytics by default** — Elpis does not upload usage analytics, and all OpenTelemetry exporters default to off. Telemetry is sent only if you explicitly configure an OTEL exporter.
- **Local read-only RAG** — from a source checkout, `scripts/setup-rag.sh` adds semantic search over local knowledge without granting write access.

## How context moves

```text
[1. Tool output]
        |
        v
[2. Codex safety cap]       deterministic; only exceptionally large output
        |
        v
[3. Active agent turn]      result remains available while the agent works
        |
        v
[4. Ace post-turn pass]     meaning-aware; runs after the work is complete
        |
        +-- useful --------> compact conclusion + rollout evidence pointer
        +-- dead end ------> removed from the next working context
        +-- failure -------> original history remains unchanged

Reasoning state:
active turn -> retained
completed turn -> expired deterministically from working history
```

> **Diagram placeholder — operating model.** Awaiting approved replacement artwork.

> **Diagram placeholder — context lifecycle.** Awaiting approved replacement artwork.

The execution foundation — terminal UI, patches, permissions, sandboxing, sessions — derives from OpenAI's Apache-2.0 Codex CLI. Elpis adds the context, continuity, memory, retrieval, and provider-control layer around it.

## Future development

- Apple Silicon macOS support, followed by Windows.
- Structured clarification and acceptance checks before difficult work.
- Multi-agent controls and visible task coordination.
- `/auto` model routing after it proves a real cost benefit.
- Voice input and LSP-backed code intelligence.

Full roadmap: [TASKS.md](TASKS.md).

## Documentation

- [Context and sessions](https://masihmoafi.github.io/Elpis/context-and-sessions/)
- [Memory](https://masihmoafi.github.io/Elpis/memory/)
- [Providers](https://masihmoafi.github.io/Elpis/providers/)
- [`GUIDE.md`](GUIDE.md) — product vision and architecture
- [`TASKS.md`](TASKS.md) — release state and backlog

## License

[![Linux verification](https://github.com/MasihMoafi/Elpis/actions/workflows/embedded-elpis-linux.yml/badge.svg)](https://github.com/MasihMoafi/Elpis/actions/workflows/embedded-elpis-linux.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MIT. Codex-derived source retains its upstream Apache-2.0 notices and attribution.
