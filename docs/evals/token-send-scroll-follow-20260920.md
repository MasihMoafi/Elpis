# Send-time token count and scroll-follow evidence — September 20, 2026

## Decision

Correct the context count if Enter replaces provider usage with a local estimate. Change normal
scrolling only if Elpis fails to follow output under conditions where current Codex follows it.
This comparison does not establish behavior in every terminal emulator or replace Masih's visual
acceptance.

## Token count

The pre-fix regressions reproduced both false states:

- an existing provider count of `10,000` changed to the local estimate `10,051` before the next
  provider response;
- a session with no provider usage fabricated a zero-token reading.

`send_current_context_token_count_event` now carries request attribution, Smart Prune state, and
the existing provider usage without replacing or inventing usage. The next provider event remains
authoritative.

Evidence:

- `cargo test -p codex-core session::tests::current_context_snapshot_ -- --nocapture`: two failures
  before the source correction, then 2/2 passing;
- `cargo test -p codex-core --test all context_attribution:: -- --nocapture`: 2/2 passing;
- `scripts/verify-elpis --changed codex-rs/core/src/session/mod.rs --changed
  codex-rs/core/src/session/tests.rs`: full selected surface passed with zero failures.

## Scroll-follow comparison

Independent variable: installed Elpis `0.2.0` versus installed Codex `0.155.1`. Fixed conditions:
the same 109-column by 37-row native VTE window, `scrollOnOutput=false`, local synthetic provider,
six user turns, two streamed chunks and 70 response rows per turn. Acceptance required every
unscrolled streaming/final sample to report `atBottom=true`, and every sample after a deliberate
turn-six wheel-up to report `atBottom=false`.

Both binaries passed. Elpis recorded 16/16 automatic-follow samples at bottom and all three
post-scroll samples away from bottom. Codex recorded the same result. The different internal
request totals (Elpis 7, Codex 12) are a known confounder from their background request behavior;
they do not change the measured viewport samples.

Raw local evidence:

- `.tmp/final-candidate/e3/result.json` — Elpis;
- `.tmp/final-candidate/c3/result.json` — Codex;
- `.tmp/final-candidate/e2/result.json` — retained failed fixture attempt whose visible-text wait
  incorrectly treated intentionally off-screen output as missing.

The comparison supports no production scroll patch: Elpis already matches Codex, and forcing the
viewport down after manual scrolling would regress intentional reading and the accepted native
two-finger scroll path.
