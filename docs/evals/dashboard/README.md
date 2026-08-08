# Experiment dashboard

`dashboard.html` is generated. Do not edit it by hand — edit the inputs and re-run `build.py`.

Everything on the page is measured. There is no projection, extrapolation or synthetic series
anywhere in the pipeline; a message that has not been run renders as an empty slot.

## Adding a run

```bash
python3 collect.py <path-to-rollout.jsonl> exp2-elpis   # writes runs/exp2-elpis.json
python3 build.py                                        # redraws dashboard.html
```

Naming is what wires a run into the page: `exp<N>-codex` and `exp<N>-elpis`, where `N` is the
message number of experiment 1 (see `../RUNBOOK.md`). `build.py` looks those names up and fills
the matching section; nothing else needs touching.

## Files

| File | Does |
| --- | --- |
| `collect.py` | Transcript → `runs/<id>.json` |
| `pricing.json` | Rate cards. Add a vendor here and it appears in every cost chart |
| `cost.py` | Prices a run; counts long-context tier crossings |
| `charts.py` | Pure-SVG primitives — no CDN, so the page opens offline |
| `build.py` | Redraws the page from whatever is in `runs/` |

## Four accounting rules that change the headline if you get them wrong

1. **Per-request usage comes from deltas of the cumulative counters**, never from the per-turn
   field. That field is re-emitted when a turn ends without issuing a request, which invented
   211,106 phantom input tokens the first time this was measured.
2. **Elpis writes prune checkpoints as `compacted` rollout items**, distinguished from a real
   compaction only by the `elpis.context-prune.v1:` message prefix. Miss it and a run with zero
   compactions reports twenty-six.
3. **OpenAI's long-context threshold is 272,000 tokens**, above the 258,400 window, so it never
   applies here. An earlier pass used 128,000 and invented a premium that does not exist.
4. **The model a run executed on is not the model the cost table prices.** Experiment 1 ran on
   `gpt-5.6-luna` in both arms. Every Sol/Claude/Gemini figure is a re-pricing of that same token
   trace, and the page says so.
