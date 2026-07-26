# Elpis Build And Reduction Audit

## Audit Methodology

Use this as the standing brief when running a reduction audit (evidence-backed report,
not a blanket refactor):

- Read `AGENTS.md`, `GUIDE.md`, and `TASKS.md` first; verify the checkout before making
  any claim.
- Do not edit code, create branches/worktrees, commit, push, or open a PR during the
  audit itself — it is a report, not an implementation pass.
- Do not run Cargo or compile Rust on the local workstation.
- Do not infer that code is unused from its name or a hidden slash command. Prove call
  sites, ownership, configuration reachability, tests, and runtime purpose.
- Preserve ChatGPT/Codex login, streaming, shell/file tools, approvals, sandboxing,
  sessions, compaction, mouse selection, `/agent`, `/skills`, and `@` attachment.
- Preserve the one-tool `elpis-rag` boundary. Do not restore deleted Python tools.
- Do not mix appearance changes, feature deletion, and architecture work in one pass.

Audit steps:

1. Map the active launch path from the `elpis` command to the first usable Ratatui
   frame.
2. Identify startup work that blocks that frame and distinguish measured cost from
   speculation. Use existing evidence or the installed binary only.
3. Find duplicate, unreachable, obsolete, or Elpis-unwanted code. For each candidate,
   name the exact path and symbol, references, tests, dependencies, user-visible
   effect, removal risk, and smallest verification.
4. Separate inherited Codex machinery Elpis still needs from dedicated product
   surfaces Masih approved for deletion.
5. Identify large dependencies or modules only when repository evidence shows they are
   part of the active build or runtime.

Required output: one report with three ranked sections — **Remove now** (proven unused
or already superseded; low risk), **Investigate** (promising but not yet proven; state
the missing evidence), and **Keep** (heavy-looking code that supports retained
behavior; explain why). For every removal candidate, include difficulty (easy/medium/
hard), expected benefit, exact acceptance test, and one bounded commit-sized task.
Recommend only the single best first removal, then stop and wait for approval of what
may be deleted. After approval, implement only one selected candidate per commit and
use the remote Rust workflow for verification — never turn an audit into an open-ended
cleanup campaign.

## Baseline

The last verified pre-optimization run was GitHub Actions run `29534784054` for commit
`e841704e`. The runner started at 21:06:52 UTC and the result commit was written at
21:27:58 UTC: about 21 minutes end to end. The uploaded stripped Linux artifact was
102,988,260 bytes.

This is a cycle-time problem, but not evidence that every crate in `codex-rs/` is built.
`cargo build -p codex-tui --bin elpis` compiles the dependency graph reachable from the
Elpis TUI; unrelated workspace members do not materially affect that command merely by
existing.

## Root Causes

1. `codex-tui` is the mature Codex-derived product surface. Its active graph includes the
   core runtime, terminal rendering, authentication, permissions, sandboxing, sessions,
   MCP/RAG integration, skills/plugins, model management, and supporting libraries. A true
   cold build is therefore substantial.
2. The old workflow compiled overlapping test graphs on every `main` push: several memory
   crates, app-server integration tests, the complete TUI library test target, individual
   TUI tests, and the binary itself.
3. The cache key omitted the commit while GitHub caches are immutable. Later runs restored
   an old `target` snapshot but could not save the newly compiled state under the same key.
   `CARGO_INCREMENTAL=0` also prevented incremental reuse.
4. CI formatted source and committed a status file back to `main`. That automation required
   write permission, created repository noise, and mixed verification with source mutation.

## Changes Applied In The Build-Cycle Pass

- Restore strict `cargo fmt --check`; CI never edits source.
- Remove the self-mutating `.github/builds/latest-main.json` process.
- Cache Cargo downloads separately from compiled outputs.
- Key compiled outputs by toolchain, lockfile, and commit, with compatible restore prefixes.
- Enable incremental compilation and disable dev/test debug information in CI.
- Keep the first-release launcher, provider, memory, archive, bounds, retrieval, and binary
  checks on ordinary changes.
- Run the inherited app-server and complete TUI regression graph only on nightly, manual
  full-regression, and tagged-release runs.
