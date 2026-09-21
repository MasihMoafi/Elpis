# Re-importing Codex 0.153.4

Elpis forked Codex at `f37fc774` (2026-07-15). Upstream is now `rust-v0.153.4`
(built 2026-09-05). Everything reported broken in Elpis on 2026-09-21 —
conversation naming, click-and-drag selection, sessions dying on a dropped
connection, memory saves failing, general sluggishness — is upstream work that
never reached this fork.

## Measured scope (2026-09-21)

Upstream moved, between our import and 0.153.4:

    3,764 files changed, 574,037 insertions, 112,285 deletions

Elpis moved, over the same base:

    1,776 files changed,  88,785 insertions,  70,223 deletions
      147 files added (our own features)
      174 files deleted (crates and subsystems removed on purpose)

A three-way merge of the two (`git merge-tree`, base `f37fc774`) reports:

    549 conflicts
      448 content        (tui 153, core 106, app-server 41, protocol 23, ...)
       84 modify/delete  (files we removed that upstream kept changing)
       14 add/add        (same path invented on both sides)
        3 rename/delete

## Where the reported defects live upstream

| Symptom | Upstream files we do not have |
| --- | --- |
| conversation not named well | `tui/src/app/thread_title.rs` (+ tests) |
| click-and-drag selection broken | `tui/src/tui/scrollback.rs` (+ tests) |
| session dies when the app-server drops | `tui/src/app/reconnect.rs`, `chatwidget/reconnect.rs`, `bottom_pane/chat_composer/reconnect.rs`, 4 test files, `tui/tests/suite/reconnect.rs` |
| memory save fails / times out | `memories/read`, `memories/write`, `ext/memories` (63 files) |
| sluggish next to Codex | `app/history_pagination.rs`, `app/thread_event_buffer.rs`, resize-reflow handling |
| no agent management surface | `app/agents_overview*.rs`, `app/agent_picker.rs`, `/agents` |

205 files are missing from `tui/src` alone; 1,181 across the workspace once the
crates we deleted on purpose are excluded.

## Branches

- `vendor/codex-0.153.4` — pure upstream drop on top of `f37fc774`. No Elpis
  content. This is the merge target, not a working branch.
- `sync/codex-0.153.4` — where the rebased Elpis work will land.

Upstream source is unpacked at `/var/tmp/codex-upstream/codex-rust-v0.153.4`.

## Decisions this needs from the owner

1. **Memory.** Codex's memory subsystem was deleted from Elpis on 2026-08-05
   after it promoted nothing, and replaced with a single 180-second
   consolidation call that is now failing. Re-importing restores upstream's,
   which has since grown to three crates with a phased write path and read-side
   tools. Take upstream's, or keep ours?
2. **Crates removed on purpose** — `cloud-tasks`, `analytics`, `feedback`,
   `realtime-webrtc`, `v8-poc`. 42 of the 84 modify/delete conflicts are these.
   Assumption unless told otherwise: they stay deleted.
3. **Build budget.** None of this can be verified without compiling, and builds
   are currently suspended.

## Order of work

1. Resolve the 84 modify/delete conflicts by policy, not by file: deleted
   crates stay deleted; the memory decision above settles the rest.
2. Take upstream wholesale for every file Elpis only rebranded, then re-run the
   rename pass over the result.
3. Re-apply Elpis's own features by hand against the new base: Context Ledger,
   Smart Prune, the pruner/memory model pickers, `/dashboard`, `agent-grep`,
   `elpis_context`, branding.
4. Verify per crate, cheapest first, before any whole-workspace build.
