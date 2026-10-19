# TUI configured providers — 19 October 2026

Contract: the worker brief `tui-credits-provider.md`, supplied by Masih.

- `/model` → provider picker lists configured providers, including Anthropic promotional credits, after the existing ordered providers. Hidden built-in providers stay hidden unless active; no duplicates.
- Search and Enter browse the selected provider; selecting its model uses that provider and its existing `provider-keys.json` entry. Never display keys or fall back to the built-in Anthropic entry's key.
- Before each paid `anthropic-credits` request, read `$XDG_CONFIG_HOME/elpis/anthropic-credits-budget.env` (default `~/.config/elpis/…`). Refuse missing, malformed, nonfinite or negative values, and a balance at or below the configured buffer. Other providers and free model discovery remain unaffected.
- This is a manual balance snapshot gate, not live balance metering. Spending after the snapshot remains unmeasured; do not claim a guaranteed account-wide spending cap.
- Prove picker selection and saved-key routing with isolated homes and fake-key HTTP mocks. Prove refusal reaches no vendor. Run tests on old code to establish failure, then run the affected files.
- Build under the worker's six-core thermal/resource guard, install with `scripts/install-engine.sh` under a new name, and run one short Opus 5.5 turn in tmux with a disposable copied profile. Trash credential copies. Record installed hash and rollback command.

Scope excludes desktop changes, real-profile config/auth edits, downloads, pushes, and extra paid turns. Masih retains functional acceptance.
