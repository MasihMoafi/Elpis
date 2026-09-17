# Memory scope decision

September 14, 2026. Resolved by Masih: keep user-controlled activation of saved
memories through the Context Ledger, including automatically saved memories.
Add guidance explaining this control. The proposed split below is not selected
and is not a blocker; no store migration or explicit-only global saving is planned.

The current saver rewrites one shared `memories/MEMORY.md`. Its contents mix
global preferences and project lessons. Admission therefore exposes another
project's lessons, and the actual unrelated-project probe followed one despite
scope instructions. The evidence and fixed acceptance controls are in
[memory-lessons-review.md](evals/memory-lessons-review.md#storage-boundary-review-september-13).

## Recommended behavior

- Automatic saving writes durable lessons to the current workspace's
  `context/workspaces/<workspace>/MEMORY.md`, beside ES and GOAL. Only that
  workspace admits those notes by default. ES stays temporary working state.
- Global preferences live in `memories/GLOBAL.md`. An explicit request to
  remember something across projects authorizes adding or correcting it through
  ordinary file tools. The background saver cannot rewrite this file.
- The Ledger exposes separate Project memory and Global preferences rows with
  independent admission. Each row shows the actual source and its scope.
- The existing mixed `memories/MEMORY.md` and its citation map remain unchanged
  as legacy notes. They must not silently become global preferences. Existing
  explicit admission remains visible as Legacy memory, with its cross-project
  scope disclosed; new project memory does not copy those notes automatically.

This avoids another classification call, database, or hidden promotion mechanism.
It deliberately changes one behavior: automatic saving no longer promotes a
preference globally on its own. That needs Masih's decision because automatic
global preferences were part of the existing mixed-memory behavior.

## Acceptance

Use the existing storage-boundary controls linked above, not a replacement
benchmark. Inspect actual outgoing requests and saved files. Include separate
budget, citation-map, locking and manual-edit controls for each writable store.
Disabling either Ledger row must remove its source from subsequent requests.
The legacy file must remain byte-for-byte intact through the transition.

Directory separation does not solve a chat about another project inside the same
workspace, or prevent an agent from explicitly reading another file. The original
same-directory unrelated-project probe remains a separate requirement. Nor does
this design establish that Luna selects useful lessons or preserves every valid
fact; retention and correction controls remain required.

## Earlier question — superseded by user clarification

Should global preferences require an explicit cross-project request, while
project lessons continue saving automatically? If global promotion must remain
automatic, this proposal is insufficient and must be revised before implementation.

## September 17, 2026 update

Resolved by Masih: one global `MEMORY.md`, and its *contents* are global too. No
per-project memory file, and no project facts inside the global one — a project
already carries `AGENTS.md`, `VISION.md`, `ES.md` and its own docs, so a project
bullet in memory is duplication. The consolidation prompt now says durable memory
is knowledge that outlives the workspace (preferences, standing agreements,
cross-project lessons), forbids project-name-prefixed bullets, and tells the saver
to delete existing bullets that break the rule.

Why this came up: every line of the live `MEMORY.md` had grown an `Elpis …` prefix
and most of it was verification status for this repo. The prompt caused it — it
asked for "stable project facts" and told the model to qualify each fact with its
project. The file was reduced to five global preferences on the same day; the
previous contents are kept at `memories/MEMORY.md.pre-cleanup-20260917`.
