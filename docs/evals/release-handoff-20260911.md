# Installed candidate and remaining release blocker

The candidate is installed and was opened on Masih's desktop. This is not a new
public release, and functional acceptance remains open.

| Requested outcome | Current evidence | Remaining limit |
| --- | --- | --- |
| One committed worktree | `git worktree list`: only `main`; source working tree clean | Archived experiments remain on recovery branches, not all integrated features |
| CLI checks | 3,145 TUI tests passed, five ignored; broader verification exited zero | Automated checks do not prove every user-visible behavior |
| IDE opens unrelated/new projects | Installed extension completed two conversations each in empty, file-only, and folder windows | Masih's everyday project still needs confirmation |
| Tab and queued-message editing | Actual VS Code terminal passed ledger toggle, resize/draft preservation, two queued messages recalled with Up; one provider request | No claim about every terminal |
| Selection/typing glitches | Three exact drag-copy trials passed in VS Code | VTE selection still fails with live output, including controls without Elpis; the reported red typing artifact is not conclusively resolved |
| Context and pressure compaction | Installed threshold is 30; prior native 30/25 control passed; readability/accounting regression checks passed | Percentages are context estimates, not reasoning-effort settings |
| Appearance | Installed screenshot inspected; orange Elpis branding, ledger sources and Smart Prune visible; spinner-removal tests passed | Visual acceptance belongs to Masih |
| Pruning savings and memory | Timestamped savings HTML and manual-memory behavior documented in the investigation | Gross removal is not net savings; no automatic memory-promotion claim |
| Final release | Matching CLI/IDE candidate installed with rollback copies | Not published: unresolved glitch and functional acceptance remain |

Installed CLI SHA256:
`7a8dd64e0d763450af18a6446fd1ee41189be7883f8d84f2ff0e0e6e87d55729`.
Installed IDE runtime SHA256:
`f6ab4e7a838162058d824cbd4e6d71a32e5566074323477033bbad57e8b83ac9`.
Version labels remain CLI 0.2.0 and IDE 0.1.19. These hashes identify this local
candidate; public versioning and release work resume once the blocker is resolved.

Evidence paths and rollback locations are recorded in
[the investigation](terminal-selection-20260910.md). Installed view:
`../../.tmp/final-candidate/shown-installed.png`.

## What Masih should test now

1. Reload VS Code, open a different project, and start a new Elpis conversation.
2. During a response, toggle the ledger with Tab; queue two messages with Ctrl+Q,
   then press Up in the empty composer and check that both are editable.
3. Type and drag-select in the terminal normally used for Elpis. Report whether
   the red typing artifact remains and name the terminal/IDE if it does.
4. Check the orange-yellow animated Elpising label and absence of its separate
   spinner, plus readable context and ledger content.

The same unresolved selection condition has persisted across more than three
consecutive goal continuations. Repeating the passing suites or the same failing
VTE controls cannot establish that Masih's reported artifact is fixed. Further
release acceptance requires feedback from the installed candidate or a concrete
change to the affected terminal interaction. No broad claim of completion is made.
