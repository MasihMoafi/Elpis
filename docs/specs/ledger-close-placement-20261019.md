# T7 · Close above Context Ledger

Masih repeated that Close must be above the Ledger heading. Existing rendering places it beside the heading and reserves a nine-cell gutter down the full pane, shortening names such as MEMORY.md and AGENTS.md.

- In the owned TUI column, keep the existing Close control on a dedicated pinned top row. Paint title/body below it; body scroll, source toggles and file links use the same reduced rectangle. Close never acquires a source hyperlink.
- Reclaim the old button gutter below the top row, leaving one blank column at the right. Show complete source names; when name plus token/state metadata cannot fit together, wrap the filename and put metadata below it. Keep estimates and admission state visible.
- Preserve the resize handle, remembered width, keyboard controls and native inline Ledger. Startup reserves the same row for alignment and paints no dead Close button. Zero/one-row areas remain safe.
- Acceptance: actual painted buffers at 80/120/150 columns and a dragged 28-column pane show Close strictly above title, correct visible hit cells and inert title/outside/modifier cells. Minimum/default panes retain complete MEMORY.md/Global AGENTS.md/Project AGENTS.md plus long relative and Unicode paths, including wrapped/scrolled click/link rows. A 0–2-row viewport stays safe. Existing inline, keyboard, drag and startup checks stay valid.

Behavioral regressions were added before production. Parent accepted authoritative native baseline red (4/4 at 100/140 columns, light/dark); old-source Rust was not run. Worker may format explicit files but never compiles/tests/builds. Root/cache_trace owns the capacity-gated Rust checks and disposable native light/dark proof. Candidate remains unverified until those pass. Opus owns integration/installation; no real profile, inference or installation here. Rollback is the focused branch commit.
