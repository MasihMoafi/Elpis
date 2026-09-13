# Memory lessons: behavioral acceptance protocol

September 13, 2026. Executed under Masih's authorization to finish the outstanding
tasks. The fixture below is preserved as specified; results follow at the end.
The earlier port-recall result remains separate evidence.

## Decision

Does a verified project lesson survive automatic saving and help a fresh chat
choose the correct action? Masih is still deciding what information should become
memory. This fixture proposes one narrow test of that policy, not a general
benchmark or a claim that memory prevents mistakes.

## Fixed fixture

Use an isolated home and a fictional project, Copper Orchard. No real project
settings or user memory may be changed. Disable ES admission in every fresh-chat
probe. Use Luna at low reasoning throughout, tools disabled, and no model fallback.

Seed evidence:

> Verified Copper Orchard lesson: after changing a file under src/parsers/, the
> generic check omits the parser fixtures. The parser-fixtures check caught the
> regression in our reproduction. Before declaring a parser change verified,
> run parser-fixtures as well as the generic check. This rule is specific to
> Copper Orchard. The current release review is unfinished; that is temporary
> work, not a lasting lesson.

The runtime must save the scoped lesson in MEMORY and retain unfinished work in
ES. Inspect both files and the save receipt. A model repeating the lesson in its
reply is not evidence that saving happened.

## Probes

1. Fresh process, Memory admitted: “In Copper Orchard I changed
   src/parsers/date.rs and the generic check passed. Which checks remain before
   declaring the change verified? Answer briefly.” Require parser-fixtures.
2. Same prompt, fresh process, Memory and ES excluded. Record the answer without
   forcing failure. If both conditions choose parser-fixtures, this pair does
   not demonstrate a benefit from memory.
3. Explicit correction in the saving conversation: “Verified correction for
   Copper Orchard: parser-fixtures has been removed; parser-regression is its
   replacement. The generic check still omits those fixtures.” Inspect that
   memory replaces the obsolete command, rather than accumulating both rules.
4. Fresh process, Memory admitted: repeat probe 1. Require parser-regression;
   reject a recommendation to run the removed parser-fixtures command.
5. Fresh process, Memory admitted: “In a different project, Silver Meadow, I
   changed a parser and its generic check passed. Which project-specific check
   is required?” Require uncertainty or project inspection, not importing the
   Copper Orchard command as a Silver Meadow requirement.

This is six main Luna turns plus two saving calls, eight requests in total if
there are no retries. Disable saving for the fresh-chat probes. Set an overall
request cap of eight and stop on unexpected extra requests or unavailable Luna.
The runtime may otherwise retry transport requests, so the driver must enforce
the cap at the request boundary. The executed driver enforced this limit.

## Evidence and interpretation

- Preserve exact prompts, binary hash, settings, saved notes, receipts, outputs,
  provider usage, elapsed time and failures. Never publish authentication data.
- Grade saved content, scope, correction and proposed action separately. Report
  the disabled control alongside the admitted condition, including a tie.
- This tool-free fixture tests action selection, not successful command execution
  or measured reduction of real coding errors. A later task evaluation needs an
  executable repository and independent verification of the resulting changes.
- One synthetic lesson cannot establish general benefit, a useful average effect,
  or research novelty. Passing automated grades is separate from Masih's acceptance.

## Execution result, September 13

The baseline completed six main turns and two saving calls: eight forwarded
requests and two receipts. The request-cap self-test passed. Saving the project
lesson, keeping temporary state in ES, changing the admitted-versus-disabled
recommendation, and following the corrected recommendation passed their grades.
The unrelated-project control failed: Copper Orchard's lesson was incorrectly
applied to Silver Meadow. The overall behavioral acceptance therefore did not pass.

Inputs, outputs, receipts, usage, grades and binary hash are recorded in
`.tmp/final-candidate/memory-lessons-live-result.json`. The candidate adds scope
guidance; the one-call replay still recommended Copper Orchard's command for
Silver Meadow despite the guidance reaching the actual request. Scope remains
failed; no further inference retries were run. This
result establishes neither reliable project scoping nor general coding benefit.

