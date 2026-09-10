# Cost-Efficiency Results for Fresh-Output Pruning

Started 8 September 2026, updated as batches seal. Protocol:
[COST_EFFICIENCY_PROTOCOL.md](COST_EFFICIENCY_PROTOCOL.md). Machine-readable
metrics: [COST_EFFICIENCY_METRICS.json](COST_EFFICIENCY_METRICS.json) (Luna) and
[COST_EFFICIENCY_METRICS_TERRA.json](COST_EFFICIENCY_METRICS_TERRA.json) (Terra main), produced by
`cost-metrics.mjs` from sealed batches. Every figure below is a published-rate
estimate (Luna, 8 September 2026: $0.20 input, $0.02 cached input, $1.20 output
per million tokens), not an invoice.

## Headline (all figures from sealed batches; see sections below)

- **Retention did not depend on effort.** Max, Low, Medium (five cases), and
  None all passed every closed-book probe they ran: 6/6 planted facts and
  citations per case including the withheld ones.
- **Effort set the overhead.** Per admission: Max 2,914 to 6,214 reasoning
  tokens and 60 to 119 s; Low 78 to 516 and 10 to 19 s; None 0 and 6 to 8 s.
  At the 8 September design's three-request horizon this is +163%, +54%, and
  +25% cost versus no pruning; token totals fall 1%, 10.5%, and 11.4%.
- **Horizon set the sign.** At Low: cost +54% at 3 requests, -3% at 11, -9.8%
  at 35 (7 of 8 cases); tokens -31% to -34% (8 of 8) beyond the first few
  requests; peak request input -35% to -40%; wall-clock +16% at 35 requests.
  At None: **-20.9% cost at 35 requests in 8 of 8 cases** (sign test
  p = 0.0078), -33.6% tokens, break-even 7 to 15 later requests.
- **Session shape amplifies it.** Eight reads then eight steps: at Low -7.5%
  cost (3 of 3 valid orderings) and -63% tokens; at None -29% cost (2 of 2)
  and -69% tokens; peak request 15k versus 70k tokens.
- **The one fidelity gap, now seen at Low too:** two summaries (one None in
  the eight-file session, one Low in the Terra batch) rewrote the exact
  `file:line` citation labels while keeping every fact and line number, so the
  answers' values were right and their citations failed the exact oracle. Max
  never did in 8 single-file admissions. A deterministic admission check that
  every source label survives verbatim would close this (product finding).
- **A pricier main model flips the sign at once (E6, measured).** Terra main
  with the Luna optimizer at Low: pruning 43% cheaper in 5 of 5 cases
  at three requests, break-even under one later request.
- **Against native compaction (E5):** pruning keeps the smallest context and
  never resets the provider cache; forced compaction resets the cached prefix
  to the system prompt at every event, retained the facts here, and reports
  zero usage for its own call, so it looks cheapest in visible counters.
- **Failures kept:** one ON stall without a receipt, one optimizer timeout that
  degraded gracefully, four `unchanged` verdicts and two malformed responses
  (each disabling pruning for the rest of the turn) in multi-file sessions, one
  probe formatting miss, one unsupported effort value, one network outage.

## Candidate under test

One local-release build of the measured 8 September candidate with a single
change: the optimizer's reasoning effort reads the config key
`smart_prune_reasoning_effort` (default Max, unchanged). Binary SHA-256
`d58e8c9b8861cc386265fdc799c3b556d8106b8f4a5983fb524ecc676f5b2c8f`; source patch SHA-256 `c83eca87e773af461a85d3b8340f28345e378577238ca6da1dc670c31aa951ea`;
optimizer instructions unchanged (SHA-256 `ddd4d0909c81bb97…`). Provenance and
build log: `~/.local/share/elpis/experiments/COST-EFFORT-BUILD-20260908-01`.
Main model `gpt-5.6-luna` at medium effort, ChatGPT authentication, one lane,
no retries; arms differ only by the pruning flag, recorded in each `launch.json`.

Definitions. OFF = pruning disabled; ON = pruning enabled (NATIVE). "ON total"
counts the optimizer's own usage once. D is the per-request main-model cost
saving for requests after the read; T* = optimizer cost / mean D is the
break-even number of later requests, extrapolated from the observed cache
pattern of that pair.

## E1. Optimizer effort ablation, minimum horizon (three requests)

Eight fact cases; per case OFF, ON, and a closed-book ADMITTED probe over the
exact admitted summary. All 24 checkpoints passed at Low: native answers 4/4 in
both arms, ADMITTED 6/6 including the two withheld facts, strict prefix check,
receipt effort `low` on every attempt.


| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lease_fencing | 3/3 | $0.00486 | $0.00344 | $0.00246 | $0.00590 | -0.00104 | 46,526 | 41,905 | +4,621 | +0.00071 | 3.5 |
| schema_defaults | 3/3 | $0.00321 | $0.00522 | $0.00243 | $0.00765 | -0.00444 | 46,672 | 42,040 | +4,632 | -0.00019 | n/a |
| archive_paths | 3/3 | $0.00309 | $0.00333 | $0.00224 | $0.00556 | -0.00247 | 46,165 | 41,381 | +4,784 | +0.00069 | 3.3 |
| event_dedupe | 3/3 | $0.00499 | $0.00338 | $0.00228 | $0.00567 | -0.00068 | 48,069 | 42,384 | +5,685 | +0.00080 | 2.8 |
| replica_quorum | 3/3 | $0.00340 | $0.00381 | $0.00249 | $0.00630 | -0.00290 | 46,364 | 42,127 | +4,237 | +0.00061 | 4.1 |
| export_order | 3/3 | $0.00477 | $0.00324 | $0.00260 | $0.00583 | -0.00106 | 46,420 | 41,084 | +5,336 | +0.00072 | 3.6 |
| quota_rollover | 3/3 | $0.00310 | $0.00291 | $0.00206 | $0.00497 | -0.00187 | 46,134 | 41,321 | +4,813 | +0.00064 | 3.2 |
| key_rotation | 3/3 | $0.00333 | $0.00344 | $0.00221 | $0.00564 | -0.00231 | 47,243 | 42,044 | +5,199 | +0.00075 | 3.0 |
| **Total** | | $0.03076 | | | $0.04752 | -0.01676 | 373,593 | 334,286 | +39,307 | | |

