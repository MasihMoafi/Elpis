# Installed regression check — 10 October 2026

**Installed: `provider-delete-c6085bc2f370`**, Elpis 0.4.1 on Codex 0.162.0. The audit found provider tools continuing after chat deletion. The corrected bridge stops active/queued work, clears history and children, and preserves native failure/fork protections. The failing old-bundle control wrote a file after deletion; the correction prevented it.

| Checked | Evidence |
| --- | --- |
| Shared sessions and deletion | 20 checks each for Claude/Gemini on the exact staged bundle. |
| Permissions | 35 Claude and 28 Gemini checks passed. |
| Normal launcher | 15 checks passed before and after activation: shortcuts, naming, permissions, steering and resume deletion. |
| Other workflows | Seven review/worktree checks, 17 provider-context checks, nine guarded-memory checks and four Smart Prune cases passed. |
| Browser dashboard | Seven tabs, polling, model save, pruning-instruction save/reload/default restore, activity, tokens and sources checked. Screenshot reviewed; no browser warnings/errors captured. |
| Unchanged Rust runtime | Prior [UI run](https://github.com/MasihMoafi/Elpis/actions/runs/38066331079): 5,799 passed, five existing exclusions. [Runtime run](https://github.com/MasihMoafi/Elpis/actions/runs/38063459154): all runtime gates passed, including 317 core and 65 integration tests. |

[Audit receipt, exact hashes and logs](../.tmp/ledger-shortcuts/audit-state.json) · [Dashboard capture](../.tmp/ledger-shortcuts/audit-dashboard.png) · [Earlier Ledger/color evidence](../.tmp/ledger-shortcuts/state.json).

The runtime and colors are unchanged. Activation waited for the old bridge to exit naturally; no user process was killed. User chats were not modified by testing.

**Limits:** live-provider authentication/inference, populated live-agent dashboard and pruning-evidence links were not checked. This is broad regression evidence, not a guarantee of every behavior. Masih’s daily-use acceptance remains open.

**Rollback:** from this worktree, `python3 .tmp/ledger-shortcuts/audit-select.py --rollback` restores the previous Ledger bundle. It refuses while a real-profile bridge runs. Rollback selection passed in an isolated directory. No release was published.
