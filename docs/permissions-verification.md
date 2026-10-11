# Ledger gold visibility — 11 October 2026

**Installed:** `ledger-gold-3529b45cdd6d`, Elpis 0.4.1 on Codex 0.162.0. Full CI and candidate/installed terminal checks passed. Masih closed Elpis; the bridge guard passed and activation selected the exact checked bundle. Wrapper, engine link and runtime hashes match the receipt.

| Checked on the exact candidate | Result |
| --- | --- |
| Actual VTE terminal, light and dark | The resting title holds saturated gold. Minimum observed title contrast across 14 frames per theme: 4.63:1 light, 8.52:1 dark, correcting the baseline’s 1.99:1 and 3.64:1. Root and reviewer inspected full terminals, resting panels and moving wave frames. |
| Category dots and bar | All nine colors match; eight background gaps remain 2 px at the captured font size. |
| Ledger title animation and palette | Native timing and spatial wave retained, with solid gold endpoints instead of a background fade. Per-32ms contrast checks passed on white, off-white and dark backgrounds. Reduced motion is static and undimmed. Elpising, teal sections, olive states/path and pink session names remain unchanged. |
| Normal launcher | All 15 checks passed before and after installation: shortcuts, names, permissions, steering and resume deletion. |
| [Exact-source full CI](https://github.com/MasihMoafi/Elpis/actions/runs/38152693733) | All runtime and installation gates passed. UI: 5,801 passed, five existing exclusions, no unreviewed snapshots. Local source `3529b45cdd6d`, validation mirror `4bf8b4d21418`. |
| Rollback | Candidate selection and exact previous-bundle restoration passed in an isolated directory. |

[Light resting capture](../.tmp/ledger-gold/light/motion-0-panel.png) · [Dark resting capture](../.tmp/ledger-gold/dark/motion-0-panel.png) · [Recorded motion](../.tmp/ledger-gold/light/ledger-animation.mp4) · [Hashes and checks](../.tmp/ledger-gold/state.json).

**Ready:** run `elpis`. Masih’s visual acceptance remains open. Future update handovers follow the explicit authorization in [AGENTS.md](../AGENTS.md#local-update-handover). Design review stayed local; no paid upload occurred.

**Rollback:** `python3 .tmp/ledger-gold/activate.py --rollback` from this worktree. It refuses while a real-profile bridge runs. The baseline bundle remains preserved. These isolated fixtures do not exercise live-provider inference.
