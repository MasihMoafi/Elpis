# Installed candidate — 9 October 2026

**Elpis 0.4.1, source `4f44937c2`, is installed on Codex 0.162.0.** Colored circles, the aligned Ledger bar, gold “Elpising,” the startup-config fix and corrected Alt+C hint are installed. Masih’s acceptance remains open.

[Runtime checks](https://github.com/MasihMoafi/Elpis/actions/runs/37978565974) passed; that run’s screen-review gate found eight screen differences. The [full UI recheck](https://github.com/MasihMoafi/Elpis/actions/runs/37983082438) passed after test-only corrections. Production code is identical between the runs, and the installed binaries match the downloaded artifact.

| Check | Passed |
| --- | --- |
| Full UI / core / context-session tests | 5,770 / 301 / 61; five UI direct-run exclusions |
| Configuration Rust / actual runtime | 16 / 5, including genuine-project and malformed-config controls |
| Provider configuration / CLI / branding | 120 |
| Native / Code Mode / Claude / Gemini / helper permissions | 11 / 15 / 35 / 28 / 32 |
| Shared sessions, transport, launcher and shared permissions | 128 |
| Local config and light/dark visual checks / installed-launcher checks | 27 / 14 |
| Offline runtime evals, failing controls and clean installation | Passed |

Evidence: [receipt](../.tmp/config-ui-install-receipt.json), reviewed [installed Ledger](../.tmp/config-ui-final-evidence/installed-visual/aligned-ledger.png), [gold status](../.tmp/config-ui-final-evidence/installed-visual/elpising-status.png), [light theme](../.tmp/config-ui-final-evidence/light-static/aligned-ledger.png). Animated gold remained readable across 25 sampled frames per theme. Earlier real Sonnet/Gemini smoke tests belong to the [previous candidate](../.tmp/parity-install-receipt.json).

**When ready:** open a new Elpis window, use **Alt+C** for the Ledger, and send a message to see **Elpising**. Existing windows keep their earlier runtime. Chats and settings were preserved.

Limits: dashboard visuals were not rechecked; native animation timing is retained with the requested gold label, without an FPS benchmark. A failed helper-permission save warns that restrictions last only until restart; the bridge does not intersect custom workspace roots.

[Rollback](/home/masih/.local/lib/elpis-next/versions/before-config-ui-20261009T194239Z/rollback.sh) restores the previous installation and preserves chats/settings. It passed a check in a private destination.