Cost: 0 of 8 cases cheaper with pruning (sign test p = 0.0078125); median -0.00209, range -0.00444 to -0.00068. Total tokens: 8 of 8 cases fewer (p = 0.0078125); main-model tokens saved +110,578 (8 of 8).
Optimizer: 8 attempts, statuses ['admitted'], efforts ['low'], reasoning tokens 78-516 per case, latency 9.7-18.5 s. Peak request input OFF 18,621 vs ON 11,164.

Wall-clock per conversation (launch to sealed result): OFF 160 s and ON 279 s
summed over the eight cases, so Low pruning adds about 15 s per conversation
here, of which the optimizer call itself is 9.7 to 18.5 s.

Reading. At the same three-request horizon where the Max-effort cohort cost
122% more, Low costs 54% more, and total tokens already fall in 8 of 8 cases.
The remaining dollar gap is the optimizer's fixed cost against only two later
requests; seven of eight pairs extrapolate to break-even within 3 to 4 later
requests. One pair (`schema_defaults`) had a cache miss on the ON arm's second
request and a hit on OFF's, which flips its per-request saving negative; it is
kept as recorded.

## E2. Horizon sweep at Low

The native prompt adds N sequential `printf STEP_k` tool calls between the read
and the answer, one per request. Horizon is measured from the rollout as the
request count; the gate tolerates one skipped or two repeated steps and records
exact compliance.

### Horizon 8 (11 requests per arm), 8 cases, all 16 checkpoints passed

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lease_fencing | 11/11 | $0.00800 | $0.00743 | $0.00221 | $0.00965 | -0.00165 | 194,643 | 136,013 | +58,630 | +0.00006 | 36.9 |
| schema_defaults | 11/11 | $0.00949 | $0.00524 | $0.00253 | $0.00776 | +0.00172 | 195,997 | 135,777 | +60,220 | +0.00026 | 9.6 |
| archive_paths | 11/11 | $0.00948 | $0.00604 | $0.00209 | $0.00813 | +0.00136 | 192,698 | 135,378 | +57,320 | +0.00026 | 8.0 |
| event_dedupe | 11/11 | $0.00832 | $0.00540 | $0.00228 | $0.00768 | +0.00065 | 202,497 | 136,731 | +65,766 | +0.00029 | 7.9 |
| replica_quorum | 11/11 | $0.01106 | $0.00603 | $0.00206 | $0.00809 | +0.00297 | 194,343 | 136,548 | +57,795 | +0.00050 | 4.1 |
| export_order | 11/11 | $0.00799 | $0.00703 | $0.00215 | $0.00918 | -0.00120 | 194,690 | 136,705 | +57,985 | +0.00026 | 8.2 |
| quota_rollover | 11/11 | $0.00799 | $0.00707 | $0.00206 | $0.00913 | -0.00114 | 193,519 | 135,814 | +57,705 | +0.00026 | 8.0 |
| key_rotation | 11/11 | $0.00959 | $0.00798 | $0.00216 | $0.01014 | -0.00055 | 198,407 | 132,640 | +65,767 | +0.00007 | 30.5 |
| **Total** | | $0.07192 | | | $0.06975 | +0.00217 | 1,566,794 | 1,085,606 | +481,188 | | |

Cost: 4 of 8 cases cheaper with pruning (sign test p = 1); median +0.00005, range -0.00165 to +0.00297. Total tokens: 8 of 8 cases fewer (p = 0.0078125); main-model tokens saved +551,930 (8 of 8).
Optimizer: 8 attempts, statuses ['admitted'], efforts ['low'], reasoning tokens 83-432 per case, latency 8.9-16.3 s. Peak request input OFF 19,547 vs ON 12,081.

Reading. With nine requests after the read instead of two, total tokens fall
31% in every case, while dollars are at break-even: pruning is cheaper in four
cases and dearer in four, net +3%. The per-request saving D is small because
the cache is warm on both arms: cached input costs one tenth of uncached input,
so a 7,000-token prefix reduction is worth about $0.00014 per request when it
hits. D varies 8x across cases (\$0.00006 to \$0.00050) with the cache-hit
pattern, not with the fixture.

### Horizon 32 (35 requests per arm), 8 cases across two batches

The first pair (`lease_fencing`) sealed in `e2-32b` before the network outage;
the other seven sealed in `e2-32c` (same plan, cases 2 to 8). All 16 checkpoints
passed; every conversation made exactly 34 calls over 35 requests.

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lease_fencing | 35/35 | $0.02638 | $0.01988 | $0.00215 | $0.02202 | +0.00436 | 677,046 | 444,054 | +232,992 | +0.00021 | 10.2 |
| **Total** | | $0.02638 | | | $0.02202 | +0.00436 | 677,046 | 444,054 | +232,992 | | |

