# Wheel browsing and double-Escape — September 14, 2026

Wheel-up entered the same transcript overlay as keyboard backtracking. It exposed
editing controls and Escape started selecting earlier messages. Wheel browsing
now disables that edit entry, clears pending backtrack state, and uses Escape to
return to chat. Deliberate double-Escape retains its original editing path.
This remains a full-screen history browser, not native terminal scrollback.

Native VTE reproduction against installed `bbec53b9` failed with
`wheel browsing exposed backtrack editing`. The corrected build passed scrolling
to earlier and latest output during a live response, Escape returning without
interrupting that response, and deliberate double-Escape opening edit preview
after completion. The scrolling screenshot was inspected; its footer offers
`esc back to chat`, while the deliberate editing view retains editing controls.
One local synthetic request was used per native run; no paid model calls.

All 34 existing pager and backtrack tests passed. Guarded offline test and
optimized builds succeeded. Native fixture and captures:
`.tmp/final-candidate/wheel-browse.cjs`, `wheel-browse-before/`,
`wheel-browse-after/`; test log: `wheel-browse-tests.log` in the same directory.

Installed SHA256:
`eeca501562fd206706ca65aef761594034102f16bed98019d56ca0a092218dab`.
Recovery: `~/.local/share/elpis/release-recovery/wheel-browse-20260914/elpis`.
Existing user processes were left running. Start a fresh `elpis` for the updated
UI. Physical mouse/touchpad acceptance remains unverified.