- Generate and upload Cargo's HTML timing report with non-PR builds. The next reduction pass
  must use that report before removing dependencies.

## Reduction Candidates

### Proven safe or already bounded

- Remove the inert `debug-m-drop` and `debug-m-update` commands. They are hidden, labelled
  `DO NOT USE`, and only display a generic stub. This is tracked by issue #32.
- Keep broad TUI/app-server regression tests, but stop compiling their dev-only graph on
  every ordinary push. This removes process, not product capability.
- Keep the auxiliary `md-events` binary out of the Elpis build. It is not built by
  `--bin elpis`; deleting it would not explain the current build time.

### Measure before deleting

The next Cargo timing report should identify the most expensive reachable crates. Audit
these product surfaces in descending measured cost, then remove one bounded capability at a
time with an acceptance test:

- Codex Desktop handoff and cloud configuration;
- apps/connectors and plugin browsing;
- feedback upload and telemetry presentation;
- IDE integration and external-agent import;
- usage/account views, personality, plan mode, pets, raw mode, and Vim mode;
- theme and syntax-highlighting assets;
- image handling when no retained first-release interaction requires it.

Several of these have hidden slash commands but may still be reachable through keybindings,
settings, startup flows, or shared runtime code. Hiding a command is not proof that its
underlying dependency is removable.

### Do not delete for build-speed theatre

Do not remove arbitrary workspace members such as cloud tasks, V8 experiments, or sample
servers merely because they appear in the root workspace list. First prove that they are in
the Elpis binary's reachable dependency graph. Repository-size cleanup and build-time
cleanup are different campaigns.

## Feature Truth At This Audit

### UI/UX

Implemented: Elpis naming and the visible `Elpis · continuity runtime` title; the inherited
Ratatui interaction quality remains intact.

Not yet implemented at the time of this audit: the coherent amber theme, persistent
runtime/model/context/memory line, provider-aware `Choose a mind` model picker, signature
continuity event, and evidence-first completion hierarchy. A later change (commit `49cd113`)
shipped a persistent cyan identity header superseding the amber direction described here; see
GUIDE.md's UI Identity section for current status.

### Memory And Context

Implemented and remotely tested: Elpis-owned memory roots, recall tracking and promotion,
artifact bounds, ranked retrieval, portable `GOAL.md`/`ES.md`, focused continuity tests, and
a verified Linux build. This pass adds a focused archive regression and makes archive write
failure block baseline reset rather than silently losing deleted memory.

Not complete at the time of this audit: user-visible exact-resume, lean-continuation,
related/unrelated recall, review, reset, and compaction acceptance still must run
locally. The fixed-length cleaner described here was later retired. Layer 1 no longer
truncates tool output; `core/src/context_cleaner.rs` now expires only completed-turn
reasoning. Ace performs strict, fail-open post-turn pruning, while Codex's inherited
model-aware output cap remains the deterministic safety bound. See
`docs/CONTEXT_AND_SESSIONS.md` and `TASKS.md` for the current acceptance status.

### Providers

Implemented and remotely tested at the launcher/configuration layer, at the time of this
audit: OpenAI, OpenRouter, Bedrock, Ollama, and LM Studio provider IDs; Claude Sonnet and
Gemini Pro/Flash aliases route through OpenRouter.

Not complete at the time of this audit: Claude and Gemini are not native vendor adapters,
the `/model` UI is not the provider-aware `Choose a mind` surface, and end-to-end
authenticated task/resume acceptance has not been recorded for each first-release path.
Native Anthropic and Google Gemini adapters were later implemented with mock-server tests
(`core/src/chat_completions.rs`); see GUIDE.md's Providers section and `TASKS.md` F5 for
current status, including that live vendor acceptance is still pending.

## Next Reduction Gate

After this branch passes, compare its ordinary-change runtime with the 21-minute baseline and
inspect the uploaded Cargo timing report. Only then select the highest-cost optional product
surface, remove it in isolation, and prove retained execution, permissions, sandboxing,
sessions, compaction, context, memory, and RAG still work.