## Storage boundary review, September 13

Read-only follow-up confirmed that saving and admission both use the shared
`memories/MEMORY.md`. A workspace context directory already exists for ES/GOAL.
The smallest proposed storage correction is to save automatic project lessons
there, separately from explicitly reviewed global preferences. This is a proposal,
not an installed change or a solution to the failed same-directory probe.

Preserve the existing mixed memory file unchanged. Do not infer its scopes with
regexes, relabel all its contents as global, or silently copy it into each workspace.
If retained as an explicitly admitted legacy source, disclose that it can still
bring another project's lessons into context.

Before installation, require these controls:

- [ ] A saved workspace A lesson reaches a fresh A request and is absent from B's
  actual outgoing context, with ES excluded in both controls.
- [ ] An explicitly approved global preference reaches both A and B.
- [ ] Withdrawal removes each source; correction replaces obsolete content.
- [ ] Legacy notes and concurrent manual edits survive migration unchanged.
- [ ] Ledger rows accurately identify the admitted source and scope.
- [ ] Re-run the original same-directory unrelated-project probe separately;
  directory isolation must not be substituted for this semantic test.

Global promotion policy and explicit project selection need a coherent user flow.
Avoid adding hidden classification calls or another prompt-only scope claim.

## Actual-file retention review, September 13

A later inspection of the real `~/.elpis/memories/MEMORY.md` found a saved entry
describing the current installed commit and pending user acceptance. That is
temporary release status, despite the prompt already excluding transient status.
The earlier synthetic temporary-state control passing therefore does not establish
that the retention policy is reliable in ordinary sessions.

The entry was manually replaced with the verified project lesson: the terminal
checkpoint writer and saver must coordinate through a workspace checkpoint lock,
preserve manual edits, and allow unrelated workspaces to keep writing. Installation
state remains in ES and the dated release evidence. This was a manual correction,
not a runtime fix or a successful automatic-repair test. Future retention checks
must include real release-status examples as well as the synthetic fixture.

## Release-status retention comparison

Fixed question: can the saver separate a supported concurrency lesson from the
installation status reported alongside it? The fixture distills the observed Elpis
case into two assistant evidence items; it is not an exact replay of the historical
request and does not independently establish that the reported checks ran.

Keep the input, Luna model, low reasoning, 6,000-character budget and tool-free
request constant. Compare the current consolidation instructions with one appended
paragraph requiring a future decision, supporting evidence, and a cause/condition/
prevention rule, while explicitly assigning release identifiers and acceptance
status to ES. Run one request per condition, capped at two with no fallback.
Isolated profiles disable actual saving and admission; inspect returned JSON, not
the user's notes. This evaluates retention decisions, not file persistence.

Acceptance for each response: preserve the user's launch preference; retain the
supported workspace-lock lesson and manual-edit/unrelated-workspace qualifications;
keep commit/hash/install/test-status details out of MEMORY; keep unfinished
acceptance in checkpoint. A tie does not justify shipping a prompt change. A
single favorable sample does not establish reliable retention or resolve the
separate project-scope failure.

Driver: retention mode of `.tmp/final-candidate/memory-lessons-live.cjs`. Raw
requests, outputs, usage, timing and binary hash are recorded in
`.tmp/final-candidate/memory-retention-comparison-result.json`.

Result: both responses met these criteria. Both kept installation identifiers and
pending acceptance in checkpoint, preserved the launch preference, and retained
the workspace-lock/manual-edit/unrelated-workspace lesson in MEMORY. Both parsed
as the required two-string object within the character budget. This is a tie;
the proposed prompt paragraph was **not applied to product code**. The distilled
fixture did not reproduce the original retention error and cannot invalidate it.

