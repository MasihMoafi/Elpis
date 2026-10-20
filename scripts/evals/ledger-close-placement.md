# T7 · portable native proof

Linux, Node.js 20+, tmux, gio and a built native CLI are required. From the repository root in CI:

```sh
node scripts/evals/ledger-close-placement.cjs --binary "$PWD/codex-rs/target/dev-small/codex" --output "$RUNNER_TEMP/t7-proof" --phase candidate
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$RUNNER_TEMP/t7-render" --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @xterm/xterm@6.0.0 playwright-core@1.62.1
node scripts/evals/render-ledger-close-placement.cjs --evidence "$RUNNER_TEMP/t7-proof" --modules "$RUNNER_TEMP/t7-render/node_modules" --chrome /usr/bin/google-chrome
```

Output must be fresh and empty. Candidate requires compact ╳ on row 0 and the title on row 1 in all 100/140-column light/dark cases. Relative Close/title order alone does not establish top placement: the previous installed runtime paints them on rows 4 and 5. Baseline requires four placement failures with working controls. Both check every painted Close cell (nine old cells or three compact cells), outside misses, Tab/Escape and zero model requests; candidate also checks title-row misses. Full filenames and wrapped/scrolled links/toggles have separate Rust regressions.

The native fixture stays idle and has no children. Child ordering is checked unconditionally by `chatwidget::tests::elpis_context_ledger::owned_ledger_title_stays_at_top_with_active_subagents`: it seeds a child and checks the title, summary, task and activity in 28/40/52-column Ledger panes. The full TUI suite in GitHub Actions must run this fixture; an absent native child is not proof of its placement. Status coverage includes real configured-rule discovery and persisted exclusion, populated native caches, ancestor deduplication, queued admission before/after commit, and ordinary README exclusion. Restoring the original `fea460113` status implementation while retaining `status_command_reports_admitted_development_rules` must fail with `/status omitted an admitted development rule` before the corrected-source suite passes.

The harness uses loopback mocks, a local catalog, private environment/homes/tmux and no credentials. Each case has a 45-second deadline and bounded cleanup. Fixtures under ~/.cache/elpis-tests/t7-ledger-* use home-filesystem gio trash and socket paths below 100 bytes; only owned processes/profiles are cleaned up. Receipts contain binary/harness hashes, controls and cleanup results.

The renderer preserves captured ANSI cells/colors plus fixture defaults; PNGs are terminal replays with DejaVu Sans Mono, not OS screenshots. It requires all four captures, records input/PNG hashes and button colors, and refuses overwrites. Historical predecessor [run 39274191727](https://github.com/MasihMoafi/Elpis/actions/runs/39274191727): four native cases / 36 clicks, zero requests and clean fixtures; root inspected all four PNGs. Ledger 44 and startup 5 checks passed (45 distinct tests), no pending snapshots.


## Current candidate — 21 October 2026

Native-only source is assembled on `fea460113`, whose native tree matches installed source `fb21bb0d`. Dashboard and desktop changes stay separate. The strengthened candidate gate was run against the actual selected binary (SHA-256 `edf91367a27cfdabd79b3441821264570f0898dda3d03b7c36369ae8cb17ae42`): all four layouts failed as expected (wide Close row 4, title row 5), while all 36 mouse controls passed, model requests remained zero, and all private fixtures stopped and were trashed. Evidence: `~/.cache/elpis-tests/tui-ledger-current-negative-20261021/result.json`.

This replacement has not been compiled or installed. The Linux verification workflow now runs the native compact/top gate, retains captures, proves the admitted-development-rule status regression fails against the original status implementation, restores candidate source, and runs the full TUI tests. Compilation, exact-artifact visual inspection, safe activation, and Masih’s acceptance remain required; the historical run above does not verify this replacement.
