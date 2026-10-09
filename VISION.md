# Elpis Vision

Elpis is the continuity layer around an AI coding runtime.

The user should be able to change a provider, model, or local runtime without losing the working agreement that makes an agent useful: the current goal, admitted context, permissions, decisions, and evidence. Elpis owns that durable boundary; the provider owns inference.

## Product promise

**Change the runtime. Keep the thread.**

Elpis should make four things visible and inspectable:

1. **Goal** — what the current session is trying to accomplish.
2. **Context** — which project instructions and memories were deliberately admitted.
3. **Control** — which tools and permissions the runtime may use.
4. **Evidence** — what changed, what was verified, and what remains unknown.

## Design direction

Masih selected exact Codex shared behavior and layout on October 9, 2026. The terminal uses that foundation for input, streaming, animations, shortcuts and the agents view. Conflicting Elpis appearance customizations yield to Codex. Keep the hand-selected slash commands unchanged and retain each agent’s model label. The accepted boundaries are in `docs/specs/codex-parity.md`.

The public website may borrow RAG Studio's standard of polish, but not its composition or palette. It should explain Elpis to someone who has never used an agent harness, show the continuity model directly, and keep experimental work clearly separated from available behavior.

## Truth boundaries

- Memory admission remains a Context Ledger choice. On September 22, 2026, Masih approved replacing the separate-model saver with an explicit guarded save by the responding agent. That candidate is under verification, not yet accepted. September 13 Luna save/recall evidence belongs to the old implementation; general coding-quality benefit remains unproven. See `docs/context.md` for the current contract and limits.
- Automatic context pruning and deterministic work graphs are experimental and off by default. Do not present them as everyday guarantees.
- Historical evaluations may be reported with their original scope and caveats. They do not establish general task-quality improvement.
- Elpis is a Linux-first early-access project. Do not describe the current candidate as production-ready until daily-driver acceptance is complete.
- Local, inspectable state is a product property; provider requests still follow the provider or runtime the user selects.

## Current state — October 9, 2026

The accepted September 30 release was v0.4.0 on Codex rust-v0.159.0. The current recovery candidate targets the installed Codex 0.162.0 foundation and preserves Elpis providers, Ledger controls, memory/continuity, pruning, dashboard and work graphs. It is under verification, not accepted or installed.

Core, UI, CLI and their tests compiled in CI 37918373073. Later permission fixes are undergoing new compiler checks. A complete runtime build and behavior checks are still pending. `docs/permissions-verification.md` distinguishes old-engine failures from candidate evidence. `ES.md` is the local continuation note; the accepted contract governs scope.

Runtime source is in `codex-rs/`, provider bridges in `tools/elpis-claude/`, checks in `scripts/` and `tests/`, and product contracts in `docs/`. State remains in `~/.elpis-next`. The website is a separate deployment boundary and is outside this recovery task.

## What this file is for

Resume project work from this identity, current direction and evidence. Keep implementation claims dated and linked to checks. Only Masih can accept the resulting experience.
