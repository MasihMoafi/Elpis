# Installed candidate and remaining release blocker

**Superseded September 12:** the installed CLI is now
`b386b39a5fc54b0758e23910b07253a4ba52df422d77fdce4ae00e2991ce894e`.
Completion/ledger focus and readable highlight motion are corrected; 3,155 TUI
tests and the actual terminal checks passed. Follow the current
[audit and launch checklist](ui-upstream-audit-20260912.md). Everything below is
the September 11 checkpoint, including its old animation and cursor behavior.

The corrected candidate is installed for Masih to launch with `elpis`. This UI
correction used headless terminal checks; no desktop window was opened for Masih.
This is not a new public release, and functional acceptance remains open.

| Requested outcome | Current evidence | Remaining limit |
| --- | --- | --- |
| One committed worktree | `git worktree list`: only `main`; source working tree clean | Archived experiments remain on recovery branches, not all integrated features |
| CLI checks | 3,151 TUI tests passed, five ignored; optimized build passed | The broader workspace verification belongs to the preceding candidate; automated checks do not establish user acceptance |
| IDE opens unrelated/new projects | Installed extension completed two conversations each in empty, file-only, and folder windows | Masih's everyday project still needs confirmation |
| Tab and queued-message editing | Enter queues during a response; one Up recalls all three messages. Actual VS Code terminal passed this, ledger toggle, resize/draft preservation, and one provider request | No default Ctrl+Q binding; slash commands remain available |
| Selection/typing glitches | Removed redraw-driven cursor hide/show and repeated style resets; cursor-output regression test and three exact drag-copy trials passed | The previous VTE selection limitation was not retested in this correction; Masih must check typing in his terminal |
| Context and pressure compaction | Installed threshold is 30; prior native 30/25 control passed; readability/accounting regression checks passed | Percentages are context estimates, not reasoning-effort settings |
| Appearance | Recovered existing Elpising dissolve/coalesce, streaming reveal, and ledger update effects. Captured motion frames inspected; static Elpis branding and no separate spinner preserved | Visual acceptance belongs to Masih |
| Pruning savings and memory | Timestamped savings HTML and manual-memory behavior documented in the investigation | Gross removal is not net savings; no automatic memory-promotion claim |
| Final release | Matching CLI/IDE candidate installed with rollback copies | Not published: unresolved glitch and functional acceptance remain |

Installed CLI SHA256:
`ed937526493c0e1dbfa8fbcb8868199d14471b32eb57fd97307eb512a43176c7`.
Installed IDE runtime SHA256:
`f6ab4e7a838162058d824cbd4e6d71a32e5566074323477033bbad57e8b83ac9`.
Version labels remain CLI 0.2.0 and IDE 0.1.19. These hashes identify this local
candidate; public versioning and release work resume once the blocker is resolved.

Evidence paths and rollback locations are recorded in
[the investigation](terminal-selection-20260910.md). Installed view:
`../../.tmp/final-candidate/shown-installed.png`.

## What Masih should test now

1. Reload VS Code, open a different project, and start a new Elpis conversation.
2. During a response, toggle the ledger with Tab; queue three messages with Enter,
   then press Up once in the empty composer and check that all three are editable.
3. Type and drag-select in the terminal normally used for Elpis. Report whether
   the red typing artifact remains and name the terminal/IDE if it does.
4. Check the orange-yellow Elpising effect without a separate spinner, streaming
   text reveal, and ledger update animation. Check that the cursor stays steady.

## UI correction evidence

- `.tmp/final-candidate/ui-correction-red-test.log`: Enter reproduced as Submitted
  rather than Queued before the correction.
- `ui-correction-terminal-before.log`: installed predecessor failed the actual
  Enter queue check; `ui-correction-terminal-after.log` passed against the new
  executable, including three recalled messages and exactly one provider request.
- `ui-correction-settled-terminal.log`: repeated terminal check also asserted that
  ledger text returns intact after the animation. Fixture responses are local.
- `ui-correction-final-tests.log`: 3,151 passed, zero failed, five ignored.
  An unrelated authentication snapshot failed once, then passed alone and in the
  repeated full suite. No authentication code was changed.
- `ui-correction-optimized.log`: optimized build passed, 143,308ms, peak 72°C.
- Motion captures: `/tmp/elpis-ide-startup-lOFyXd/folder/motion-{0,1,2}.png`;
  final terminal capture shows all three restored messages in the composer.
- Rollback executable:
  `~/.local/share/elpis/release-recovery/ui-correction-20260911/elpis-before`.

Steering and deferred-command lifecycle tests now submit explicitly through the
composer's existing submission path; Enter behavior is tested separately through
real key events. No new runtime subsystem was introduced.

The same unresolved selection condition has persisted across more than three
consecutive goal continuations. Repeating the passing suites or the same failing
VTE controls cannot establish that Masih's reported artifact is fixed. Further
release acceptance requires feedback from the installed candidate or a concrete
change to the affected terminal interaction. No broad claim of completion is made.
