# RQ2 result: post-prune information retention

**Status:** established for the six tested targets

**Audit date:** 2026-08-11

**Session:** `019ff1b2-be61-7ea3-b835-652379b13f91`

**Source commit:** `0b832c3ef77ed29a658b694e73a0cd356a6fe99a`

## Claim

After 11 automatic Ace pruning passes, all six planted task-relevant targets were still
explicitly present in the model-visible post-prune context at `replacement_history`
record 298.

For this result, retention means that the exact planted requirement or value remains in
the active context after pruning. It is checked from the raw rollout; no model judge is
used.

## Evidence

The audited rollout is:

`~/.elpis/sessions/2026/08/11/rollout-2026-08-11T20-10-51-019ff1b2-be61-7ea3-b835-652379b13f91.jsonl`

The session ran with Elpis binary SHA-256
`782fd9859e1dd69aa5fb7074bfebf4dbd0e319574412cdc742926816a19ee0a1`, model
`gpt-5.6-luna`, and a 258,400-token context window. The repository remained clean and no
`.rs` files were modified.

| Target | Planted information | Original source | Present after pruning |
|---|---|---|---|
| T1 | `ORCHID-7319` | User prompt | Yes, record 298 item 2 |
| T2 | `0b832c3ef77ed29a658b694e73a0cd356a6fe99a` | Initial tool output | Yes, record 298 item 6 |
| T3 | `670d1cb780484b674c338ba924558fa9f539747a22bc20cc2e223f730dda614c` | Initial tool output | Yes, record 298 item 6 |
| T4 | `Never modify any .rs file` | User prompt | Yes, record 298 item 2 |
| T5 | `Do not use web search` | User prompt | Yes, record 298 item 2 |
| T6 | `Final report must contain exactly 6 top-level numbered sections` | User prompt | Yes, record 298 item 2 |

**Result: 6/6 targets retained.**

All 11 pruning passes were automatic; the session contains no manual `/prune` or
`/compact` command. The three final passes reduced active context from 243,335 to 196,868
tokens. The cumulative `context_prune_saved_tokens` counter reached 197,345 tokens across
all 11 passes.

## Scope

This establishes post-prune context retention for the six tested targets. Four targets
were user requirements, which pruning cannot rewrite. The two tool-output values also
remained intact in primary history. The audit does not show recovery of a value after its
source item was deleted or replaced.

Retention and task performance are separate questions. This result does not establish
that pruning improves task completion, output quality, cost, or latency.
