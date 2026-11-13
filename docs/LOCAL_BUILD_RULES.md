# Local build rules

Build and check the desktop app locally with one job at the lowest priority. Keep the `.next` cache on the New Volume. Do not build while a game runs.

Desktop verification and installation: [TESTING.md](../apps/elpis-desktop/TESTING.md).

## Installing the engine

`scripts/install-engine.sh <name>` installs the engine from the cargo build folder and the bridge scripts
(`tools/elpis-claude/`) from the checkout into `~/.local/lib/elpis-next/versions/<name>-<sha8>`, and writes
`source.json` and `rollback.sh` there. When no Rust build is allowed and only scripts changed,
`--binaries-from <installed version> --reason <text>` takes the binaries and prompts from that version (only read,
never pruned by this install) instead; `source.json` then keeps the binaries' own `source_head`, adds
`binaries_from`, `scripts_head`, `checkout_codex_rs`, `skipped` and `reason`. It refuses a missing version, one
without a binary or whose record does not match it, the version being written, and `--with-frontend`. Tests:
`node --test tests/install/install-engine.test.mts` (throwaway homes under `~/.cache/elpis-tests/`).

## Never format the whole repo

`cargo fmt --all` rewrites every file in the workspace, including in-flight work from
another session or another agent. Masih often has a second session open. Format only the
files you edited:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo fmt -p <crate>     # or rustfmt the specific paths
```

## Checked verification selector

Run the checked selector from the repository root:

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 nice -n 10 scripts/verify-elpis --changed codex-rs/tui/src/app.rs
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 nice -n 10 scripts/verify-elpis --surface full
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 ELPIS_CARGO_TARGET_DIR=/absolute/shared/target nice -n 10 scripts/verify-elpis --surface tui
```

The selector itself forces `CARGO_BUILD_JOBS=2`, `RUST_TEST_THREADS=2`,
`CODEX_SKIP_BWRAP_BUILD=1`, and `CARGO_TARGET_DIR=<selected target>` for every Cargo
child, invoking it through `nice -n 10`. The wrapper in the examples keeps that
hardware policy visible at the call site too. Without an
override, it runs `git rev-parse --path-format=absolute --git-common-dir`, takes the
common directory's parent, and uses `<parent>/codex-rs/target`. This keeps linked
worktrees on the repository's shared target.

`ELPIS_CARGO_TARGET_DIR` is accepted only when the value is absolute and the target is
writable. Replace `/absolute/shared/target` with a real writable path; the selector
prints the chosen target before it runs commands. It may create the target directory,
but it never deletes targets or caches and never runs `cargo clean`.

`cargo fmt --all --check` is the one narrow check-only exception to the rule above: it
checks the whole workspace without rewriting source. Plain `cargo fmt --all` remains
prohibited.
