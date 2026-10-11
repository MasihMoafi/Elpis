# Elpis accents and Ledger motion — 11 October 2026

**Installed:** `accent-refresh-5beaae1bed39`, Elpis 0.4.1 on Codex 0.162.0. Runtime, UI and local checks passed; installed wrapper, runtime hash and engine link match the tested bundle.

| Checked on the exact candidate | Result |
| --- | --- |
| Actual VTE terminal, light and dark | Teal headings, gold titles/model, olive active states/path, pink session names. Static accents meet 4.5:1 contrast; category labels stay neutral. Root and reviewer inspected both full terminals and panels. |
| Category dots and bar | All nine colors match; eight background gaps remain 2 px at the captured font size. |
| Ledger title animation | Idle captures show the shared Elpising brightness wave in both themes. Exact-wave, reduced-motion and static off-white contrast tests passed in the original run. The animated dim phase does not carry the static 4.5:1 claim. |
| Normal launcher | All 15 checks passed before and after installation: shortcuts, names, permissions, steering and resume deletion. |
| [Runtime CI](https://github.com/MasihMoafi/Elpis/actions/runs/38142805121) and [UI rerun](https://github.com/MasihMoafi/Elpis/actions/runs/38149339952) | All runtime gates passed. The full UI rerun passed 5,801 tests, with five existing exclusions and no unreviewed screenshots, after a test-only visibility correction; application code is unchanged. |
| Rollback | Candidate selection and exact previous-bundle restoration passed in an isolated directory. |

[Light capture](../.tmp/accent-refresh/light/ledger-panel.png) · [Dark capture](../.tmp/accent-refresh/dark/ledger-panel.png) · [Recorded motion](../.tmp/accent-refresh/light/ledger-animation.mp4) · [Hashes and checks](../.tmp/accent-refresh/state.json).

**Ready:** run `elpis`. Masih closed the old `WhisperType` window; its bridge exited after the normal grace period, and guarded activation passed. Masih’s visual acceptance remains open. Design review stayed local; no 12ui upload or charge occurred.

**Rollback:** `python3 .tmp/accent-refresh/activate.py --rollback` from this worktree; it refuses while a real-profile bridge runs. The [previous installed checkpoint](../.tmp/ledger-gaps/state.json) remains available. These isolated fixtures do not exercise live-provider inference.
