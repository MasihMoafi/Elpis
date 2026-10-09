# Installed candidate — 9 October 2026

**Elpis 0.4.1 is installed**, source `0c5e5518f`, on Codex 0.162.0. [Full CI passed](https://github.com/MasihMoafi/Elpis/actions/runs/37953792953); all three runtime binaries match the installed bundle exactly. [Install receipt](../.tmp/parity-install-receipt.json). Masih’s acceptance remains open.

| Check | Passed |
| --- | --- |
| UI / core / context-session Rust tests | 1,226 / 301 / 61; one manual export helper ignored |
| Provider configuration / CLI / branding | 120 |
| Native / Code Mode / Claude / Gemini / helper permissions | 11 / 15 / 35 / 28 / 32 |
| Shared provider sessions / transport and launcher races | 32 / 24 |
| Terminal and Ledger checks / installed launcher checks | 25 / 9 |
| Real Sonnet High and Gemini Flash 3.8 High | File tasks, zero Full Access approval prompts |
| Failure controls; offline and Debian installs | Passed |

Records: [permissions](../.tmp/final-permissions-results.json), [shared sessions](../.tmp/final-sharing-results.json), [terminal](../.tmp/final-terminal-results.json), reviewed [wide](../.tmp/final-ui-evidence/agents-80.png)/[narrow](../.tmp/final-ui-evidence/agents-40.png) captures.

**Try two new windows** in different folders: check ← Agents, model labels, typing and queued messages. Select Full Access or `/yolo`, perform a file task, then resume it. The saved default remains Ask for approval. Chats/settings were preserved; existing windows keep their earlier runtime.

Limits: the browser dashboard was not visually rechecked. Shared animation/streaming modules match Codex source; no FPS claim. A failed helper-permission save warns that restrictions last only until restart; the bridge does not intersect custom workspace roots.

[Rollback script](/home/masih/.local/lib/elpis-next/versions/before-parity-20261009T115727Z/rollback.sh) restores the earlier runtime and bridge while preserving chats/settings. It was tested in a private destination.