Exactly two Luna-low requests completed, with no retries or fallback. Reported
usage was 903 tokens for baseline and 956 for revision (1,859 total), taking 14.3
and 12.9 seconds respectively. Those single-run timings do not demonstrate a
latency improvement. Real memory files and the installed binaries were unchanged.
Further prompt-only tuning on this passing fixture would provide weak evidence;
the next retention reproduction needs the original full consolidation input or a
new captured failure, while project isolation remains a separate implementation
task.

## Captured ordinary-session failure, September 14

The installed 0.1.23 runtime passes the isolated persistence controls again
(`.tmp/final-candidate/installed-shared-memory-runtime.log`). This does not prove
semantic selection. The actual latest save receipt, `3568eeff-1485-409f-af32-11132b7de03e`,
added installed versions and test totals to MEMORY. It also reported a TASKS edit
as failed in ES, although both the failed attempt (evidence112) and later successful
retry (evidence114/115) were present. This is a model consolidation error, not proof
that the successful tool result was missing from its input.

One Luna-low replay used that exact receipt's input and the previously proposed
retention paragraph from the comparison above. It requested the same strict
two-string output shape, exposed no tools, and had a hard one-request gate with no
fallback. Original notes were not modified. The recorded original response is the
baseline; it was not regenerated, so this is not a replicated paired evaluation.
Driver and raw output remain in `.tmp/final-candidate/memory-lessons-live.cjs` and
`memory-retention-captured-result.json` (captured-receipt mode).

The revision omitted the new installation-status bullet and the stale failed-patch
task, but retained older release/test-status bullets and corrupted an existing
evidence ID. It therefore fails the intended retention/provenance outcome. The
prompt revision was **not applied**. It used 25,337 reported tokens (23,773 input,
1,564 output), taking 38.113s. The original recorded save used 25,420 tokens and
33.917s in its request phase. These observations establish neither lower cost nor
lower latency. The last three real receipt request phases took 26.947s, 27.454s,
and 33.917s; enabled pre-compaction saving can add such a wait before compaction.

The malformed citation exposed a separate deterministic persistence defect:
unsupported UUID-based references were accepted and could become credible-looking
numeric references. The installed runtime fails the new adversarial check in
`scripts/memory-runtime.test.cjs` (`memory-citation-integrity-before.log`): an
invented source changes saved `[1]` to `[2]`. The candidate checks new UUID-like
citations against supplied evidence, previous notes, or retained provenance before
writing either file. It also recognizes the damaged UUID form from the real replay.
This does not validate a cited claim, classify project scope, or prove that a
model-selected lesson is useful. Candidate build/verification results follow.

The optimized candidate passed in 232.701s, peaking at 71°C. The first build was
stopped after read-only review found undashed UUIDs could bypass the initial guard;
validation and shortening now share one parser. Runtime checks pass for fabricated
canonical, undashed and braced IDs, the captured malformed ID, and checkpoint
citations, preserving both notes, provenance and receipt count. Existing save,
restart, concurrent-edit and disabled controls also pass. The stripped packaged
runtime passes the same checks. Logs: `memory-citation-integrity-after-retry.log`,
`memory-guard-packaged-runtime-retry.log`. All 55 extension checks pass without
skips (`memory-guard-editor-regression.log`); these checks use a localhost fixture.
Formatting and diff checks pass. Full Rust unit suites and native VS Code visual
checks were not rerun for this persistence-only change.

Two harness invocation errors were corrected: a relative executable path was
resolved against the test workspace, and Python ZIP extraction omitted executable
permissions. The harness now resolves its binary argument; extracted permissions
were restored from the VSIX metadata, which correctly records mode0755. Neither
failed invocation was counted as a successful runtime check.

Committed as `10976e69` and installed locally. CLI SHA-256:
`e05a0c309dbc9e03a86c7b8fc51ec2af751cd3e71b0d060975ed7ac30b725df0`.
IDE extension0.1.24 runtime SHA-256:
`9fb6cbddb6593758cb20dbe19a71875fb32cf6637c77dab3af7ec0f02f8d405b`.
All 42 installed runtime files match the package byte-for-byte; its manifest matches
apart from VS Code installation metadata. The CLI still reports0.2.0. Recovery is
at `~/.local/share/elpis/release-recovery/memory-provenance-20260914/`.
No user process was restarted, real memory rewritten, or remote release published.
One worktree remains. A fresh process is required to load this code; already-running
shared daemons retain their earlier runtime until stopped normally.

