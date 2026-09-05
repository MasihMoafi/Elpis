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

The incremental-compilation cache was 162 GB of that historical total. It is a
possible cleanup candidate, not an automatic deletion target. Masih's current
instruction is to preserve files and propose exact deletion candidates only.
Do not clear incremental state or run `cargo clean` to speed up a build: both
discard reusable work. Report disk pressure before starting a large build.

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

Masih explicitly authorized a faster local path on 2026-09-04 provided the machine stays below
80 C. Use `scripts/build-elpis-local {check|dev|optimized|shipping}` for that path. It defaults
to half the logical CPUs, capped at eight for checks and four for sustained builds.
Rust front-end threads remain independently capped at eight to preserve the warm
build fingerprint. Where supported, it uses the bundled LLD linker. These two compiler
execution flags require `RUSTC_BOOTSTRAP=1`; the wrapper probes them before use and reports its
selected accelerator. It does not enable unstable Rust language features in Elpis source.

The wrapper runs at reduced scheduler priority and samples Linux thermal sensors.
It refuses to start without readings or at the configured cutoff (default80 C).
During a build it pauses its owned process group5 C below that cutoff and resumes
below cutoff minus13 C (margins scale for cutoffs below14 C). Reaching the cutoff
holds work instead of discarding compiler progress. It reports pause count,
cooling milliseconds and limit holds. Sensor loss, cancellation or an unexpectedly
departed Cargo leader resumes/terminates surviving owned descendants.
Sampling cannot guarantee no overshoot, and pausing Elpis does not control other
applications' heat. Do not claim a system-wide temperature ceiling from this guard.
`ELPIS_BUILD_JOBS`, `ELPIS_RUSTC_THREADS`, and `ELPIS_MAX_TEMP_C` accept explicit positive
integer overrides; the temperature cutoff may be lowered but cannot exceed 80 C.
This exception applies to the wrapper, not arbitrary Cargo commands.

## 4. Use the cheapest build that answers the question

Do not use an optimized release build as the edit-test loop. The default sequence is:

1. Inspect source and run source-only checks.
2. Run `scripts/verify-elpis --changed <file>` or the exact behavioral test being changed.
   For a unit test inside one crate, include `--lib` and the narrowest stable test filter;
   omitting `--lib` makes Cargo prepare unrelated package targets. This reduces target work,
   but a change to a large Rust source or test file can still require that crate's relink.
3. Type-check the Elpis binary without linking it:

   ```bash
   scripts/build-elpis-local check
   ```

4. Use `scripts/build-elpis-local dev` only when a runnable debugging binary is needed.
5. Use `scripts/build-elpis-local optimized` only for local acceptance/install.
6. Use `scripts/build-elpis-local shipping` only for the exact release-profile artifact.

For local user acceptance, `scripts/build-elpis-local optimized` uses the separate
`local-release` profile: optimization level 1, 256 codegen units, incremental compilation, no
LTO, and no debug information. It is an install candidate, but it is not the shipping artifact. Run
`scripts/build-elpis-local shipping` for the unchanged ThinLTO release profile.

The development binary is an iteration artifact, not an install candidate. Do not copy it
over `~/.local/bin/elpis`, and do not restart or replace a running Elpis merely to inspect it.
The wrapper's `dev-small` profile strips debug information: it supports interactive
functional debugging, not full source-level debugging. Use the existing `dev` profile
when debugger symbols are required; do not silently change a warm profile's flags.

For dashboard styling, use [the development preview](../tools/dashboard-preview/README.md).
It serves the production web assets with explicit fixture or live local data; refreshing
after HTML/JavaScript edits needs no Rust compilation. TUI changes still require Rust.

Use one stable integration checkout for repeated Rust checks. A new worktree changes the
path identity of local crates and recompiles them even when external dependencies are warm.
Keep each worktree's own target directory as required by section 9; integrate first instead
of sharing a target across checkouts.

### Measured on 2026-09-04

These are wall-clock observations from the v0.2.0 candidate, not general benchmarks:

| Invocation | State | Wall time |
| --- | --- | ---: |
| Focused `codex-tui` palette test after a TUI edit | Warm target; TUI/test relink required | 38-48 s |
| Focused `codex-tui --lib` tests, no Rust source change | Warm target; test binary already linked | 1.05-2.26 s |
| Focused `codex-tui --lib` dashboard module after one test-source line | Warm dependencies; TUI test relink required | 33.44 s |
| Development `elpis` binary | Existing target; first current dev binary | 4m00.89s |
| Release binary after a TUI-only edit | Warm dependencies; final ThinLTO link required | 16m19s |
| Second release binary after a TUI-only edit | Same warm target and frozen remapping flags | 16m28s |
| Correctly remapped local release binary | Throttled at two jobs | 29m31s |
| Same release command, no source or flag change | Fully warm/no-op | 2.59s |
| Hosted Linux release gate | Clean 1,343 units; four-job runner | 15m07.7s |
| First `local-release` design (`opt-level=2`) | Cold profile; stopped after matching the old baseline | over 15m, then 2m36s to resume and link |
| Replacement `local-release` (`opt-level=1`) | First build of the new profile fingerprint; eight jobs, parallel Rust front end, bundled LLD | 12m06.5s; 77 C peak |
| Replacement `local-release` | One changed TUI source file, twice | 18.65s and 20.20s; 76 C peak |
| Replacement `local-release` | Fully warm/no-op | 1.55s; 65 C peak |
| Final integrated `local-release` candidate | Core dependencies warmed by the focused Smart Prune suite; final binary build/link still required | 6m36s; 76 C peak |
| Final integrated `local-release` candidate | Exact-head warm/no-op rerun | 2.58s wall; Cargo reported 2.35s |
| `build-elpis-local check` after focused test builds | First fill of the distinct Cargo check graph; eight jobs, parallel Rust front end | 3m12.254s; 78 C peak |
| `build-elpis-local check` exact repeat | Fully warm/no-op check graph | 1.555s; 61 C peak |
| Current-head `local-release`, first attempt | Eight Cargo jobs and eight Rust front-end threads | thermal guard stopped at 37.453s; exactly 80 C |
| Current-head `local-release`, same fingerprint resumed | Four Cargo jobs and eight Rust front-end threads; completed units reused | 4m15.720s; 76 C peak |
| Current-head `local-release`, exact warm repeat | Four Cargo jobs and eight Rust front-end threads; no source or flag change | 2.073s wall; Cargo reported 1.60s; 64 C peak |
| 2026-09-05 attribution/error-audit/retained-logo candidate | Changed core and TUI; four Cargo jobs and eight Rust front-end threads; stable warm integration checkout | 4m50.127s wall; 74 C peak |
| Same candidate, atomic installation | Existing verified optimized artifact, 219,125,416 bytes | 0.14s; source and installed SHA-256 matched |
| 2026-09-05 resume-attribution and context-math candidate | Changed app-server and TUI; same warm integration checkout and profile, four Cargo jobs/eight Rust front-end threads | 1m51.283s wall; 77 C sampled peak |
| Same resume/context candidate, atomic installation | Existing verified optimized artifact, 219,129,512 bytes | 0.16s; source and installed SHA-256 matched |
| 2026-09-05 explicit Smart Prune context-audit candidate | TUI-only edit; same warm profile, one Cargo job, eight Rust front-end threads restricted to CPU 0, nice 19 | 1m53.966s inner build; 73 C sampled peak; outer guard reported 116s |
| Same context-audit candidate, atomic installation | Existing verified optimized artifact, 219,129,512 bytes | 0.19s; source and installed SHA-256 matched |

The local session spent 115m14s in Cargo because three optimized builds were started with
different remapping flags. No individual build ran for 90 minutes. The avoidable cost was
changing the build fingerprint and paying for release code generation/linking again.