Cost: 1 of 1 cases cheaper with pruning (sign test p = 1); median +0.00436, range +0.00436 to +0.00436. Total tokens: 1 of 1 cases fewer (p = 1); main-model tokens saved +241,693 (1 of 1).
Optimizer: 1 attempts, statuses ['admitted'], efforts ['low'], reasoning tokens 135-135 per case, latency 10.9-10.9 s. Peak request input OFF 21,141 vs ON 14,041.
EXCLUDED {'caseId': 'schema_defaults', 'reason': 'missing OFF, incomplete NATIVE'}

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| schema_defaults | 35/35 | $0.02427 | $0.02004 | $0.00248 | $0.02252 | +0.00175 | 679,201 | 449,772 | +229,429 | +0.00011 | 23.1 |
| archive_paths | 35/35 | $0.02265 | $0.02096 | $0.00229 | $0.02325 | -0.00060 | 670,680 | 453,807 | +216,873 | +0.00010 | 23.7 |
| event_dedupe | 35/35 | $0.02507 | $0.01871 | $0.00241 | $0.02112 | +0.00395 | 705,189 | 455,729 | +249,460 | +0.00018 | 13.1 |
| replica_quorum | 35/35 | $0.02440 | $0.02127 | $0.00253 | $0.02379 | +0.00061 | 674,334 | 455,014 | +219,320 | +0.00009 | 27.6 |
| export_order | 35/35 | $0.02644 | $0.01778 | $0.00228 | $0.02006 | +0.00638 | 674,957 | 453,847 | +221,110 | +0.00022 | 10.3 |
| quota_rollover | 35/35 | $0.02377 | $0.02110 | $0.00219 | $0.02329 | +0.00048 | 671,286 | 454,822 | +216,464 | +0.00009 | 23.4 |
| key_rotation | 35/35 | $0.02303 | $0.01837 | $0.00241 | $0.02078 | +0.00224 | 688,289 | 453,276 | +235,013 | +0.00018 | 13.1 |
| **Total** | | $0.16962 | | | $0.15482 | +0.01480 | 4,763,936 | 3,176,267 | +1,587,669 | | |

Cost: 6 of 7 cases cheaper with pruning (sign test p = 0.125); median +0.00175, range -0.00060 to +0.00638. Total tokens: 7 of 7 cases fewer (p = 0.015625); main-model tokens saved +1,650,721 (7 of 7).
Optimizer: 7 attempts, statuses ['admitted'], efforts ['low'], reasoning tokens 211-464 per case, latency 10.3-15.0 s. Peak request input OFF 21,964 vs ON 14,358.

Pooled over the eight pairs (descriptive, two batches): cost OFF $0.19600 versus
ON $0.17684 including the optimizer, so pruning is **9.8% cheaper**,
cheaper in 7 of 8 cases (exact sign test p = 0.0703). Total tokens
5,440,982 versus 3,620,321, **33.5% fewer**, 8 of 8 (p = 0.0078).
Peak request input 21,964 versus 14,358 tokens. Wall-clock 757 s versus 881 s
(+16%). Per-request saving D ranged \$0.00009 to \$0.00022
(median \$0.00015) and break-even T* 10 to 28 later requests
(median 18).

Reading. Dollar savings grow with horizon at Low effort: -54% at three requests,
+3% at eleven, +10% at thirty-five. Token savings are stable at
30-34% once the output has been re-sent a few times, and hold in every case at
every horizon. D shrinks as the cache warms, which is why T* estimated from a
long warm-cache run (10 to 28) is larger than the one estimated from the first
requests (3 to 4): the dollar case for pruning is strongest exactly where the
provider cache is weakest.

### Horizon 32 at None effort (35 requests per arm), 8 cases, `e2-32-none`

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lease_fencing | 35/35 | $0.02645 | $0.02076 | $0.00197 | $0.02273 | +0.00372 | 674,992 | 451,825 | +223,167 | +0.00021 | 9.2 |
| schema_defaults | 35/35 | $0.02430 | $0.01835 | $0.00195 | $0.02030 | +0.00400 | 677,696 | 449,808 | +227,888 | +0.00013 | 15.2 |
| archive_paths | 35/35 | $0.02450 | $0.01735 | $0.00186 | $0.01921 | +0.00529 | 670,008 | 447,520 | +222,488 | +0.00021 | 8.9 |
| event_dedupe | 35/35 | $0.02565 | $0.01767 | $0.00205 | $0.01971 | +0.00594 | 701,805 | 451,951 | +249,854 | +0.00023 | 8.7 |
| replica_quorum | 35/35 | $0.02624 | $0.01704 | $0.00184 | $0.01888 | +0.00735 | 673,689 | 451,208 | +222,481 | +0.00027 | 6.8 |
| export_order | 35/35 | $0.02451 | $0.01754 | $0.00194 | $0.01948 | +0.00504 | 673,105 | 450,976 | +222,129 | +0.00021 | 9.4 |
| quota_rollover | 35/35 | $0.02573 | $0.01924 | $0.00193 | $0.02116 | +0.00457 | 665,278 | 452,666 | +212,612 | +0.00019 | 10.0 |
| key_rotation | 35/35 | $0.02613 | $0.01747 | $0.00200 | $0.01947 | +0.00666 | 688,105 | 448,660 | +239,445 | +0.00022 | 9.1 |
| **Total** | | $0.20351 | | | $0.16094 | +0.04256 | 5,424,678 | 3,604,614 | +1,820,064 | | |

Cost: 8 of 8 cases cheaper with pruning (sign test p = 0.0078125); median +0.00516, range +0.00372 to +0.00735. Total tokens: 8 of 8 cases fewer (p = 0.0078125); main-model tokens saved +1,889,114 (8 of 8).
Optimizer: 8 attempts, statuses ['admitted'], efforts ['none'], reasoning tokens 0-0 per case, latency 5.0-7.0 s. Peak request input OFF 21,851 vs ON 14,278.

Pooled: cost OFF $0.20351 versus ON $0.16094 (**20.9% cheaper**,
8 of 8), tokens 5,424,678 versus 3,604,614
(**33.6% fewer**, 8 of 8), wall-clock 753 s versus 800 s
(+6%).

## E3. Multi-output session at Low

