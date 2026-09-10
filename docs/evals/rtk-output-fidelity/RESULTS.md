# First Local RTK Fidelity Results

2026-09-05. RTK 0.43.0. Local offline observation, not generalized acceptance.

## Outcome

RTK did omit relevant information on a real experiment-spec search. One scripted
fallback read recovered it. RTK did not shorten the full-file spec read. Therefore
RTK is a demonstrated source of some omissions, but not the explanation for every
summary seen in this conversation.

| Repository task | Raw bytes | RTK bytes | Critical checks lost | Recovery reads |
| --- | ---: | ---: | ---: | ---: |
| Read checkpoint heading/intent before editing | 641 | 239 | 0 / 2 | 0 |
| Read complete experiment protocol | 22,412 | 22,412 | 0 / 6 | 0 |
| Audit pruning/cache references in protocol | 2,986 | 2,145 | 2 / 4 | 1 |

The search returned 35 matches in the raw capture. RTK displayed 25, shortened
several lines, and replaced the last ten with a count. Concrete losses:

- The warning against assuming automatic pruning is default-on was shortened to
  `automatic pruning is def...`, losing the end of the warning.
- The later requirement to exercise a harmless tool call and pruning pass and
  verify streaming was in the omitted matches.

The search's RTK output plus the actual raw recovery read totaled 5,131 bytes,
versus 2,986 bytes for the initial raw command alone. This is captured subprocess
output volume, not token usage or a measured model productivity/cost result.

The `head -12 ES.md` rewrite also omitted five nonempty lines from the requested
slice, but its two predefined heading/intent checks survived. We must not label
those two checks failures or claim a recovery was needed for that narrow task.

## Evidence and Verification

Final captures: `runs/2026-09-05T18-13-30.259Z-2/`. Each case has the original
source snapshot, raw and RTK stdout/stderr/exit status, hashes, and check results.
The search also has a real recovery capture. Full spec stdout was byte-identical.

The earlier capture at `runs/2026-09-05T18-12-43.976Z-2/` is retained. Its oracle
was then hardened to ignore indentation after search line numbers, avoiding a
formatting-only false positive. The final run still found the same two omissions.
These are repeated diagnostic captures, not independent statistical samples.

Passed controls: intact content accepted; search indentation changes accepted;
deleted fact, shortened fact, and empty output detected. `git diff --check` passed.
No dependencies installed, paid inference performed, or runtime settings changed.

## Limits and Useful Next Step

This demonstrates loss in these direct RTK paths and one scripted recovery, not
that an LLM necessarily would issue the same fallback. Downstream Elpis Smart Prune
and outer tool truncation were bypassed in the archived captures, not evaluated.
It does not establish how often the problem occurs or whether RTK is worse overall.

For exact protocol/evidence inspection, use direct raw captures; keep RTK available
for summaries. Do not globally disable it based on three selected commands.
Next live pruning pilot should perform useful spec/tool repairs in isolated copies,
with the already specified frozen prompts, hidden grading, state isolation, and
explicit run limits. That live harness and its fixtures are not implemented yet.
