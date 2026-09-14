# Worktree cleanup — 2026-09-10

## September 14 targeted preservation review

At `e236dcf5`, one main worktree remains. The additional
`context-live-model-20260905` candidate (`3a44e6e4`, also represented by
`0386c6b3`) is already present in the recovered source: context snapshots use
`self.model_display_name()` rather than the initial configured model. All three
archived `context_model_label_*` regressions are present in current source. Two
expected labels were subsequently corrected from `one full-window scale` to
`capacity unknown` when there is no measurement; the third body is unchanged.
They cover switching before the first request, no switch with unknown usage,
and switching while retaining an existing measurement.

Those three checks pass in the retained September 13 TUI test executable
`codex_tui-d9c0df61a72c641b`; output is
`.tmp/final-candidate/recovered-model-label-tests.log`. This is a rerun of an
existing executable, not a fresh build of current HEAD or native UI acceptance.
The current install was built afterward with the same model-label selection.
No old patch was reapplied and no checkout was created.

The authority/edge/rollback work and optional pruning-effort override listed below
remain preserved but unintegrated. Current shared CLI/IDE startup and single-editor
tool ownership are separate, newer implemented behavior; absent archived helper
names do not establish that those newer features are missing. Website alternatives
and research artifacts remain separate from the installed CLI. The audit still
does not prove integration of every original dirty working-copy change.

## September 12 source coverage follow-up

At `59964954`, one worktree remains. This supersedes the historical two-tree
status below. The archives and recovery branches still exist; removing a checkout
did not establish that its features were integrated.

| Recovered work | Current source evidence | Disposition |
| --- | --- | --- |
| `ace-inactivity-180` | `core/src/session/smart_prune.rs` has both 180-second timeouts, provider timeout adjustment and completion-event collection, with tests. | Core behavior present in main; no need to reapply the old patch. |
| `ace-fact-preservation` | The default prompt in `core/src/pruner_settings.rs` preserves distinct facts and uncertainty; optimizer effort is Low in `smart_prune.rs`. | These behaviors are present. The archived `smart_prune_reasoning_effort` configuration override is absent; do not claim complete patch integration. |
| `manual-memory-resume-test` | Restored the archived restart/resume case in `app-server/tests/suite/v2/memory_recall.rs`, adding an assertion that the first request has no admitted memory. | Integrated and passed through the full verifier: the first resumed request contains the newly admitted marker exactly once. This tests delivery, not model quality. |
| `daily-driver-readiness` | Recovery retains `cd088885` agent-control protocol types, `e0f4f48c` graph ownership work and unfinished authority/readback edits. Current source lacks the new authority snapshot and exact-edge helpers. | Partially recovered by behavior: `af026a24` prevents loaded-child teardown after a failed Closed write; candidate0.1.28 rolls back spawn/resume on failed Open writes. Actual-handler failure/retry controls pass. Broader authority/readback and missing-edge work remains unintegrated. |
| `ci-linux-v4` | Main contains `TurnActivityUpdatedNotification`, terminal activity sequencing, and the public-submission manual-memory test helper from the historical work. | Relevant timing and test behavior present; reapplying the old commits is unnecessary. |
| `elpis-ide-reference-controls` | Current source differs in four UI files; the archived extension writes settings only to `WorkspaceFolder`, while main supports empty/file windows and protects startup submission. | Keep the newer implementation. The current packaged runtime passed empty/file/folder startup checks. |
| `elpis-ide-default-model` | The archived installer/workflow patch additionally auto-installs VS Code from the CLI installer; current installer does not. Current extension retains model selection and conversation history. | Do not claim the automatic installer integration shipped. Local IDE installation is separately verified; automatic cross-product installation is not necessary for the requested chat/startup fix. |
| `elpis-ide-provider-completion` | Archived UI is an earlier implementation lacking the later follow-up, ledger, settings and IDE-context modules. | Superseded as an implementation base; do not overwrite the tested current extension with it. |
| `elpis-ide-smart-runtime` | Recovery tip has no `editors/` tree; its runtime work predates the current extension. | Historical runtime/evidence branch, not a replacement for the current IDE package. |
| `release-v020-evidence-refresh` | Main has `dashboard_evidence.rs` and its token-gated evidence routing. The recovery commit's separate note is absent. | Evidence-viewer behavior present; historical release notes are not a new runtime feature. |
| `parallel-runner-offline` | All 52 files added by its recovery commit remain absent from main. | Research harness/protocol/results preserved on the recovery branch; not installed or integrated. Review before using for a paper. |
| `portable-checkpoint` | Independent commit `1730ac2b` adds `STARTER_PROMPT.md`. | Preserved evaluation prompt, not an implemented portable-memory feature. |
| `release-v0.3.0-vscode` | Independent `5d761053` changes release version/workflow and IDE packaging. | Unpublished alternative release preparation; do not silently change the selected version by merging it. |
| `paper-controlled-study-20260905` | Independent history includes `82b9ca30`, selecting Luna Max optimizer policy. Main currently uses Low. | Preserve historical study; do not restore a superseded optimizer policy through a documentation merge. |
| `elpis-ide-detailed` | Early `0b0ca274` supplies editor read, diagnostics, definitions/references and proposed edits; those tool paths exist in the current, expanded extension. | Earlier implementation base superseded; preserve its design/evaluation notes. Current packaged startup and editor tests are the applicable evidence. |
| `release-v0.2.0-candidate` | Archived interaction code lacks current clipboard retention, plain-Up queue restoration and completion priority. Its context rendering also contains the old dark-gray text. | Keep current tested replacements; do not regress the user's later corrections by restoring the archived UI files. |
| `site-seo-20260905` | Patch adds canonical/OpenGraph/Twitter/schema metadata absent from current `website/index.html`. | Unintegrated website work, not an installed CLI feature. Preserve for the website publishing review. |
| `site-live-seo-20260905` | Website implementation/assets differ substantially from the current site. | Separate website candidate; preserve rather than replacing the site during CLI readiness work. |
| `modern-UI` | Extensive alternative website implementation and visualization assets differ from the current site. | Separate visual proposal, not the TUI fixes requested here. Preserve for a dedicated website decision. |
| `terminal-bench-eval` | Branch contains real-task pilot and compaction-pair reports. Local CompCert raw rollouts confirm one compaction in each arm; saved results report both passing. | Historical research evidence retained; no general pruning-quality or compaction-frequency win established. See the research boundary in docs/context.md. |