One conversation reads eight evidence files (one call each), runs eight
`printf STEP_k` calls, then answers the four native questions of the first file.
Four orderings rotate the first file. Pruning ON admits each read separately.

### First ordering (`lease_fencing` first), sealed in `e3-8b`

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lease_fencing | 18/18 | $0.03592 | $0.00974 | $0.01842 | $0.02816 | +0.00776 | 989,580 | 317,494 | +672,086 | +0.00154 | 11.9 |
| **Total** | | $0.03592 | | | $0.02816 | +0.00776 | 989,580 | 317,494 | +672,086 | | |

Cost: 1 of 1 cases cheaper with pruning (sign test p = 1); median +0.00776, range +0.00776 to +0.00776. Total tokens: 1 of 1 cases fewer (p = 1); main-model tokens saved +744,092 (1 of 1).
Optimizer: 8 attempts, statuses ['admitted'], efforts ['low'], reasoning tokens 1838-1838 per case, latency 89.6-89.6 s. Peak request input OFF 70,228 vs ON 15,069.
EXCLUDED {'caseId': 'archive_paths', 'reason': 'missing OFF, incomplete NATIVE'}

The ON arm admitted all eight reads; the OFF arm's context reached 70,228 input
tokens on its largest request against 15,069 with pruning. The second ordering
stalled (see Deviations); orderings two to four are queued as `e3-8c`.

### Orderings two and three (`archive_paths`, `replica_quorum` first), sealed in `e3-8c`

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| archive_paths | 18/18 | $0.03452 | $0.01367 | $0.01810 | $0.03177 | +0.00275 | 991,529 | 435,298 | +556,231 | +0.00122 | 14.8 |
| replica_quorum | 18/18 | $0.03464 | $0.01379 | $0.02010 | $0.03389 | +0.00075 | 988,285 | 342,027 | +646,258 | +0.00123 | 16.4 |
| **Total** | | $0.06916 | | | $0.06566 | +0.00351 | 1,979,814 | 777,325 | +1,202,489 | | |

Cost: 2 of 2 cases cheaper with pruning (sign test p = 0.5); median +0.00175, range +0.00075 to +0.00275. Total tokens: 2 of 2 cases fewer (p = 0.5); main-model tokens saved +1,347,490 (2 of 2).
Optimizer: 16 attempts, statuses ['admitted', 'unchanged'], efforts ['low'], reasoning tokens 1425-1994 per case, latency 85.9-121.8 s. Peak request input OFF 70,318 vs ON 22,465.
EXCLUDED {'caseId': 'quota_rollover', 'reason': 'gate failed NATIVE: No qualified admission: No source admission; Strict logical-prefix check failed'}

Pooled over the three valid orderings: cost OFF $0.10508 versus ON $0.09381
(**10.7% cheaper**, 3 of 3), total tokens 2,969,394 versus 1,094,819
(**63.1% fewer**, 3 of 3), with peak request input 70k to 72k
tokens OFF against 15k to 16k ON.

The fourth ordering (`quota_rollover` first) completed with a correct answer
over 18 requests, but the optimizer returned `unchanged` for two of the eight
reads, including the first file, so the pair fails the admission gate and is
excluded from the summary. Its raw numbers, unsealed by any gate: OFF $0.03765
(990,394 tokens, peak request 70,281) versus ON $0.03697 with six admissions and
two declined outputs (553,445 tokens, peak 30,229), still 1.8% cheaper and 44%
fewer tokens.
Across the 29 optimizer attempts in the Low multi-output runs, 4 returned
`unchanged` (each a full optimizer call with no saving); none did in the 24
single-output E1 runs at any effort.

Reading. In the session shape closest to real use (many outputs, then work),
pruning at Low is cheaper in every valid ordering and cuts tokens by roughly
two thirds, because every later request re-sends eight summaries instead of
eight raw outputs. The break-even is reached within the session itself (T*
12 to 16 later requests against 17 actual).

### Multi-output at None effort (`e3-8-none`): two valid orderings, then a citation-label loss

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lease_fencing | 18/18 | $0.03629 | $0.01045 | $0.01574 | $0.02619 | +0.01010 | 989,765 | 310,546 | +679,219 | +0.00142 | 11.1 |
| archive_paths | 18/18 | $0.03609 | $0.00949 | $0.01566 | $0.02515 | +0.01094 | 990,588 | 307,904 | +682,684 | +0.00147 | 10.7 |
| **Total** | | $0.07238 | | | $0.05134 | +0.02104 | 1,980,353 | 618,450 | +1,361,903 | | |

Cost: 2 of 2 cases cheaper with pruning (sign test p = 0.5); median +0.01052, range +0.01010 to +0.01094. Total tokens: 2 of 2 cases fewer (p = 0.5); main-model tokens saved +1,501,250 (2 of 2).
Optimizer: 16 attempts, statuses ['admitted'], efforts ['none'], reasoning tokens 0-0 per case, latency 47.6-52.6 s. Peak request input OFF 70,240 vs ON 14,701.
EXCLUDED {'caseId': 'replica_quorum', 'reason': 'gate failed NATIVE: Answer or citation check failed'}

The third ordering (`replica_quorum` first) admitted all eight reads and the
native answer had all four values correct, but every citation failed: the
None-effort summary of the first file rewrote its labels as
`evidence.txt (source labels replica_quorum.log): line 3: ...`, and the main
model then cited `evidence.txt:3` where the oracle requires the exact original
`replica_quorum.log:3`. Every fact and line number survived; the exact
citation string did not. No Low or Max summary did this in 24 single-file and
29 multi-file admissions. This is the one fidelity difference observed between
effort levels, and it argues for Low rather than None as the default.

## E1 at Max, Medium, None (same binary, same night)


