# Elpising visibility — 11 October 2026

**Installed:** `elpising-gold-ab1bb00e5a84`, Elpis 0.4.1 on Codex 0.162.0. Full CI and candidate/installed terminal checks passed. The bridge guard found no running real-profile bridge; activation selected the exact checked bundle. Installed wrapper, engine link and runtime hashes match the receipt.

| Checked on the exact candidate | Result |
| --- | --- |
| Active Elpising in actual VTE, light and dark | Fourteen frames per theme include the resting phase and traveling band. Minimum observed contrast: 4.63:1 light / 9.54:1 dark, correcting the baseline’s 1.99:1 / 3.64:1. Root and reviewer inspected actual captures. |
| Selected gold and native motion | Light: #927000–#684C00. Dark: #C8B77F–#EBC64B; the dark base exactly matches the former light resting gold requested by Masih. Native timing, spatial wave and weight remain; the background fade is removed. |
| Ledger and surrounding palette | Ledger title contrast remains 4.63:1 light / 8.52:1 dark. Teal headings, olive states/path and pink session names remain intact. All nine dot/bar colors match; eight background gaps remain 2 px at the captured font size. |
| Normal launcher | All 15 checks passed before and after installation: shortcuts, names, permissions, steering and resume deletion. |
| [Exact-source full CI](https://github.com/MasihMoafi/Elpis/actions/runs/38157746607) | Full CI passed: 5,802 UI tests, five existing exclusions, no unreviewed snapshots. Configuration, context/session, provider, permission, runtime and installer gates passed. Local source `ab1bb00e5a84`, validation mirror `080deceb00c33`. |
| Rollback | Candidate selection and exact previous-bundle restoration passed in an isolated directory. |

[Light active capture](../.tmp/elpising-gold/light/working-0-panel.png) · [Dark active capture](../.tmp/elpising-gold/dark/working-0-panel.png) · [Recorded motion](../.tmp/elpising-gold/light/elpising-animation.mp4) · [Hashes and checks](../.tmp/elpising-gold/state.json).

**Ready:** run `elpis`. Update handovers follow [Masih’s authorization](../AGENTS.md#local-update-handover). Masih’s visual acceptance remains open.

**Rollback after activation:** `python3 .tmp/elpising-gold/activate.py --rollback` from this worktree. It refuses while a real-profile bridge runs. The baseline bundle and [earlier Ledger evidence](../.tmp/ledger-gold/state.json) remain preserved. These isolated fixtures do not exercise live-provider inference. Design review stayed local; no paid upload occurred.