These dispositions cover all 20 archived tree categories and distinguish
superseded code, requested runtime behavior and research material. They do not
claim a line-by-line correctness audit of every archived change, or that all
branches were merged. The missing configuration override, orchestration work,
website variants and research artifacts remain explicitly preserved outside main.

This audit does not establish that all 79 trees' distinct work is available in the installed
candidate. Website and historical research changes must not be blindly applied to
the CLI as part of integration.

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

## Current-source audit, September 11

There is one checkout on `main`. All 20 `recovery/committed-20260910/*` branch tips
still exist. A fresh comparison of their final preservation commits against main
is recorded locally in `.tmp/final-candidate/recovery-current-audit.json`. This
inventory does not by itself audit every earlier commit on those branches.

Confirmed in current source:

- The three-minute optimizer inactivity limit and streaming collector from
  `ace-inactivity-180` are present in `core/src/session/smart_prune.rs`.
- The optimizer defaults to Low effort. The archived variant's additional
  reasoning-effort configuration field is not present.
- Project-specific IDE approval modes, explicit full-access confirmation, and
  applying the selected policy to the runtime are present in the VS Code source.

Commit `5597b870` restores the stronger fact-preservation instructions from
`ace-fact-preservation` into the canonical default in `core/src/pruner_settings.rs`.
Its SHA256 exactly matches the recorded evaluation policy:
`ddd4d0909c81bb979c8346686524af8c15e9c8914a77e974964853f171719b61`. The existing
[bounded evaluation](evals/rq3/BOUNDED_SYNTHETIC_EVALUATION.md) records a canary that
lost two unasked requirements under the earlier policy and passed under the
revised policy. That is development evidence, not a universal guarantee. A new
request-path regression failed on the old default and passes after restoration;
all 20 Smart Prune integration tests pass. They cover default/custom routing,
audit records, unchanged main-model settings, and preservation on failures.
The debug test required `RUST_MIN_STACK=16777216`; the initial overflow and failing
policy check are retained in `.tmp/final-candidate/recovered-policy-before*.log`.
Passing evidence is `recovered-policy-final.log` in the same directory.

This source fix has not yet been installed or released. Baseline V2-agent reload
is present in `core/src/agent/control/spawn.rs`: the existing
`ensure_v2_agent_loaded_reloads_registered_unloaded_agent` check passes, including
communication after reloading a persisted child (`.tmp/final-candidate/v2-reload-current.log`).
The archived `daily-driver-readiness` changes add persisted-edge validation,
subtree-closure checks, and rollback around resume; those additions are not
integrated, and their compatibility review remains open. Missing helper names
alone must not be interpreted as proof that all agent reload behavior is absent.

Do not equate one worktree with all experiments having been integrated or accepted.
