# Memory scope decision

September 14, 2026. Proposed behavior; not implemented or installed.

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

## Decision required

Should global preferences require an explicit cross-project request, while
project lessons continue saving automatically? If global promotion must remain
automatic, this proposal is insufficient and must be revised before implementation.
