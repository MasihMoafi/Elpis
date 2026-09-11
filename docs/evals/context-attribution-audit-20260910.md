# Context attribution audit — September 10, 2026

Masih questioned a Reasoning slice of 18% while main-model effort was Low/Medium.
The display arithmetic is reproducible; the category attribution is not proven
to be an accurate measurement of hidden reasoning tokens.

An inspected live snapshot estimated 61,748 reasoning-category tokens out of
202,744 locally estimated request tokens. The UI proportionally scaled those
categories to the provider-reported total of 155,560 tokens, then divided by the
258,400-token window. That yields approximately 18.3% of window capacity. It is
not the current response's reasoning-token percentage or the effort setting.

`core/src/client_common.rs` groups Reasoning, Compaction, and ContextCompaction
items into the same reasoning field. `context_manager/history.rs` estimates
encrypted content from its encoded length, subtracts a fixed overhead, and uses
a bytes-to-tokens heuristic. The actual hidden content is not observable here.
`tui/src/chatwidget/context_usage.rs` preserves those estimated proportions while
scaling their sum to the measured total. Scaling does not calibrate the individual
categories. Existing category/rendering tests prove classification and arithmetic,
not agreement with provider-measured category counts.

Consequently, the 18% label must not be represented as a verified pure-reasoning
measurement. It includes retained history and compaction estimates. The UI's
estimated-attribution note is material. Separating compaction and validating
opaque estimates remain open accuracy issues;
no counter was changed merely to make this percentage look smaller.

September 11 correction: the shared category label is now **Reasoning + compaction**.
The context chart explains that it includes retained-history estimates rather than
the effort setting. A new rendering check failed against the old label, then
passed for both narrow and wide layouts; its negative case omits the category and
explanation when reasoning/compaction estimates are absent. The measured total and
proportional allocation are unchanged. All 22 active context-report checks pass
(one is ignored). Evidence: `.tmp/final-candidate/context-label-before.log` and
`context-label-after.log`. This clarifies the UI; it does not validate opaque-token
estimates against provider-measured category counts.

The same session also recorded 35 Smart Prune requests with about 67.5 minutes
of cumulative optimizer latency; the latest inspected attempt used gpt-5.6-luna
at Max effort. This is separate from main-model effort and can overlap build
time. The build delay also includes a cold test build and a second dependency
feature set for the normal executable. The existing local-release profile,
linker/path-remapping settings, and thermal guard were used with one Cargo job
and one compiler thread. More assistant thinking budget would not shorten these
compilation or optimizer operations.

This audit does not establish provider-side reasoning retention or tokenizer
accuracy, and it does not change model/optimizer settings. Manual acceptance of
the context breakdown remains pending.

## Capacity reporting correction, 2026-09-11

The UI previously guessed capacity from model names: one million for names containing
`gemini`, 200,000 for `claude`, and 258,400 otherwise. A focused runtime regression
reproduced the invented 258,400-token capacity for an unknown model with neither a
reported nor configured window (`context-capacity-before.log`).

The correction uses a positive reported capacity, then a positive explicitly
configured capacity, otherwise unknown. Measured token usage remains visible without
a fabricated percentage. The context report, Ledger and dashboard share that rule.
The focused Rust regression passed (`context-capacity-after.log`). A DOM evaluation
of the dashboard failed against the previous source and passed the correction for
reported, missing and invalid capacity, plus absent usage
(`context-capacity-dashboard-before.log` and `context-capacity-dashboard-after.log`).
All evidence files above are under `.tmp/final-candidate/`.

The first full TUI run after the correction recorded 3,059 passed, 84 failed and
five ignored. It fixed the existing unknown-window token indicator failure; two
model-label tests still expected the removed full-window wording. Their assertions
were updated and all three model-label checks pass. The separate startup footer
fallback also reproduced the false 100% claim, then passed after changing it to
`context unknown` (`context-capacity-startup-before.log` and
`context-capacity-startup-after.log`). Known percentages and measured token counts
retain their existing display behavior. Invalid configured capacities and actual
Ledger buffer rendering are covered by the expanded regression.

Reviewed 28 footer snapshots: only the unknown-state wording and its spacing changed;
one narrow footer consequently exposes two more characters of the Tab hint. All 21
affected snapshot tests pass. The final full run records **3,062 passed, 82 failed,
five ignored**, with no new failures against the prior committed baseline
(`tui-context-capacity-reviewed.log`). Remaining failures still prevent a clean
release; this evidence is not user acceptance.
