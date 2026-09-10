# Elpis v0.2.0 release — handoff

Written 2026-09-04 by the release-unblock session. Untracked on purpose; commit or delete
as you see fit. Companion records: `ES.md` on `release/v0.2.0-candidate` (execution state),
`docs/SHIPPING_RULES.md`, and the agent memory note `project_elpis_v020_release_state`.

## TL;DR

The v0.2.0 candidate is releasable by its own gate. Hosted run **33798425168** on
`release/v0.2.0-candidate` @ **`07b5d47`** passed end to end on 2026-09-03 (19:46–20:40 UTC):
full Linux surface, exhaustive nightly continuity regression, release build, version identity,
clean-home launch, developer-path check, `.deb` packaging, installer platform selection, and
a clean-container install and launch of both artifacts.

**Nothing has been tagged, released, or installed.** Tagging needs Masih's explicit go and
must point at `07b5d47` exactly. Merging PR #111 into `main` is a separate job: it conflicts
in 48 files.

## Current state (verified 2026-09-04)

| Item | State |
| --- | --- |
| `release/v0.2.0-candidate` on GitHub | `07b5d47` — the gate-verified head |
| Same branch, local worktree `.worktrees/release-v0.2.0-candidate` | `097fc7b` = `07b5d47` + one unpushed docs commit (ES.md record of the passing gate). Do not push it before tagging, or tag `07b5d47` explicitly. |
| PR #111 (candidate → main) | Open, `CONFLICTING`. GitHub does not start pull-request checks on a conflicting PR; that is why the PR shows no checks. |
| `main` (local = origin) | `c68db3e`, moved twice today by the website session. Its Linux verification workflow is red at `2d43115` (rustfmt diffs in `tui/src/status/card.rs` and `tui/src/token_usage.rs`; three macOS-only `elpis_context` test failures the candidate fixed in `8e9e2b7`). Later main pushes were website-only, so only Security Check ran. |
| Tags / releases | No `v0.2*` tag. Latest release is still `v0.1.2` (2026-08-02). |
| Installed `~/.local/bin/elpis` | Built 2026-09-02 18:18, reports `0.1.2`. Most likely a local build of `integration/elpis-stable` @ `e06e263` (the candidate's lineage before the version bump); not hash-proven. Previous build kept as `elpis.pre-stable-2026-09-02`. It is **not** the gate-verified head. |
| Scratch branch `ci/prune-hang-probe` | On GitHub at `83b62df`. Holds the probe workflow and instrumentation used to diagnose the hangs. Safe to delete once its evidence is no longer wanted. |
| Website | Deployed from `main` at https://elpis.masihmoafi.com by the website session; the candidate's `website/` is older and conflicts with main's. |

## What was done (all pushed to the candidate unless noted)

Chronological, with evidence.

1. **Explained the "merged, not by me" event.** PR #105 was auto-marked merged at 12:00 UTC
   when the website session pushed `main` containing that branch's commits. Nobody clicked
   merge.
2. **Found the real gate blocker.** Every full-surface run on the candidate ran to the job
   timeout (90 min, then 180 min). Logs showed two `context_prune` tests "running for over
   60 seconds" and then silence for hours; the previous coordinator had misread this as a cold
   build and raised the timeout. These prune tests had never run on a hosted runner before.
3. **Built a probe harness** (`ci/prune-hang-probe`): runs each test alone under a kill
   timeout with `--nocapture`, then the exact gate command. Two traps found on the way:
   cargo's `[env] RUST_MIN_STACK=16MiB` is not applied when the test binary is run directly
   (stack overflow), and GitHub's `bash -e` step default kills a loop on the first non-zero
   exit.
4. **Prune hang root cause and fix (`b4b68ff`).** The two multi-batch prune tests used the
   shared 10k-token window while producing two ~30k-token tool outputs. The context-limit
   check fired after the first output, native compaction consumed the scripted mock replies
   (both turns ended with a compaction error), turn two never reached history, the sweep had
   one batch, and the rearm test waited forever for a sixth request. Fix: a realistic window
   for those two tests and a 30-second bound on the streaming mock's request wait. Tests only.
5. **`/context` palette (`593fc84`, approved by Masih).** The attribution grid used terminal
   "light" ANSI slots that collapse on dark themes. Replaced with seven explicit colours
   validated (dataviz validator) for adjacent-pair separation under normal and
   colour-deficient vision and 3:1 contrast on a dark surface; the dashboard receives the
   light-surface steps of the same hues; tests, fixture, changelog and release notes updated.
   Not yet visually accepted by Masih.
6. **First full gate on `d5f190f`** (run 33776267693) cleared 20 commands and failed on
   `app-server-turn-cost` (4 of 25 tests).
7. **Turn-cost root causes and fixes (`b4db1ef`, `35673af`, `80d7d6b`, `e7b7d94`, `07b5d47`).**
   - Two tests asserted `auth_manager.reload()` returns true after an API-key rotation.
     `CodexAuth` equality compares by auth mode, so one API key replacing another is "no
     change" to that boolean even though the new key is loaded and the auth revision the worker
     watches is bumped. Tests now assert the revision bump.
   - Two `start_paused` tests do real loopback HTTP to wiremock. Any movement of the paused
     clock while a request is in flight (tokio `timeout`, `advance(150s)`, one-second or even
     one-millisecond steps) lets the clock outrun the real round trip and fire the worker's
     15-second request timeout; the worker drops to retry and the mock sees extra polls.
     Final fix: real-time pauses on a blocking thread (tokio inhibits paused-clock
     auto-advance while a blocking task runs) and five-second clock steps between them.
   Verified 25/25 on a hosted runner, alone and via the exact gate command (run 33797631679).
8. **Stale verification manifest (`757ea86`).** `app-server-memory-recall` filtered on a
   renamed test, ran zero tests, and the selector rightly failed the empty result. Now filters
   on the module.
9. **Remaining surfaces pre-verified on the probe branch** (run 33787158938): work graph,
   memory, nightly-release, provider-info, chat-completions, release build, identity,
   clean-home launch, path check, `.deb`.
10. **Second full gate on `07b5d47`** (run 33798425168): passed end to end. See TL;DR.

No runtime behaviour was changed by any of the above. Every code change is in tests, the
verification manifest, the TUI palette, or docs.

## Evidence index

| Run | Branch / head | Result | What it proves |
| --- | --- | --- | --- |
| 33718313736 | candidate `259aa22` | cancelled at 180 min | The original hang (prune tests) |
| 33756379858 | probe | 22/22 prune tests pass alone; whole suite hangs on one test | Isolation of the hang |
| 33775452658 | probe | prune suite passes with the window fix | Prune fix |
| 33776267693 | candidate `d5f190f` | failed at `app-server-turn-cost` | Gate progressed past prune |
| 33787158938 | probe | work-graph, memory, nightly, provider, release build, `.deb` pass | Remaining surfaces |
| 33797631679 | probe | turn-cost 25/25 alone and via gate command | Turn-cost fix |
| 33798425168 | candidate `07b5d47` | **success**, all jobs | Release gate |

## Known gaps and caveats

- Masih's manual acceptance items (U2, U3, U4, U5, U6, U7, U11, U13 in
  `docs/USER_REQUESTS.md`) remain open. A green gate is evidence, not acceptance.
