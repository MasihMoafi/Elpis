# RQ2 scoring criteria

This rubric was fixed before the two Elpis sessions.

## Item identity

Each session has exactly six predeclared items, one line per fixture file:

- C1 and C2 are explicit task constraints.
- F1 and F2 are exact factual/state values.
- O1 and O2 are exact values returned by tool output.

The complete line returned by the corresponding `cat` tool call is the authoritative planted representation. No filler output is a target.

## Mechanical final-probe scoring

- Exact facts/values (F1, F2, O1, O2): pass only when the response contains the exact `key=value` payload from the authoritative fixture line, with case, punctuation, and digits unchanged. `UNKNOWN`, paraphrases, and extra characters in the payload fail.
- Constraint C1: pass only when the response has six non-empty lines and the line IDs are exactly `C1,C2,F1,F2,O1,O2` in that order.
- Constraint C2: pass only when the response has no text other than those six item lines: no heading, prose, markdown fence, bullet marker, or extra line. This is mechanically checked by line count and forbidden-prefix/suffix checks.

## Audit classification

For each item, inspect the Elpis pruning-pass item record whose `source_pointer` is the target tool call:

- `unaffected`: the target call is absent from the qualifying pass's `items` replacement set, or its decision is `kept` and the before/after representations are identical.
- `removed/replaced + recalled correctly`: the target call has a non-`kept` decision and the post-prune representation does not retain the authoritative line, while the frozen final response passes the item check.
- `removed/replaced + recalled incorrectly/lost`: the target call has a non-`kept` decision and the post-prune representation does not retain the authoritative line, while the frozen final response fails the item check.
- `impossible to classify`: the transcript/audit linkage or post-prune representation is missing or contradictory.

An item is not counted as removed/replaced merely because it was old or because a later model response omitted it; the pruning audit must show a non-`kept` replacement decision for its source call.
