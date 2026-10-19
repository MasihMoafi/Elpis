# T7 · portable native proof

Linux, Node.js 20+, tmux, gio and a built native CLI are required. From the repository root in CI:

```sh
node scripts/evals/ledger-close-placement.cjs --binary "$PWD/codex-rs/target/dev-small/codex" --output "$RUNNER_TEMP/t7-proof" --phase candidate
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$RUNNER_TEMP/t7-render" --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @xterm/xterm@6.0.0 playwright-core@1.62.1
node scripts/evals/render-ledger-close-placement.cjs --evidence "$RUNNER_TEMP/t7-proof" --modules "$RUNNER_TEMP/t7-render/node_modules" --chrome /usr/bin/google-chrome
```

Output must be fresh and empty. Candidate requires Close above the title in all 100/140-column light/dark cases; baseline requires four placement failures with working controls. Both check all nine Close cells, outside misses, Tab/Escape and zero model requests; candidate also checks title-row misses. Full filenames and wrapped/scrolled links/toggles have separate Rust regressions.

The harness uses loopback mocks, a local catalog, private environment/homes/tmux and no credentials. Each case has a 45-second deadline and bounded cleanup. Fixtures under ~/.cache/elpis-tests/t7-ledger-* use home-filesystem gio trash and socket paths below 100 bytes; only owned processes/profiles are cleaned up. Receipts contain binary/harness hashes, controls and cleanup results.

The renderer preserves captured ANSI cells/colors plus fixture defaults; PNGs are terminal replays with DejaVu Sans Mono, not OS screenshots. It requires all four captures, records input/PNG hashes and button colors, and refuses overwrites. [Verified run 39274191727](https://github.com/MasihMoafi/Elpis/actions/runs/39274191727): four native cases / 36 clicks, zero requests and clean fixtures; root inspected all four PNGs. Ledger 44 and startup 5 checks passed (45 distinct tests), no pending snapshots.
