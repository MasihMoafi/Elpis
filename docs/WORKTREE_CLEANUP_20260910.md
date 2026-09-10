# Worktree cleanup — 2026-09-10

The initial cleanup reduced 79 registrations to **one: main**. The first pass removed 54 redundant
checkouts and four missing registrations. At Masih's request, the remaining 20
secondary checkouts were then archived and removed. Temporary integration and
recovery-test checkouts were also removed. All original branch references remain.
Approximately 69 GB was recovered net of recovery archives (filesystem free space
increased from 63 GB initially to 132 GB). At that point `.worktrees/` was empty.

The last 20 trees were archived with their unfinished changes, not integrated into
main. Each has a full source/evidence archive and a dedicated recovery branch.

## Follow-up: restore the current implementation

Masih questioned the reduction to one checkout. Removing every secondary working
copy made unfinished work harder to review and left the latest installed CLI's
source outside main. The installed executable itself had not been removed.

The coherent latest CLI source has now been recovered and integrated into main,
along with the IDE fix for file-only/empty windows. Main and one active candidate
worktree are retained. Other experiments remain in their preserved branches and
archives; they have not all been integrated. Rebuilding has recreated compiler
caches, so the original disk-space recovery figure is historical.

See [CLI recovery and build evidence](evals/latest-cli-recovery-20260910.md) and
[IDE startup evidence](evals/ide-startup-20260910.md). Manual acceptance is pending.

## Initial integration

The five published extension 0.1.17 commits were cherry-picked into local main as
`a50450c8`, `b2849bd9`, `88534947`, `356506b9`, and `3ebe27a3`.
After that initial integration, the committed Rust runtime, extension, and
extension-release workflow were identical to `release/vscode-0.1.17`.
Existing main-only website work remains.

The README conflict was resolved to preserve newer working-copy prose and retain
nonconflicting release corrections. The original README is still in the named
stash `worktree-cleanup-20260910-readme`. All 208 original dirty/untracked path
statuses matched before and after integration and cleanup, before adding this
report and updating TASKS.md. Those user edits were left uncommitted by the cleanup.

## Evidence and limits

- All 40 prescribed extension checks passed with the existing packaged runtime.
- All eight controlled provider cases passed: OpenAI, OpenRouter, Anthropic, and
  Gemini, each with editor access enabled and disabled. These used local controlled
  providers, not live paid model calls.
- The first exploratory test glob included editor-host tests that cannot run in
  plain Node. The prescribed test command initially lacked its packaged runtime;
  supplying the existing release binary resolved all six missing-runtime failures.
- The isolated integration tree exactly matched main before its removal.
- `git diff --check` passed; no unresolved index entries remain; the final
  worktree-prune dry run was empty.
- Removed-tree archives were compared against their original files before deletion.
  Cargo target directories and node_modules caches were excluded; other local
  notes, ignored evidence, and packaged artifacts were preserved.
- All 20 final-pass archive checksums and both original and recovery branch tips
  were verified after removal. The unfinished `ace-fact-preservation` tree was
  restored in a temporary checkout: its status, tracked changes, staged changes,
  and archive contents matched exactly. That temporary checkout was then removed.
- No Rust rebuild, installation, publication, push, or new user-visible acceptance
  was performed. Checks of the existing release binary do not verify the unfinished
  fixes listed below.

## Archived unfinished work

These require separate source/evidence review before integration. They are no
longer checked out, but their branches, edits, and evidence remain recoverable.

| Former worktree under `.worktrees/` | Work preserved |
| --- | --- |
| ace-fact-preservation | Uncommitted configuration and fact-preservation changes differ from main. |
| ace-inactivity-180 | Uncommitted three-minute timeout/stream-completion fix is absent from the published runtime. |
| ci-linux-v4 | Unmatched historical formatting and manual-memory test changes need disposition. |
| daily-driver-readiness | Two independent agent-control/state commits, unfinished runtime edits, and audit notes. |
| elpis-ide-default-model | Uncommitted extension, installer, and release-workflow changes. |
| elpis-ide-detailed | Separate experimental implementation/specification and local artifacts. |
| elpis-ide-provider-completion | Uncommitted intermediate editor/provider changes and evidence. |
| elpis-ide-reference-controls | Release source is largely captured, but local reference audits, assets, documentation, and evidence still need consolidation. |
| elpis-ide-smart-runtime | Runtime files match the release; provider documentation differs and local build/evaluation artifacts remain. |
| manual-memory-resume-test | Uncommitted memory-recall regression changes. |
| modern-UI | Extensive unfinished website/source and evaluation assets. |
| paper-controlled-study-20260905 | Independent historical study and launch documents; do not revive old optimizer-policy choices automatically. |
| parallel-runner-offline | Untracked evaluation harness, protocols, and results. |
| portable-checkpoint | Explicitly deferred independent checkpoint evaluation prompt. |
| release-v0.2.0-candidate | Preserved consolidated history plus uncommitted context controls, interaction tests, outcome-ledger edits, and evidence. |
| release-v0.3.0-vscode | Unpublished alternative release configuration needs explicit disposition; do not replace the accepted release with it. |
| release-v020-evidence-refresh | Independent release/evidence history and local task notes. |
| site-live-seo-20260905 | Uncommitted website implementation and assets. |
| site-seo-20260905 | Uncommitted SEO changes and test. |
| terminal-bench-eval | Independent pilot harness/evaluation commits; pilot execution remains a separate task. |

## Recovery

The private local recovery directories are:

- `.git/worktree-recovery-20260910/`
- `.git/worktree-recovery-20260910-phase2/`
- `.git/worktree-recovery-20260910-final/`

The first two contain the initial audit, selected paths, and `removed.json` with
original HEAD/branch/path mappings. Per-tree directories contain metadata, a
tracked patch, and, where needed, `local-files.tar.gz` plus its checksum.
Integration provider evidence is in `integration-test-evidence.tar.gz` in the
first directory.

The final directory contains `archived.json` for all 20 formerly retained trees.
Each has a complete `worktree.tar.gz`, tracked and staged patches, original status,
and checksum. Reproducible dependency/compiler caches and the root Git link are
excluded. `README.md` in that directory contains concrete restoration commands;
`recovery-verification.json` records the successful recovery test. Dedicated
`backup/archived-worktree-20260910/<name>` branches preserve their original tips.

To recover a removed checkout, use `git worktree add <new-path> <retained-branch>`
with the branch from `removed.json`, then extract its archive into that checkout.
Use the recorded tracked patch for any tracked edits not represented by restored
files. Detached source/missing-checkout tips received backup branch references.
`backup/pre-worktree-cleanup-20260910` preserves pre-integration main; do not reset
the dirty main checkout to it. The integration branch also remains available.

For a final-pass archive, create a checkout from its dedicated recovery branch,
apply its nonempty `tracked.patch` (including deletions), extract `worktree.tar.gz`
into that checkout, and apply its nonempty `staged.patch` with `git apply --cached`.
Do not extract unfinished work over main. No unfinished behavior was promoted to
main during this final archive pass.

Next: review the archived pruning fixes and context changes against an agreed
acceptance harness before integrating new runtime behavior. Website and evaluation
work requires its own consolidation; it was not silently folded into this cleanup.