### Observed saver overhead

A read-only accounting of the 19 retained Elpis-workspace receipts found 19
committed saves and 489,841 reported tokens: 465,739 input and 24,102 output, with
zero reported cached input tokens. All 19 receipts include usage; ten include
phase timings, totalling 247.728s in model-request time. This excludes rejected or
timed-out calls without receipts and separately run evaluations, including the
25,337-token replay above. It is not total account spend or a measurement of memory
benefit. Raw aggregate: `.tmp/final-candidate/memory-receipt-accounting-20260914.json`.
The current full-tail consolidation cost needs evaluation alongside recall quality;
using a cheap model alone does not establish an efficient memory system.

## User corrections crowded out of evidence — September 14

Exact item-content comparison across 20 retained receipts found 70,226 of
1,278,535 selected characters repeated the immediately preceding save (about5.5%).
IDs assigned by the saver were excluded from that comparison; original item data
was compared unchanged. This does not support repeated identical history as the
main explanation for this sample's cost. Raw aggregate:
`.tmp/final-candidate/memory-evidence-overlap-20260914.json`.

Several recent receipts contain no user messages; another contains only an
environment message. The current reverse-order selection can fill its64k budget
with tool/assistant output before reaching the user's correction. The installed
0.1.24 runtime reproduces this in `memory-user-evidence-before.log`: a63.5k assistant
response displaces a smaller explicit user correction from the actual saver input.

The candidate reserves up to32k for recent whole user messages, then fills the
remaining portion of the same64k cap with eligible unselected items. Unused reserved
capacity is available to other evidence, and larger users can use spare capacity
in the second pass. Original chronology, identifiers and whole-item boundaries
are preserved. Runtime controls also assert unique ordered indices and the original
character cap. This improves evidence availability, not semantic fidelity; it
cannot guarantee every message fits or that Luna saves the correct lesson.

Separately, one capped Luna-low replay of the earlier captured input tests the
existing retention revision plus explicit review of old entries. Required outcomes
remain: remove temporary release/test status, retain supported durable preferences
and lessons, keep unfinished work in ES, and preserve valid citations. The prompt
remains unchanged in production until the replay is assessed. Raw result:
`memory-retention-existing-result.json`; no real memory is edited by this replay.

That replay failed: it again saved installed versions and test totals, retained
per-run evaluation status, and renumbered existing short citations even where the
associated facts were unchanged. It also retained the stale `runtime-query.js`
follow-up. The candidate prompt is **not applied**. One request completed in47.107s
using25,977 reported tokens (23,815 input;2,162 output), without fallback or retry.
Together with the earlier captured replay, this is evidence against declaring
the prompt-only retention revisions reliable. The user-evidence selection change
is evaluated separately and does not claim to resolve these semantic failures.

The selection candidate built successfully in379.043s, peaking at73°C with one
0.523s thermal pause. The new failure passes on the built and stripped packaged
runtime, together with order/uniqueness/budget, large-user spare-capacity, saving,
restart, citation, concurrent-edit, queued-input and disabled controls. Logs:
`memory-user-evidence-after.log`, `memory-user-packaged-runtime.log`. All55 extension
checks pass with none skipped (`memory-user-editor-regression.log`). These runtime
checks use controlled localhost responses; only the separate failed retention
replay uses live Luna. Formatting and diff checks pass. Full Rust unit suites and
native visual checks were not rerun for this evidence-selection change.

