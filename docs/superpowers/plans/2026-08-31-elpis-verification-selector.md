# Elpis Verification Selector Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add one checked verification-surface manifest and one portable scripts/verify-elpis command that selects conservative local/Linux checks without deleting caches, then make the Linux workflows reuse it.

**Architecture:** tools/verify-elpis/surfaces.toml is the single checked source for command rows, surface membership, and path ownership. scripts/verify-elpis parses only that manifest, chooses a stable deduplicated union, prints it, and executes it with the required Cargo environment. A fake-Cargo shell harness proves selection and failure behavior without invoking Rust; CI/local Rust checks remain separate evidence.

**Tech Stack:** Bash arrays, Git, Python 3.11+ standard-library tomllib, TOML, Cargo, GitHub Actions, Linux.

**Spec:** docs/superpowers/specs/2026-08-31-elpis-daily-driver-readiness-design.md Stage 2; .superpowers/daily-driver-audits/build-cycle.md; docs/LOCAL_BUILD_RULES.md; docs/SHIPPING_RULES.md.

## Global Constraints

- Linux only; always export CODEX_SKIP_BWRAP_BUILD=1. No macOS work or gate.
- The selector accepts repeatable --changed PATH, --paths-file FILE, and --surface NAME; it never accepts raw Cargo arguments. Reject no input, unknown surface/command, malformed manifest, unreadable or empty path file before Cargo.
- Default target: absolute Git common dir from git rev-parse --path-format=absolute --git-common-dir, take its parent, then codex-rs/target. Accept ELPIS_CARGO_TARGET_DIR only when absolute and writable; print it. mkdir -p may create that target, but no cargo clean, rm, cache pruning/deletion, build/install/package/launch is allowed.
- Every Cargo child gets CODEX_SKIP_BWRAP_BUILD=1 and CARGO_TARGET_DIR=<selected>; execute Cargo from codex-rs.
- Formatting is exactly cargo fmt --all --check; it must never write.
- Path records preserve spaces. A --paths-file containing NUL is NUL-delimited; otherwise it is newline-delimited. Preserve all non-delimiter bytes, reject empty records, and never word-split, eval, or interpolate a path/manifest argv.
- Union/dedupe uses manifest declaration order. For changed paths, the first matching path rule owns each path. Two or more changed paths are "mixed" only when their resolved non-full surface lists differ; that condition selects full. Repeated paths resolving to the same list stay focused. Explicit --surface values are a deliberate union applied after path classification and do not trigger the mixed-path fallback. Any unmatched, shared-foundation, selector/workflow, Cargo manifest/lock, .cargo/**, or installer change selects full.
- Each `mode = "test"` row makes one Cargo call, retains/prints its output, fails on Cargo failure, then requires at least one matching test result: ok. <positive integer> passed line. Scan all summaries, not only the last; no positive passed harness is a failure. A checked `cargo test --no-run` row is `mode = "check"` and is exempt from the harness-summary rule.
- Workers do not edit coordinator-owned `docs/GUIDE.md` or ignored `TASKS.md`; preserve every unrelated working-tree change and untracked audit file.
- Do not promise a speedup. Fake-Cargo, local Rust, and remote CI are separate evidence.

## Checked Manifest and CLI Contract

Create tools/verify-elpis/surfaces.toml with semantic declaration order:

~~~toml
schema_version = 1

[commands.fmt-check]
kind = "cargo"
mode = "check"
argv = ["fmt", "--all", "--check"]

[commands.tui-dashboard]
kind = "cargo"
mode = "test"
argv = ["test", "-p", "codex-tui", "--lib", "--locked", "dashboard"]

[[surfaces]]
name = "dashboard"
commands = ["fmt-check", "tui-dashboard", "tui-context-usage"]

[[path_rules]]
glob = "codex-rs/tui/src/dashboard_server.rs"
surfaces = ["dashboard"]
~~~

The closed schema is commands (ordered table: literal argv, kind = cargo|shell, mode = check|test), surfaces, and path_rules. Reject duplicate names, invalid kind/mode/schema version, empty argv, unknown command references, and unknown path-rule surfaces. Command execution is also closed: a shell row is accepted only as `mode = "check"` with argv exactly `["git", "diff", "--check"]`; Cargo argv must begin with `fmt`, `check`, or `test`; `fmt` must be exactly `["fmt", "--all", "--check"]`; `check` must use `mode = "check"`; `test` uses `mode = "test"` unless it contains `--no-run`, in which case it must use `mode = "check"`. Reject `--release`, `--profile`, `--target-dir`, and every Cargo subcommand outside that allowlist before executing anything. Its parser emits NUL-delimited fields to Bash; Bash loads arrays and uses array expansion, never shell-evaluates TOML.

Declare surfaces in this order: docs, dashboard, tui, context-compaction, app-server, telemetry, agents-work-graph, memory, full, nightly-release. Retain the existing Linux assertions named in the build-cycle audit: format/diff/workspace check; automatic-pruning; state/core/integration work-graph; context prune; app-server list-models; five TUI model filters; launcher; context-cleaner/context-ledger; durable-memory/core memory; provider/auth; branding/slash-command. Add dashboard, telemetry, and agents/work-graph rows only where the audit names an existing exact test; any candidate without a real current test maps to full, never an invented filter.

full lists diff/format/workspace check and every ordinary focused row once. It excludes release build, package/install/identity execution, macOS, and nightly-release. nightly-release holds current inherited app-server/TUI checks separately; its compile-only `cargo test --no-run` row is `mode = "check"`.

Declare path rules in this exact precedence family so first-match ownership is conservative: selector/workflow/Cargo-manifest/.cargo/installer/shared-foundation and command-bearing documentation exceptions -> full; exact dashboard/context-usage rendering -> dashboard; explicit context/prune/compact/features/ledger paths -> context-compaction; timing/backend-client/otel/app-server turn-cost paths -> telemetry; state/work-graph/TUI multi-agent paths -> agents-work-graph; continuity/memory/app-server recall paths -> memory; remaining app-server -> app-server; remaining TUI -> tui; ordinary non-command documentation -> docs; unmatched -> full. A broad TUI, app-server, or docs rule must never precede one of its listed exceptions.

The CLI prints stable output:

~~~text
Elpis verification: surfaces=dashboard
Elpis verification: changed=codex-rs/tui/src/dashboard_server.rs
Elpis verification: target=<absolute target>
Elpis verification: commands=fmt-check,tui-dashboard,tui-context-usage
~~~

### Task 1: Fail-first fake-Cargo selector

**Files:**

- Create: tests/verify-elpis/test_verify_elpis.sh
- Create: tools/verify-elpis/surfaces.toml
- Create: scripts/verify-elpis

**Interfaces:**

- Consumes: checked manifest, Git, python3, Cargo on PATH, optional target override.
- Produces: scripts/verify-elpis [--changed PATH]... [--paths-file FILE] [--surface NAME]....

- [ ] **Step 1: Write the failing isolated shell harness.**

Use Bash set -euo pipefail, mktemp -d, and a cleanup trap. It creates a temporary Git repository with codex-rs/, copies the future selector/manifest, puts a fake cargo first on PATH, and writes NUL-delimited argv/environment records. The fake only prints controlled harness summaries; it never invokes Rust.

Start RED with:

~~~bash
run_selector --changed codex-rs/tui/src/dashboard_server.rs
assert_status 0
assert_output 'Elpis verification: surfaces=dashboard'
assert_output 'Elpis verification: commands=fmt-check,tui-dashboard,tui-context-usage'
assert_cargo_env 'CODEX_SKIP_BWRAP_BUILD=1'
assert_cargo_argv 'fmt' '--all' '--check'
assert_cargo_argv 'test' '-p' 'codex-tui' '--lib' '--locked' 'dashboard'
~~~

- [ ] **Step 2: Add the complete manifest, then confirm the test remains red because selector code is absent.**

Populate all rows/rules in the contract, with stable order and intentional command overlap between the dashboard, TUI, and full surfaces. Run:

~~~bash
bash tests/verify-elpis/test_verify_elpis.sh
~~~

Expected: non-zero because scripts/verify-elpis cannot meet the first contract case.

- [ ] **Step 3: Implement the selector minimally.**

Use embedded python3 only to import tomllib, parse/validate the TOML closed schema and command allowlist above, and emit NUL-delimited values. This adds no package: both relevant workflows already invoke python3, local Python is 3.13, and Ubuntu 24.04 has Python 3.12. If tomllib is unavailable, fail before Cargo with a Python-3.11 requirement; do not add pip, a vendored parser, or a Cargo/Rust parser.

Collect --changed literally; for --paths-file, read NUL records when a NUL exists and otherwise newline records; reject empty/missing input. Apply safe shell glob matching without eval and use the first matching path rule. If changed paths resolve to different non-full surface lists, replace their union with full; then add explicit surfaces normally. Union commands with associative-array membership but emit manifest order. Print the four header lines before execution. For Cargo rows, run cargo with the array argv in codex-rs. For diff-check, use the one allowed literal shell argv only at the repository root. Capture each `mode = "test"` row to a temporary file, tee normal output, require a positive successful harness summary, then remove only that temporary file.

- [ ] **Step 4: Make all harness cases green.**

Add and run these exact cases:

1. Dashboard path selects dashboard, exports both variables, and runs only declared rows in manifest order.
2. Repeated/explicit surfaces and path-plus-surface are a stable deduplicated union.
3. Unknown, shared-foundation, and unclassified paths select full. Two changed paths resolving to different focused surface lists select full; repeated paths resolving to the same list remain focused; explicit multiple surfaces and path-plus-surface remain a stable union rather than triggering the mixed-path fallback.
4. First-match precedence is proven in both directions for every broad-family exception: dashboard and context/ledger before remaining TUI; TUI work-graph before remaining TUI; app-server turn-cost before remaining app-server; app-server memory recall before remaining app-server; and command-bearing docs before ordinary docs.
5. Newline files preserve spaces; NUL files preserve an embedded newline; empty/missing list fails before fake Cargo.
6. Only zero-pass summaries fail; multiple summaries pass only when one has a positive passed count; fake Cargo non-zero fails.
7. Unknown surface/reference, malformed TOML, non-absolute override, unwritable override, arbitrary shell argv, `cargo clean`, unsupported Cargo subcommands, release/profile/target-dir flags, and a `test --no-run` row mislabeled as `mode = "test"` fail before fake Cargo or shell execution.
8. Every format call contains --check; logs contain no clean, rm, write-mode fmt, install, release build, or executable launch.

Run:

~~~bash
bash tests/verify-elpis/test_verify_elpis.sh
git diff --check -- scripts/verify-elpis tools/verify-elpis/surfaces.toml tests/verify-elpis/test_verify_elpis.sh
~~~

Expected: green using fake Cargo only.

- [ ] **Step 5: Commit.**

~~~bash
git add scripts/verify-elpis tools/verify-elpis/surfaces.toml tests/verify-elpis/test_verify_elpis.sh
git commit -m "feat: add Elpis verification selector"
~~~

### Task 2: Reuse selector in Linux workflows

**Files:**

- Modify: .github/workflows/embedded-elpis-linux.yml
- Modify: .github/workflows/launcher-diagnostics.yml
- Modify: tests/verify-elpis/test_verify_elpis.sh

**Interfaces:**

- Consumes: Task 1 selector/manifest.
- Produces: PR/push path selection via --paths-file; schedule/tag/manual via --surface full; launcher diagnostics via --surface tui; no duplicate workflow test list.

- [ ] **Step 1: Add failing static workflow assertions.**

The shell harness must assert Linux CI runs itself before selector use, creates a NUL diff list, calls scripts/verify-elpis --paths-file, and has no run_filter helper or copied focused cargo test -p list. Assert launcher diagnostics calls scripts/verify-elpis --surface tui and has no write-mode cargo fmt --all.

- [ ] **Step 2: Prove the workflow assertions are red.**

~~~bash
bash tests/verify-elpis/test_verify_elpis.sh
~~~

Expected: only new workflow wiring checks fail; Task 1 cases remain green.

- [ ] **Step 3: Migrate the main Linux workflow.**

Make selector steps root-scoped (remove job-wide codex-rs default or set it per retained release command). Add selector, manifest, harness, and docs paths to event filters. Before Rust, run the shell harness.

For PRs, produce git diff --name-only -z "$base" "$head" > "$RUNNER_TEMP/elpis-changed-paths" and invoke:

~~~bash
scripts/verify-elpis --paths-file "$RUNNER_TEMP/elpis-changed-paths"
~~~

For schedule, tag, and manual full regression, use scripts/verify-elpis --surface full, then use --surface nightly-release only in the current schedule/tag/manual exhaustive branch. Remove both run_filter helpers and every duplicated focused row. Retain release build, identity, artifacts, packaging, and macOS outside the selector; give retained Cargo release commands working-directory: codex-rs. Do not change cache policy, permissions, materialization, tag/release behavior, or macOS.

- [ ] **Step 4: Migrate launcher diagnostics.**

After existing materialization, replace direct format mutation/direct launcher Cargo test with scripts/verify-elpis --surface tui. Retain branch gate/artifact logic only if it still has independent diagnostic value; do not retain a third launcher list.

- [ ] **Step 5: Verify and commit.**

~~~bash
bash tests/verify-elpis/test_verify_elpis.sh
git diff --check -- .github/workflows/embedded-elpis-linux.yml .github/workflows/launcher-diagnostics.yml tests/verify-elpis/test_verify_elpis.sh
git add .github/workflows/embedded-elpis-linux.yml .github/workflows/launcher-diagnostics.yml tests/verify-elpis/test_verify_elpis.sh
git commit -m "ci: reuse Elpis verification selector"
~~~

Expected: source/shell proof only; no Rust/cache/remote workflow run.

### Task 3: Document local and shipping boundaries

**Files:**

- Modify: docs/LOCAL_BUILD_RULES.md
- Modify: docs/SHIPPING_RULES.md
- Modify: tests/verify-elpis/test_verify_elpis.sh

**Interfaces:**

- Consumes: Task 1 CLI and manifest names.
- Produces: discoverable safe local use and an explicit non-release boundary.

- [ ] **Step 1: Add failing documentation assertions.**

Assert local rules contain changed-path and full examples, bwrap behavior, common-Git-dir target derivation, absolute writable override, cache-preservation, and check-only formatting. Assert shipping rules say the selector is not artifact build/install/package/launch, tag, clean-machine, or manual acceptance evidence.

- [ ] **Step 2: Establish RED.**

~~~bash
bash tests/verify-elpis/test_verify_elpis.sh
~~~

Expected: new doc assertions fail only.

- [ ] **Step 3: Add narrow documentation.**

Add to docs/LOCAL_BUILD_RULES.md:

~~~bash
scripts/verify-elpis --changed codex-rs/tui/src/dashboard_server.rs
scripts/verify-elpis --surface full
ELPIS_CARGO_TARGET_DIR=/absolute/shared/target scripts/verify-elpis --surface tui
~~~

State the selector sets bwrap, derives CARGO_TARGET_DIR portably unless overridden, never deletes targets/caches, and has the read-only cargo fmt --all --check exception to the no-whole-repo-format warning. In shipping rules, state proportional selector evidence does not replace release/clean-machine/tag/manual acceptance. Do not change release mechanics.

- [ ] **Step 4: Verify and commit.**

~~~bash
bash tests/verify-elpis/test_verify_elpis.sh
git diff --check -- docs/LOCAL_BUILD_RULES.md docs/SHIPPING_RULES.md tests/verify-elpis/test_verify_elpis.sh
git add docs/LOCAL_BUILD_RULES.md docs/SHIPPING_RULES.md tests/verify-elpis/test_verify_elpis.sh
git commit -m "docs: explain Elpis verification selector"
~~~

### Task 4: Close with proportional evidence

**Files:**

- Modify: none unless the preceding acceptance harness finds a real selector defect.

**Interfaces:**

- Consumes: Tasks 1-3.
- Produces: an honest coordinator handoff; no GUIDE.md/TASKS.md worker edit.

- [ ] **Step 1: Re-run clean fake-Cargo evidence.**

~~~bash
bash tests/verify-elpis/test_verify_elpis.sh
~~~

Expected: proves selection, environment, delimiter handling, zero-match failure, docs, and workflow source wiring only.

- [ ] **Step 2: Run local Rust evidence only at functional close.**

Follow docs/LOCAL_BUILD_RULES.md: inspect disk and preserve caches, then execute actual focused and conservative full surfaces.

~~~bash
du -sh codex-rs/target
scripts/verify-elpis --changed <actual-changed-path>
scripts/verify-elpis --surface full
~~~

Expected: selector prints commands before each run. Record focused/full Rust results separately. Do not release-build/install/launch, push, tag, run macOS, or delete a cache in this task.

- [ ] **Step 3: Report deferred evidence.**

State shell evidence as pass/fail, local focused/full Rust evidence as pass/fail/deferred, and remote Linux workflow evidence as deferred until an authorized push/trigger. Do not assert a timing or speedup without later approved per-command timing plus cache restore/save-byte evidence.

## Coverage Review

| Requirement | Plan coverage |
| --- | --- |
| One manifest + one command | Task 1 |
| Portable target + mandatory bwrap | Task 1 |
| Stable union/dedupe and conservative full | Task 1 |
| NUL/newline paths + zero-match failure | Task 1 |
| Check-only/no deletion/release action | Tasks 1 and 3 |
| Workflow reuse with no duplicate test list | Task 2 |
| Docs | Task 3 |
| Shell vs local Rust vs remote evidence | Task 4 |

No implementation is part of this draft. Fake-Cargo shell proof comes first; local Rust and remote workflow evidence are deliberately deferred.
