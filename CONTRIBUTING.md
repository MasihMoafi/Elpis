# Contributing to Elpis

Rust and TypeScript contributors, Linux testers and careful bug reports are welcome. Elpis is a Linux coding-agent environment: a terminal app derived from OpenAI's Codex CLI and a desktop app that share one engine and one state folder. [The guide](docs/GUIDE.md) is the product and architecture reference.

## Reporting

Use the [bug report form](https://github.com/MasihMoafi/Elpis/issues/new?template=bug_report.yml). Include `elpis --version`, your Linux distribution, X11 or Wayland, the provider you used (ChatGPT sign-in, Claude, Gemini, OpenRouter, an API key or a local model), the steps and the expected result. Keep API keys, sign-in tokens and private conversations out of reports; a small synthetic project is enough. Security problems go through [SECURITY.md](docs/SECURITY.md), not public issues.

## Building the terminal app

The Rust workspace is `codex-rs/` with the toolchain pinned in `codex-rs/rust-toolchain.toml` (Rust 1.95). The shipped `elpis` binary is the `codex` binary of the `codex-cli` crate:

```sh
cd codex-rs
cargo build --release --locked -p codex-cli --bin codex
./target/release/codex
cargo test --profile dev-small --locked -p codex-tui --lib
```

Building the bundled sandbox needs libcap; set `CODEX_SKIP_BWRAP_BUILD=1` to skip it locally. [Release CI](.github/workflows/embedded-elpis-linux.yml) builds the binaries, the Debian package and checksums, and installs the result in a clean container; it is the reference for the exact commands. The whole inherited Codex test suite is not claimed green; keep the focused Elpis checks passing.

## Building the desktop app

```sh
cd apps/elpis-desktop
npm ci
npm run build
npm run desktop
npm test
```

[apps/elpis-desktop/README.md](apps/elpis-desktop/README.md) explains the bridge, the runtime socket and the test gate. Distribution packaging for the desktop app is unfinished.

## Changes

Reproduce the failure on the current app first, keep the strongest behavioral check that catches it, then fix and re-run the surrounding flow. Behavior that can silently do nothing needs a positive and a negative case. Do not commit `target/`, `node_modules`, state folders, transcripts or credentials. Read [AGENTS.md](AGENTS.md), [shipping rules](docs/SHIPPING_RULES.md) and [local build rules](docs/LOCAL_BUILD_RULES.md) before a release-related change.

Elpis is [Apache-2.0](LICENSE). Upstream Codex keeps its attribution and [NOTICE](NOTICE); the bundled sandbox is bubblewrap under its own licence.