Each level is its own 24-conversation batch with its own OFF arm; every
completed batch passed all gates, so Max, Low, and None each retained 6/6 facts
and citations on all eight ADMITTED probes (48/48 per level, including the 16
withheld facts). Source size was identical across levels (56,207 tokens over
the eight outputs).

| Optimizer effort | Retention (cases with ADMITTED 6/6) | Reasoning tokens per admission | Optimizer latency | Admitted tokens (8 cases) | Optimizer cost per case | Cost vs OFF at 3 requests | Total tokens vs OFF |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Max | 8/8 | 2,914 to 6,214 | 60 to 119 s | 2,580 | $0.00741 | -163% (0/8) | +1.1% (6/8) |
| Low | 8/8 | 78 to 516 | 9.7 to 18.5 s | 2,340 | $0.00235 | -54% (0/8) | +10.5% (8/8) |
| None | 8/8 | 0 | 5.6 to 8.0 s | 1,948 | $0.00193 | -25% (1/8) | +11.4% (8/8) |
| Medium | 5/5 completed (case 1 probe-format failure, case 7 optimizer timeout, case 8 not run) | 333 to 828 | 12.6 to 23.6 s | 1,381 (5 cases) | $0.00273 | -41% (0/5) | +9.6% (5/5) |

Reading. Effort changes the optimizer's price and speed by an order of
magnitude without changing what survives: Max spends 3,000 to 6,000 reasoning
tokens and one to two minutes per admission, None spends zero and six to eight
seconds, and both produce summaries of similar size that pass the same
closed-book probes. Max is the setting the 8 September cohort measured; on the
same fixtures and binary it is 163% dearer than OFF at three requests, Low 54%,
None 25%. The main-model saving is the same at every level (about 110,000
tokens over eight cases), so the whole difference is the optimizer's own bill.
The optimizer's remaining cost at None is dominated by its input (about 8,200
tokens per admission at the uncached rate), not its output.

### Max

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lease_fencing | 3/3 | $0.00327 | $0.00180 | $0.00639 | $0.00819 | -0.00492 | 46,570 | 45,246 | +1,324 | +0.00073 | 8.7 |
| schema_defaults | 3/3 | $0.00320 | $0.00172 | $0.00685 | $0.00856 | -0.00536 | 46,686 | 45,568 | +1,118 | +0.00074 | 9.2 |
| archive_paths | 3/3 | $0.00310 | $0.00171 | $0.00943 | $0.01114 | -0.00804 | 46,181 | 47,427 | -1,246 | +0.00067 | 14.1 |
| event_dedupe | 3/3 | $0.00498 | $0.00356 | $0.00848 | $0.01203 | -0.00705 | 48,077 | 47,905 | +172 | +0.00072 | 11.7 |
| replica_quorum | 3/3 | $0.00431 | $0.00184 | $0.00739 | $0.00922 | -0.00492 | 46,382 | 46,077 | +305 | +0.00068 | 10.8 |
| export_order | 3/3 | $0.00317 | $0.00341 | $0.00821 | $0.01163 | -0.00846 | 46,454 | 46,699 | -245 | +0.00069 | 12.0 |
| quota_rollover | 3/3 | $0.00312 | $0.00353 | $0.00549 | $0.00902 | -0.00590 | 46,186 | 44,526 | +1,660 | +0.00062 | 8.9 |
| key_rotation | 3/3 | $0.00483 | $0.00182 | $0.00707 | $0.00889 | -0.00406 | 47,280 | 46,132 | +1,148 | +0.00150 | 4.7 |
| **Total** | | $0.02997 | | | $0.07868 | -0.04871 | 373,816 | 369,580 | +4,236 | | |

Cost: 0 of 8 cases cheaper with pruning (sign test p = 0.0078125); median -0.00563, range -0.00846 to -0.00406. Total tokens: 6 of 8 cases fewer (p = 0.2890625); main-model tokens saved +109,335 (8 of 8).
Optimizer: 8 attempts, statuses ['admitted'], efforts ['max'], reasoning tokens 2914-6214 per case, latency 60.3-119.1 s. Peak request input OFF 18,630 vs ON 11,243.

### None

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lease_fencing | 3/3 | $0.00504 | $0.00177 | $0.00196 | $0.00373 | +0.00131 | 46,558 | 41,405 | +5,153 | +0.00163 | 1.2 |
| schema_defaults | 3/3 | $0.00321 | $0.00187 | $0.00193 | $0.00381 | -0.00060 | 46,694 | 41,319 | +5,375 | +0.00067 | 2.9 |
| archive_paths | 3/3 | $0.00309 | $0.00280 | $0.00192 | $0.00471 | -0.00162 | 46,169 | 41,107 | +5,062 | +0.00070 | 2.7 |
| event_dedupe | 3/3 | $0.00335 | $0.00180 | $0.00209 | $0.00390 | -0.00055 | 48,075 | 42,204 | +5,871 | +0.00077 | 2.7 |
| replica_quorum | 3/3 | $0.00328 | $0.00353 | $0.00183 | $0.00536 | -0.00208 | 46,454 | 41,203 | +5,251 | +0.00068 | 2.7 |
| export_order | 3/3 | $0.00316 | $0.00174 | $0.00187 | $0.00362 | -0.00046 | 46,438 | 41,211 | +5,227 | +0.00073 | 2.6 |
| quota_rollover | 3/3 | $0.00310 | $0.00192 | $0.00185 | $0.00377 | -0.00067 | 46,147 | 41,036 | +5,111 | +0.00059 | 3.2 |
| key_rotation | 3/3 | $0.00337 | $0.00352 | $0.00202 | $0.00554 | -0.00217 | 47,305 | 41,693 | +5,612 | -0.00008 | n/a |
| **Total** | | $0.02758 | | | $0.03443 | -0.00685 | 373,840 | 331,178 | +42,662 | | |

