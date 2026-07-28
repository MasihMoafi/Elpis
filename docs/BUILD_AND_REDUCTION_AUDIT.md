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
- Preserve the `/rag` MCP-client boundary. Elpis contains no retrieval engine and no
  Python; do not restore either.
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

## Next Reduction Gate

After this branch passes, compare its ordinary-change runtime with the 21-minute baseline and
inspect the uploaded Cargo timing report. Only then select the highest-cost optional product
surface, remove it in isolation, and prove retained execution, permissions, sandboxing,
sessions, compaction, context, memory, and RAG still work.
