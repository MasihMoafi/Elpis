# Experiment Lab page · 19 October 2026

Contract: Masih's experiment-lab-page.md handoff governs this change.

- Experiment Lab has its own sidebar entry immediately after New chat, with
  a distinct vector icon matching the other icons' size and alignment.
- It opens its own page, participates in Back/Forward and command search,
  and shows its own active navigation state and title.
- Workflows has no Experiment Lab header button. Its current board remains
  available to the Lab, including edits made immediately before navigation.
- Existing comparison, validation, results, export, stop and saved-run restore
  behavior stays intact. Lab keyboard actions must not modify the board.

Plan: fail real-click navigation/current-board tests first, move the existing
Lab into page navigation, retain its API and storage, run affected UI and
sidebar checks, types/build, bridge and desktop suites. Inspect light/dark
screenshots in ~/.cache/elpis-tests/experiment-lab-page/.
No installation or remote changes. Masih's acceptance remains open.
