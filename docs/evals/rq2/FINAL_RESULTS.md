# FINAL RQ2 results

## Outcome

The RQ2 measurement has not completed and has no defensible retention estimate. The preserved session-1 attempt captured all six predeclared items, but Elpis returned `server_overloaded` before producing a qualifying pruning event; under the resumed protocol, that external interruption is not counted as an experimental run. Resume of the existing session ID was then rejected by the frozen binary’s CLI, so session 2 was not started and no replacement session was launched. No final probe was issued, so no item-level retention score exists.

The interrupted attempt and the failed resume are preserved; neither is silently retried or relabeled as a completed run.

## Fixed identities and procedure

- Worktree: `/home/masih/Desktop/p/elpis-rq2-final`
- Source commit: `0b832c3ef77ed29a658b694e73a0cd356a6fe99a`
- Elpis binary: `/home/masih/.local/bin/elpis`
- Binary SHA256: `782fd9859e1dd69aa5fb7074bfebf4dbd0e319574412cdc742926816a19ee0a1`
- Model/provider: `gpt-5.6-luna` / `openai`
- Session configuration: read-only model shell, approvals never, memories disabled by CLI overrides, working directory set to this worktree, no alternate terminal screen.
- Exact launch procedure is preserved in [`runs/session-1-invalid/RUN_STATUS.md`](runs/session-1-invalid/RUN_STATUS.md) and the exact initial prompts are [`procedure/session-1-initial.txt`](procedure/session-1-initial.txt) and [`procedure/session-2-initial.txt`](procedure/session-2-initial.txt).
- The frozen final probe was [`procedure/frozen-final-probe.txt`](procedure/frozen-final-probe.txt); it was not issued because the qualifying-prune precondition failed.
- The deterministic rubric was fixed before execution in [`SCORING_CRITERIA.md`](SCORING_CRITERIA.md).
- The resume attempt and frozen-binary CLI evidence are [`runs/session-1-invalid/RESUME_STATUS.md`](runs/session-1-invalid/RESUME_STATUS.md).

The actual session-1 ID was `019ff148-e0d6-79e1-84ce-d352a866bdcb`. No session-2 ID exists.

## Twelve item-level accounting rows

The table has 12 rows to account for the requested two-by-six design. Rows marked `not run` are not observations and are included only to make the missing second session explicit.

| Session | Class | Item | Exact planted line | Evidence/status | Prune classification | Deterministic final score |
|---|---|---|---|---|---|---|
| 1 | constraint | C1 | `FINAL_RESPONSE_ORDER=C1,C2,F1,F2,O1,O2` | Captured by target call in [`target-captures.tsv`](runs/session-1-invalid/target-captures.tsv) | impossible to classify: no qualifying prune | not scored: no final probe |
| 1 | constraint | C2 | `FINAL_RESPONSE_SHAPE=exactly six non-empty plain-text lines and nothing else` | Captured by target call in [`target-captures.tsv`](runs/session-1-invalid/target-captures.tsv) | impossible to classify: no qualifying prune | not scored: no final probe |
| 1 | factual/state | F1 | `state_code=Q7-EMBER` | Captured by target call in [`target-captures.tsv`](runs/session-1-invalid/target-captures.tsv) | impossible to classify: no qualifying prune | not scored: no final probe |
| 1 | factual/state | F2 | `revision_slot=214` | Captured by target call in [`target-captures.tsv`](runs/session-1-invalid/target-captures.tsv) | impossible to classify: no qualifying prune | not scored: no final probe |
| 1 | tool output | O1 | `tool_hex=9A7F-C2D1` | Captured by target call in [`target-captures.tsv`](runs/session-1-invalid/target-captures.tsv) | impossible to classify: no qualifying prune | not scored: no final probe |
| 1 | tool output | O2 | `tool_count=5831` | Captured by target call in [`target-captures.tsv`](runs/session-1-invalid/target-captures.tsv) | impossible to classify: no qualifying prune | not scored: no final probe |
| 2 | constraint | C1 | `FINAL_RESPONSE_ORDER=C1,C2,F1,F2,O1,O2` | Not run; session 2 prohibited by stop rule | not observed | not scored |
| 2 | constraint | C2 | `FINAL_RESPONSE_SHAPE=exactly six non-empty plain-text lines and nothing else` | Not run; session 2 prohibited by stop rule | not observed | not scored |
| 2 | factual/state | F1 | `state_code=R4-QUARTZ` | Not run; session 2 prohibited by stop rule | not observed | not scored |
| 2 | factual/state | F2 | `revision_slot=731` | Not run; session 2 prohibited by stop rule | not observed | not scored |
| 2 | tool output | O1 | `tool_hex=4D8B-E671` | Not run; session 2 prohibited by stop rule | not observed | not scored |
| 2 | tool output | O2 | `tool_count=9062` | Not run; session 2 prohibited by stop rule | not observed | not scored |

