# Installed Ledger palette — 11 October 2026

**Installed:** `category-palette-519e32dc0247`, Elpis 0.4.1 on Codex 0.162.0. The ordinary `elpis` launcher and runtime match the checked bundle. Activation waited for the old bridge to exit naturally.

| Checked on the exact candidate | Result |
| --- | --- |
| Actual VTE terminal, light and dark | All nine categories exercised; screenshot pixels and terminal output confirm matching dot/bar colors and readable neutral labels. Full and detail captures inspected. |
| Contrast on the captured backgrounds | Labels: 19.03:1 light / 16.70:1 dark. Weakest markers: 3.79:1 / 5.16:1. |
| Separation and failing controls | Minimum CIEDE2000 distance 20.08 light / 20.67 dark. The previous palette fails; strengthened Rust regressions reject its similar colors. |
| Normal launcher | All 15 checks passed before and after installation: Ledger shortcuts, names, permissions, steering and resume deletion. |
| [Full CI](https://github.com/MasihMoafi/Elpis/actions/runs/38110370953) | Completed successfully: full UI, core, context/session, provider, permissions, runtime and both installation gates passed. |
| Rollback | Candidate selection and exact previous-bundle restoration passed in an isolated directory. |

[Light capture](../.tmp/category-palette/all-nine-light/ledger-detail.png) · [Dark capture](../.tmp/category-palette/all-nine-dark/ledger-detail.png) · [Receipt, hashes and checks](../.tmp/category-palette/state.json).

**Next:** run `elpis` to use the update. No user process was stopped. Your olive Tool results, red System instructions and gold source headings are retained. Masih’s visual acceptance remains open.

**Rollback after activation:** from this worktree, `python3 .tmp/category-palette/activate-palette.py --rollback`. It refuses while a real-profile bridge runs. The [previous broader audit](../.tmp/ledger-shortcuts/audit-state.json) remains recorded; live-provider inference was not exercised by these local fixtures.
