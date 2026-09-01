# Elpis Local Build & Test Rules

Read this before running any `cargo` command on Masih's workstation. These are
machine facts, not preferences — ignoring them has already cost a near-full disk.

## 1. Check disk before a big build

`codex-rs/target/` grows without bound and nothing prunes it. On 2026-07-25 it had
reached **246 GB** on a 451 GB disk (90% full, 47 GB free) — enough that linking the
workspace test binaries could have filled the disk mid-run.

```bash
du -sh codex-rs/target                 # check first
du -sh codex-rs/target/debug/* | sort -rh | head
```

**The safe reclaim** is the incremental-compilation cache. It was 162 GB of the 246 GB
and it is pure scratch — deleting it only makes the next build recompile changed crates
non-incrementally; the crate outputs in `target/debug/deps` are still reused.

```bash
rm -rf codex-rs/target/debug/incremental   # reclaimed 161 GB; 90% -> 52% full
```

Do this before any workspace-wide `cargo test`, and any time `target/` is over ~100 GB.
Prefer it to `cargo clean`, which throws away `deps/` too and forces a full rebuild.

## 2. `CODEX_SKIP_BWRAP_BUILD=1` is mandatory here

This machine has no `libcap` discoverable via `pkg-config`, so the `codex-bwrap` build
script panics and **every** cargo invocation fails before it compiles anything Elpis
owns:

```
failed to compile bubblewrap for Linux target: libcap not available via pkg-config
```

Prefix every cargo command with `CODEX_SKIP_BWRAP_BUILD=1`. A cargo failure without
that variable set is an environment problem, not a code problem — do not "fix" code in
response to it.

## 3. Throttle every local Rust build and test

Never let Cargo use the workstation's default all-core parallelism. Unless Masih
explicitly changes the limit, every local Rust verification command must inherit:

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo ...
```

The same variables and `nice` wrapper apply to `scripts/verify-elpis`. Do not raise
the job/thread counts to shorten a run. Hosted CI is preferable when an authorized
branch/push workflow exists. Local Rust commands remain throttled under this document;
remote validation does not authorize a release. Source-only and fake-Cargo checks do
not need this wrapper because they do not compile or execute Rust.

## 4. Verification command for workspace-wide edits

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo check --workspace --all-targets --exclude codex-sandboxing
```

`--all-targets` matters: it type-checks tests too, and several Elpis test files are the
only callers of some functions. A `--lib`-only check will happily let you delete
something the tests still use.

## 5. Known failures that are NOT yours

Verified pre-existing as of 2026-07-25 — do not chase them, do not "fix" them as part of
unrelated work:

- `sandboxing/src/manager_tests.rs` — missing an `arg0` field.
- `session::tests::guardian_tests::strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip`
  — stack-overflows in debug builds.
- `model-provider/src/provider.rs:303,349` — clippy `expect-used` denials, so
  `cargo clippy --workspace` cannot go green without touching that file.
- Assorted `dead_code` warnings in `tui/` and `core/src/client.rs`.

Establish the warning/failure baseline **before** you start editing, so you can tell
what you introduced from what was already broken.

## 6. Never format the whole repo

`cargo fmt --all` rewrites every file in the workspace, including in-flight work from
another session or another agent. Masih often has a second session open. Format only the
files you edited:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo fmt -p <crate>     # or rustfmt the specific paths
```

## 7. Checked verification selector

Run the checked selector from the repository root:

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 nice -n 10 scripts/verify-elpis --changed codex-rs/tui/src/dashboard_server.rs
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

`cargo fmt --all --check` is the one narrow check-only exception to section 6: it
checks the whole workspace without rewriting source. Plain `cargo fmt --all` remains
prohibited.
