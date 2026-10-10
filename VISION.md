# Elpis Vision

Current workstation source and installed runtime: [Elpis/CURRENT.md](../Elpis/CURRENT.md). This worktree implements the [October 10 continuity/workflow contract](docs/specs/continuity-workflows.md); see `ES.md` for checks and remaining work.

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

Masih selected exact Codex shared behavior and layout on October 9, 2026. The terminal uses that foundation for input, streaming, animations, shortcuts and the agents view. Conflicting Elpis appearance customizations yield to Codex. Retain the hand-selected slash commands and each agent’s model label. On October 10, Masih additionally requested access to the inherited `/review` and `/worktree` workflows. The accepted boundaries are in `docs/specs/codex-parity.md`.

The public website may borrow RAG Studio's standard of polish, but not its composition or palette. It should explain Elpis to someone who has never used an agent harness, show the continuity model directly, and keep experimental work clearly separated from available behavior.

## Truth boundaries

- Memory admission remains a Context Ledger choice. On September 22, 2026, Masih approved replacing the separate-model saver with an explicit guarded save by the responding agent. That candidate is under verification, not yet accepted. September 13 Luna save/recall evidence belongs to the old implementation; general coding-quality benefit remains unproven. See `docs/context.md` for the current contract and limits.
- Automatic context pruning and deterministic work graphs are experimental and off by default. Do not present them as everyday guarantees.
- Historical evaluations may be reported with their original scope and caveats. They do not establish general task-quality improvement.
- Elpis is a Linux-first early-access project. Do not describe the current candidate as production-ready until daily-driver acceptance is complete.
- Local, inspectable state is a product property; provider requests still follow the provider or runtime the user selects.

## Current state — October 10, 2026

Active follow-up: lighter category colors, native gold animation, visible session names and Shift+Tab permission controls are under implementation/verification. They are not installed yet; [the refined contract](docs/specs/codex-parity.md) and `ES.md` distinguish these corrections from the previous installed checkpoint.

The continuity candidate `continuity-7aeef7edb4f6` is installed. It restores inherited review/worktree workflows through the local provider launcher, refreshes admitted context each turn and isolates goals/checkpoints by thread. Final CI run 38032311498 passed all gates; its binaries match the installed runtime, Code Mode host and sandbox byte for byte. The installed launcher passed all seven workflow checks. [Verification and tested rollback](docs/continuity-verification.md) record scope and evidence. Daily-use acceptance remains pending; no release was published.

## Previous checkpoint — October 9, 2026

The accepted September 30 release was v0.4.0 on Codex rust-v0.159.0. The local recovery candidate, Elpis 0.4.1 from `4f44937c2`, was installed on the Codex 0.162.0 foundation. It preserves the selected commands, provider support, Ledger controls, memory/continuity, pruning, dashboard and work graphs. The October 9 follow-up separates Codex user settings from Elpis project settings, corrects the Alt+C hint, replaces category shapes with colored circles, aligns the Ledger bar and displays “Elpising” in Deus Ex gold. It awaits Masih’s daily use and acceptance; no new release was published.

Runtime run 37978565974 passed its configuration, core, provider, permission, session and offline-install checks; its screen-review gate found eight screen differences. Test-only corrections passed the full UI suite in run 37983082438: 5,770 passed, five direct-run exclusions, no unreviewed snapshots. Production code is identical between those runs, and the installed runtime matches the downloaded artifact byte for byte. Four light/dark captures were reviewed, animated gold met the contrast threshold, and all 14 installed-launcher checks passed, including Full Access, folder ordering and model labels. See `docs/permissions-verification.md` for evidence, remaining limits, a short user check and tested rollback. `ES.md` is the continuation note; the accepted contract governs scope.

Runtime source is in `codex-rs/`, provider bridges in `tools/elpis-claude/`, checks in `scripts/` and `tests/`, and product contracts in `docs/`. State remains in `~/.elpis-next`. The website is a separate deployment boundary and is outside this recovery task.

## What this file is for

Resume project work from this identity, current direction and evidence. Keep implementation claims dated and linked to checks. Only Masih can accept the resulting experience.