Cost: 1 of 8 cases cheaper with pruning (sign test p = 0.0703125); median -0.00064, range -0.00217 to +0.00131. Total tokens: 8 of 8 cases fewer (p = 0.0078125); main-model tokens saved +111,200 (8 of 8).
Optimizer: 8 attempts, statuses ['admitted'], efforts ['none'], reasoning tokens 0-0 per case, latency 5.6-8.0 s. Peak request input OFF 18,639 vs ON 11,081.

### Medium (cases 2 to 6 complete in `e1-medium-c`; stopped at case 7)

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer | ON total | Saved | Tokens OFF | Tokens ON | Tokens saved | Mean D (k>=2) | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| schema_defaults | 3/3 | $0.00320 | $0.00179 | $0.00283 | $0.00463 | -0.00143 | 46,705 | 42,292 | +4,413 | +0.00069 | 4.1 |
| archive_paths | 3/3 | $0.00317 | $0.00182 | $0.00304 | $0.00487 | -0.00170 | 46,298 | 42,410 | +3,888 | +0.00066 | 4.6 |
| event_dedupe | 3/3 | $0.00335 | $0.00192 | $0.00269 | $0.00460 | -0.00126 | 48,089 | 42,790 | +5,299 | +0.00071 | 3.8 |
| replica_quorum | 3/3 | $0.00325 | $0.00204 | $0.00233 | $0.00437 | -0.00113 | 46,408 | 41,903 | +4,505 | +0.00061 | 3.8 |
| export_order | 3/3 | $0.00336 | $0.00184 | $0.00276 | $0.00460 | -0.00124 | 46,497 | 42,174 | +4,323 | +0.00075 | 3.7 |
| **Total** | | $0.01632 | | | $0.02307 | -0.00675 | 233,997 | 211,569 | +22,428 | | |

Cost: 0 of 5 cases cheaper with pruning (sign test p = 0.0625); median -0.00126, range -0.00170 to -0.00113. Total tokens: 5 of 5 cases fewer (p = 0.0625); main-model tokens saved +68,676 (5 of 5).
Optimizer: 5 attempts, statuses ['admitted'], efforts ['medium'], reasoning tokens 333-828 per case, latency 12.6-23.6 s. Peak request input OFF 18,646 vs ON 11,191.
EXCLUDED {'caseId': 'quota_rollover', 'reason': 'missing OFF, gate failed NATIVE: Trace/probe protocol failed; No qualified admission: No source admission; Strict logical-prefix check failed'}

## E5. Cache and compaction head-to-head at Low (three orderings)

Same eight-file session as E3 with a third arm: no pruning plus forced native
compaction (`model_auto_compact_token_limit = 40000`, so compaction fires after
the fourth or fifth read). On this ChatGPT backend the compaction is remote: the
rollout records an encrypted `compaction` item and a zero-usage marker whose
total is the new context size, so the compaction call itself cannot be priced
from evidence and its content cannot be inspected. Batches `cache-8-low`
(ordering 1) and `cache-8b-low` (orderings 2 to 4); the fourth ordering's ON arm
hit a malformed optimizer response on its first read and is excluded (see
Product findings), so three orderings have all three arms.

| First file | OFF cost | ON cost (opt) | COMPACT cost | OFF tokens | ON tokens | COMPACT tokens | Peak OFF/ON/COMPACT | ON first file admitted / declined | Compaction after request | COMPACT answer | Cached on request after compaction (before) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| archive_paths | $0.03960 | $0.03341 ($0.01732) | $0.02295 | 991,004 | 383,504 | 299,053 | 70,287/21,845/33,427 | True / 1 | 4 | 4/4 | 2,816/18,608 (25,344/32,906) |
| replica_quorum | $0.03460 | $0.04343 ($0.01888) | $0.02951 | 988,121 | 512,335 | 534,867 | 70,298/28,498/39,738 | False / 2 | 5 | 4/4 | 8,960/19,448 (31,488/39,738) |
| lease_fencing | $0.03628 | $0.03061 ($0.01930) | $0.02501 | 989,692 | 318,564 | 526,459 | 70,220/15,039/40,330 | None / 0 | 5 | 4/4 | 8,960/18,998 (31,488/40,330) |
| **Total (3)** | $0.11049 | $0.10744 | $0.07747 | 2,968,817 | 1,214,403 | 1,360,379 | | | | | |

Totals over the three orderings (published Luna rates, compaction call
unpriced): no pruning $0.11049, pruning $0.10744 (2.8% cheaper), compaction
$0.07747 (29.9% cheaper than no pruning, 27.9% cheaper than pruning). Tokens:
2,968,817 versus 1,214,403 (pruning, 59% fewer) versus 1,360,379 (compaction,
54% fewer). Peak request input: 70k versus 15k to 28k (pruning) versus 33k to
40k (compaction). Both interventions answered 4/4 on the first file in every
ordering; the compaction summaries are opaque, so where those facts lived
cannot be shown.

**Cache behaviour, the thesis claim.** After each compaction the cached prefix
on the next request fell to the 8,960-token system prompt (2,816 in one
ordering) from 25k to 31k just before, and rebuilt from there: compaction
discards the cached history by construction. Pruning's arms show no such reset;
their cached prefix grows monotonically with the admitted summaries, and the
strict continuation check passed on every qualified admission. That is the
measured difference: pruning never invalidates what the provider already
cached, compaction always does, once per event.

**What this does not show.** Compaction's own cost is invisible here. Priced
as an API compaction of the full 40k context at the Luna input rate, each event
would add about $0.008, which brings the compaction arm to roughly $0.101 for
three orderings against pruning's $0.107; that is an estimate, not a
measurement. Retention did not separate the two methods on these fixtures,
whose facts are single lines in otherwise repetitive files; a compaction
summary can carry six such facts easily. Harder fixtures, or facts that depend
on exact wording across many lines, are the place to look for a difference.