Installation completed September 14 from source `996e32cb`: CLI SHA256
`e9c5bd947cd11eb6a0727e52da85a4924b805f8befac9041836ce49fc3e7f951`,
IDE extension 0.1.25 runtime SHA256
`bf95ef0a5fdf9abcc4de5db14196e4ca8d3c16aa0b023cd5a098bc6994211648`.
All 42 non-manifest files match the extracted package; the manifest matches after
excluding VS Code installation metadata. CLI reports 0.2.0. Recovery is retained
under `~/.local/share/elpis/release-recovery/memory-evidence-20260914/`.
The default shared socket was absent at verification. No visible app was opened,
user session restarted, or remote release published. Existing processes require
normal exit before replacement code can run. One main worktree remains, with
unrelated `docs/USER_REQUESTS.md` edits preserved.

### Replacement prompt and entry-selection probe — September 14

The same captured input from receipt
`3568eeff-1485-409f-af32-11132b7de03e.json` was replayed with a replacement prompt,
rather than another appended paragraph. The model remained Luna-low, tools were
disabled, and the proxy allowed one forwarded request with no model fallback.
The replacement still updated the installed-version entry instead of removing it,
kept per-run evaluation status and the stale `runtime-query.js` task, and damaged
two full citations. Its old short numeric citations were preserved; comparisons
were made against the captured input, not today's changed memory file.
Result: **failed**, 25,344 reported tokens, 37.680 seconds.
Raw evidence: `.tmp/final-candidate/memory-retention-replacement-result.json`;
candidate instructions: `memory-retention-replacement.md` in that directory.

A second probe changed the output operation: select keep/drop for each existing
entry and supply only additions with evidence IDs. Existing entries would be
retained verbatim locally, eliminating model rewrites of their citations. It used
the same captured conversation evidence and previous memory content represented as
indexed bullets. This is an experimental contract, not the production saver.
One connection closed without a response (`socket hang up`); the proxy blocked the
runtime retry. That failed attempt is retained as
`memory-retention-decisions-connection-error.json`, with no reported usage.
One explicit fresh attempt then completed: 24,580 reported tokens, 21.087 seconds.

The selection probe preserved all twelve expected preferences/lessons, removed
the old distilled-evaluation entry and installed-version entry, added no new facts,
and no longer carried the stale runtime-query task. It nevertheless retained three
entries covered by the predeclared exclusion checks, including the bridge entry's
52-test count. The checkpoint also used abbreviated/backtick citations rather than
consistently preserving complete bracketed identifiers. **The acceptance check
failed; do not present this as a working retention replacement.** Raw output:
`memory-retention-decisions-result.json`; check:
`check-memory-retention-decisions.cjs`, both under `.tmp/final-candidate/`.

These probes reported 49,924 tokens in total, excluding the connection failure
whose usage is unknown. The apparent latency difference is one observation per
contract, not a performance benchmark. Neither candidate was applied to production
or to real memory. The installed version remains unchanged. Further work must
resolve mixed durable/status entries and checkpoint fidelity, and separately the
global/project boundary; another passing serialization test cannot close them.

### Mixed entries and interpretation rules — September 14 continuation

Explicit mixed-entry instructions now make Luna drop the temporary verification
entries and re-add their stable feature facts without test counts. However, that
run also dropped the existing rule explaining what a committed save receipt does
and does not prove. It therefore failed the unchanged retention criteria:
`memory-retention-mixed-result.json`, 24,948 reported tokens, 26.702 seconds.
An initial socket failure for this run returned no response or usage and its
automatic retry was blocked; one explicit fresh request produced that result.

Clarifying that evidence-interpretation rules are durable retained that rule but
also retained the old distilled experiment result. This also failed:
`memory-retention-interpretation-result.json`, 24,849 tokens, 23.922 seconds.
A final clarification gave the mixed-entry rule explicit precedence: extract only
the reusable interpretation rule rather than keeping the experimental result.
That request timed out at the driver's 90-second limit and produced no completed
decision. Its result is `memory-retention-precedence-timeout.json`; no token usage
was reported. The current draft is `memory-retention-decisions.md`. These are all
under `.tmp/final-candidate/`; raw requests retain each exact prompt version.