- The palette fix is validated numerically, not by eye. Masih should look at `/context` and
  `/dashboard` on a build of the candidate.
- The installed daily driver is not the candidate head. Installing the published artifact
  (after tagging) or a local build of `07b5d47` is the way to evaluate the release.
- `main` is red on its own CI and has diverged from the candidate; see next steps.
- The prune and turn-cost tests were previously "verified" only by local claims that were
  never true for this runtime; treat other local-only verification claims with the same
  suspicion.
- `.agent-task.md` (untracked, prior coordinator's brief) still sits in the candidate worktree.

## Decisions for Masih

1. **Tag `v0.2.0` at `07b5d47`.** Irreversible and public. Not done.
2. **How to reconcile the candidate with `main`.** Options below. Not started.
3. **Delete `ci/prune-hang-probe`** once its evidence is no longer needed.
4. **Start the pruner-model feature as v0.2.1** (approved in principle on 2026-09-03).

## Plan for next steps

### A. Release (after the go)

```bash
# from the candidate worktree; tag the gate-verified head exactly
git tag -a v0.2.0 07b5d47 -m "Elpis v0.2.0"
git push origin v0.2.0
gh run list --workflow "Elpis Linux verification" --event push --limit 3   # the tag run
gh release list --limit 3                                                    # must show v0.2.0
```

Then, per `docs/SHIPPING_RULES.md`: install the published artifact in a clean container
(the docker network trap and SOCKS proxy note are in the `project_elpis_build_install`
memory), run `elpis --version` and a first-run smoke, and only then install locally with
matching hashes and keep the replaced binary. If the tag run fails, the tag exists but no
release is published and `releases/latest` silently keeps serving `v0.1.2`; a version number
that never reached a user may be reused.

After tagging, push the local docs commit (`097fc7b`) so the branch records the outcome.

### B. Reconcile with `main`

The trial merge conflicts in 48 files across TUI (status card, context ledger, dashboard
HTML and server), app-server (turn-cost worker and protocol), website, and docs. Main holds
newer manual-memory rendering, dashboard visual identity, an activity fix, and the deployed
website; the candidate holds Smart Prune, the `/prune` removal, the palette, and packaging.

Recommended sequence, one decision per area, each verified by the hosted gate on the result:

1. Decide per area which side is authoritative (website: main; Smart Prune and packaging:
   candidate; TUI status/ledger/dashboard: needs Masih's call because both sides changed
   product behaviour).
2. Merge on a scratch branch off the candidate, resolve, run `scripts/verify-elpis --surface full`
   on a hosted runner via a PR or dispatch, then update PR #111.
3. Fix main's formatting drift at the same time (its files were formatted with different
   settings; the gate's `fmt-check` is the arbiter).

### C. Pruner-model feature (v0.2.1)

Approved shape: a `pruner_model` setting plus reasoning effort, `elpis --pruner-model <name>`
as a session override, `/pruner-model` opening the same provider-aware searchable picker as
`/model`, the pruner constrained to the active provider, and the active pruner shown in
`/context` and `/dashboard`. Acceptance: setting, flag and command each change the model the
next prune request actually uses; the choice survives restart; an unknown name fails with a
clear message rather than a silent fallback; switching providers re-validates it. Today the
model is hard-wired to Luna at max reasoning for OpenAI and shared by `/force-prune` and
Smart Prune. Do it on a branch off the merged result of B, with the hosted gate as the check.

### D. Housekeeping

- Delete `ci/prune-hang-probe` (`gh api -X DELETE repos/MasihMoafi/Elpis/git/refs/heads/ci/prune-hang-probe`).
- The stale `ci/elpis-stable-linux-v*` and `integration/elpis-stable` branches from prior
  coordinators are unrelated to this session; leave unless Masih wants them gone.

## Operating notes for the next agent

- No local Cargo builds on this workstation; every verification in this session ran on GitHub
  Actions. A probe branch with a small workflow costs ~7 minutes per iteration.
- When running a test binary directly (not via `cargo test`), export
  `RUST_MIN_STACK=16777216`; the workspace cargo config sets it for `cargo test` only.
- GitHub step shells run `bash -e`; use `set +e` around loops that must survive failures.
- Never raise a CI timeout for a silent test; isolate it with `--nocapture` and a kill timeout.
- Paused-clock tests that touch real sockets must not move the clock while a request is in
  flight; use blocking-thread real pauses and small steps.
- Job logs for a completed job in a still-running run are available through
  `gh api repos/<owner>/<repo>/actions/jobs/<job_id>/logs`.
- `gh` is the tool for all remote operations; plain `git push` only for branches you own.
# Current pointer — 2026-09-05

The handoff below is historical. Masih's current action is runtime truthfulness,
Smart Prune evidence, faster build/debug loops, and visual acceptance. Use
`.worktrees/release-v0.2.0-candidate/TASKS.md` and its `ES.md` for the live state.
Preserve the existing root website changes. The optional, illustrative visual
candidate is `website/candidates/persistent-logo/`, not a deployed replacement.
