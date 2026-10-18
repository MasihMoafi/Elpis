# Love Spot deletion sync · 19 October 2026

Contract: Masih's `night-lovespot-sync.md` worker handoff. Use throwaway boards.
Keep the existing page protocol, image limits, agent cards and Talk behavior.

Acceptance: two clients perform real edits and deletes from the same scene.
A delayed older live save cannot revive a delete. At equal versions, deletion
wins in either arrival order, regardless of nonce. Equal live edits retain the
existing lower-nonce rule. A higher-version deliberate undo can restore an item,
and redo deletes it again. Both renderers and the store use one ordering rule.
Remote synchronization must not become a local undo operation.
The user's screenshot placement remains its own undo/redo step, separate from
other changes received in the same scene.

Plan: demonstrate failing bridge and two-window UI cases, fix the shared merge
ordering and renderer save path as evidence requires, then run affected Love Spot
checks, bridge/desktop checks, TypeScript, inventory and the renderer build.
Inspect light/dark captures. Do not install, push, use live models or real boards.
Rollback: revert the focused worker commit. Masih's acceptance remains pending.
