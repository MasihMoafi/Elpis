# T7 · Close above Context Ledger

Masih repeated that Close must be above the Ledger heading. Existing rendering places it beside the heading and reserves a nine-cell gutter down the full pane, shortening names such as MEMORY.md and AGENTS.md.

- In the owned TUI column, keep the existing Close control on a dedicated pinned top row. Paint title/body below it; body scroll, source toggles and file links use the same reduced rectangle. Close never acquires a source hyperlink.
- Reclaim the old button gutter below the top row, leaving one blank column at the right. Show complete source names; when name plus token/state metadata cannot fit together, wrap the filename and put metadata below it. Keep estimates and admission state visible.
- Preserve the resize handle, remembered width, keyboard controls and native inline Ledger. Startup reserves the same row for alignment and paints no dead Close button. Zero/one-row areas remain safe.
- Acceptance: actual painted buffers at 80/120/150 columns and a dragged 28-column pane show Close strictly above title, correct visible hit cells and inert title/outside/modifier cells. Minimum/default panes retain complete MEMORY.md/Global AGENTS.md/Project AGENTS.md plus long relative and Unicode paths, including wrapped/scrolled click/link rows. A 0–2-row viewport stays safe. Existing inline, keyboard, drag and startup checks stay valid.

Evaluation: regressions preceded production; the accepted old native baseline failed placement in all four 100/140-column light/dark cases while all 36 Close-cell controls passed. Old-source Rust tests were not run.

Verified in [Actions run 39274191727](https://github.com/MasihMoafi/Elpis/actions/runs/39274191727): 44 Ledger tests plus five startup checks pass (45 distinct tests), no pending snapshots, same-source CLI builds. Native placement passes 4/4, all 36 button cells and keyboard controls pass, outside/title cells stay inert, and all private fixtures stop and clean up with zero model requests. Root inspected all four ANSI-replay PNGs. Frozen native tree 65d7ef0bc342a91ea84d0cefd8a08e96db232ea9; binary SHA-256 97f7ddc89ab4fb370da5507016f1e17134f2ca3800bb4908eb3b2f6ea852e5d9.

Delivery: implementation 7d16113e1 and actual-output test corrections a2df3a536; portable proof/renderer in scripts/evals. Opus owns integration/install and retains bridge 08a446480. Use this local feature branch; the separate codex/t7-ledger-ci-20261019 branch is a native verification snapshot, not an integration patch or installation package. Masih's app acceptance remains open.
