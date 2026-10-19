# T7 · portable native proof

Requires Linux, Node.js 20+, `tmux`, `gio` and a built native CLI; no npm dependencies or credentials. From the repository root:

```sh
node scripts/evals/ledger-close-placement.cjs --binary /absolute/path/to/codex --output /tmp/t7-candidate-proof --phase candidate
```

Use a fresh empty output directory. `candidate` requires Close immediately above the heading in all four 100/140-column light/dark cases; `baseline` requires the same positive controls and four placement failures. Both require all nine Close cells, two outside misses, Tab/Escape and zero mock-provider requests; the candidate also checks that the title row does not close the pane.

The harness uses a local catalog, loopback mocks, private homes/environment/tmux socket and no auth or real user configuration. Each case has a 45-second interaction deadline plus bounded cleanup; finally it stops its own server/tmux and sends its fixture to `gio trash`. Keep the separate output: JSON receipts with CLI/harness SHA-256, ANSI/text captures and bounded native logs. No CLI copy or profile is retained there. Filename wrapping remains covered by the Rust regressions; visible fixture source labels are recorded without claiming that check. This portable adaptation has only been syntax-checked locally; CI must run it before claiming candidate proof.

For PNG replays in CI, use the pinned versions read from installed package manifests (registry availability unchecked), plus existing Chrome:

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$RUNNER_TEMP/t7-render" --no-save --package-lock=false --no-audit --no-fund @xterm/xterm@6.0.0 playwright-core@1.62.1
node scripts/evals/render-ledger-close-placement.cjs --evidence "$RUNNER_TEMP/t7-proof" --modules "$RUNNER_TEMP/t7-render/node_modules" --chrome /usr/bin/google-chrome
```

The renderer requires all four 100/140-column light/dark `*-open.ansi` captures. It writes matching PNGs and `render-result.json` with hashes and parsed button colors, preserving ANSI cells and the harness's default palette; it refuses existing outputs. These are ANSI replays using DejaVu Sans Mono (runner monospace fallback), not native screenshots. The renderer is syntax-checked only; inspect CI images before claiming visual verification.
