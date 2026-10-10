# Checked Ledger and resume follow-up — 10 October 2026

**Candidate `resume-ledger-14a9f9cd7fce` is tested; activation is waiting for the old Elpis window to close.** Installed remains `palette-fb0b04a60f0a`, Elpis0.4.1 on Codex0.162.0. Temporary activation was rolled back after the real-profile check found that window’s older bridge; previous wrapper and runtime hashes were confirmed.

The candidate keeps Alt+C and adds Ctrl+X for the Ledger, accelerates saved-history discovery, restores confirmed Backspace deletion in `/resume`, retains slightly lighter olive Tool results and uses Deus Ex gold source headings. Tab and Enter retain their existing roles.

| Check | Result |
| --- | --- |
| [Runtime CI](https://github.com/MasihMoafi/Elpis/actions/runs/38063459154) | All runtime, permission, provider, session and offline checks passed;317 core and65 integration tests. The new UI fixture failed and was corrected below. |
| [Complete UI rerun](https://github.com/MasihMoafi/Elpis/actions/runs/38066331079) | 5,799 passed, five existing exclusions, no pending snapshots. Only two cfg(test) files changed; production code matches the built artifact. |
| Actual launcher | All15 checks passed before and after temporary installation: Ledger shortcuts idle/busy, permissions, naming, Enter steering, `/resume` search/cancel/delete and other-session preservation. |
| Appearance | Seven assertions per theme passed; actual gold/olive RGB and bar/legend agreement checked. Three rendered captures reviewed. |
| Resume discovery | Three fixture checks passed;81 saved roots took297ms versus2112ms before. Timeout/retry and late-response cleanup passed. Actual-profile UI timing remains pending. |

[Receipt and exact hashes](../.tmp/ledger-shortcuts/state.json), [installed-launcher evidence](../.tmp/ledger-shortcuts/final-evidence/installed/evidence.json), [light](../.tmp/ledger-shortcuts/final-evidence/light/aligned-ledger.png), [dark](../.tmp/ledger-shortcuts/final-evidence/dark/aligned-ledger.png), and [delete confirmation](../.tmp/ledger-shortcuts/final-evidence/terminal/resume-delete-confirmation.png) preserve the evidence.

**Next:** finish and close the old Elpis terminal for `~/Desktop/tmp/rayan`; allow about30seconds for its bridge to exit. Then guarded activation and the real-profile `/resume` check can finish. No user window was killed. The guard now handles the normal default profile when ELPIS_HOME is unset.

**User check after activation:** Ctrl+X or Alt+C opens the Ledger. In `/resume`, Backspace edits nonempty search text; with an empty search it opens delete confirmation. Y deletes; Escape, N or Enter cancels. Masih’s acceptance remains open. This is not a Codex version upgrade or complete-parity claim.

[Tested rollback](/home/masih/.local/lib/elpis-next/versions/before-ledger-shortcuts-20261010T121612Z/rollback.sh) restores the previous palette installation. Live inference services and dashboard visuals were not retested. No release was published.
