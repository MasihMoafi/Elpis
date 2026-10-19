# Love Spot save recovery — 19 October 2026

Goal: typing and Ctrl+S preserve a verdict despite a newer stale-window deletion. A failed multiwindow quit must not let later edits skip saving.
Scope: draft recovery/version ordering, quit flush acknowledgement, and focused tests. Base: selected Ship `6132f02a1`; no real board/profile/config changes or installation.
Acceptance: a held local text save wins above a newer remote tombstone; its textarea remains intact and the board contains the exact verdict. Ordinary saves still work.
Acceptance: after one window refuses or throws during quit, editing and closing another window saves its final text. A refused close keeps its window and text; an entirely successful quit does not save twice.
Plan: prove both failures first; apply only the relevant production hunks from `572323653`; run affected checks and a disposable dock/embedded Electron pair.
Observability: record red/green counts and exact source in the worktree ES.md. Candidate evidence does not imply installation or Masih’s acceptance.
Rollback: before integration, retain Ship unchanged. After integration, revert this focused commit and rerun the same acceptance checks.
Stop: report source/contract contradictions, any need for real user state, or failure after three focused repair attempts. No redesign, screenshot feature changes, dependencies, paid calls or other worktrees.
