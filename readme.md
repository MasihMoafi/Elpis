# Elpis

[![Linux verification](https://github.com/MasihMoafi/Elpis/actions/workflows/embedded-elpis-linux.yml/badge.svg)](https://github.com/MasihMoafi/Elpis/actions/workflows/embedded-elpis-linux.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Quickstart

Linux x86_64:

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/main/scripts/install-elpis.sh | bash
elpis
```

On first launch, choose a provider and sign in or enter its API key.

## What is Elpis

Elpis is a terminal environment for coding agents. You put an agent into Elpis, and it becomes Elpis.

The agent runs the model loop. Elpis owns the environment around it: context, continuity, memory, permissions, evidence, and explicit provider choice.

### Elpises

Elpis is the shared environment, not any one agent. Put an agent inside it and the agent inherits the same context, memory, permissions, evidence, and control.

![Elpises working on different paths of one shared Elpis environment](docs/assets/elpises.svg)

Multiple Elpises working from those shared roots is a direction for the project, not a claim that multi-agent control ships in `v0.1.1`.

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

## Demo

![Elpis demo](docs/assets/demo-linkedin.gif)

### Evidence — full context-management session

The clip above is a 25-second highlight. The recording below captures an uncut agent session showing Elpis's context loop in action: how working state is pruned post-turn, how the Context Ledger tracks the live file set, and how goal and checkpoint state survive across compaction events. Watch it to see the 93 vs 73% numbers produced in real time.

![Elpis evidence — full session](docs/assets/evidence.gif)

## Current state

`v0.1.1`, Linux x86_64. Not in this release: macOS, Windows, `/auto` routing, multi-agent control, voice input, LSP integration.

Full status and backlog: [TASKS.md](TASKS.md).

The execution foundation — terminal UI, patches, permissions, sandboxing, sessions — derives from OpenAI's Apache-2.0 Codex CLI. Elpis adds the context, continuity, memory, retrieval, and provider-control layer around it.

<details>
<summary>Other install methods</summary>

**Direct binary download**

```bash
mkdir -p "$HOME/.local/bin"
curl -fL --progress-bar -o "$HOME/.local/bin/elpis" https://github.com/MasihMoafi/Elpis/releases/latest/download/elpis-linux-x86_64
chmod 755 "$HOME/.local/bin/elpis"
```

**Debian / Ubuntu**

```bash
deb_url=$(curl -s https://api.github.com/repos/MasihMoafi/Elpis/releases/latest | grep -oE '"browser_download_url": *"[^"]*\.deb"' | grep -v sha256 | cut -d '"' -f4)
curl -fL --progress-bar -o elpis.deb "$deb_url"
sudo dpkg -i elpis.deb
```

Both methods install to `~/.local/bin`, which must be on your `PATH`.

</details>

## Documentation

- [Context and sessions](https://masihmoafi.github.io/Elpis/context-and-sessions/)
- [Memory](https://masihmoafi.github.io/Elpis/memory/)
- [Providers](https://masihmoafi.github.io/Elpis/providers/)
- [`GUIDE.md`](GUIDE.md) — product vision and architecture
- [`TASKS.md`](TASKS.md) — release state and backlog

## License

MIT. Codex-derived source retains its upstream Apache-2.0 notices and attribution.
