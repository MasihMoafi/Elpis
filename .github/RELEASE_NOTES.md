Elpis v0.4.1 moves the terminal runtime to Codex rust-v0.160.0 and adds `elpis claude`. State from v0.4.0 stays compatible.

Changes since v0.4.0:

- `elpis claude` starts the Claude Code CLI and runs Smart Prune on its requests through a loopback proxy. It is not a model provider for Elpis sessions. `/dashboard` shows the tokens that it saves.
- A new wrapper theme: gold titles, thin teal rules around the composer, popups and Context Ledger, and the Codex status indicator.
- `/model` shows the provider rows first, and each provider shows one time.
- Rewind (Esc, Esc, then Enter) also starts when the Context Ledger has focus.
- In full-screen mode, the Context Ledger hides when it would leave fewer than 8 transcript rows.
- A subagent spawn, resume or close fails when Elpis cannot save its state. Before, the subagent ran without a record and held an agent slot.

Linux x86_64 only. The installer and Debian package include the Code Mode host that GPT-6/5.6 tools need and the bundled Linux sandbox. Each executable and Debian package has a SHA-256 sidecar.

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/v0.4.1/scripts/install-elpis.sh | bash
~/.local/bin/elpis
```

This release uses `~/.elpis-next` by default, or an explicit `ELPIS_HOME`. It ignores an inherited `CODEX_HOME`. It refuses a v0.3.0 state database and does not change it.

Rewind needs a chat in the paginated format. To convert chats that an earlier build saved in the legacy format, close Elpis and run it one time with `elpis -c features.background_paginated_rollout_migration=true`. This upstream feature is under development.

Known limits: `/force-prune`, Auto routing and `tui.appearance` are not ported. Subscription cost is not available. Focused Elpis Rust checks and real app-server evals with failing controls gate this release. The release does not claim that the full inherited Codex test suite passes.

RTK is optional, and the installer does not download it. Skills stay opt-in. The release includes no local model weights and no retrieval engine.