## Outcomes by information class

| Class | Predeclared | Captured in a session | Qualifyingly pruned | Final probes scored | Valid retention observations |
|---|---:|---:|---:|---:|---:|
| Constraints | 4 | 2 | 0 | 0 | 0 |
| Factual/state values | 4 | 2 | 0 | 0 | 0 |
| Tool-output values | 4 | 2 | 0 | 0 | 0 |
| Total | 12 | 6 | 0 | 0 | 0 |

The six session-1 capture outputs are exact and independently traceable to six separate tool calls. They are evidence of planting, not evidence of post-prune retention. Session-2 fixture files document the predeclared design but do not count as Elpis observations.

## Removed/replaced retention

There were zero items with audit evidence of a non-`kept` pruning replacement. Therefore:

- removed/replaced items: `0`;
- recalled correctly after removal: `0`;
- recalled incorrectly/lost after removal: `0`;
- retention among actually removed/replaced items: undefined, with denominator `0`.

No item is classified as unaffected, because an unaffected classification requires a qualifying pruning pass against which the target call can be compared. The six session-1 items are `impossible to classify`; the six session-2 items were not run.

## Deterministic scoring

No LLM judge was used. The fixed rubric scores C1/C2 from exact line count/order and absence of extra text, and F1/F2/O1/O2 from exact `key=value` payload equality. Since the frozen final probe was never issued, every session-1 final score is `not scored`, not pass or fail.

## Strongest defensible RQ2 conclusion

This experiment provides no evidence for or against information retention across an actual Elpis pruning event. The only supported operational finding is that this controlled session’s selected model became unavailable while accumulating context, before the required pruning event; that is a run-validity failure, not an information-retention result.

## Limitations

- The provider/model capacity error prevented the qualifying event and final probe.
- The explicit stop rule prevented a second session, so the requested two-session comparison cannot be estimated.
- The last emitted context trajectory was 70,706 input tokens within a 258,400-token model window; the transcript contains no prune/compaction event and `context_prune_saved_tokens` remained zero.
- The global `~/.elpis/logs/pruning/passes/` directory also contains pruning records from the surrounding agent environment. Some quote the child transcript inside outer evidence text, but no qualifying pass has an audit item `call_id`/`source_pointer` equal to a child-session target call, so those records were excluded.
- No repository build or test was run. Elpis itself was executed only for the controlled measurement.

## Evidence index

- Session-1 full Elpis transcript: [`runs/session-1-invalid/elpis-session.jsonl`](runs/session-1-invalid/elpis-session.jsonl)
- Session-1 full terminal transcript: [`runs/session-1-invalid/terminal-transcript.log`](runs/session-1-invalid/terminal-transcript.log)
- Session-1 target calls and exact outputs: [`runs/session-1-invalid/target-captures.tsv`](runs/session-1-invalid/target-captures.tsv)
- Session-1 all tool calls: [`runs/session-1-invalid/all-tool-calls.tsv`](runs/session-1-invalid/all-tool-calls.tsv)
- Session-1 all tool outputs: [`runs/session-1-invalid/all-tool-outputs.tsv`](runs/session-1-invalid/all-tool-outputs.tsv)
- Session-1 token/context trajectory: [`runs/session-1-invalid/token-context-trajectory.tsv`](runs/session-1-invalid/token-context-trajectory.tsv)
- Session-1 empty child prune-event extract: [`runs/session-1-invalid/child-prune-events.tsv`](runs/session-1-invalid/child-prune-events.tsv)
- Session-1 completion error: [`runs/session-1-invalid/task-complete.json`](runs/session-1-invalid/task-complete.json)
- Session-1 status and configuration: [`runs/session-1-invalid/RUN_STATUS.md`](runs/session-1-invalid/RUN_STATUS.md)
- Resume attempt and CLI help: [`runs/session-1-invalid/resume-attempt.log`](runs/session-1-invalid/resume-attempt.log), [`runs/session-1-invalid/resume-cli-help.txt`](runs/session-1-invalid/resume-cli-help.txt), [`runs/session-1-invalid/RESUME_STATUS.md`](runs/session-1-invalid/RESUME_STATUS.md)
- Session-1 pruning record: [`runs/session-1-invalid/PRUNING_PASS_RECORD.md`](runs/session-1-invalid/PRUNING_PASS_RECORD.md)
- Session-2 stop record: [`runs/session-2-not-run/STATUS.md`](runs/session-2-not-run/STATUS.md)
- Predeclared session-1 and session-2 target fixtures: [`fixtures/`](fixtures/)
