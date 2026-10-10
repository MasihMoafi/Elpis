# Installed Ledger and resume follow-up — 10 October 2026

**`resume-ledger-14a9f9cd7fce` is installed**, Elpis 0.4.1 on Codex 0.162.0. The selected launcher and runtime match the tested bundle byte for byte. The old bridge exited after Masih closed its terminal; no user process was killed.

The update keeps Alt+C and adds Ctrl+X for the Ledger, accelerates saved-history discovery, restores confirmed Backspace deletion in `/resume`, retains slightly lighter olive Tool results and uses Deus Ex gold source headings. Tab and Enter retain their existing roles.

| Check | Result |
| --- | --- |
| [Runtime CI](https://github.com/MasihMoafi/Elpis/actions/runs/38063459154) | All runtime, permission, provider, session and offline checks passed; 317 core and 65 integration tests. The new UI fixture failed and was corrected below. |
| [Complete UI rerun](https://github.com/MasihMoafi/Elpis/actions/runs/38066331079) | 5,799 passed, five existing exclusions, no pending snapshots. Only two cfg(test) files changed; production code matches the built artifact. |
| Actual launcher | All 15 checks passed through the candidate and installed launcher: Ledger shortcuts idle/busy, permissions, naming, Enter steering, `/resume` search/cancel/delete and other-session preservation. |
| Appearance | Seven assertions per theme passed; actual gold/olive RGB and bar/legend agreement checked. Three rendered captures reviewed. |
| Resume discovery | Three fixture checks passed; 81 roots took 297 ms versus 2,112 ms before. Real-profile `/resume` showed sessions in 826 ms; All loaded in 547 ms. No model message, saved-chat resume or deletion was performed in that real-profile check. |

[Receipt and exact hashes](../.tmp/ledger-shortcuts/state.json), [installed-launcher evidence](../.tmp/ledger-shortcuts/final-evidence/installed/evidence.json), [light](../.tmp/ledger-shortcuts/final-evidence/light/aligned-ledger.png), [dark](../.tmp/ledger-shortcuts/final-evidence/dark/aligned-ledger.png), and [delete confirmation](../.tmp/ledger-shortcuts/final-evidence/terminal/resume-delete-confirmation.png) preserve the evidence.

[Real-profile startup and loading receipt](../.tmp/ledger-shortcuts/real-profile-smoke.json) records the installed smoke test. The installation guard also checks the default profile when ELPIS_HOME is unset.

**User check:** Ctrl+X or Alt+C opens the Ledger. In `/resume`, Backspace edits nonempty search text; with an empty search it opens delete confirmation. Y deletes; Escape, N or Enter cancels. Masih’s acceptance remains open. This is not a Codex version upgrade or complete-parity claim.

[Tested rollback](/home/masih/.local/lib/elpis-next/versions/before-ledger-shortcuts-20261010T121612Z/rollback.sh) restores the previous palette installation. Live inference services and dashboard visuals were not retested. No release was published.