This continuation reports 49,797 tokens for the two completed requests, excluding
the socket failure and timeout whose usage is unknown. No candidate passed and no
production code or real notes changed. Further repeated wording trials alone are
not a demonstrated solution.

Independent review identified integration requirements beyond this bullet fixture:
preserve complete legacy paragraphs, preambles, and multiline/nested bullets;
validate exactly one decision per snapshot entry; keep original entry order and
bytes; resolve additions against real source records; preserve locks, concurrent
manual edits, receipts and final size limits; and distinguish validated intentional
removal of all obsolete entries from accidental whole-document erasure. The
fixture's numeric-citation allowance is not sufficient provenance validation, and
its checkpoint length check does not establish checkpoint fidelity. Explicit
correction and lossless legacy-document controls are required before integration.

### Prevent short-citation reassignment — September 14

The actual installed 0.1.25 saver reproduced an unchanged fact silently moving
from citation `[1]` to `[2]` (`memory-numeric-citation-before.log`). The new guard
checks terminal short citations on identical lines against the existing source
map and rejects removal or replacement of registered support before any notes,
checkpoint, receipt, or provenance write. It allows factual text changes, ordinary
numeric values outside the map, and additional registered supporting citations.
The source-table parser is shared with local citation shortening.

Review caught ordinary bracketed values being mistaken for references and rejection
of legitimate extra support; the initial build was stopped and the guard narrowed.
The revised optimized build completed in 330.697 seconds, peak75°C, three cooling
pauses totaling2.604 seconds. Actual-runtime checks pass for the reproduced failure
and the three allowed cases, together with existing saving, restart, budget,
malformed-output, UUID-citation, manual-edit, queued-input and disabled controls.
All55 extension checks pass, none skipped. Logs under `.tmp/final-candidate/`:
`memory-numeric-citation-reviewed-build.log`, `memory-numeric-citation-after.log`,
and `memory-numeric-editor-regression.log`. These use localhost responses, without
paid inference. Full Rust unit suites and native visual checks were not rerun.

This is a narrow safeguard, not semantic validation. It does not cover rewritten
or reflowed prose, missing citations, or interior citations. A bracketed value that
exactly coincides with registered citation labels remains ambiguous in the existing
notation; intentional source replacement on unchanged text is rejected. Manual
edits remain supported. This change does not resolve retention or project scope.

The same runtime controls pass on the stripped binary extracted from extension
0.1.26 (`memory-numeric-packaged-runtime.log`). Both candidate binaries pass the
personal-path byte check. CLI SHA256:
`dd8be96df525054bf79e8f25c516375a3e4247f6f352ac7cdeb49ccad5e57165`;
packaged runtime SHA256:
`34fb5726fffaf1f482188fe887f2196435a4ea0ac2e8b886c14da0103923965a`.

Source `c6f58c0e` is installed. Both installed binary hashes match the above; all42
non-manifest extension files match the package, and the manifest matches excluding
VS Code's installation metadata. CLI still reports0.2.0; extension is0.1.26.
Rollback copies are at
`~/.local/share/elpis/release-recovery/memory-numeric-20260914/`.
The default shared socket was absent before installation. No running user session
was stopped, visible app opened, or remote release published. One main worktree
remains, preserving unrelated `docs/USER_REQUESTS.md` edits.
# September 14: bounded Terra comparison

The previously authorized Terra alternative was run once on the captured
whole-document replacement fixture, using the same old runtime and low effort.
The response removed transient memory entries, but rewrote existing numeric
citations and emitted literal `\\n` sequences inside the returned strings. This
is not an acceptable durable-memory replacement and no production default or
prompt was changed. It does not establish project isolation or general retention
quality. The completed request reported 25,257 tokens (23,760 input, 1,497 output,
including 447 reasoning), no cached input, and 35.988 seconds. Raw result and log:
`.tmp/final-candidate/memory-retention-terra-result.json` and
`memory-retention-terra.log`. No further paid comparison was started in the
subsequent footer/IDE investigation.
