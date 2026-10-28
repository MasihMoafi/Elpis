# Contributing to Elpis

Elpis is a Linux coding-agent environment: a terminal app derived from OpenAI's Codex CLI and a desktop app that share one engine and one state folder, `$ELPIS_HOME` (default `~/.elpis-next`). [The guide](docs/GUIDE.md) is the product and architecture reference. Rust and TypeScript contributors, Linux testers and careful bug reports are welcome.

## Reporting a bug

Use the [bug report form](https://github.com/MasihMoafi/Elpis/issues/new?template=bug_report.yml). It asks for the version (`elpis --version`; in the desktop app, Settings > About shows the version and commit), your Linux distribution, X11 or Wayland, the provider and model, the steps, what you expected and what you saw. Logs help most when they cover the failing moment:

- Terminal app: `$ELPIS_HOME/logs_2.sqlite`, an SQLite database. The `logs_client` binary of `codex-rs/cli` tails it with filters: `logs_client --db ~/.elpis-next/logs_2.sqlite`.
- Desktop app: error notices show a code and a request ID; `$ELPIS_HOME/logs/desktop-requests.jsonl` holds the matching server errors, without message text. The terminal that started the app shows its other output.
- Claude and Gemini turns: `/tmp/acp-bridge/bridge.log` (or `ACP_BRIDGE_LOG`), written only when that folder exists. Secrets are redacted.

Keep API keys, sign-in tokens and private conversations out of reports; a small synthetic project is enough. Security problems go through [SECURITY.md](docs/SECURITY.md), not public issues.

## Building the terminal app

The Rust workspace is `codex-rs/`, with Rust 1.95.0 pinned in `codex-rs/rust-toolchain.toml`. The shipped `elpis` binary is the `codex` binary of the `codex-cli` crate:

```sh
cd codex-rs
CODEX_SKIP_BWRAP_BUILD=1 cargo build --release --locked -p codex-cli --bin codex
CODEX_SKIP_BWRAP_BUILD=1 cargo test --profile dev-small --locked -p codex-tui --lib
```

`CODEX_SKIP_BWRAP_BUILD=1` skips the bundled sandbox, which needs libcap. Test one crate per command and cap the jobs (`CARGO_BUILD_JOBS=2`); [local build rules](docs/LOCAL_BUILD_RULES.md) explain why. The [Linux verification workflow](.github/workflows/embedded-elpis-linux.yml) holds the exact commands: it runs on pull requests that touch `codex-rs/`, `tools/elpis-claude/`, `scripts/` or `tests/install/`, and builds the binaries, the Debian package and checksums. The whole inherited Codex test suite is not claimed green; keep the focused Elpis checks passing.

## Building the desktop app

Node 26 (CI uses 26.1.0). From `apps/elpis-desktop`:

```sh
npm ci
npm ci --prefix ../../tools/elpis-claude
npx tsc --noEmit -p .
npm run build
npm test
```

`npm test` runs `scripts/test-gate.mjs`: it checks that `test-inventory.json` assigns every test file to one tier, then runs the fast, bridge, desktop and UI tiers one file at a time, each under a time limit that starts once the file holds its shared lock, with a throwaway `ELPIS_HOME`. A failing file does not stop the later tiers; the run reports every failure and exits non-zero. `npm run test:fast` (or `test:bridge`, `test:desktop`, `test:ui`) runs one tier. The UI tier needs Playwright with Chromium; set `ELPIS_PLAYWRIGHT_PACKAGE` to its package folder. The attachment and transcription tests need `poppler-utils` and `ffmpeg`. Each run writes its logs and `summary.json` under `/tmp/elpis-test-gate-*`. [TESTING.md](apps/elpis-desktop/TESTING.md) covers the opt-in tests and what done means.

`npm run desktop` opens the window. It needs an installed Elpis engine at `~/.local/bin/elpis-next`, or one named by `ELPIS_ENGINE_BIN`, with its provider bridge; the desktop app has no installer for other machines yet. [The desktop README](apps/elpis-desktop/README.md) explains the bridge and the runtime socket.

## Changes

Reproduce the failure on the current app first, write the test that catches it, then fix and re-run the surrounding flow. Behavior that can silently do nothing needs a positive and a negative case. Do not commit `target/`, `node_modules`, state folders, transcripts or credentials. Read the [shipping rules](docs/SHIPPING_RULES.md) before a release-related change.

Elpis is [Apache-2.0](LICENSE). Upstream Codex keeps its attribution and [NOTICE](NOTICE); the bundled sandbox is bubblewrap under its own licence.
