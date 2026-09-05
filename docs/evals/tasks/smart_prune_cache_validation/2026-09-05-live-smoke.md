# ELPIS-SMOKE-20260905-01 — live Smart Prune smoke

Executed 2026-09-05. This is an ON-only functional observation, not a
controlled cost/quality experiment. One fresh tool output was shortened before
the main-model follow-up; the tool-only fact remained available. Broader UI
acceptance and paper claims remain separate.

## Question and method

Can the installed candidate admit an eligible tool output through the real
optimizer and still answer a fact absent from the prompt and prior response?
The fixture emits 12,000 repeated characters followed by an audit marker. The
initial prompt requests one shell command and then only the marker's value; the
value is planted in tool output, not the prompt.

Smart Prune was ON. Unnecessary apps/plugins/MCP and notifications were disabled;
the shell sandbox was read-only. Existing subscription authentication was used
without copying credentials, and the alternate provider key was absent from the
process. No matched OFF arm was run. Mocked positive/OFF controls belong to a
separate integration suite.

## Identity and deviations

| Field | Observed value |
| --- | --- |
| Version / profile | Elpis 0.2.0 / `local-release`; local candidate, not published release |
| Provider route | OpenAI route / existing subscription |
| Main model / effort | `gpt-5.6-luna` / medium |
| Optimizer / effort | `gpt-5.6-luna` / low |
| Main inferences / shell commands / optimizer attempts | 2 / 1 / 1 |
| Recorded whole-turn duration | 11,502 ms |
| Optimizer latency | 5,002 ms |

The launcher requested a different small model at low effort, but startup
migration interaction resulted in Luna medium. This is not a small-model result.
The launcher is not an enforceable HTTP-call cap; lower-level retries are not
fully observable. Startup included human interaction and is not a performance
measurement. A later color inspection changed terminal environment only; raw
model evidence was not rewritten.

## Measurements

| Measurement | Result | Meaning |
| --- | ---: | --- |
| Source / admitted size | 3,029 / 71 | Locally estimated tokens |
| One-time source reduction | 2,958 (97.66%) | Removed before first exposure; not net cost saved |
| Optimizer input / output / total | 6,495 / 136 / 6,631 | Provider-reported usage |
| First main input / cached input | 9,561 / 0 | Recorded accounting; zero may omit cache detail |
| Follow-up input / cached input / output | 9,785 / 8,960 / 20 | Provider-reported usage |
| Follow-up cached share | 91.57% | Cache reuse observed for this response |
| Main total / main + optimizer total | 19,462 / 26,093 | Reported request usage, not context occupancy |
| Tool-only fact | Retained | Absent before tool output |

Missing usage/pricing remains unknown; no subscription-dollar saving is
calculated. Source reduction is not subtracted from optimizer totals as net
savings. No causal cost, matched OFF comparison, generalized quality retention,
or statistical significance is established.

## Allowed conclusions and evidence boundary

Supported: live admission observed, tool-only fact retained, cache reuse observed,
and append-only logical continuation supported for this request pair. Encoded
wire-prefix identity and unchanged cache hit rate versus OFF are untested.

Raw traces, payloads, receipts, fixtures, and private archive inventories remain
outside Git and are not named or hashed here. They are private supporting
evidence, not public reproducibility material.

The aggregate receipt audit can be rerun without model calls from a private copy:

```sh
node tools/smart-prune-report/report.mjs --root /path/to/private/archive/state/logs/smart-prune
```

The retained verification report link is
[2026-09-05-live-smoke-verification.json](2026-09-05-live-smoke-verification.json).
Its structural PASS does not override the untested causal/cache-cost fields.
