# Upstream provenance

`codex-rs/` is upstream code: the Rust workspace of
[openai/codex](https://github.com/openai/codex), Apache-2.0, with its notices
kept here and in the root [NOTICE](../NOTICE).

| | |
| --- | --- |
| Upstream | `openai/codex` tag `rust-v0.162.0`, commit `c1382380de69521303b416720a52f42d51af6248` (tagged 2026-10-08) |
| Unmodified copy | Elpis commit `8aa35e622`, local branch `vendor/codex-rust-v0.162.0` |
| Integrated in | Elpis commit `9109c7980` (2026-10-09), which carried the Elpis features onto that tree |
| Earlier bases | `2e1607ee` (imported 2026-07-15 in `f37fc7742`), then rust-v0.158.0, v0.159.3 and v0.160.0 |

A move to a newer release vendors it unmodified on its own branch, integrates it, and updates this table
([docs/GUIDE.md](../docs/GUIDE.md) describes the vendor-and-carry strategy).

## Where Elpis's changes live

- Elpis-owned crates: `elpis-gateway/` and `elpis-claude-proxy/`.
- Elpis-owned files inside upstream crates: those with `elpis` in the name,
  mostly in `tui/`, `core/`, `app-server/`, `app-server-protocol/` and `cli/`
  (`git ls-files codex-rs | rg -i elpis`).
- Some edits to upstream files carry `// Elpis:` comments (185 files); most do not,
  so the diff below is the complete record.
- The full Elpis delta is `git diff 8aa35e622 -- codex-rs`.

## Generated files

Do not edit these by hand; change the source and rerun the command.

| File | Source | Command |
| --- | --- | --- |
| `codex-rs/app-server-protocol/schema/` | protocol types in `app-server-protocol/src/` | `python3 codex-rs/app-server-protocol/scripts/write_schema_fixtures.py` |
| `docs/workflow-sources.md` | `apps/elpis-desktop/lib/workflow-sources.json` | `node scripts/workflow-sources.mts` (`--check` detects drift) |
| `apps/elpis-trajectory/dist/` | `apps/elpis-trajectory/src/` | `npm run build` in `apps/elpis-trajectory` |
| `website/technical.html` | `readme.md`, `website/technical-template.html` | `python3 scripts/build-public-content.py` |
| `website/styles.css` | `website/source.css` | `npm run build:css` in `website` |
| `website/assets/technical/elpis-current-{effort,horizon}-20260909.svg`, `current-evidence-20260909.json` | `website/evidence/COST_EFFICIENCY_METRICS.json` | `python3 scripts/refresh-public-evidence.py` |
| `website/assets/technical/elpis_empirical_evaluation_bars.svg` | measurements in the script | `python3 docs/evals/charts/render_peak_context.py` |
| `docs/evals/dashboard/dashboard.html` | `docs/evals/dashboard/runs/` | `python3 docs/evals/dashboard/build.py` |
