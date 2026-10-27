# Elpis Vision

Elpis is the continuity layer around an AI coding runtime: a Linux terminal app and a desktop app that share one engine and one state folder, `~/.elpis-next`.

The user should be able to change a provider, model, or local runtime without losing the working agreement that makes an agent useful: the current goal, admitted context, permissions, decisions, and evidence. Elpis owns that durable boundary; the provider owns the model.

## Product promise

**Change the runtime. Keep the thread.**

Elpis makes four things visible and inspectable:

1. **Goal** — what the current session is trying to accomplish.
2. **Context** — which project instructions and memories were deliberately admitted.
3. **Control** — which tools and permissions the runtime may use.
4. **Evidence** — what changed, what was verified, and what remains unknown.

## Design direction

The terminal keeps the exact Codex shared behavior and layout (Masih, 9 Oct 2026); Elpis appearance customizations yield to Codex. The desktop app copies the ChatGPT and Claude desktop apps first and departs only for a stated reason. Its look comes from shared tokens and components, never from per-screen styling.

## Truth boundaries

- Automatic context pruning and deterministic work graphs are experimental. Do not present them as everyday guarantees.
- Historical evaluations may be reported with their original scope and caveats. They do not establish general task-quality improvement.
- Elpis is a Linux-first early-access project. It is not production-ready until Masih accepts daily-driver use.
- Local, inspectable state is a product property; provider requests follow the provider or runtime the user selects.

## Map

- `codex-rs/` — engine and terminal app (Rust, built on Codex).
- `apps/elpis-desktop/` — desktop app: Electron shell, Next renderer, Node bridge. `SPEC.md` is its requirement list.
- `tools/elpis-claude/` — provider bridges (Claude and others) that the terminal and desktop apps talk through.
- `scripts/`, `tests/`, `tools/verify-elpis/` — checks. `docs/` — guide and reference. `website/` — a separate deployment boundary.

## Current state

Read [the project handoff](docs/HANDOFF.md) before editing or installing. It owns the dated installed/candidate state, remaining checks and worktree triage. Older session notes are historical.

## What this file is for

Resume project work from this identity and its dated state. Keep claims dated and linked to checks. Only Masih can accept the resulting experience.
