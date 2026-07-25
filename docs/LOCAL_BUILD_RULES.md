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

## 3. Verification command for workspace-wide edits

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo check --workspace --all-targets --exclude codex-sandboxing
```

`--all-targets` matters: it type-checks tests too, and several Elpis test files are the
only callers of some functions. A `--lib`-only check will happily let you delete
something the tests still use.

## 4. Known failures that are NOT yours

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

## 5. Never format the whole repo

`cargo fmt --all` rewrites every file in the workspace, including in-flight work from
another session or another agent. Masih often has a second session open. Format only the
files you edited:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo fmt -p <crate>     # or rustfmt the specific paths
```
