# Modal width and ledger preference

The context ledger reserved a sidebar even while a dialog was open. At 100 columns,
the Plan reasoning dialog split its default-reasoning explanation across lines;
permission and settings descriptions also lost space. Dialogs now use the full
terminal width. Closing a dialog restores the ledger preference, including changes
made with Tab while the dialog was open.

Evidence under `.tmp/final-candidate/`:

- `modal-ledger-before.log`: the full-widget regression failed on the clipped Plan
  default explanation. An earlier compile error is retained separately and is not
  counted as behavioral evidence.
- `modal-ledger-after.log`: the regression passes, covering complete text, normal
  sidebar restoration, Tab while a dialog is open, and reopening afterward.
- `modal-ledger-native-before/modal.png`: viewed GTK/VTE reproduction with the
  permissions dialog sharing space with the ledger.
- `modal-ledger-native-after-settled/modal.png` and its sibling `result.json`:
  viewed real-terminal result; all four interaction checks pass with zero provider
  requests. The harness waits after typing slash commands before pressing Enter.
  Its first after-run selected a different popup and is retained as a harness
  timing failure, not passing evidence.

Optimized candidate SHA-256:
`b4d05d587bc628cca8fa2118814ffc537622ed7b20503a645d30630d82c8b308`.
The build passed in 124,583 ms with a peak recorded temperature of 73°C.

The full TUI run records **3,039 passed, 106 failed, five ignored**
(`tui-modal-ledger-after.log`). Compared with the preceding 75-failure run, 13
failures are absent (including two preceding test corrections), and 44 snapshot
tests newly fail because dialogs now use the full width. There are no new
non-snapshot failures. Snapshot review and the remaining release checks are open.
This is local verification, not installation, release, or Masih's acceptance.

The unrelated native selection glitch remains open. The first Codex 0.153.4
comparison did not send a provider request, so it provides no selection evidence.
