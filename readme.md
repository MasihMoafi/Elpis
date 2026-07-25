# Elpis

[![Linux verification](https://github.com/MasihMoafi/Elpis/actions/workflows/embedded-elpis-linux.yml/badge.svg)](https://github.com/MasihMoafi/Elpis/actions/workflows/embedded-elpis-linux.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**You run an agent inside Elpis, and it becomes Elpis.**

Elpis is a terminal shell for coding agents. It keeps one local control environment around the active agent: context, memory, continuity, permissions, evidence, and provider/runtime choice.

Instead of treating the full transcript as the agent's state, Elpis keeps the current working set small and inspectable while preserving exact conversations, tool output, and artifacts on disk.

**Current release:** `v0.1.1` for Linux x86_64. Release acceptance and live development state are tracked in [TASKS.md](TASKS.md).

**One controlled comparison:** same task, same prompt — Elpis finished with **93% free context**, Codex with **73%**. Screenshots: [proof below](#context-pruning-one-controlled-comparison).

## Install

### Latest release

```bash
mkdir -p "$HOME/.local/bin"
curl -fL --progress-bar -o "$HOME/.local/bin/elpis" https://github.com/MasihMoafi/Elpis/releases/latest/download/elpis-linux-x86_64
chmod 755 "$HOME/.local/bin/elpis"
elpis
```

This assumes `~/.local/bin` is on your `PATH`.

### Clone the repository

```bash
git clone https://github.com/MasihMoafi/Elpis.git
cd Elpis
./scripts/install-elpis.sh
elpis
```

The installer downloads the latest checksummed Linux x86_64 release and installs it atomically into `~/.local/bin`.

### Debian / Ubuntu

```bash
deb_url=$(curl -s https://api.github.com/repos/MasihMoafi/Elpis/releases/latest | grep -oE '"browser_download_url": *"[^"]*\.deb"' | grep -v sha256 | cut -d '"' -f4)
curl -fL --progress-bar -o elpis.deb "$deb_url"
sudo dpkg -i elpis.deb
```

On first launch, Elpis asks you to choose a provider and complete sign-in or API-key setup.

## Demo

![Elpis demo](docs/assets/elpis-demo.gif)

## Why Elpis exists

Long coding-agent sessions accumulate transcripts, file reads, searches, command output, and failed paths. The useful state of the work can become difficult to distinguish from the history of how the agent got there.

Elpis separates those things.

- **Working context** is the small set admitted into the next model request.
- **Evidence** stays exact and durable even when it is no longer in working context.
- **Continuity** preserves goals and checkpoints without replaying the whole transcript.
- **Memory** is bounded, selective, and backed by provenance.
- **Runtime choice** stays explicit instead of silently collapsing every provider into one route.

The selected agent still performs the model loop. Elpis owns the environment around it.

## Context pruning: one controlled comparison

The screenshots below show Elpis and Codex running the same task. In this recorded comparison, Elpis ended with **93% free context** and Codex with **73% free context**.

This demonstrates one controlled workflow, not a claim that every task will produce the same reduction.

### Start

![Starting Elpis](docs/demo/starting-elpis.png)
![Starting Codex with the same prompt](docs/demo/starting-codex.png)

### End

**Elpis: 93% free context remaining**

![Elpis end state](docs/demo/elpis-end-state.png)

**Codex: 73% free context remaining**

![Codex end state](docs/demo/codex-end-state.png)

## How it works

Elpis uses three context-reduction layers:

| Layer | What happens | Inspection |
| --- | --- | --- |
| Tool cleanup | Oversized stdout/stderr becomes compact head/tail receipts | `/status`, evidence pointers |
| Model pruning | Transient conversation material is removed while useful decisions are retained | `/prune`, pruning report |
| Session compaction | Older history becomes portable goal/checkpoint state | Context Ledger, `/usage`, rollout logs |

Full conversations, terminal events, and artifacts remain on disk. Elpis can retrieve exact evidence later instead of attaching the full history to every request.

The execution foundation — terminal UI, patches, permissions, sandboxing, and sessions — is derived from OpenAI's Apache-2.0 Codex CLI. Elpis adds its context, continuity, memory, retrieval, and provider-control layer around that execution loop.

## Current state

`v0.1.1` ships a Linux x86_64 release with a checksummed installer, the Ratatui
terminal UI, dual-layer pruning (deterministic tool receipts plus Ace message
pruning), the Context Ledger with ctrl+clickable context files, portable session
continuity, bounded local memory, local read-only RAG, and
OpenAI/Anthropic/Gemini/OpenRouter provider support. macOS, Windows, `/auto`
routing, multi-agent control, voice input, and LSP integration are not in
`v0.1.1`.

Full status, in-progress work, and the backlog: [TASKS.md](TASKS.md).

## Documentation

- [Context and sessions](https://masihmoafi.github.io/Elpis/context-and-sessions/)
- [Memory](https://masihmoafi.github.io/Elpis/memory/)
- [Providers](https://masihmoafi.github.io/Elpis/providers/)
- [`GUIDE.md`](GUIDE.md) — product vision and architecture
- [`TASKS.md`](TASKS.md) — release state and backlog
- [`docs/BUILD_AND_REDUCTION_AUDIT.md`](docs/BUILD_AND_REDUCTION_AUDIT.md) — measured build and reduction work

## License

Elpis is MIT licensed. Codex-derived source retains its upstream Apache-2.0 notices and attribution.
