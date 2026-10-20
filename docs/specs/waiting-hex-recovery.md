# Restore the approved waiting hexagon

Masih reports that Elpis shows the old working mark and offers no update button. Inspection on 20 October 2026 confirms that both running Electron and the selected launcher use `session-manager-finish-20261020-478059e83`, whose renderer contains the earlier filled diamond.

The approved request in animation thread `01a15883-f454-7813-b770-e5b5f9d07413` is an 18px hollow hexagon with a blinking central dot, rotating every four seconds and blinking every two seconds, including when the desktop uses reduced motion. The approved preview and original implementation remain in `Elpis-wt-working-facets-20261020`.

Acceptance:

- The real chat working state renders the approved thin hexagonal outline and central dot in light and dark themes.
- Rendered size is 18px; rotation and blink have 4000ms and 2000ms durations in both motion settings. Their transforms and opacity visibly change.
- Completing the turn removes its working indicator. Startup animation and existing chat/session behavior remain intact.
- Restore the shared component and its existing CSS from the approved implementation, using an isolated branch based on the running build. Preserve all other features and user state.
- Typecheck, build, focused native update checks and rendered positive/negative evaluations pass. Prove the rendered evaluation fails on the current installed renderer before trusting it.
- Package and verify the corrected local renderer. Recheck launcher provenance before offering it, preserving any concurrent release selection. Let Masih choose restart from the update control; do not close his running chat.

Plan: reproduce against installed renderer; restore only the shared mark/styles; build and verify actual chat states and motion; inspect screenshots; package with manifest verification; make the checked update available within existing release restrictions.

Do not alter chat titles, Rust Notes, engine selection, credentials, real conversation contents, startup artwork or unrelated repair work. Preserve the existing selected bundle for recovery; do not create backup copies or publish anything.

## Checked handoff — 20 October 2026

Recovery coordination requests that this thread stop at this checkpoint so the shared bridge can restart safely. `/root/accounts_finish` is the sole activation owner. No launcher/runtime selector, installed bundle, real profile or running app was changed by this worktree. Do not select or restart concurrently.

The production renderer in `apps/elpis-desktop/out` is built and checked. TypeScript passes. Ten rendered checks pass: four working-hex theme/motion cases plus six startup regressions. Seventeen update-selection and package checks pass. Logs and inspected light/dark screenshots are in `.tmp/waiting-hex/`. The four working-hex evaluations fail on the actual installed renderer before the fix (28px filled diamond). They pass on the rebuilt renderer: hollow 18px outline, center dot, actual 4s rotation and 2s blink, animation transforms/opacity change, completion removes the indicator, composer remains usable, no page errors.

Fresh native Electron restart-button tests and packaging/install/selection were not run in this checkpoint. Current selected/running version was `session-manager-finish-20261020-478059e83`; recheck before integration. The restored component and mark CSS match the original approved artwork and timing. Startup code is untouched. Renderer hashes are preserved in `.tmp/waiting-hex/renderer-sha256.json`; the source commit and exact artifact digest are in `ES.md`. Integrate this narrow change into the activation owner’s final source without dropping account/session-manager changes.
