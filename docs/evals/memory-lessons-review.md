# Memory lessons: behavioral acceptance draft

September 13, 2026. Review draft; no new paid inference has been run for this
protocol. The existing port-recall result is separate evidence.

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

## Proposed probes

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
the cap at the request boundary before a paid run is approved.

## Evidence and interpretation

- Preserve exact prompts, binary hash, settings, saved notes, receipts, outputs,
  provider usage, elapsed time and failures. Never publish authentication data.
- Grade saved content, scope, correction and proposed action separately. Report
  the disabled control alongside the admitted condition, including a tie.
- This tool-free fixture tests action selection, not successful command execution
  or measured reduction of real coding errors. A later task evaluation needs an
  executable repository and independent verification of the resulting changes.
- Masih reviews the categories and fixture before execution. One synthetic lesson
  cannot establish general benefit, a useful average effect, or research novelty.
