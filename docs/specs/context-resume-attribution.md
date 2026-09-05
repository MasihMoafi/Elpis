# Context attribution on resume

Accepted direction: Masih requested continued bug fixes with `/context` correctness
and visual quality near the top priority on 2026-09-05, after the explicit resume
acceptance proposal. This is a display-replay repair, not a change to model context.

## Contract

- Resume/rejoin/fork replays the category snapshot from the latest persisted
  token-count record alongside restored totals, without a provider request.
- If that record has no category snapshot, report unavailable; do not borrow a
  category snapshot from an older incompatible usage record or another thread.
- Do not mutate history, add rollout records, change tokens/cache keys, or read
  additional files. Use the history already loaded for usage replay.
- Preserve response-before-notification ordering and the metadata-only cheap path.
- If a running thread advances after history loading, omit mismatched historical
  categories instead of combining them with newer live usage totals.

## Plan and checks

1. Extend the existing actual app-server resume test with a saved nonzero category
   snapshot and a missing-snapshot negative; prove the positive fails before fixing.
2. Pass loaded rollout items through the three existing replay call sites and fill
   the existing optional field. No schema or provider changes.
3. Reuse focused tests; build/install one guarded candidate only after they pass.
4. Resume the preserved smoke thread without a model call and compare both displays.

Rollback: revert this display-only change; saved records remain untouched. Escalate
if replay needs an API/schema change, new disk reads, or a model request. Masih's
visual acceptance remains required after agent verification.
