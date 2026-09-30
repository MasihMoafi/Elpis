Elpis v0.4.0 moves the terminal runtime onto Codex rust-v0.159.0 while retaining Elpis's identity, Context Ledger, explicit responding-agent memory saves, compaction instructions, Smart Prune, provider picker and local dashboard.

Masih tested the installed candidate on September 30 and accepted the experience for release. Focused Elpis Rust checks and real app-server evals with failing controls gate this release; the entire inherited Codex suite is not claimed green.

Linux x86_64 only. The installer and Debian package include the Code Mode host needed by GPT-6/5.6 tools and the bundled Linux sandbox. Every executable and Debian package has a SHA-256 sidecar.

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/MasihMoafi/Elpis/v0.4.0/scripts/install-elpis.sh | bash
~/.local/bin/elpis
```

This release uses `~/.elpis-next` by default, or an explicit `ELPIS_HOME`. It ignores inherited `CODEX_HOME`. The v0.3.0 state database is incompatible and is refused rather than modified. Existing v0.3.0 state is preserved; automatic migration is not included. Existing next-build users keep their next-build state. Back up an older executable before replacing it if rollback is needed.

Known limits: `/force-prune`, Auto routing and `tui.appearance` are not ported. Subscription cost is unavailable. Strict configuration does not currently reject unknown gateway-provider keys. The inherited TUI suite has appearance/snapshot differences and known identity-rename failures. Light-theme acceptance and every historical outcome are not established by this release.

RTK is optional and is not downloaded by the installer. Skills remain opt-in. No local model weights or retrieval engine are bundled.
