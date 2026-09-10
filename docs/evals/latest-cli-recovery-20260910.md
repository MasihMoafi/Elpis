# Latest CLI source recovery — September 10, 2026

The worktree cleanup preserved branches and archived uncommitted source, but it
left the source of the latest installed CLI outside main. This candidate restores
that coherent implementation instead of combining every unfinished experiment.
The cleanup did not replace or remove the installed executable.

## Source scope

- Recover the Rust source and assets from archived `release-v0.2.0-candidate`
  (`40838f83`) and its uncommitted context-visual and queue-edit changes.
- Retain main's newer provider fixes in `core/src/client.rs` and
  `core/src/chat_completions.rs`.
- Include the existing local `--resume SESSION_ID` implementation and parser test.
- Restore the guarded local build helper; include CLI parser tests in its
  test-build mode and correct thermal hysteresis that stalled below the ceiling.
- Preserve the fact-preservation/Low-effort optimizer and agent-control
  experiments in their recovery archives. They are not integrated by this build.
- Leave unrelated website, evaluation, and other main-checkout edits untouched.

The previous installed executable's SHA256 is
`7641b5fdecb9343fdd8cbc5618a91fcc13c1316d07557a35d63f3329e353d55b`.
It matches the September 9 context-visual build. A separate executable backup is
retained locally for rollback. Source recovery instructions are in
`docs/WORKTREE_CLEANUP_20260910.md`.

## Verification

The cold test build completed successfully in 77m 58s, with one Cargo job and one
compiler thread. The thermal guard sampled a maximum of 75 C and held compilation
at the configured ceiling. Compiler warnings remain; there were no build errors.

374 focused tests pass: 21 context-usage, 44 context-ledger, 5 pruner, 7 motion,
4 startup, 56 streaming, 9 status, 9 queue-editing, 23 CLI-parser, and 196 config
tests. Three optional capture tests were ignored. This is not a full-suite pass.
The three build-guard tests pass, including refusing startup at the ceiling; the
old helper demonstrably timed out in the warm-background regression case.
Changed Rust formatting, dashboard JavaScript syntax, and the diff excluding
intentionally padded snapshot files pass their checks.

The optimized executable build is in progress. Installation and smoke results
will be recorded before pushing. No public release is requested. The separately
installed IDE 0.1.18 fix and its evidence are in `ide-startup-20260910.md`.

## User checks

1. Start a new Elpis process. Check the orange/yellow appearance and readability
   during startup and streaming, including your preferred light/dark theme.
2. Open `/context` and the persistent Context Ledger (`Alt+C`). Check category
   colors, token/percentage labels, unused capacity, and evidence readability.
3. While a reply is running, queue two messages. With an empty composer, press
   Up: the newest message should become editable and leave the queue, while the
   earlier message stays queued. An existing draft must remain intact.
4. Open `/pruner-model`; check search/selection and the dashboard pruner model
   and prompt settings. Confirm your choice survives reopening the settings.
5. Resume a test conversation with `elpis --resume SESSION_ID`. Use
   `elpis archive SESSION_ID` and `elpis unarchive SESSION_ID` to verify reversible
   hiding and restoration of that test conversation.

Automated checks are evidence, not Masih's acceptance. Live provider behavior and
clean-machine portability must not be inferred from this local build.