## E6. Measured: Terra main model, Luna optimizer at Low (three requests)

Batch `e1-low-terra-b` (the first attempt, `e1-low-terra`, stopped at its second
conversation on the exact two-call gate because Terra adds a file lookup before
the read; the ablation gate now tolerates that). Main model `gpt-5.6-terra` at
medium effort, optimizer `gpt-5.6-luna` at Low, priced with
`TERRA_MAIN_LUNA_OPTIMIZER_RATES_2026-09-09.json`. Five cases completed all
three arms before the sixth ADMITTED probe failed on paraphrased citation
labels (values 6/6 correct; see Product findings), which stopped the batch.

| Case | Requests OFF/ON | OFF cost | ON main | Optimizer (Luna) | ON total | Saved | Tokens OFF | Tokens ON | T* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lease_fencing | 3/3 | $0.05167 | $0.01966 | $0.00276 | $0.02242 | +0.02925 | 50,620 | 47,264 | 0.4 |
| schema_defaults | 4/3 | $0.03856 | $0.01762 | $0.00247 | $0.02009 | +0.01847 | 63,321 | 46,117 | 0.3 |
| archive_paths | 3/3 | $0.07051 | $0.06196 | $0.00489 | $0.06686 | +0.00365 | 50,324 | 52,582 | 1.1 |
| event_dedupe | 4/3 | $0.07580 | $0.01854 | $0.00221 | $0.02075 | +0.05505 | 64,697 | 46,514 | 0.2 |
| replica_quorum | 3/3 | $0.05216 | $0.03128 | $0.00216 | $0.03344 | +0.01872 | 50,552 | 45,721 | 0.3 |
| **Total (5)** | | $0.28871 | | | $0.16357 | +0.12514 | 279,514 | 238,198 | |

Pruning is **43.3% cheaper in 5 of 5 cases** at the three-request
horizon where, with Luna as the main model, it cost 54% more. Break-even is
below one later request in every case. Tokens fall 14.8% (4 of 5).
Terra's own answers used more output tokens than Luna's, which is why the
measured saving exceeds the projection made from Luna token counts. Retention:
four ADMITTED probes 6/6; the fifth had all values right and all citations
wrong because the Luna summary paraphrased the file label.

## Projection: a pricier main model with the same Luna optimizer

Not a measurement. The main-model token series of the sealed pairs are re-priced
at the published rates of Terra, Sol, and Astra (`OPENAI_PUBLISHED_RATES_2026-09-09.json`)
while the optimizer's sealed Luna usage is kept as is, since the build pins the
optimizer to Luna whatever the main model. Cached-input and output prices scale
with each model's published rates. Token counts are assumed unchanged, which
ignores that another model may reason or call tools differently. Positive means
pruning saves money; negative means it costs more.

| Sealed condition | Luna main (measured) | Terra main (10x) | Sol main (20x) | Astra main (50x) |
| --- | ---: | ---: | ---: | ---: |
| 3 requests, None | -24.8% | +25.7% | +29.2% | +30.9% |
| 3 requests, Low | -54.5% | +0.4% | +3.8% | +5.7% |
| 11 requests, Low | +3.0% | +25.0% | +27.0% | +27.7% |
| 35 requests, Low (7 cases) | +8.7% | +17.5% | +18.5% | +18.8% |
| 35 requests, None | +20.9% | +27.8% | +28.8% | +29.0% |

The break-even horizon scales with the ratio of optimizer price to main-model
price, so with Terra in front of Luna pruning already saves money at the
three-request horizon in projection. A small Terra confirmation run (the
three-request ablation at Low, 24 conversations) is the cheapest way to turn
this into a measurement; Sol and Astra remain projections.

## Related tooling and the novelty statement (9 September)

