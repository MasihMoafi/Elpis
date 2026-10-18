# Installed local CLI package — 19 October 2026

Goal: `elpis agents` starts the shared server from Masih's installed engine bundle.
Scope: local engine installer and its regression checks. Keep daemon validation intact.

Acceptance:
- A failing installer test proves the old bundle lacks the required package layout.
- The real executable lives in a self-contained package with manifest, host, rg and bwrap.
- Keep bridge dependencies outside that package: daemon copying rejects directory links.
- Mark local builds with a SemVer build suffix so upstream automatic updates stay disabled.
- Missing inputs fail before launcher activation. A new bundle never overwrites an old one.
- Rollback restores the previous launcher and engine selection, including across two installs.
- Rebuild offline under the 18 October resource and temperature limits.
- Installed `elpis --version`, `elpis agents` and ordinary TUI startup pass in tmux.
- Use a disposable ELPIS_HOME. Stop its daemon and trash its copied auth after checks.

Plan: test the existing handoff installer, then move its implementation into
`scripts/install-engine.sh` and make the handoff entry point delegate to it.
Keep a minimal `package/` subtree separate from the existing bridge and rollback files.
Run installer regressions, rebuild, commit named files, install a new bundle, and
record installed tmux checks and the exact rollback command in the worker brief.

Stop if an install would affect real profile data, dependencies require downloads,
or validation requires weakening the daemon's package checks. No remote publication.