## Foundation-Import Evidence Log

Chronological measurement/proof record for the Codex-foundation import. Earliest first.

### 2026-07-15 — Launch smoke (`agent/foundation-codex-baseline`, commit `f37fc77`)

Binary: `codex-rs/target/debug/codex-tui`, built `--locked` in the worktree. Links only
system libraries: `libssl.so.3`, `libcrypto.so.3`, `libgcc_s.so.1`, `libc.so.6`.

- `--help` exits `0`.
- The TUI starts and enters its event loop without crashing (verified by a 4s timeout
  kill with no error; it opened `~/.codex/config.toml`, `auth.json`, `state_5.sqlite`,
  and entered its event loop).
- `strace -f -e trace=openat` during startup (617 syscalls) recorded zero opens against
  the donor clone path `/home/masih/Desktop/f/p/others/codex`.
- `strings` on the binary found no `Desktop/f/p/(others|codex)` matches — no donor path
  embedded in the binary.
- Observed runtime file reads were limited to `~/.codex/config.toml`, `~/.codex/auth.json`,
  `~/.codex/state_5.sqlite` (+ `-wal`/`-shm`), and `~/.codex/tmp/arg0/` lock files.

Conclusion: the imported TUI starts cleanly and is donor-isolated at runtime.

### 2026-07-15 — Foundation acceptance turn (`agent/foundation-codex-baseline`, imported binary)

An authenticated ChatGPT/Codex turn was run inline against
`/home/masih/Desktop/f/p/Elpis-foundation`, requiring one `pwd`, creation of a marker
file (`.elpis-foundation-acceptance-test.txt`, content
`ELPIS_FOUNDATION_CODEX_BASELINE_OK`), and a final `pwd`/`cat` verification. The
recorded Codex turn `019f6616-842c-7b90-9b48-844406cd496f` confirmed all three tool
calls (`pwd`, file write, `pwd`, `cat`) with matching output. An independent shell check
confirmed the file, and it was removed afterward (`git status --short` confirmed clean).

Combined with the launch-smoke evidence above, this passes all three acceptance items:
the imported TUI builds and launches from repository-contained source; an authenticated
Codex turn runs commands and creates a workspace file; runtime checks show zero file
access to the donor clone.

### 2026-07-15 — Embedded launcher (`agent/elpis-embedded-launcher`, commit `4c6ad25`)

The repository-contained foundation built and launched as `elpis` via
`.github/workflows/embedded-elpis-linux.yml`, GitHub Actions run `29446246504` (passed).

- Remote formatting, focused TUI compilation, Elpis branding test, release build,
  executable identity check, stripping, and artifact upload passed.
- Artifact `elpis-linux-x86_64`, SHA-256 `3883df12371a9ec37041d05be3208797e23cb37d04d17c49629b7eda5258c205`.
- `elpis --version` returned `elpis 0.0.0`; `elpis --help` identified the command as `elpis`.
- Dynamic dependencies resolved to system OpenSSL, libgcc, libm, and libc.
- Installed atomically at `/home/masih/.local/bin/elpis`; a fresh login shell resolved it.
- A pseudo-terminal launch stayed alive for a 4s smoke window, was stopped by the safety
  timer, and left no Elpis process running afterward.
- The installed binary contained the string `Welcome to Elpis, with Codex as the active
  runtime`.

Canonical `main` verification followed at commit `948c373` (GitHub Actions run
`29449900034`, passed; installed SHA-256
`bcb9dc5c5402e15cbb670210c31b94ccac58255bf7aaafca0b48831f4a395f8b`). The first
subtraction pass — removing the archived root TUI, old Python agent main, and the
obsolete Debian builder — kept remote formatting, focused TUI compilation, branding,
release build, executable identity, and artifact upload passing. The installed artifact
launched as `Elpis · Codex runtime` and exited cleanly on interruption.

This checkpoint proves the contained build and installation only. Command/file
rendering, permissions, mouse behavior, sessions, and compaction were inherited Codex
capabilities at this point, carried forward and subtracted from since — see
`Current State` in GUIDE.md for present status.
