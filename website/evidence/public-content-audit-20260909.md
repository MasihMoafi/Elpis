# Public content and evidence audit — September 9, 2026

The README and website were compared with the accepted development UI, current
dashboard assets, archived experiment records, and focused verification logs.
This is a local content refresh, not a release, deployment, or new provider run.

## Three separate identities

| Evidence | Identity | What it establishes |
| --- | --- | --- |
| Published release | v0.2.0, published September 5 | Release identity only; the later UI is not asserted to be shipped. |
| Current UI | commit 40838f83; installed SHA256 9490f4d6f8356eb6588f9b4788e71418f3727310338695c361978be6115eb60d | September 9 appearance and focused motion/streaming regression checks. |
| Cost experiment | frozen binary SHA256 d58e8c9b8861cc386265fdc799c3b556d8106b8f4a5983fb524ecc676f5b2c8f | Synthetic admission-pruning usage and estimated cost; not a benchmark of the current UI. |

## What was stale

The main README already named v0.2.0 correctly. Its old terminal GIFs and ledger
image did not show the accepted appearance. Its RQ4 section and generated website
technical page omitted the September 9 cost study. Dashboard captures omitted the
current Tokens view and newer settings/evidence details. Those public surfaces are
refreshed, with explicit dates and fixture captions.

The website's scroll-driven illustration remains a concept demonstration, not a
native session. Current native media is presented separately. The older /context
image illustrates the category view; it is not a new appearance capture.

## Visual provenance

The native PNG and motion replay come from exported Rust widget frames using the
real TachyonFX effects, with illustrative session data. A browser canvas renders
those frames; the video/GIF samples every other 40 ms frame at 12.5 fps. It is not
a live provider recording. Dashboard images use the current development assets
and checked-in `dashboard_assets/fixtures/activity-state.json`, served by the
dashboard preview tool. Its banner identifies illustrative data; settings are
disabled in the preview. None of these displayed counters are benchmark results.

## Experiment and chart checks

The original calculators reproduced all **17 batches / 61 accepted pairs** from
19 archived cost directories. Pair records, summaries, frozen binary identities,
and exclusion lists matched `COST_EFFICIENCY_METRICS.json` exactly. No paid runs
were repeated. `scripts/refresh-public-evidence.py` independently validates token
sums and prices, then generates the two current SVG figures and machine-readable
chart provenance. Costs use recorded September 8 rates, not invoices or live prices.

The short-session chart selects the report's completed effort cohorts. The horizon
chart joins two disjoint Low/35 batches descriptively, checks duplicate case IDs,
and requires a shared frozen binary. The full report retains unsuccessful probes,
timeouts, exclusions, and the separate None-effort exact-citation failure. Cache
fractions were observed rather than controlled. Synthetic cost results do not
establish general coding quality or savings.

The full report also contains Terra/Sol/Astra price projections using the same
Luna token traces. They are projections, not additional measured model cohorts;
the overview figures deliberately show measured Luna cohorts only. A rate file
or a planned confirmation run is not evidence of a completed experiment.

The RQ1 peak, distribution, normalized trajectory, and operating-zone charts, the
41-pass overhead chart, RQ2's 6/6 targets, and RQ5's 7-full/2-partial audit remain
**historical**. The experiment dashboard in `docs/evals/dashboard` still depicts
the older Run 1 comparison. Those records were not relabeled as new experiments.
The newer cost results are linked and charted separately.

## Verification scope

The other implementation agent's UI record reports 127 focused passing tests: motion 7, startup 4,
streaming 56, context ledger 51, status 9. Both native export tests passed; a
170-frame simulation retained five completed response lines exactly once; an
installed PTY smoke check covered startup, theme persistence, and clean exit.
These records are in the UI worktree's `docs/evals/elpis-motion-readability-20260909.md`.
This audit did not independently rerun those UI tests or terminal checks.
They do not mean the entire inherited suite passes: baseline failures remain.
The [UI verification record](elpis-motion-readability-20260909.md) is copied from
that development commit; its local log paths are not publicly hosted artifacts.

The public-content audit reran the cost/pruning calculator tests (18 passed),
current dashboard preview tests (7 passed), and independent chart validation tests
(4 passed, including rejection of wrong optimizer prices, duplicate cohorts, and
mixed binaries).
Website tests (13 passed) cover the existing concept demo plus current media, evidence labels,
and technical-page synchronization. Local browser checks inspect the overview,
technical page, charts, media loading, and narrow-screen layout. Both pages passed
at 1440 px and 390 px with no broken images, browser errors, or horizontal page
overflow. The generated technical page initially overflowed; code/table wrapping
and oversized dashboard images were corrected and checked again. No claim is made
that the deployed website has changed.

## Rebuilding

Run `python3 scripts/refresh-public-evidence.py` to validate recorded metrics and
regenerate current charts. Run `python3 scripts/build-public-content.py` to rebuild
the technical page from the README and copy its referenced assets and evidence.
Then run `npm run build:css` and `npm test` in `website/`. Pandoc and matplotlib
are local build prerequisites. Historical figures keep their original provenance.
