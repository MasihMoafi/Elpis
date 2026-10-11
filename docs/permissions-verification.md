# Ledger separators — 11 October 2026

**Built and staged:** `ledger-gaps-c330b6c53b4a`, Elpis 0.4.1 on Codex 0.162.0. The previous palette bundle remains installed while activation waits for the running Elpis bridge to close.

| Checked on the exact candidate | Result |
| --- | --- |
| Actual VTE terminal, light and dark | All nine categories checked together: matching dots/bar, readable neutral labels and thin background-colored gaps. Root and reviewer inspected both captures. |
| Actual gap pixels | Eight gaps per capture, each 2 px at the captured font size; white on white, #101010 on #101010. The previous installed palette fails this check. |
| Width and small categories | Rust regressions passed for zero, narrow, full and excess usage. One-cell categories remain visible; the final usage edge and allocated width stay fixed. |
| Normal launcher | All 15 candidate checks passed: Ledger shortcuts, names, permissions, steering and resume deletion. Installed-path check follows activation. |
| [CI](https://github.com/MasihMoafi/Elpis/actions/runs/38118320154) | Completed successfully: runtime, UI, provider, permission and installation gates passed. |
| Rollback | Candidate selection and exact previous-palette restoration passed in an isolated directory. |

[Light capture](../.tmp/ledger-gaps/light/ledger-detail.png) · [Dark capture](../.tmp/ledger-gaps/dark/ledger-detail.png) · [Hashes and checks](../.tmp/ledger-gaps/state.json).

**Next:** close the Elpis windows, then complete guarded activation and the installed-launcher check. No user process was stopped. The selected palette, olive Tool results, red System instructions and gold headings stay unchanged. Masih’s visual acceptance remains open.

**Rollback after activation:** `python3 .tmp/ledger-gaps/activate-gaps.py --rollback` from this worktree; it refuses while a real-profile bridge runs. The [prior palette](../.tmp/category-palette/state.json) and [broader audit](../.tmp/ledger-shortcuts/audit-state.json) retain their evidence. These isolated fixtures do not exercise live-provider inference.
