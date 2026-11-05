# Upstream provenance

`codex-rs/` is upstream code: the Rust workspace of
[openai/codex](https://github.com/openai/codex), Apache-2.0, with its notices
kept here and in the root [NOTICE](../NOTICE).

| | |
| --- | --- |
| Upstream | `openai/codex`, revision `2e1607ee2fa8099a233df7437adee5f16a741905` (committed 2026-07-15) |
| Imported in | Elpis commit `f37fc7742` ("Import pinned Codex Rust foundation", 2026-07-15) |
| Import method | Committed upstream content only; parts Elpis does not ship were removed (fork-and-subtract) |

The planned move to a newer upstream release (vendor and carry, in
[docs/GUIDE.md](../docs/GUIDE.md)) records its new pin in this file.

## Where Elpis's changes live

- Elpis-owned crates: `elpis-gateway/` and `elpis-claude-proxy/`.
- Elpis-owned files inside upstream crates: those with `elpis` in the name,
  mostly in `tui/`, `core/`, `app-server/`, `app-server-protocol/` and `cli/`
  (`git ls-files codex-rs | rg -i elpis`).
- Edits to upstream files are marked with `// Elpis:` comments
  (`rg -l '// Elpis:' codex-rs`).
- The full Elpis delta is `git diff f37fc7742 -- codex-rs`.

## Generated files

Do not edit these by hand; change the source and rerun the command.

| File | Source | Command |
| --- | --- | --- |
| `codex-rs/app-server-protocol/schema/` | protocol types in `app-server-protocol/src/` | `python3 codex-rs/app-server-protocol/scripts/write_schema_fixtures.py` |
| `docs/workflow-sources.md` | `apps/elpis-desktop/lib/workflow-sources.json` | `node scripts/workflow-sources.mjs` (`--check` detects drift) |
| `apps/elpis-trajectory/dist/` | `apps/elpis-trajectory/src/` | `npm run build` in `apps/elpis-trajectory` |
| `website/technical.html` | `readme.md`, `website/technical-template.html` | `python3 scripts/build-public-content.py` |
| `website/styles.css` | `website/source.css` | `npm run build:css` in `website` |
| `website/assets/technical/elpis-current-{effort,horizon}-20260909.svg`, `current-evidence-20260909.json` | `website/evidence/COST_EFFICIENCY_METRICS.json` | `python3 scripts/refresh-public-evidence.py` |
| `website/assets/technical/elpis_empirical_evaluation_bars.svg` | measurements in the script | `python3 docs/evals/charts/render_peak_context.py` |
| `docs/evals/dashboard/dashboard.html` | `docs/evals/dashboard/runs/` | `python3 docs/evals/dashboard/build.py` |
