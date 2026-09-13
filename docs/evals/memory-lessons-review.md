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
