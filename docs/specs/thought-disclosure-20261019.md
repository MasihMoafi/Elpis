# A18 Thought disclosure

Masih clicks “Thought” and sees no content. One pointer click or keyboard activation must show the reasoning summary actually recorded for that step.

- Render recorded nonblank summary/content strings immediately inside the opened Thought group, using the existing Step/Markdown components and styles.
- A missing or blank payload shows “No reasoning summary was recorded for this step.” Never manufacture text or ask a provider for hidden reasoning.
- Pointer and keyboard can open, close and reopen the group in light and dark themes. Seeing recorded text requires no second activation of its inner row.
- Keep other activities collapsed/lazy by default; commands, tool output, transcripts and live-event payload handling retain their behavior.
- Scope: shared Activity/reasoning rendering in `components/chat-message.tsx` and existing `tests/step-sentences.test.cjs`; no runtime, configuration, package, identity or design changes.
- Verification: fixture-only recorded/missing cases must fail on the old renderer, then pass on the candidate. Inspect light/dark captures; run adjacent step/live-event checks and types. One candidate Next build under the shared lock.
- Boundary: no real conversations, provider calls, user windows, installs or ship commits. Root integrates the own-branch checkpoint; user acceptance remains open.

Receipt: old immutable `62fe14131` export (matching relevant render branches) failed all four new pointer/keyboard cases. Candidate passed 6/6 UI cases, 21/21 adjacent step/live-event checks, types and one locked Next build. [Red](../../.tmp/thought-disclosure-20261019/red.tap) · [UI](../../.tmp/thought-disclosure-20261019/green.tap) · [Adjacent](../../.tmp/thought-disclosure-20261019/adjacent.tap) · [Types](../../.tmp/thought-disclosure-20261019/types.log) · [Build](../../.tmp/thought-disclosure-20261019/build.log).

Inspected captures: recorded summary [light](../../.tmp/thought-disclosure-20261019/green/thought-recorded-light.png) / [dark](../../.tmp/thought-disclosure-20261019/green/thought-recorded-dark.png); missing summary [light](../../.tmp/thought-disclosure-20261019/green/thought-missing-light.png) / [dark](../../.tmp/thought-disclosure-20261019/green/thought-missing-dark.png). Text fits and is visible after one activation. Fixture acceptance only; installed behavior and Masih's acceptance remain unchecked.
