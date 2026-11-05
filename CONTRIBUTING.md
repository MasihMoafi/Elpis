# Contributing to Elpis

The [README](readme.md) introduces Elpis; the [guide](docs/GUIDE.md) covers its architecture.

## Reporting a bug

Use the [bug report form](https://github.com/MasihMoafi/Elpis/issues/new?template=bug_report.yml). It asks for the version (`elpis --version`; in the desktop app, Settings > About shows version and commit), your Linux distribution, X11 or Wayland, the provider and model, the steps, and what you expected and saw. Attach logs from the failing moment:

- Terminal app: `$ELPIS_HOME/logs_2.sqlite`, an SQLite database. The `logs_client` binary of `codex-rs/cli` tails it with filters: `logs_client --db ~/.elpis-next/logs_2.sqlite`.
- Desktop app: error notices show a code and a request ID; `$ELPIS_HOME/logs/desktop-requests.jsonl` holds the matching server errors, without message text. The terminal that started the app shows its other output.
- Claude and Gemini turns: `/tmp/acp-bridge/bridge.log` (or `ACP_BRIDGE_LOG`), written only when that folder exists, with secrets redacted.

Keep API keys, sign-in tokens and private conversations out of reports; a small synthetic project is enough. Security problems go through [SECURITY.md](docs/SECURITY.md), not public issues.

## Building the terminal app

The Rust workspace is `codex-rs/`, with Rust 1.95.0 pinned in `codex-rs/rust-toolchain.toml`. The shipped `elpis` binary is the `codex` binary of the `codex-cli` crate:

```sh
cd codex-rs
CODEX_SKIP_BWRAP_BUILD=1 cargo build --release --locked -p codex-cli --bin codex
CODEX_SKIP_BWRAP_BUILD=1 cargo test --profile dev-small --locked -p codex-tui --lib
```

`CODEX_SKIP_BWRAP_BUILD=1` skips the bundled sandbox, which needs libcap. The [Linux verification workflow](.github/workflows/embedded-elpis-linux.yml) holds the exact commands; it runs on pull requests that touch `codex-rs/`, `tools/elpis-claude/`, `scripts/` or `tests/install/`, and builds the binaries, the Debian package and checksums. Keep the focused Elpis checks passing; the full inherited Codex suite is [not claimed](readme.md#current-state).

## Building the desktop app

Node 26 (CI uses 26.1.0). From `apps/elpis-desktop`:

```sh
npm ci
npm ci --prefix ../../tools/elpis-claude
npx tsc --noEmit -p .
npm run build
npm test
```

Test tiers, opt-in checks and prerequisites: [TESTING.md](apps/elpis-desktop/TESTING.md).

`npm run desktop` opens the window. It needs an installed Elpis engine at `~/.local/bin/elpis-next`, or one named by `ELPIS_ENGINE_BIN`, with its provider bridge. Packaging and installation: [README](readme.md#quickstart). Bridge and runtime socket: [desktop README](apps/elpis-desktop/README.md).

## Changes

Do not commit `target/`, `node_modules`, state folders, transcripts or credentials. Read the [shipping rules](docs/SHIPPING_RULES.md) before a release-related change.

Elpis is [Apache-2.0](LICENSE). Upstream Codex keeps its attribution and [NOTICE](NOTICE); the bundled sandbox is bubblewrap under its own licence.