Two tools sit closest to this work and should be cited, neither is a paper:
Headroom (headroomlabs-ai/headroom, MIT, June 2026) compresses tool outputs
with rule-based, content-type compressors behind a proxy, library, or MCP
server, keeps the frozen prefix byte-identical, and reports GSM8K, TruthfulQA,
and tool-use accuracy under compression; RTK (the token-reducing command proxy
used in this project's own sessions) rewrites shell command output before it
reaches the agent. Both act outside the agent loop on the bytes of an output.

What is ours, and what the paper can claim: the pruning runs inside the agent's
turn loop, on a fresh tool result before the model first sees it, with a model
that decides per output between `compact` and `unchanged` under an explicit
fact-preservation policy; every admission leaves a receipt with the exact
source, the admitted text, usage, and a strict continuation check (RQ5); the
existing history is never rewritten, which is why the provider cache is never
reset (E5); and the method is evaluated on closed-book fact retention, paired
cost, horizon, effort, and a compaction baseline. That combination is not in
either tool, and citing them costs nothing.

## Deviations recorded

- `e2-8-low-01` (strict gate): stopped at conversation 6 because the ON arm
  repeated `printf STEP_7` (11 calls for 10 prescribed; answer 4/4, admission
  qualified). Its two complete pairs are priced separately in the metrics file;
  the failed pair is excluded with its recorded reason.
- `e2-32-low-01`: aborted by the operator during its first conversation, before
  any checkpoint, to replace the strict gate; directory kept with the suffix
  `-aborted-strict-gate`. The horizon batches were rerun as `e2-8b` and `e2-32b`.
- `e1-minimal`: Luna rejects `reasoning.effort = minimal` (supported: none, low,
  medium, high, xhigh, max). The ON conversation kept the original output and
  still answered 4/4; the batch stopped at its second checkpoint. Its two
  conversations overlapped for about one minute with `e2-8-low-01` conversations
  3 and 4 because a chain script waited on the wrong process id. A `none`
  batch is queued instead.
- Network outage 00:45 to about 02:10 on 9 September: the horizon-32 batch
  `e2-32b` lost its third conversation mid-run (`schema_defaults` ON, 23 calls,
  then `peer closed connection without sending TLS close_notify` and two
  `error sending request` failures) and stopped; its first pair is sealed and
  priced. The queued `e3-8`, `e1-max`, `e1-medium`, and `e1-none` batches each
  failed their first conversation at request 1 with `error sending request`
  and stopped; all are kept. The remaining work was relaunched at 03:11 as
  `e2-32c` (cases 2 to 8), `e3-8b`, `e1-max-b`, `e1-medium-b`, `e1-none-b`,
  with a reachability probe before each launch.
- `e3-8b` (multi-output) stopped at conversation 3: the ON arm with
  `archive_paths` first made six reads (five optimizer attempts: three admitted,
  two `unchanged`) and then issued no seventh request and no sixth optimizer
  receipt until the 1,200 s guard interrupted it. The trace shows no failed
  inference; the stall sits between the sixth tool output and the next
  request, where Smart Prune runs, but no process log was captured to place
  it. It occurred on a night with two documented network failures. Kept as a
  failure; the three remaining orderings were queued as `e3-8c`.
- `e1-medium-b` stopped at its third conversation: the closed-book ADMITTED
  probe for `lease_fencing` answered q1 as the string `"19"` where the oracle
  requires the number 19; the other five values and all six citations passed.
  The admitted summary contains the fact verbatim (`owns fencing epoch 19`), so
  this is a probe formatting failure under exact-type grading, not an omission
  by the optimizer. Recorded as a failed checkpoint; Medium cases 2 to 8 were
  queued as `e1-medium-c`.
- `e3-8c` conversation 6 (`quota_rollover` first, ON): the optimizer answered
  `unchanged` for the first and third reads and admitted the other six; the
  answer was correct over 18 requests. The gate requires the first file's
  admission, so the pair is excluded from the priced summary and reported in
  prose. Together with the stalled `e3-8b` run, 4 of 29 Low multi-output
  optimizer attempts declined to compress.
- `e1-medium-c` stopped at `quota_rollover` ON: a provider websocket stall hit
  the main request (`idle timeout waiting for websocket`, retried and
  completed) and the optimizer, whose 180 s inactivity bound fired and was
  recorded as a `timed_out` receipt (189.9 s); the conversation kept the
  original output and answered 4/4. Kept as a failed checkpoint; the timeout
  path worked as designed. Medium therefore has five complete cases.
- Harness fix during the study: a failed pruning-ON checkpoint did not
  reproduce from its sealed JSON (undefined fields); fixed and tested before
  later batches. Running batches use their own sealed harness copies.

## Evidence

Private local archives under `docs/evals/final-data/`, each with its own sealed
harness copy, plan, oracles, checkpoints, report, and `SHA256SUMS`; audit with
`node ARCHIVE/harness/staged-study.mjs --audit ARCHIVE`:

| Archive | Content |
| --- | --- |
| COST-E1-LOW-LUNA-20260908-01 | E1 Low, 24 conversations, passed |
| COST-E1-MAX-B-LUNA-20260908-01 | E1 Max, 24, passed |
| COST-E1-NONE-B-LUNA-20260908-01 | E1 None, 24, passed |
| COST-E1-MEDIUM-B / -C-LUNA-20260908-01 | E1 Medium: stopped at 3 (probe format); cases 2 to 8 stopped at 16 (optimizer timeout) |
| COST-E2-8-LOW / -8B-LOW-LUNA-20260908-01 | Horizon 8: strict-gate stop at 6; rerun 16, passed |
| COST-E2-32B-LOW / -32C-LOW-LUNA-20260908-01 | Horizon 32: outage stop at 3; cases 2 to 8, 14, passed |
| COST-E2-32-LOW-ABORTED-STRICT-GATE-LUNA-20260908-01 | Operator abort before any checkpoint (copied, hashed) |
| COST-E3-8B-LOW / -8C-LOW-LUNA-20260908-01 | Multi-output: stall at 3; orderings 2 to 4, 6, stopped at 6 (unadmitted first file) |
| COST-E1-MAX / -MEDIUM / -NONE / E3-8-LOW-LUNA-20260908-01 | Outage-stopped first conversations |
| COST-E1-MINIMAL-LUNA-20260908-01 | Unsupported effort value (copied, hashed) |
| COST-E2-32-NONE / COST-E3-8-NONE-LUNA-20260908-01 | None effort at horizon 32 and multi-output (see sections) |
| COST-CACHE-8-LOW / -8B-LOW-LUNA-20260908-01 | E5 three-arm cache head-to-head: ordering 1 (stopped at 4, malformed response); orderings 2 to 4 (9, stopped at 9) |
| COST-E1-LOW-TERRA / -TERRA-B-20260908-01 | E6 Terra main: exact-gate stop at 2; rerun 15 conversations, stopped at the sixth probe |

Frozen binary and provenance: `~/.local/share/elpis/experiments/COST-EFFORT-BUILD-20260908-01`.
Calculator: `cost-metrics.mjs` (hash recorded in the metrics file); rates:
`LUNA_PUBLISHED_RATES_2026-09-08.json`.

## Limitations

Same synthetic fixtures, one model, one day, one account. That account was a
free-tier ChatGPT login (the auth file the earlier studies had pinned), not the
owner's Pro account; dollar figures are published-rate estimates either way,
but rate limiting, throttling, and cache behaviour may differ by tier. Cache-hit fractions
are observed, not controlled; they vary per request between arms and dominate
the dollar result because cached input costs one tenth of uncached input. Token
counts do not depend on the cache. No real-repository task is measured here.