The first `local-release` design was not faster and is retained above as a failed measurement.
The replacement lowers local-only optimization and targets the observed single-crate and linker
bottlenecks. Its first-profile build was 26% faster than the representative 16m19s release build;
the more important edit loop is now about 19-20 seconds for the measured one-file TUI change.
The 2026-09-05 check measurement compares initial graph fill with a no-op repeat, not an
edit rebuild. Its 123.6x ratio must not be advertised as an edit-loop speedup. Do not restart,
change flags, or create a fresh worktree
because the first check compiled dependencies; keep using the stable checkout and identical wrapper
invocation so Cargo can reuse that graph.
The current-head optimized measurement also sets the safe default for sustained compilation on
this Core i9-11900H: eight Cargo jobs reached the 80 C cutoff, while four Cargo jobs retained
parallel Rust front-end work and completed below it. Keep the eight-job setting for short checks;
use `ELPIS_BUILD_JOBS=4 ELPIS_RUSTC_THREADS=8 scripts/build-elpis-local optimized` for a sustained
optimized build unless a later measured run demonstrates more thermal headroom.
These figures apply only to this checkout and machine. The unchanged shipping profile still needs
its own detached measurement before making a shipping-build speed claim.

On 2026-09-05 Masih reported CPU pressure during the UI check. The compiler was
idle at the initial inspection (hottest reported sensor 61 C); ChatGPT/Chrome
processes were the largest listed CPU users. A subsequent two-job test build
restricted to CPUs 0-3 hit a stricter 75 C guard and was stopped. A two-CPU retry
also stopped at a 76 C sample. Masih asked to continue through completion; the
corrected focused tests subsequently passed on CPU 0 at nice 19 in 38 s, sampled
peak 74 C, with the same cache fingerprint. For continued work under this load,
use only CPU 0, wait for all monitored sensors below62 C before starting, and
configure75 C cutoff (pause70 C/resume below62 C). Do not change compiler flags
or discard cached artifacts. Apply
`taskset --cpu-list 0` to the optimized wrapper with
`ELPIS_BUILD_JOBS=1 ELPIS_RUSTC_THREADS=8 ELPIS_MAX_TEMP_C=75`. Other processes
can still heat the machine; CPU affinity and sampled thermal holds are not a
guarantee of system-wide temperature. Retain older aborted attempts as failures,
not successful timing measurements, and do not restart healthy paused compilers.

The copper candidate needed a stricter task-local cgroup supervisor:25% of one
logical CPU, idle scheduling, pause70 C/resume below62 C, with monitoring outside
the frozen group. Focused test compilation completed in276s with6 holds and77 C
sampled peak. Optimized linking then failed after469s/11 holds; external sampling
reached82 C while the compiler was frozen (inner guard recorded74 C).
These are cooling/recovery observations, not evidence of an edit-loop speedup or
compliance with a whole-machine below80 C limit. See
[the dated evidence](evals/tasks/context_ui_validation/2026-09-05-brand.md).

When an agent must run that one long release link, use a named detached terminal and report its
name. A foreground tool session can be terminated by a new chat turn even though Cargo itself is
healthy; on 2026-09-04 that discarded a partially completed final link and forced it to restart.
Monitor the detached terminal and the real Cargo/rustc process before declaring it stalled or
starting another build.

The remembered command containing `755` is an installer, not a compiler invocation:

```bash
scripts/install-elpis-binary.sh codex-rs/target/local-release/elpis
```

Internally it uses `install -m 0755`; `0755` is the executable permission mode. It is fast because
it copies an artifact that already exists. It cannot replace compilation after source changes.

### Terminal visual checks

For terminal visual checks launched by an agent, inspect the child environment.
On 2026-09-05 the agent runner's inherited `NO_COLOR=1` suppressed every Elpis color;
this was not an old binary. Use `env -u NO_COLOR elpis` for the explicitly requested
color inspection. On a known RGB-capable terminal, `tmux -T RGB attach-session -t
<test-session>` advertises that capability for the client. Do not change the app
palette, rewrite global tmux settings, or rebuild Rust to fix this harness issue.

## 5. Freeze release flags before the first optimized build

Rust, C, and C++ remapping must all be present on the first release invocation. Adding or
changing any of these variables invalidates cached units. Use the same remapping root for every candidate rebuild. In this illustrative
command, replace `/home/developer` with your own home directory before the first build:

