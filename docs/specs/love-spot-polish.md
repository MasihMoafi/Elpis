# Love Spot polish · 18 October 2026

Contract: Masih's assigned `love-spot-polish.md` handoff. Existing React/Excalidraw editor and shared controls remain the owners.

Acceptance:
- One Agents button opens all six presets. Choosing one adds its card and opens its editable task inspector.
- All names and descriptions remain readable inside the menu at the desktop's minimum width, in light and dark.
- Outside pointer gestures and Escape close the menu. Dismissal never draws or edits the board. Inside choices still work.
- Skip already loaded scene bytes only during fresh stream bootstrap. Preserve all live updates, screenshot notifications, older subscribers and full refresh on reconnect.
- Opening an unchanged page does not resave or rasterize it. First edits, deletions and remote updates still save and refresh the preview.
- A repeatable browser timing check uses private copies of the morning/current pages. Record load, switch, pan and note typing before/after, with CPU profiles.
- Preserve tombstones, undo images, concurrent board merges, page isolation, voice and Talk. Normalized copies of immutable editor files must not trigger a save loop. Never modify original pages.

Plan: add real mouse/keyboard regressions and baseline timing; reuse shared dismissal controls; keep embedded images out of per-event scene serialization; queue Talk capture and dispatch with board saves; rerun focused Love Spot checks and renderer build; inspect private-display screenshots.
Failure boundaries: preserve existing save errors and retry behavior. Stop for an incompatible storage contract or data-loss risk.
Rollback: revert only the polish commits. No migration or real-profile change is required.
Evidence belongs in the assigned handoff report; Masih's functional acceptance remains open.
