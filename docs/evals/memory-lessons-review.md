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