```bash
CARGO_BUILD_JOBS=2 \
RUST_TEST_THREADS=2 \
CODEX_SKIP_BWRAP_BUILD=1 \
RUSTFLAGS='--remap-path-prefix=/home/developer=/build' \
CFLAGS='-ffile-prefix-map=/home/developer=/build -fdebug-prefix-map=/home/developer=/build' \
CXXFLAGS='-ffile-prefix-map=/home/developer=/build -fdebug-prefix-map=/home/developer=/build' \
nice -n 10 cargo build --release --locked --offline -p codex-tui --bin elpis
```

Rust remapping alone is insufficient: tree-sitter C objects retained source paths until
`CFLAGS` and `CXXFLAGS` were added. Verify the finished candidate before installation:

```bash
strings target/release/elpis | rg '/home/developer|Desktop/p/'
```

No output is the passing result. If an unchanged release command begins compiling many
crates instead of finishing in seconds, stop it and compare the checkout, profile, Rust
toolchain, target directory, and all three flag variables before spending another full link.

Cargo's [build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html),
[profiles](https://doc.rust-lang.org/cargo/reference/profiles.html), and
[`--timings`](https://doc.rust-lang.org/cargo/reference/timings.html) documentation explain
the underlying cache and optimization tradeoffs. The candidate already uses ThinLTO; the
2026-09-04 hosted timing report showed the final `elpis` binary as the largest single build
unit at 399.5s, so focused checks and avoiding repeated release links have the largest proven
payoff.

`sccache` and `mold` are possible follow-up experiments, not current instructions. Neither
is installed on this workstation; the available `ld.gold` is also unbenchmarked. `sccache`
can cache compiler outputs but does not remove the final-link cost, while a different linker
changes the release toolchain. Benchmark either in isolation and retain binary-portability
and behavior checks before adopting it.

## 6. Verification command for workspace-wide edits

```bash
CARGO_BUILD_JOBS=2 RUST_TEST_THREADS=2 CODEX_SKIP_BWRAP_BUILD=1 nice -n 10 cargo check --workspace --all-targets --exclude codex-sandboxing
```

`--all-targets` matters: it type-checks tests too, and several Elpis test files are the
only callers of some functions. A `--lib`-only check will happily let you delete
something the tests still use.

## 7. Known failures that are NOT yours

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

## 8. Never format the whole repo

`cargo fmt --all` rewrites every file in the workspace, including in-flight work from
another session or another agent. Masih often has a second session open. Format only the
files you edited:

```bash
CODEX_SKIP_BWRAP_BUILD=1 cargo fmt -p <crate>     # or rustfmt the specific paths
```

## 9. Checked verification selector

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
override, it uses `<current checkout>/codex-rs/target`, so linked worktrees do not
reuse another checkout's path-crate artifacts. Explicitly sharing one target across
different checkouts can reuse stale artifacts and produce false failures.

`ELPIS_CARGO_TARGET_DIR` is accepted only when the value is absolute and the target is
writable. Replace `/absolute/shared/target` with a real writable path; the selector
prints the chosen target before it runs commands. It may create the target directory,
but it never deletes targets or caches and never runs `cargo clean`.

`cargo fmt --all --check` is the one narrow check-only exception to section 8: it
checks the whole workspace without rewriting source. Plain `cargo fmt --all` remains
prohibited.

Changed-file selection is intentionally narrower than the conservative named acceptance
surfaces:

- a Context Ledger edit runs formatting plus the `/context` and Ledger tests;
- a Smart Prune core edit runs only the feature, Smart Prune, and control tests;
- an ordinary TUI edit runs formatting plus a crate-local `cargo check`;
- several known paths form the union of their focused surfaces instead of escalating to `full`;
- an unknown or cross-cutting safety path still selects `full`.

Explicit `--surface tui`, `--surface context-compaction`, and `--surface full` retain their
larger acceptance suites. The focused selector is an edit-loop check, not release evidence.
