# Installed follow-up — 10 October 2026

**Elpis 0.4.1, source `fb0b04a60`, is installed on Codex 0.162.0.** Shift+Tab changes permissions with confirmed feedback. Session names appear before the directory. Ledger colors are lighter and distinct; Tool results remain separate. “Elpising” uses lighter Deus Ex gold with Codex’s animation and normal font weight.

| Check on the installed candidate | Result |
| --- | --- |
| [Full CI](https://github.com/MasihMoafi/Elpis/actions/runs/38044290925) | All gates passed; 5,780 UI tests, 317 core tests, 65 integration tests; five existing UI exclusions |
| Permission regressions | Native, Code Mode, Claude/Gemini bridges and helpers passed, including active-turn updates, protected edits and restrictions |
| Ordinary launcher | All 11 checks passed before and after installation, including Full Access cancellation, confirmed settings and a protected write without an approval popup |
| Light/dark appearance and animation | 22 checks passed; 70 frames per theme; six rendered captures reviewed |

The installed runtime, Code Mode host and sandbox match the CI artifacts byte for byte. [Receipt and hashes](../.tmp/palette/state.json), [permission feedback](../.tmp/palette/final-evidence/terminal_launcher/full-access-applied.png), [80-column name](../.tmp/palette/final-evidence/terminal_launcher/automatic-title-visible-80.png), reviewed [light](../.tmp/palette/final-evidence/appearance_light/aligned-ledger.png)/[dark](../.tmp/palette/final-evidence/appearance_dark/aligned-ledger.png) Ledger captures, and [installed-launcher evidence](../.tmp/palette/final-evidence/installed-launcher/evidence.json) record the checks.

**User check:** finish current work, close **all** Elpis windows, wait about **30 seconds** for the old bridge to exit, reopen/resume, then use Shift+Tab to select Full Access and check its confirmation. Alt+C opens the Ledger; `/plan` toggles Plan. Existing windows keep the old runtime, and mixed versions are refused.

Limits: this is not a Codex version upgrade or complete-parity claim. Live provider services and dashboard visuals were not rechecked here. Failed helper-permission saves leave restrictions temporary; the bridge does not intersect custom workspace roots. Native light-theme animation retains its dim phase. Masih’s daily-use acceptance remains open.

[Tested rollback](/home/masih/.local/lib/elpis-next/versions/before-palette-20261010T080310Z/rollback.sh) restores the previous continuity installation. Chats and settings were preserved. Earlier [October 9 evidence](../../Elpis-wt-parity/.tmp/config-ui-install-receipt.json) and [continuity verification](continuity-verification.md) remain historical.
