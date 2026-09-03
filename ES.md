# Execution State

## 2026-09-03 — Elpis v0.2.0 release

Intent: assemble, verify, publish, install, and document one Linux release containing the completed cache-stable Smart Prune path and the stable daily-driver features.

Acceptance:

- Smart Prune acts before first main-model exposure, is Experimental/off by default, and leaves admitted history unchanged.
- `/prune` and `/ide` are absent; `/force-prune` and native `/compact` keep their distinct meanings.
- Context, dashboard, manual memory, skill/plugin, provider, and work-graph claims match code and evidence.
- Linux full and nightly-release verification pass on the exact release commit.
- The published artifact is smoke-tested in a clean environment, then installed with matching hashes.
- README, release notes, technical preprint, portfolio write-up, and standalone website use current, privacy-safe visuals and qualified evaluation claims.

Out of scope:

- The unfinished human agent-control RPC/UI work in `feat/daily-driver-readiness`.
- Automatic memory extraction or promotion.
- macOS and Windows artifacts.

Status: release candidate assembled; exact-head hosted verification is pending. No tag or
v0.2.0 release exists yet.

## 2026-09-03 — Resume the release gate after the coordinator's usage limit

Intent: pick up the v0.2.0 candidate where the previous coordinator stopped, finish the
docs-versus-code alignment, and get an exact-head hosted Linux verification to a terminal
result without local Cargo builds or subagents.

Acceptance:

- Internal docs describe manual `MEMORY.md` admission, the real `--provider` flag, the
  dormant `:memory` cache namespace, the untracked `TASKS.md`, and the U8 visual direction.
- Work graphs are labelled by their code stage (under development, off by default) and the
  README states they await live acceptance.
- The candidate branch on GitHub equals the local head and PR #111 tracks it.
- The full and nightly-release Linux surfaces run on the exact head and reach a terminal
  conclusion instead of the 90-minute timeout.

Status: docs commits `de6707b` and `63058d9`, workflow timeout raised to 180 minutes in
`259aa22` (previous run 33701576903 died cold at 90 minutes; the repository had no saved
Actions caches). Website tests pass. Branch pushed fast-forward `6da0166..259aa22`.
Dispatch run 33718313736 and PR run 33718317590 started 05:18 UTC on `259aa22`; results
pending. No tag, release, or install has happened. Masih's manual acceptance of U2, U3,
U4, U5, U6, U7, U11, and U13 remains open.

## 2026-09-03 — Unblock the hosted release gate

Intent: find why every full-surface run on the candidate ran to the job timeout, fix the
cause without touching runtime behaviour, land the approved `/context` palette fix, and
get the full + nightly-release gate to a terminal result on the exact candidate head.

Acceptance:

- The hang is reproduced in isolation and its cause is shown, not inferred.
- No test can hang the gate again: the mock server's request wait is bounded.
- `/context` categories use validated, distinct colours on dark terminals; the dashboard
  mirrors them; tests and fixtures agree.
- Full and nightly-release surfaces pass on the pushed head; the tag decision goes back to
  Masih with the evidence.

Status: probe branch `ci/prune-hang-probe` ran each prune test alone under a kill timeout.
One test hung: `manual_prune_rearms_cancellation_before_a_later_batch_commits`. Cause: the
two multi-batch tests used the 10k window with two ~30k-token outputs, so the context-limit
check fired after the first output, native compaction consumed the scripted mock replies
(both turns ended with a compaction error), turn two never reached history, the sweep had
one batch, and the test waited forever for request six. Fixed in `b4b68ff` (test window +
bounded wait); palette in `593fc84`. Hosted verification of the fix across the prune
suites and the full gate are pending; no tag, release, or install has happened.
